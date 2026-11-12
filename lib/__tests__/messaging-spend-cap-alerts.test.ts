/**
 * #992: merchant spend-cap alerts (50/75/90/100%) — Owner decisions 2026-11-12.
 *
 * Runs the real checkSpendThresholds (bot path) and the real messaging-spend-warnings cron
 * route against an in-memory database that enforces what PostgreSQL enforces for these
 * calls: the alerts primary key and the messaging_spend_threshold_alerts unique key
 * (business, currency, period, level) both refuse a duplicate with 23505. Email is mocked at
 * the Resend boundary (lib/email/client sendEmail).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const sendEmail = vi.fn();
vi.mock('@/lib/email/client', () => ({ sendEmail: (...a: unknown[]) => sendEmail(...a) }));
const createServiceClient = vi.fn();
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => createServiceClient() }));

import {
  checkSpendCapPeriod, reachedSpendLevels, spendCapAlertId, spendCapAlertText,
  resetSpendCapConfigCache, SPEND_CAP_ALERT_TYPE, type SpendPeriod,
} from '@/lib/messaging/spend-cap-alerts';
import { checkSpendThresholds } from '@/lib/bot/conversation-guard';
import { GET as cronGET } from '@/app/api/cron/messaging-spend-warnings/route';

const BIZ = 'b47d9058-78bc-40a8-90ac-bd9667713710';
const BIZ2 = '4ca1b911-17f8-4b53-9036-4d992f2e4c25';
const monthStart = () => { const d = new Date(); d.setUTCDate(1); d.setUTCHours(0, 0, 0, 0); return d; };
// PostgREST returns timestamptz like this, not with ".000Z"
const PERIOD = monthStart().toISOString().replace('.000Z', '+00:00');
// Staging config 2026-11-07
const PRICING = {
  NGN: { rates: { NG: { '*': 1300, utility: 1300, marketing: 10000 } }, default_cost_minor: 1300, default_spend_cap_minor: 7500000 },
  GBP: { rates: { GB: { '*': 3 } }, default_cost_minor: 3, default_spend_cap_minor: 4000 },
};

type Row = Record<string, unknown>;
type PeriodRow = SpendPeriod & { business_id: string };

function makeDb(opts: {
  periods: PeriodRow[];
  gate?: boolean;
  countries?: Record<string, string>;
  ownerEmail?: string | null;
  failAlertInsert?: boolean;
}) {
  const alerts = new Map<string, Row>();
  const audit = new Map<string, Row>();
  const auditKey = (r: Row) => `${r.business_id}|${r.currency_code}|${new Date(r.period_start as string).toISOString()}|${r.threshold_pct}`;

  const from = vi.fn((table: string) => {
    const filters: Array<[string, string, unknown]> = [];
    let op: 'select' | 'insert' | 'update' = 'select';
    let payload: Row | null = null;
    const chain: Record<string, unknown> = {};
    for (const m of ['order', 'limit', 'lte']) chain[m] = vi.fn(() => chain);
    for (const m of ['eq', 'is', 'gte', 'gt', 'in']) {
      chain[m] = vi.fn((c: string, v: unknown) => { filters.push([m, c, v]); return chain; });
    }
    chain.select = vi.fn(() => chain);
    chain.update = vi.fn((row: Row) => { op = 'update'; payload = row; return chain; });
    chain.insert = vi.fn((row: Row) => { op = 'insert'; payload = row; return chain; });
    const eqVal = (c: string) => filters.find(f => f[0] === 'eq' && f[1] === c)?.[2];

    const run = (): { data: unknown; error: unknown } => {
      if (op === 'insert') {
        const row = payload!;
        if (table === 'alerts') {
          if (opts.failAlertInsert) return { data: null, error: { code: '57014', message: 'canceling statement' } };
          if (alerts.has(row.id as string)) return { data: null, error: { code: '23505', message: 'duplicate key' } };
          alerts.set(row.id as string, { ...row, is_read: false });
          return { data: null, error: null };
        }
        if (table === 'messaging_spend_threshold_alerts') {
          if (audit.has(auditKey(row))) return { data: null, error: { code: '23505', message: 'duplicate key' } };
          audit.set(auditKey(row), row);
          return { data: null, error: null };
        }
        return { data: null, error: { message: `unexpected insert into ${table}` } };
      }
      if (op === 'update' && table === 'alerts') {
        const row = alerts.get(eqVal('id') as string);
        const email = ((row?.metadata as Row | undefined)?.email || {}) as Row;
        const ok = !!row && filters.every(([m, c, v]) => {
          if (c !== 'metadata->email->>claimed_at') return true;
          return m === 'is' ? email.claimed_at == null : email.claimed_at === v;
        });
        if (ok) Object.assign(row!, payload);
        return { data: ok ? [{ id: row!.id }] : [], error: null };
      }
      if (table === 'alerts') {
        const ids = (filters.find(f => f[0] === 'in' && f[1] === 'id')?.[2] || []) as string[];
        return { data: ids.filter(i => alerts.has(i)).map(i => ({ id: i, metadata: alerts.get(i)!.metadata })), error: null };
      }
      if (table === 'messaging_spend_periods') {
        let rows = opts.periods;
        const biz = eqVal('business_id');
        if (biz) rows = rows.filter(r => r.business_id === biz);
        const ps = eqVal('period_start');
        if (ps) rows = rows.filter(r => new Date(r.period_start).getTime() === new Date(ps as string).getTime());
        return { data: rows.map(r => ({ ...r })), error: null };
      }
      return { data: null, error: null };
    };

    chain.maybeSingle = vi.fn(async () => {
      if (table === 'alerts') {
        const row = alerts.get(eqVal('id') as string);
        return { data: row ? { id: row.id, metadata: row.metadata } : null, error: null };
      }
      if (table === 'businesses') {
        const id = eqVal('id') as string;
        return { data: {
          country_code: (opts.countries || {})[id] ?? 'NG', name: 'TestBiz <b>',
          profiles: { email: opts.ownerEmail === undefined ? 'owner@example.com' : opts.ownerEmail },
        }, error: null };
      }
      if (table === 'platform_config_versions') {
        return { data: { config_snapshot: { messaging_financial_gate: opts.gate ?? true, messaging_pricing: PRICING } }, error: null };
      }
      return { data: null, error: null };
    });
    chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(run()).then(resolve, reject);
    return chain;
  });
  return { client: { from } as never, alerts, audit, from };
}

const ngn = (used: number, extra: Partial<PeriodRow> = {}): PeriodRow => ({
  business_id: BIZ, currency_code: 'NGN', period_start: PERIOD, cap_minor: 7500000, reserved_minor: 0, spent_minor: used, ...extra,
});
const spendAlerts = (d: ReturnType<typeof makeDb>) => [...d.alerts.values()].filter(a => a.type === SPEND_CAP_ALERT_TYPE);

beforeEach(() => {
  vi.clearAllMocks();
  resetSpendCapConfigCache();
  sendEmail.mockResolvedValue({ success: true, id: 'resend-1' });
});

describe('#992 levels', () => {
  it('room-based 100%: NGN stops at 7,499,700 of 7,500,000 (rate 1,300) and that counts as reached', () => {
    expect(reachedSpendLevels(ngn(7499700), 1300)).toEqual([50, 75, 90, 100]);
    expect(reachedSpendLevels(ngn(7499700), null)).toEqual([50, 75, 90]);
    expect(reachedSpendLevels(ngn(7498700), 1300)).toEqual([50, 75, 90]); // 1,300 left: one more reply fits
  });
  it('exact edges, reserved counts, no cap → nothing', () => {
    expect(reachedSpendLevels(ngn(3749999), 1300)).toEqual([]);
    expect(reachedSpendLevels(ngn(3750000), 1300)).toEqual([50]);
    expect(reachedSpendLevels(ngn(3000000, { reserved_minor: 3000000 }), 1300)).toEqual([50, 75]);
    expect(reachedSpendLevels(ngn(10, { cap_minor: 0 }), 1300)).toEqual([]);
  });
});

describe('#992 Owner-approved text', () => {
  it('75%: amounts as currency, reset date, warning', () => {
    const t = spendCapAlertText({ ...ngn(5625000), period_start: '2026-11-01T00:00:00+00:00' }, 75);
    expect(t).toEqual({
      severity: 'warning',
      title: 'Monthly messaging limit: 75% used',
      message: 'Your business has used 75% of its monthly WhatsApp messaging limit (₦56,250 of ₦75,000). '
        + 'If the limit is reached, bot replies to customers pause until it resets on 1 December.',
    });
  });
  it('100%: reached text, critical, December period resets on 1 January', () => {
    const t = spendCapAlertText({ ...ngn(7499700), period_start: '2026-12-01T00:00:00+00:00' }, 100);
    expect(t).toEqual({
      severity: 'critical',
      title: 'Monthly messaging limit reached',
      message: 'Your business has reached its monthly WhatsApp messaging limit of ₦75,000. '
        + 'Bot replies to customers are paused until the limit resets on 1 January. '
        + 'Topping up your balance does not raise this limit. Contact Waaiio support if you have questions.',
    });
  });
  it('90% is critical; fractional amounts keep pence; never shows minor units', () => {
    const t = spendCapAlertText({ business_id: BIZ2, currency_code: 'GBP', period_start: PERIOD, cap_minor: 4000, reserved_minor: 0, spent_minor: 3601 } as PeriodRow, 90);
    expect(t.severity).toBe('critical');
    expect(t.message).toContain('(£36.01 of £40)');
    expect(t.message).not.toMatch(/minor/);
  });
});

describe('#992 bot path: checkSpendThresholds', () => {
  it('A1: at 50% creates one alert + one audit row; a second check creates nothing', async () => {
    const d = makeDb({ periods: [ngn(3750000)] });
    await checkSpendThresholds(d.client, BIZ);
    await checkSpendThresholds(d.client, BIZ);
    const a = spendAlerts(d);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({
      id: spendCapAlertId(BIZ, 'NGN', PERIOD, 50), business_id: BIZ, severity: 'warning',
      title: 'Monthly messaging limit: 50% used',
    });
    expect([...d.audit.values()].map(r => r.threshold_pct)).toEqual([50]);
    expect(d.audit.values().next().value).toMatchObject({ utilization_at_alert: 50, cap_minor: 7500000, spent_minor: 3750000 });
    expect(sendEmail).not.toHaveBeenCalled(); // email only at 90% and 100%
  });

  it('A2: an audit row without its alert (old code / stopped process) gets the alert', async () => {
    const d = makeDb({ periods: [ngn(5700000)] });
    d.audit.set(`${BIZ}|NGN|${new Date(PERIOD).toISOString()}|50`, { threshold_pct: 50 });
    d.audit.set(`${BIZ}|NGN|${new Date(PERIOD).toISOString()}|75`, { threshold_pct: 75 });
    await checkSpendThresholds(d.client, BIZ);
    expect(spendAlerts(d).map(a => a.id)).toEqual([spendCapAlertId(BIZ, 'NGN', PERIOD, 75)]);
  });

  it('A4: NGN at 7,499,700 raises the 100% alert and emails the owner', async () => {
    const d = makeDb({ periods: [ngn(7499700)] });
    await checkSpendThresholds(d.client, BIZ);
    const [a] = spendAlerts(d);
    expect(a).toMatchObject({ id: spendCapAlertId(BIZ, 'NGN', PERIOD, 100), title: 'Monthly messaging limit reached', severity: 'critical' });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const mail = sendEmail.mock.calls[0][0];
    expect(mail.to).toBe('owner@example.com');
    expect(mail.subject).toBe('Monthly messaging limit reached — TestBiz <b>');
    expect(mail.html).toContain('Topping up your balance does not raise this limit.');
    expect(mail.html).toContain('/dashboard/billing">View your messaging usage</a>');
    expect((a.metadata as Row).email).toMatchObject({ status: 'provider_accepted', provider_id: 'resend-1', attempts: 1 });
  });

  it('A5b: usage going down (a reservation released) never raises a lower level after a higher one', async () => {
    const periods = [ngn(7499700)];
    const d = makeDb({ periods });
    await checkSpendThresholds(d.client, BIZ); // limit reached
    periods[0].spent_minor = 7000000; // room again: highest reached is now 90
    await checkSpendThresholds(d.client, BIZ);
    periods[0].spent_minor = 6000000; // now 75
    await checkSpendThresholds(d.client, BIZ);
    expect(spendAlerts(d).map(a => (a.metadata as Row).threshold_pct)).toEqual([100]);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it('A5: a jump from 0 to 95% alerts only 90%; all reached levels are audited; 50/75 never sent later', async () => {
    const periods = [ngn(7125000)];
    const d = makeDb({ periods });
    await checkSpendThresholds(d.client, BIZ);
    expect(spendAlerts(d).map(a => a.title)).toEqual(['Monthly messaging limit: 95% used']);
    expect(spendAlerts(d)[0].id).toBe(spendCapAlertId(BIZ, 'NGN', PERIOD, 90));
    expect([...d.audit.values()].map(r => r.threshold_pct).sort()).toEqual([50, 75, 90]);
    // Later usage reaches the cap: only the 100% alert is added
    periods[0].spent_minor = 7499700;
    await checkSpendThresholds(d.client, BIZ);
    expect(spendAlerts(d).map(a => (a.metadata as Row).threshold_pct)).toEqual([90, 100]);
    expect(sendEmail).toHaveBeenCalledTimes(2);
  });

  it('A7: database errors never reach the caller; a failed alert insert writes no audit row', async () => {
    const d = makeDb({ periods: [ngn(7000000)], failAlertInsert: true });
    await expect(checkSpendThresholds(d.client, BIZ)).resolves.toBeUndefined();
    expect(d.audit.size).toBe(0);
    // Next check (insert works again) still raises it, because no audit row hid it
    const d2 = makeDb({ periods: [ngn(7000000)] });
    await checkSpendThresholds(d2.client, BIZ);
    expect(spendAlerts(d2)).toHaveLength(1);
    const broken = { from: vi.fn(() => { throw new Error('DB down'); }) } as never;
    await expect(checkSpendThresholds(broken, BIZ)).resolves.toBeUndefined();
  });

  it('A8: below 50%, no period, or financial gate off → nothing written, no config read below 50%', async () => {
    const low = makeDb({ periods: [ngn(3749999)] });
    await checkSpendThresholds(low.client, BIZ);
    expect(low.alerts.size + low.audit.size).toBe(0);
    expect(low.from.mock.calls.map(c => c[0])).toEqual(['messaging_spend_periods']);

    const none = makeDb({ periods: [] });
    await checkSpendThresholds(none.client, BIZ);
    expect(none.alerts.size + none.audit.size).toBe(0);

    const gateOff = makeDb({ periods: [ngn(7499700)], gate: false });
    await checkSpendThresholds(gateOff.client, BIZ);
    expect(gateOff.alerts.size + gateOff.audit.size).toBe(0);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('email: no owner email is recorded as not_sent; a failed email is retried after 10 minutes, at most 3 times', async () => {
    const noMail = makeDb({ periods: [ngn(7000000)], ownerEmail: null });
    await checkSpendThresholds(noMail.client, BIZ);
    expect((spendAlerts(noMail)[0].metadata as Row).email).toMatchObject({ status: 'not_sent', reason: 'no_owner_email' });

    sendEmail.mockResolvedValue({ success: false });
    const d = makeDb({ periods: [ngn(7000000)] });
    const t0 = new Date('2026-11-12T10:00:00Z');
    const p = ngn(7000000);
    await checkSpendCapPeriod(d.client, BIZ, p, t0);
    await checkSpendCapPeriod(d.client, BIZ, p, new Date(t0.getTime() + 5 * 60_000)); // too soon
    expect(sendEmail).toHaveBeenCalledTimes(1);
    await checkSpendCapPeriod(d.client, BIZ, p, new Date(t0.getTime() + 11 * 60_000));
    await checkSpendCapPeriod(d.client, BIZ, p, new Date(t0.getTime() + 22 * 60_000));
    await checkSpendCapPeriod(d.client, BIZ, p, new Date(t0.getTime() + 33 * 60_000)); // 4th: refused
    expect(sendEmail).toHaveBeenCalledTimes(3);
    expect((spendAlerts(d)[0].metadata as Row).email).toMatchObject({ status: 'failed', attempts: 3 });
    expect(spendAlerts(d)).toHaveLength(1);
  });
});

describe('#992 cron path: messaging-spend-warnings', () => {
  const req = () => new NextRequest('http://localhost/api/cron/messaging-spend-warnings', {
    headers: { authorization: `Bearer ${process.env.CRON_SECRET ?? ''}` },
  });

  it('refuses a request without the cron secret', async () => {
    const prev = process.env.CRON_SECRET;
    process.env.CRON_SECRET = 'test-secret';
    try {
      const res = await cronGET(new NextRequest('http://localhost/api/cron/messaging-spend-warnings'));
      expect(res.status).toBe(401);
      expect(createServiceClient).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = prev;
    }
  });

  it('raises alerts for spend the bot never checked (e.g. broadcasts), one per business', async () => {
    const d = makeDb({
      periods: [ngn(6000000), { business_id: BIZ2, currency_code: 'GBP', period_start: PERIOD, cap_minor: 4000, reserved_minor: 0, spent_minor: 3999 }, ngn(100, { business_id: 'other' })],
      countries: { [BIZ2]: 'GB' },
    });
    createServiceClient.mockReturnValue(d.client);
    const res = await cronGET(req());
    expect(await res.json()).toEqual({ status: 'ok', periodsScanned: 3, alertsCreated: 2 });
    const a = spendAlerts(d);
    expect(a.map(x => x.id).sort()).toEqual([
      spendCapAlertId(BIZ, 'NGN', PERIOD, 75), spendCapAlertId(BIZ2, 'GBP', PERIOD, 100), // GBP 3,999/4,000, rate 3
    ].sort());
  });

  it('A3: bot check and cron on the same period → one alert per level, none skipped', async () => {
    const d = makeDb({ periods: [ngn(5700000)] });
    createServiceClient.mockReturnValue(d.client);
    await checkSpendThresholds(d.client, BIZ); // bot first
    const res = await cronGET(req());
    expect(await res.json()).toMatchObject({ alertsCreated: 0 });
    expect(spendAlerts(d)).toHaveLength(1);

    // Cron first, then two concurrent bot checks
    const d2 = makeDb({ periods: [ngn(6800000)] });
    createServiceClient.mockReturnValue(d2.client);
    await cronGET(req());
    await Promise.all([checkSpendThresholds(d2.client, BIZ), checkSpendThresholds(d2.client, BIZ)]);
    expect(spendAlerts(d2).map(a => a.id)).toEqual([spendCapAlertId(BIZ, 'NGN', PERIOD, 90)]);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });
});
