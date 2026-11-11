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
}) {
  const alerts = new Map<string, Record<string, unknown>>();
  const inserts: Array<Record<string, unknown>> = [];
  const from = vi.fn((table: string) => {
    const filters: Array<[string, string, unknown]> = [];
    let pendingUpdate: Record<string, unknown> | null = null;
    const chain: Record<string, unknown> = {};
    chain.select = vi.fn(() => chain);
    chain.eq = vi.fn((c: string, v: unknown) => { filters.push(['eq', c, v]); return chain; });
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
      if (table === 'alerts') return { data: alerts.has(eqVal('id') as string) ? { id: eqVal('id') } : null, error: null };
      if (table === 'businesses') return { data: { name: 'TestBiz <b>', profiles: { email: opts.ownerEmail === undefined ? 'owner@example.com' : opts.ownerEmail } }, error: null };
      return { data: null, error: null };
    });
    chain.then = (resolve: (v: unknown) => unknown) => {
      if (pendingUpdate && table === 'alerts') {
        const id = eqVal('id') as string;
        if (alerts.has(id)) alerts.set(id, { ...alerts.get(id)!, ...pendingUpdate });
        return Promise.resolve({ error: null }).then(resolve);
      }
      if (table === 'messaging_allowances') {
        return Promise.resolve({ data: opts.allowances.filter(a => eqVal('business_id') === BIZ && a), error: null }).then(resolve);
      }
      if (table === 'platform_settings') {
        if (opts.settingsError) return Promise.resolve({ data: null, error: { message: 'down' } }).then(resolve);
        const s = { messaging_pricing: NGN_PRICING, ...(opts.settings || {}) };
        return Promise.resolve({ data: Object.entries(s).map(([key, value]) => ({ key, value })), error: null }).then(resolve);
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
