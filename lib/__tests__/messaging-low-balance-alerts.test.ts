/**
 * Low messaging-balance alerts (TestBiz staging, 10 Nov 2026: a non-expiring NGN top-up had
 * 900 minor units left, each reply cost 1300, replies stopped with no warning).
 *
 * Real checkLowBalanceAlerts against an in-memory database that behaves like PostgREST for
 * the calls it makes (alerts primary key refuses a duplicate id with 23505). Email is mocked
 * at the Resend boundary (lib/email/client sendEmail).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendEmail = vi.fn();
vi.mock('@/lib/email/client', () => ({ sendEmail: (...a: unknown[]) => sendEmail(...a) }));

import {
  checkLowBalanceAlerts, reachedLevel, parseLowBalanceConfig, lowBalanceAlertId,
  DEFAULT_LOW_BALANCE_CONFIG, LOW_BALANCE_ALERT_TYPE, resetLowBalanceSettingsCache,
} from '@/lib/messaging/low-balance-alerts';

const BIZ = 'b47d9058-78bc-40a8-90ac-bd9667713710';
const NGN_PRICING = { NGN: { rates: { NG: { '*': 1300 } }, default_cost_minor: 1300 } };
const NOW = new Date('2026-11-11T00:55:00Z');

type Allowance = { id: string; currency_code: string; remaining_minor: number; expires_at: string | null; created_at: string };

function db(opts: {
  allowances: Allowance[];
  settings?: Record<string, unknown>;
  ownerEmail?: string | null;
  settingsError?: boolean;
  /** Simulate another send inserting the same alert between our read and our insert. */
  raceInsert?: boolean;
  /** Billing config snapshot overrides (newest platform_config_versions row). */
  snapshot?: Record<string, unknown>;
  country?: string | null;
}) {
  const alerts = new Map<string, Record<string, unknown>>();
  const inserts: Array<Record<string, unknown>> = [];
  const from = vi.fn((table: string) => {
    const filters: Array<[string, string, unknown]> = [];
    let pendingUpdate: Record<string, unknown> | null = null;
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'lte', 'order', 'limit']) chain[m] = vi.fn(() => chain);
    chain.eq = vi.fn((c: string, v: unknown) => { filters.push(['eq', c, v]); return chain; });
    chain.is = vi.fn((c: string, v: unknown) => { filters.push(['is', c, v]); return chain; });
    chain.in = vi.fn((c: string, v: unknown) => { filters.push(['in', c, v]); return chain; });
    const eqVal = (c: string) => filters.find(f => f[0] === 'eq' && f[1] === c)?.[2];
    chain.insert = vi.fn(async (row: Record<string, unknown>) => {
      inserts.push(row);
      if (table !== 'alerts') return { error: null };
      if (opts.raceInsert || alerts.has(row.id as string)) return { error: { code: '23505', message: 'duplicate key' } };
      alerts.set(row.id as string, { ...row, is_read: false });
      return { error: null };
    });
    chain.update = vi.fn((row: Record<string, unknown>) => { pendingUpdate = row; return chain; });
    chain.maybeSingle = vi.fn(async () => {
      if (table === 'alerts') {
        const row = alerts.get(eqVal('id') as string);
        return { data: row ? { id: row.id, metadata: row.metadata } : null, error: null };
      }
      if (table === 'businesses') return { data: {
        country_code: opts.country === undefined ? 'NG' : opts.country, name: 'TestBiz <b>',
        profiles: { email: opts.ownerEmail === undefined ? 'owner@example.com' : opts.ownerEmail },
      }, error: null };
      if (table === 'platform_config_versions') {
        if (opts.settingsError) return { data: null, error: { message: 'down' } };
        return { data: { config_snapshot: { messaging_financial_gate: true, messaging_pricing: NGN_PRICING, ...(opts.snapshot || {}) } }, error: null };
      }
      return { data: null, error: null };
    });
    chain.then = (resolve: (v: unknown) => unknown) => {
      if (pendingUpdate && table === 'alerts') {
        // PostgREST-like: the update applies only to rows matching every filter
        const id = eqVal('id') as string;
        const row = alerts.get(id);
        const email = ((row?.metadata as Record<string, unknown> | undefined)?.email || {}) as Record<string, unknown>;
        const ok = !!row && filters.every(([op, c, v]) => {
          if (c === 'id') return true;
          if (c === 'metadata->email->>claimed_at') return op === 'is' ? email.claimed_at == null : email.claimed_at === v;
          return true;
        });
        if (ok) alerts.set(id, { ...row!, ...pendingUpdate });
        return Promise.resolve({ data: ok ? [{ id }] : [], error: null }).then(resolve);
      }
      if (table === 'messaging_allowances') {
        const cur = eqVal('currency_code');
        return Promise.resolve({ data: opts.allowances.filter(a => eqVal('business_id') === BIZ && (!cur || a.currency_code === cur)), error: null }).then(resolve);
      }
      if (table === 'platform_settings') {
        return Promise.resolve({ data: Object.entries(opts.settings || {}).map(([key, value]) => ({ key, value })), error: null }).then(resolve);
      }
      return Promise.resolve({ data: [], error: null }).then(resolve);
    };
    return chain;
  });
  return { client: { from } as never, alerts, inserts };
}

const topup = (id: string, remaining: number, created = '2026-10-24T07:36:51Z', expires: string | null = null): Allowance =>
  ({ id, currency_code: 'NGN', remaining_minor: remaining, expires_at: expires, created_at: created });

beforeEach(() => {
  sendEmail.mockReset();
  sendEmail.mockResolvedValue({ success: true, id: 'resend-1' });
  resetLowBalanceSettingsCache();
});

describe('levels: 200 / 100 / 50 estimated messages and ₦250', () => {
  const cfg = DEFAULT_LOW_BALANCE_CONFIG;
  it.each([
    [300_000, null],                 // 230 messages left
    [261_300, null],                 // 201 messages
    [260_000, 'messages_200'],       // 200 messages
    [130_000, 'messages_100'],
    [65_000, 'messages_50'],
    [64_999, 'messages_50'],         // 49 messages
    [25_000, 'money_25000'],         // ₦250 (19 messages): money level is the more urgent one
    [900, 'money_25000'],            // TestBiz on 10 Nov: below one message
    [0, 'money_25000'],
  ])('balance %i NGN minor at 1300/message → %s', (balance, key) => {
    expect(reachedLevel(balance, 1300, 'NGN', cfg)?.key ?? null).toBe(key);
  });

  it('a currency without a money threshold uses only message levels', () => {
    expect(reachedLevel(40, 1, 'USD', cfg)?.key).toBe('messages_50');
    expect(reachedLevel(500, 1, 'USD', cfg)).toBeNull();
  });

  it('no per-message price: only the money level applies', () => {
    expect(reachedLevel(900, null, 'NGN', cfg)?.key).toBe('money_25000');
    expect(reachedLevel(900, null, 'GHS', cfg)).toBeNull();
  });
});

describe('configuration (platform_settings messaging_low_balance_alerts)', () => {
  it('uses an admin value when well formed', () => {
    expect(parseLowBalanceConfig({ message_thresholds: [500, 20], money_thresholds_minor: { NGN: 50000, GHS: 500 } }))
      .toEqual({ message_thresholds: [500, 20], money_thresholds_minor: { NGN: 50000, GHS: 500 } });
  });
  it('falls back to 200/100/50 and ₦250 for missing or malformed parts', () => {
    expect(parseLowBalanceConfig(undefined)).toEqual(DEFAULT_LOW_BALANCE_CONFIG);
    expect(parseLowBalanceConfig({ message_thresholds: [-1, 'x'], money_thresholds_minor: { NGN: 0 } })).toEqual(DEFAULT_LOW_BALANCE_CONFIG);
  });
  it('an admin threshold is used by the check', async () => {
    const d = db({ allowances: [topup('a1', 600_000)], settings: { messaging_low_balance_alerts: { message_thresholds: [500], money_thresholds_minor: {} } } });
    await checkLowBalanceAlerts(d.client, BIZ, NOW);
    expect([...d.alerts.values()][0]).toMatchObject({ metadata: expect.objectContaining({ level: 'messages_500' }) });
  });
});

describe('checkLowBalanceAlerts', () => {
  it('TestBiz (900 left at 1300/message): one dashboard alert and one owner email, outcome recorded as accepted, not delivered', async () => {
    const d = db({ allowances: [topup('66715744', 900)] });
    await checkLowBalanceAlerts(d.client, BIZ, NOW);
    const rows = [...d.alerts.values()];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: lowBalanceAlertId(BIZ, 'NGN', '66715744', 'money_25000'),
      business_id: BIZ, type: LOW_BALANCE_ALERT_TYPE, severity: 'critical', is_read: false,
      metadata: expect.objectContaining({ balance_minor: 900, cost_per_message_minor: 1300, estimated_messages: 0, level: 'money_25000' }),
    });
    expect(rows[0].message).toContain('about 0 messages');
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0]).toMatchObject({ to: 'owner@example.com' });
    expect(sendEmail.mock.calls[0][0].html).toContain('TestBiz &lt;b&gt;');
    expect((rows[0].metadata as Record<string, unknown>).email).toMatchObject({ status: 'provider_accepted', provider_id: 'resend-1' });
    expect(JSON.stringify(rows[0])).not.toMatch(/deliver/i);
  });

  it('deduplicates: later sends at the same level raise nothing and email nobody', async () => {
    const d = db({ allowances: [topup('a1', 900)] });
    await checkLowBalanceAlerts(d.client, BIZ, NOW);
    await checkLowBalanceAlerts(d.client, BIZ, NOW);
    await checkLowBalanceAlerts(d.client, BIZ, NOW);
    expect(d.alerts.size).toBe(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it('two sends at once: the database refuses the second copy (23505) and only the winner emails', async () => {
    const d = db({ allowances: [topup('a1', 900)], raceInsert: true });
    await checkLowBalanceAlerts(d.client, BIZ, NOW);
    expect(d.inserts.filter(r => r.type === LOW_BALANCE_ALERT_TYPE)).toHaveLength(1);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('balance falling through the levels raises each new level once', async () => {
    const allowance = topup('a1', 260_000);
    const d = db({ allowances: [allowance] });
    for (const left of [260_000, 200_000, 130_000, 100_000, 65_000, 25_000, 900]) {
      allowance.remaining_minor = left;
      await checkLowBalanceAlerts(d.client, BIZ, NOW);
    }
    expect([...d.alerts.values()].map(a => (a.metadata as Record<string, unknown>).level))
      .toEqual(['messages_200', 'messages_100', 'messages_50', 'money_25000']);
    expect(sendEmail).toHaveBeenCalledTimes(4);
  });

  it('a big drop sends only the most urgent level, and the skipped levels are not sent later', async () => {
    const allowance = topup('a1', 900);
    const d = db({ allowances: [allowance] });
    await checkLowBalanceAlerts(d.client, BIZ, NOW);
    allowance.remaining_minor = 800;
    await checkLowBalanceAlerts(d.client, BIZ, NOW);
    expect(d.alerts.size).toBe(1);
  });

  it('a top-up resets: after new credit runs low again, the levels alert again', async () => {
    const allowances = [topup('a1', 900)];
    const d = db({ allowances });
    await checkLowBalanceAlerts(d.client, BIZ, NOW);
    allowances.push(topup('a2', 1_500_000, '2026-11-11T09:00:00Z'));
    await checkLowBalanceAlerts(d.client, BIZ, NOW); // topped up: above every level
    expect(d.alerts.size).toBe(1);
    allowances[1].remaining_minor = 20_000;
    await checkLowBalanceAlerts(d.client, BIZ, NOW);
    expect(d.alerts.size).toBe(2);
    expect([...d.alerts.keys()][1]).toBe(lowBalanceAlertId(BIZ, 'NGN', 'a2', 'money_25000'));
  });

  it('expired allowances do not count toward the balance', async () => {
    const d = db({ allowances: [topup('a1', 900), topup('old', 5_000_000, '2026-09-01T00:00:00Z', '2026-10-01T00:00:00Z')] });
    await checkLowBalanceAlerts(d.client, BIZ, NOW);
    expect([...d.alerts.values()][0]).toMatchObject({ metadata: expect.objectContaining({ balance_minor: 900 }) });
  });

  it('a healthy balance raises nothing', async () => {
    const d = db({ allowances: [topup('a1', 1_500_000)] });
    await checkLowBalanceAlerts(d.client, BIZ, NOW);
    expect(d.alerts.size).toBe(0);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('a business that never had messaging credit is not alerted', async () => {
    const d = db({ allowances: [] });
    await checkLowBalanceAlerts(d.client, BIZ, NOW);
    expect(d.inserts).toHaveLength(0);
  });

  it.each([
    ['no owner email', { ownerEmail: null }, undefined, { status: 'not_sent', reason: 'no_owner_email' }],
    ['email not configured (dev)', {}, { success: true, dev: true }, { status: 'not_sent', reason: 'email_not_configured' }],
    ['provider refused', {}, { success: false, error: 'x' }, { status: 'failed' }],
  ])('email outcome is recorded honestly: %s', async (_n, extra, result, expected) => {
    if (result) sendEmail.mockResolvedValue(result);
    const d = db({ allowances: [topup('a1', 900)], ...extra });
    await checkLowBalanceAlerts(d.client, BIZ, NOW);
    const row = [...d.alerts.values()][0];
    expect((row.metadata as Record<string, unknown>).email).toMatchObject(expected);
  });

  it('a thrown email error is recorded as failed and the alert stays', async () => {
    sendEmail.mockRejectedValue(new Error('network'));
    const d = db({ allowances: [topup('a1', 900)] });
    await checkLowBalanceAlerts(d.client, BIZ, NOW);
    expect([...d.alerts.values()][0].metadata).toMatchObject({ email: expect.objectContaining({ status: 'failed' }) });
  });

  it('never throws (settings unreadable): no alert, no email', async () => {
    const d = db({ allowances: [topup('a1', 900)], settingsError: true });
    await expect(checkLowBalanceAlerts(d.client, BIZ, NOW)).resolves.toBeUndefined();
    expect(d.alerts.size).toBe(0);
  });
});

describe('follows billing (check_or_authorize_send / authorize_message_send)', () => {
  it.each([
    ['gate off', { messaging_financial_gate: false }],
    ['gate key absent', { messaging_financial_gate: undefined }],
  ])('%s: balances are not enforced, so no alert', async (_n, snapshot) => {
    const d = db({ allowances: [topup('a1', 900)], snapshot });
    await checkLowBalanceAlerts(d.client, BIZ, NOW);
    expect(d.alerts.size).toBe(0);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('uses the billing config snapshot, not the live settings price', async () => {
    // Settings say 1300; the effective config version says 2100 (as older staging versions did)
    const d = db({
      allowances: [topup('a1', 200 * 2100)],
      settings: { messaging_pricing: NGN_PRICING },
      snapshot: { messaging_pricing: { NGN: { rates: { NG: { '*': 2100 } }, default_cost_minor: 2100 } } },
    });
    await checkLowBalanceAlerts(d.client, BIZ, NOW);
    expect([...d.alerts.values()][0].metadata).toMatchObject({ level: 'messages_200', cost_per_message_minor: 2100, estimated_messages: 200 });
  });

  it('rate is rates[country].service, then rates[country]["*"], then default_cost_minor', async () => {
    const { billingCurrencyAndRate } = await import('@/lib/messaging/low-balance-alerts');
    expect(billingCurrencyAndRate({ NGN: { rates: { NG: { service: 900, '*': 1300 } }, default_cost_minor: 1500 } }, 'NG')).toEqual({ currency: 'NGN', cost: 900 });
    expect(billingCurrencyAndRate({ NGN: { rates: { NG: { '*': 1300 } }, default_cost_minor: 1500 } }, 'NG')).toEqual({ currency: 'NGN', cost: 1300 });
    expect(billingCurrencyAndRate({ NGN: { rates: { NG: {} }, default_cost_minor: 1500 } }, 'NG')).toEqual({ currency: 'NGN', cost: 1500 });
    expect(billingCurrencyAndRate({ NGN: { rates: { NG: {} } } }, 'NG')).toEqual({ currency: 'NGN', cost: null });
  });

  it('no currency, or two currencies, for the business country: no alert (billing refuses too)', async () => {
    const { billingCurrencyAndRate } = await import('@/lib/messaging/low-balance-alerts');
    expect(billingCurrencyAndRate({ NGN: { rates: { NG: { '*': 1 } } }, USD: { rates: { NG: { '*': 1 } } } }, 'NG')).toBeNull();
    const d = db({ allowances: [topup('a1', 900)], country: 'KE' });
    await checkLowBalanceAlerts(d.client, BIZ, NOW);
    expect(d.alerts.size).toBe(0);
  });

  it('only the business-country currency counts: a leftover allowance in another currency is ignored', async () => {
    const usd = { id: 'usd-old', currency_code: 'USD', remaining_minor: 0, expires_at: null, created_at: '2026-11-01T00:00:00Z' };
    const d = db({ allowances: [topup('a1', 1_500_000), usd] });
    await checkLowBalanceAlerts(d.client, BIZ, NOW);
    expect(d.alerts.size).toBe(0);
  });
});

describe('an email that was never sent is sent again later', () => {
  const later = (min: number) => new Date(NOW.getTime() + min * 60_000);

  /** The function stopped after the alert insert, before the email outcome was written. */
  async function stuckPending() {
    const d = db({ allowances: [topup('a1', 900)] });
    sendEmail.mockImplementationOnce(() => new Promise(() => { /* never settles: function frozen */ }));
    void checkLowBalanceAlerts(d.client, BIZ, NOW);
    await vi.waitFor(() => expect(d.alerts.size).toBe(1));
    sendEmail.mockClear();
    return d;
  }
  const email = (d: ReturnType<typeof db>) => ([...d.alerts.values()][0].metadata as Record<string, unknown>).email as Record<string, unknown>;

  it('not before 10 minutes; after that, sent once and recorded', async () => {
    const d = await stuckPending();
    expect(email(d)).toMatchObject({ status: 'pending', attempts: 1 });
    await checkLowBalanceAlerts(d.client, BIZ, later(5));
    expect(sendEmail).not.toHaveBeenCalled();
    await checkLowBalanceAlerts(d.client, BIZ, later(11));
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(email(d)).toMatchObject({ status: 'provider_accepted', attempts: 2 });
    await checkLowBalanceAlerts(d.client, BIZ, later(30));
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it('a failed email is retried, at most 3 attempts in all', async () => {
    sendEmail.mockResolvedValue({ success: false, error: 'x' });
    const d = db({ allowances: [topup('a1', 900)] });
    for (const m of [0, 11, 22, 33, 44]) await checkLowBalanceAlerts(d.client, BIZ, later(m));
    expect(sendEmail).toHaveBeenCalledTimes(3);
    expect(email(d)).toMatchObject({ status: 'failed', attempts: 3 });
  });

  it('"not sent" (no owner email) is not retried', async () => {
    const d = db({ allowances: [topup('a1', 900)], ownerEmail: null });
    await checkLowBalanceAlerts(d.client, BIZ, NOW);
    await checkLowBalanceAlerts(d.client, BIZ, later(20));
    expect(email(d)).toMatchObject({ status: 'not_sent', attempts: 1 });
  });

  it('two checks retrying at once: only the one that claims the row sends', async () => {
    const d = await stuckPending();
    await Promise.all([checkLowBalanceAlerts(d.client, BIZ, later(11)), checkLowBalanceAlerts(d.client, BIZ, later(11))]);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });
});

describe('alert id', () => {
  it('is a valid UUID and stable for the same business, currency, top-up and level', () => {
    const a = lowBalanceAlertId(BIZ, 'NGN', 'a1', 'messages_50');
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(lowBalanceAlertId(BIZ, 'NGN', 'a1', 'messages_50')).toBe(a);
    expect(lowBalanceAlertId(BIZ, 'NGN', 'a2', 'messages_50')).not.toBe(a);
    expect(lowBalanceAlertId(BIZ, 'GHS', 'a1', 'messages_50')).not.toBe(a);
    expect(lowBalanceAlertId('other', 'NGN', 'a1', 'messages_50')).not.toBe(a);
  });
});
