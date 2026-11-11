/**
 * Route-handler tests for merchant-local payout period integration.
 *
 * Tests actual POST (manual generate) and GET (cron auto-payout) handlers
 * with mocked DB/provider boundaries. These are NOT real DB/RLS/Bearer tests.
 *
 * Fixed clock: 2026-11-02T00:30:00Z
 *   Africa/Lagos (UTC+1): Mon 2026-11-02 01:30 → completed week Oct 26–Nov 1
 *   Pacific/Pago_Pago (UTC-11): Sat 2026-11-01 13:30 → completed week Oct 19–Oct 25
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The first test in each block imports a payout route cold (~3 s locally); under
// parallel CI load that can pass the 5 s default and fail at random (review r2-796 P2-3).
vi.setConfig({ testTimeout: 30_000 });
import { NextRequest } from 'next/server';

// ── Fixed clock ──
const FIXED_NOW = new Date('2026-11-02T00:30:00.000Z');
// Lagos (UTC+1): local Mon 2026-11-02 01:30 → preceding completed Mon Oct 26 – Sun Nov 1
const LAGOS_START = '2026-10-26';
const LAGOS_END = '2026-11-01';
const LAGOS_Q_START = '2026-10-25T23:00:00.000Z'; // Mon 00:00 WAT = Sun 23:00 UTC
const LAGOS_Q_END = '2026-11-01T23:00:00.000Z';   // next Mon 00:00 WAT
// Pago Pago (UTC-11): local Sat 2026-11-01 13:30 → preceding completed Mon Oct 19 – Sun Oct 25
const PAGO_START = '2026-10-19';
const PAGO_END = '2026-10-25';
const PAGO_Q_START = '2026-10-19T11:00:00.000Z'; // Mon 00:00 SST = Mon 11:00 UTC
const PAGO_Q_END = '2026-10-26T11:00:00.000Z';
const LAGOS_RECENT_FROM = '2025-10-20'; // LAGOS_START - 53 weeks (M521 payout-history read)
const PAGO_RECENT_FROM = '2025-10-13';  // PAGO_START - 53 weeks

// ── Shared mock infrastructure ──

let mockFromImpl: (table: string) => Record<string, unknown>;
const mockLoggerError = vi.fn();
const mockLoggerWarn = vi.fn();

function chainMock() {
  const chain: Record<string, unknown> = {};
  const methods = ['select', 'eq', 'neq', 'in', 'is', 'gte', 'lte', 'lt', 'order', 'range', 'insert', 'update', 'contains', 'limit'];
  for (const m of methods) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }
  chain.single = vi.fn().mockResolvedValue({ data: null, error: null });
  chain.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
  return chain;
}

function makePostRequest(url: string, body: Record<string, unknown>) {
  return new NextRequest(new URL(url, 'http://localhost:3000'), {
    method: 'POST', body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer test-token' },
  });
}

function makeGetRequest(url: string) {
  return new NextRequest(new URL(url, 'http://localhost:3000'), {
    method: 'GET', headers: { 'Authorization': 'Bearer cron-secret' },
  });
}

// ═══════════════════════════════════════════════════════════════
// Manual generate route
// ═══════════════════════════════════════════════════════════════

describe('payouts/generate: merchant-local period', () => {
  let generateModule: typeof import('@/app/api/admin/payouts/generate/route');

  beforeEach(async () => {
    vi.clearAllMocks(); mockLoggerError.mockClear(); mockLoggerWarn.mockClear();
    vi.resetModules();
    vi.useFakeTimers({ now: FIXED_NOW, toFake: ['Date'] });

    vi.doMock('@/lib/admin-auth', () => ({ requirePlatformAdmin: vi.fn().mockResolvedValue({ id: 'admin-1', userId: 'admin-1', email: 'a@t.com', role: 'admin', aal: 'aal2', bearerToken: 'b' }) }));
    vi.doMock('@/lib/admin-audit', () => ({ logAdminAudit: vi.fn().mockResolvedValue(undefined) }));
    vi.doMock('@/lib/admin-step-up', () => ({ consumeStepUp: vi.fn().mockResolvedValue(true), StepUpError: class extends Error { constructor(m: string) { super(m); } } }));
    vi.doMock('@/lib/countries', () => ({ loadCountries: vi.fn() }));
    vi.doMock('@/lib/constants', () => ({ getCurrencyCode: vi.fn((cc: string) => { const m: Record<string,string> = { NG:'NGN', US:'USD' }; if (m[cc]) return m[cc]; throw new Error('unknown'); }), CountryCode: {}, VerificationLevel: {} }));
    vi.doMock('@/lib/platformSettings', () => ({ loadPlatformSettings: vi.fn().mockResolvedValue({ payout_cooling_period_days: 7, fraud_velocity_threshold: 50, minimum_payout: { NG: 100 } }) }));
    vi.doMock('@/lib/logger', () => ({ logger: { error: mockLoggerError, warn: mockLoggerWarn, info: vi.fn(), debug: vi.fn(), withContext: vi.fn(() => ({ error: mockLoggerError, warn: mockLoggerWarn, info: vi.fn(), debug: vi.fn() })) }, safeLogErrorContext: vi.fn(() => ({})) }));
    vi.doMock('@/lib/errors', () => ({ safeLogErrorContext: vi.fn(() => ({})) }));
  });

  afterEach(() => { vi.useRealTimers(); });

  it('invalid timezone: HTTP 207 with failed>0, no INSERT', async () => {
    let insertCalled = false;
    mockFromImpl = (table: string) => {
      const c = chainMock();
      if (table === 'businesses') { c.eq = vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ data: [{ id: 'b1', created_at: '2025-01-01', verification_level: 'basic', payout_limit_monthly: 500000, country_code: 'NG', timezone: 'Invalid/Zone' }], error: null }) }); }
      else if (table === 'business_payouts') { c.insert = vi.fn().mockImplementation(() => { insertCalled = true; return c; }); }
      return c;
    };
    vi.doMock('@/lib/supabase/service', () => ({ createServiceClient: vi.fn(() => ({ from: (t: string) => mockFromImpl(t), rpc: vi.fn().mockImplementation((name: string) => Promise.resolve({
          data: name === 'tax_refund_payout_currencies_980' ? [] : name === 'tax_refund_payout_projection_980' ? { affected: false } : null, error: null,
        })) })) }));
    generateModule = await import('@/app/api/admin/payouts/generate/route');
    const res = await generateModule.POST(makePostRequest('/api/admin/payouts/generate', { stepUpId: 'su-1' }));
    expect(res.status).toBe(207);
    const body = await res.json();
    expect(body.failed).toBeGreaterThan(0);
    expect(insertCalled).toBe(false);
  });

  it('fee and velocity queries use exact fixed-clock UTC bounds; response correct; insert payload correct', async () => {
    let feesGteArg: string | null = null;
    let feesLtArg: string | null = null;
    let velGteArg: string | null = null;
    let velLtArg: string | null = null;
    let capturedInsert: Record<string, unknown> | null = null;

    mockFromImpl = (table: string) => {
      const c = chainMock();
      if (table === 'businesses') {
        c.eq = vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ data: [{ id: 'b1', created_at: '2025-01-01', verification_level: 'basic', payout_limit_monthly: 500000, country_code: 'NG', timezone: 'Africa/Lagos' }], error: null }) });
      } else if (table === 'platform_fees') {
        c.gte = vi.fn().mockImplementation((_: string, v: string) => { feesGteArg = v; return c; });
        c.lt = vi.fn().mockImplementation((_: string, v: string) => { feesLtArg = v; return Promise.resolve({ data: [{ transaction_amount: 10000, fee_total: 500, gateway_fee: 100, waived: false, is_direct_transfer: false, payments: { currency: 'NGN' } }], error: null }); });
      } else if (table === 'payments') {
        c.gte = vi.fn().mockImplementation((_: string, v: string) => { velGteArg = v; return c; });
        c.lt = vi.fn().mockImplementation((_: string, v: string) => { velLtArg = v; return Promise.resolve({ data: [], error: null }); });
      } else if (table === 'business_payouts') {
        // Dedup + M521 anchor: .select().eq(biz).gte('period_end').limit() → no earlier payouts
        c.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
        c.is = vi.fn().mockReturnValue({ maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }) });
        c.insert = vi.fn().mockImplementation((payload: Record<string, unknown>) => {
          capturedInsert = payload;
          return { select: vi.fn().mockReturnValue({ single: vi.fn().mockResolvedValue({ data: { id: 'p1' }, error: null }) }) };
        });
        c.gte = vi.fn().mockImplementation((column: string) => column === 'period_end'
          ? { limit: vi.fn().mockResolvedValue({ data: [], error: null }) }
          : Promise.resolve({ data: [], error: null }));
      } else if (table === 'payout_adjustments') {
        c.is = vi.fn().mockResolvedValue({ data: [], error: null });
      } else if (table === 'payout_accounts') {
        c.maybeSingle = vi.fn().mockResolvedValue({ data: { id: 'pa-1' }, error: null });
      }
      return c;
    };
    vi.doMock('@/lib/supabase/service', () => ({ createServiceClient: vi.fn(() => ({ from: (t: string) => mockFromImpl(t), rpc: vi.fn().mockImplementation((name: string) => Promise.resolve({
          data: name === 'tax_refund_payout_currencies_980' ? [] : name === 'tax_refund_payout_projection_980' ? { affected: false } : null, error: null,
        })) })) }));

    generateModule = await import('@/app/api/admin/payouts/generate/route');
    const res = await generateModule.POST(makePostRequest('/api/admin/payouts/generate', { stepUpId: 'su-1' }));
    const body = await res.json();

    // HTTP response
    expect(res.status).toBe(200);
    expect(body.created).toBe(1);
    expect(body.failed).toBe(0);
    expect(body.held).toBe(0);
    expect(body.period).toEqual({ start: LAGOS_START, end: LAGOS_END });

    // Exact UTC bounds
    expect(feesGteArg).toBe(LAGOS_Q_START);
    expect(feesLtArg).toBe(LAGOS_Q_END);
    expect(velGteArg).toBe(LAGOS_Q_START);
    expect(velLtArg).toBe(LAGOS_Q_END);

    // Insert payload
    expect(capturedInsert).not.toBeNull();
    expect(capturedInsert!.business_id).toBe('b1');
    expect(capturedInsert!.period_start).toBe(LAGOS_START);
    expect(capturedInsert!.period_end).toBe(LAGOS_END);
    // M521: the payout records the exact range it counted
    expect(capturedInsert!.covered_from).toBe(LAGOS_Q_START);
    expect(capturedInsert!.covered_to).toBe(LAGOS_Q_END);
  });

  /** Generate-route mock whose recent-payout read returns `recent`; captures fee bounds and inserts. */
  function mockGenerateWithRecent(recent: unknown[]) {
    const seen = { feesGte: null as string | null, feesLt: null as string | null, velGte: null as string | null, inserts: [] as Record<string, unknown>[] };
    mockFromImpl = (table: string) => {
      const c = chainMock();
      if (table === 'businesses') {
        c.eq = vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ data: [{ id: 'b1', created_at: '2025-01-01', verification_level: 'basic', payout_limit_monthly: 500000, country_code: 'NG', timezone: 'Africa/Lagos' }], error: null }) });
      } else if (table === 'platform_fees') {
        c.gte = vi.fn().mockImplementation((_: string, v: string) => { seen.feesGte = v; return c; });
        c.lt = vi.fn().mockImplementation((_: string, v: string) => { seen.feesLt = v; return Promise.resolve({ data: [{ transaction_amount: 10000, fee_total: 500, gateway_fee: 100, waived: false, is_direct_transfer: false, payments: { currency: 'NGN' } }], error: null }); });
      } else if (table === 'payments') {
        c.gte = vi.fn().mockImplementation((_: string, v: string) => { seen.velGte = v; return c; });
        c.lt = vi.fn().mockResolvedValue({ data: [], error: null });
      } else if (table === 'business_payouts') {
        c.is = vi.fn().mockReturnValue({ maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }) });
        c.insert = vi.fn().mockImplementation((payload: Record<string, unknown>) => {
          seen.inserts.push(payload);
          return { select: vi.fn().mockReturnValue({ single: vi.fn().mockResolvedValue({ data: { id: 'p1' }, error: null }) }) };
        });
        c.gte = vi.fn().mockImplementation((column: string) => column === 'period_end'
          ? { limit: vi.fn().mockResolvedValue({ data: recent, error: null }) }
          : Promise.resolve({ data: [], error: null }));
      } else if (table === 'payout_adjustments') {
        c.is = vi.fn().mockResolvedValue({ data: [], error: null });
      } else if (table === 'payout_accounts') {
        c.maybeSingle = vi.fn().mockResolvedValue({ data: { id: 'pa-1' }, error: null });
      }
      return c;
    };
    vi.doMock('@/lib/supabase/service', () => ({ createServiceClient: vi.fn(() => ({ from: (t: string) => mockFromImpl(t), rpc: vi.fn().mockImplementation((name: string) => Promise.resolve({
          data: name === 'tax_refund_payout_currencies_980' ? [] : name === 'tax_refund_payout_projection_980' ? { affected: false } : null, error: null,
        })) })) }));
    return seen;
  }

  it('M521: after a timezone change, counts from where last week\'s payout ended (no double count)', async () => {
    // Last week (2026-10-19..25) was paid while the business was on Pacific/Pago_Pago:
    // it counted up to Mon 2026-10-26 11:00 UTC, 12h after this Lagos week starts.
    const seen = mockGenerateWithRecent([
      { id: 'prev', currency: 'NGN', period_start: '2026-10-19', period_end: '2026-10-25', covered_from: '2026-10-19T11:00:00.000Z', covered_to: '2026-10-26T11:00:00.000Z' },
    ]);
    generateModule = await import('@/app/api/admin/payouts/generate/route');
    const res = await generateModule.POST(makePostRequest('/api/admin/payouts/generate', { stepUpId: 'su-1' }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.created).toBe(1);
    expect(seen.feesGte).toBe('2026-10-26T11:00:00.000Z');
    expect(seen.feesLt).toBe(LAGOS_Q_END);
    expect(seen.velGte).toBe('2026-10-26T11:00:00.000Z');
    expect(seen.inserts).toHaveLength(1);
    expect(seen.inserts[0].covered_from).toBe('2026-10-26T11:00:00.000Z');
    expect(seen.inserts[0].covered_to).toBe(LAGOS_Q_END);
  });

  it('M521: after a week with no payout, counts from the last recorded end (quiet weeks roll forward)', async () => {
    // Paid through 2026-10-12..18 (ended Sun 2026-10-18 23:00 UTC); 10-19..25 made no payout.
    const seen = mockGenerateWithRecent([
      { id: 'older', currency: 'NGN', period_start: '2026-10-12', period_end: '2026-10-18', covered_from: '2026-10-11T23:00:00.000Z', covered_to: '2026-10-18T23:00:00.000Z' },
    ]);
    generateModule = await import('@/app/api/admin/payouts/generate/route');
    const res = await generateModule.POST(makePostRequest('/api/admin/payouts/generate', { stepUpId: 'su-1' }));
    expect(res.status).toBe(200);
    expect(seen.feesGte).toBe('2026-10-18T23:00:00.000Z');
    expect(seen.feesLt).toBe(LAGOS_Q_END);
    expect(seen.inserts[0].covered_from).toBe('2026-10-18T23:00:00.000Z');
  });

  it('M521: a full payout-history page (API row cap) fails closed: no fee read, no insert', async () => {
    const page = Array.from({ length: 1000 }, (_, i) => ({ id: `h${i}`, currency: 'NGN', period_start: '2026-01-05', period_end: '2026-01-11', covered_from: null, covered_to: null }));
    const seen = mockGenerateWithRecent(page);
    generateModule = await import('@/app/api/admin/payouts/generate/route');
    const res = await generateModule.POST(makePostRequest('/api/admin/payouts/generate', { stepUpId: 'su-1' }));
    const body = await res.json();
    expect(res.status).toBe(207);
    expect(body.failed).toBe(1);
    expect(seen.feesGte).toBeNull();
    expect(seen.inserts).toHaveLength(0);
  });

  it('M521: a range overlapping another recorded payout fails closed (HTTP 207, no insert, no fee read)', async () => {
    const seen = mockGenerateWithRecent([
      { id: 'later', currency: 'NGN', period_start: '2026-11-02', period_end: '2026-11-08', covered_from: '2026-11-01T10:00:00.000Z', covered_to: '2026-11-08T10:00:00.000Z' },
    ]);
    generateModule = await import('@/app/api/admin/payouts/generate/route');
    const res = await generateModule.POST(makePostRequest('/api/admin/payouts/generate', { stepUpId: 'su-1' }));
    const body = await res.json();
    expect(res.status).toBe(207);
    expect(body.failed).toBe(1);
    expect(body.created).toBe(0);
    expect(seen.inserts).toHaveLength(0);
    expect(seen.feesGte).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
// Cron auto-payout route
// ═══════════════════════════════════════════════════════════════

const cronStarted = vi.fn();
const cronCompleted = vi.fn();
const cronFailed = vi.fn();

describe('cron/auto-payout: merchant-local period', () => {
  let cronModule: typeof import('@/app/api/cron/auto-payout/route');

  beforeEach(async () => {
    vi.clearAllMocks(); mockLoggerError.mockClear(); mockLoggerWarn.mockClear();
    vi.resetModules();
    vi.useFakeTimers({ now: FIXED_NOW, toFake: ['Date'] });
    process.env.ENABLE_PAYOUTS = 'true';

    cronStarted.mockClear(); cronCompleted.mockClear(); cronFailed.mockClear();
    vi.doMock('@/lib/cron-auth', () => ({ verifyCronAuth: vi.fn().mockReturnValue(null) }));
    vi.doMock('@/lib/observability/cron', () => ({ createCronLogger: vi.fn(() => ({ started: cronStarted, completed: cronCompleted, failed: cronFailed })) }));
    vi.doMock('@sentry/nextjs', () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));
    vi.doMock('@/lib/countries', () => ({ loadCountries: vi.fn() }));
    vi.doMock('@/lib/constants', () => ({ getCurrencyCode: vi.fn((cc: string) => { const m: Record<string,string> = { NG:'NGN', US:'USD' }; if (m[cc]) return m[cc]; throw new Error('unknown'); }), getPaymentGatewayForCountry: vi.fn(() => 'paystack'), CountryCode: {}, VerificationLevel: {} }));
    vi.doMock('@/lib/platformSettings', () => ({ loadPlatformSettings: vi.fn().mockResolvedValue({ payout_cooling_period_days: 7, fraud_velocity_threshold: 50, minimum_payout: { NG: 100 } }) }));
    vi.doMock('@/lib/logger', () => ({ logger: { error: mockLoggerError, warn: mockLoggerWarn, info: vi.fn(), debug: vi.fn(), withContext: vi.fn(() => ({ error: mockLoggerError, warn: mockLoggerWarn, info: vi.fn(), debug: vi.fn() })) }, safeLogErrorContext: vi.fn(() => ({})) }));
    vi.doMock('@/lib/errors', () => ({ safeLogErrorContext: vi.fn(() => ({})) }));
    vi.doMock('@/lib/email/client', () => ({ sendEmail: vi.fn() }));
    vi.doMock('@/lib/email/templates', () => ({ payoutFailedEmail: vi.fn() }));
    vi.doMock('@/lib/payouts/verification-limit', () => ({ checkVerificationLimit: vi.fn().mockResolvedValue({ allowed: true, limit: 999_999_999, used: 0, remaining: 999_999_999 }) }));
    vi.doMock('@/lib/payouts/auto-payout-decision', () => ({ decideAutoPayoutOutcome: vi.fn(({ holdReasons }: { holdReasons: string[] }) => ({ status: 'held', overLimit: false, flags: holdReasons.map((r: string) => ({ type: 'hold', message: r, severity: 'warning' })), structuredFlags: holdReasons.map((r: string) => ({ type: 'hold', message: r, severity: 'warning' })) })) }));
    vi.doMock('@/lib/payments/payout-classification', () => ({ classifyPaystackError: vi.fn(), isEligiblePaystackAccount: vi.fn().mockReturnValue(false) }));
  });

  afterEach(() => { delete process.env.ENABLE_PAYOUTS; vi.useRealTimers(); });

  it('invalid timezone: HTTP 200, generated=0, error logged', async () => {
    mockFromImpl = (table: string) => {
      const c = chainMock();
      if (table === 'businesses') { c.eq = vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ data: [{ id: 'bad-tz', name: 'BadTZ', created_at: '2025-01-01', country_code: 'NG', verification_level: 'basic', timezone: 'Fake/Zone' }], error: null }) }); }
      else if (table === 'business_payouts') { c.eq = vi.fn().mockResolvedValue({ data: [], error: null }); }
      return c;
    };
    vi.doMock('@/lib/supabase/service', () => ({ createServiceClient: vi.fn(() => ({ from: (t: string) => mockFromImpl(t), rpc: vi.fn().mockImplementation((name: string) => Promise.resolve({
          data: name === 'tax_refund_payout_currencies_980' ? [] : name === 'tax_refund_payout_projection_980' ? { affected: false } : null, error: null,
        })) })) }));
    cronModule = await import('@/app/api/cron/auto-payout/route');
    const res = await cronModule.GET(makeGetRequest('/api/cron/auto-payout'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.generated).toBe(0);
    expect(mockLoggerError.mock.calls.some((a: unknown[]) => typeof a[0] === 'string' && a[0].includes('Invalid timezone'))).toBe(true);
    // Cron lifecycle: started once, completed once (no-valid-timezones exit), never failed
    expect(cronStarted).toHaveBeenCalledTimes(1);
    expect(cronCompleted).toHaveBeenCalledTimes(1);
    expect(cronFailed).toHaveBeenCalledTimes(0);
  });

  it('mixed timezones: exact two periods, no single period field; per-group bounds; held once; dedup', async () => {
    // Track per-group query shapes
    const dedupCalls: { bizIds: string[]; recentFrom: string }[] = [];
    const feeCalls: { bizIds: string[]; gteArg: string; ltArg: string }[] = [];
    const insertPayloads: Record<string, unknown>[] = [];
    let heldQueryCount = 0;
    let heldReleaseCount = 0;
    let bpCallIdx = 0;

    mockFromImpl = (table: string) => {
      const c = chainMock();

      if (table === 'businesses') {
        // First call: main query. Second+: held-release
        if (heldQueryCount === 0 || bpCallIdx < 5) {
          c.eq = vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({
            data: [
              { id: 'lagos-biz', name: 'Lagos', created_at: '2025-01-01', country_code: 'NG', verification_level: 'basic', timezone: 'Africa/Lagos' },
              { id: 'pago-biz', name: 'Pago', created_at: '2025-01-01', country_code: 'NG', verification_level: 'basic', timezone: 'Pacific/Pago_Pago' },
            ], error: null,
          }) });
        } else {
          // Held-release business fetch
          c.limit = vi.fn().mockResolvedValue({ data: [], error: null });
        }
      } else if (table === 'business_payouts') {
        const idx = bpCallIdx++;
        if (idx === 0) {
          // Legacy payouts (period-independent)
          c.limit = vi.fn().mockResolvedValue({ data: [], error: null });
        } else if (idx <= 2) {
          // Per-business dedup + M521 anchor read: .eq(biz).gte('period_end', week start - 53 weeks).limit()
          let capturedBizIds: string[] = [];
          let capturedRecentFrom = '';
          c.eq = vi.fn().mockImplementation((col: string, id: string) => { if (col === 'business_id') capturedBizIds = [id]; return c; });
          c.gte = vi.fn().mockImplementation((_col: string, val: string) => {
            if (_col === 'period_end') capturedRecentFrom = val;
            return c;
          });
          c.limit = vi.fn().mockImplementation(() => {
            dedupCalls.push({ bizIds: capturedBizIds, recentFrom: capturedRecentFrom });
            // Seed: lagos-biz already has an NGN payout (with its recorded range) for its period
            const seeded = capturedBizIds.includes('lagos-biz') && capturedRecentFrom === LAGOS_RECENT_FROM
              ? [{ business_id: 'lagos-biz', currency: 'NGN', period_start: LAGOS_START, period_end: LAGOS_END, covered_from: LAGOS_Q_START, covered_to: LAGOS_Q_END }] : [];
            return Promise.resolve({ data: seeded, error: null });
          });
        } else if (idx <= 4) {
          // INSERT
          c.insert = vi.fn().mockImplementation((payload: Record<string, unknown>) => {
            insertPayloads.push(payload);
            return { select: vi.fn().mockReturnValue({ single: vi.fn().mockResolvedValue({ data: { id: `payout-${payload.business_id}`, net_amount: 1000 }, error: null }) }) };
          });
        } else {
          // Held payouts query — must be reached exactly once
          heldQueryCount++;
          c.eq = vi.fn().mockResolvedValue({ data: [], error: null });
          c.update = vi.fn().mockImplementation(() => { heldReleaseCount++; return { eq: vi.fn().mockResolvedValue({ error: null }) }; });
        }
      } else if (table === 'platform_fees') {
        let capturedBizIds: string[] = [];
        let capturedGte = '';
        let capturedLt = '';
        c.in = vi.fn().mockImplementation((_col: string, ids: string[]) => { capturedBizIds = ids; return c; });
        c.gte = vi.fn().mockImplementation((_col: string, v: string) => { capturedGte = v; return c; });
        c.lt = vi.fn().mockImplementation((_col: string, v: string) => { capturedLt = v; return c; });
        c.limit = vi.fn().mockImplementation(() => {
          feeCalls.push({ bizIds: capturedBizIds, gteArg: capturedGte, ltArg: capturedLt });
          // Lagos group gets NGN+USD fees; Pago group gets NGN fee
          const isLagos = capturedBizIds.includes('lagos-biz') && !capturedBizIds.includes('pago-biz');
          const isPago = capturedBizIds.includes('pago-biz') && !capturedBizIds.includes('lagos-biz');
          if (isLagos) {
            return Promise.resolve({ data: [
              { business_id: 'lagos-biz', created_at: '2026-10-29T12:00:00.000Z', transaction_amount: 10000, fee_total: 500, gateway_fee: 100, waived: false, is_direct_transfer: false, payments: { currency: 'NGN' } },
              { business_id: 'lagos-biz', created_at: '2026-10-29T12:00:00.000Z', transaction_amount: 100, fee_total: 5, gateway_fee: 1, waived: false, is_direct_transfer: false, payments: { currency: 'USD' } },
              // At the exclusive end of the range: must not be counted (M521 per-business filter)
              { business_id: 'lagos-biz', created_at: LAGOS_Q_END, transaction_amount: 999999, fee_total: 5, gateway_fee: 1, waived: false, is_direct_transfer: false, payments: { currency: 'USD' } },
            ], error: null });
          }
          if (isPago) {
            return Promise.resolve({ data: [
              { business_id: 'pago-biz', created_at: '2026-10-22T12:00:00.000Z', transaction_amount: 5000, fee_total: 250, gateway_fee: 50, waived: false, is_direct_transfer: false, payments: { currency: 'NGN' } },
            ], error: null });
          }
          return Promise.resolve({ data: [], error: null });
        });
      } else if (table === 'payout_adjustments') {
        c.limit = vi.fn().mockResolvedValue({ data: [], error: null });
      } else if (table === 'payout_accounts') {
        c.limit = vi.fn().mockResolvedValue({ data: [], error: null });
      }
      return c;
    };

    vi.doMock('@/lib/supabase/service', () => ({ createServiceClient: vi.fn(() => ({ from: (t: string) => mockFromImpl(t), rpc: vi.fn().mockImplementation((name: string) => Promise.resolve({
          data: name === 'tax_refund_payout_currencies_980' ? [] : name === 'tax_refund_payout_projection_980' ? { affected: false } : null, error: null,
        })) })) }));

    cronModule = await import('@/app/api/cron/auto-payout/route');
    const res = await cronModule.GET(makeGetRequest('/api/cron/auto-payout'));
    expect(res.status).toBe(200);
    const body = await res.json();

    // ── Response metadata: exactly two distinct periods, no single 'period' field ──
    expect(body.period).toBeUndefined();
    expect(body.periods).toBeDefined();
    expect(Array.isArray(body.periods)).toBe(true);
    expect(body.periods.length).toBe(2);
    const periodStrs = body.periods.map((p: { start: string; end: string }) => `${p.start}:${p.end}`);
    expect(periodStrs).toContain(`${LAGOS_START}:${LAGOS_END}`);
    expect(periodStrs).toContain(`${PAGO_START}:${PAGO_END}`);

    // ── Per-group dedup used correct DATE labels ──
    expect(dedupCalls.length).toBe(2);
    // (one read per group covers this week and the previous week; labels are matched in code)
    const lagosDedup = dedupCalls.find(d => d.recentFrom === LAGOS_RECENT_FROM);
    const pagoDedup = dedupCalls.find(d => d.recentFrom === PAGO_RECENT_FROM);
    expect(lagosDedup).toBeDefined();
    expect(lagosDedup!.bizIds).toEqual(['lagos-biz']);
    expect(pagoDedup).toBeDefined();
    expect(pagoDedup!.bizIds).toEqual(['pago-biz']);

    // ── Per-group fee queries used correct UTC bounds ──
    expect(feeCalls.length).toBe(2);
    const lagosFee = feeCalls.find(f => f.bizIds.includes('lagos-biz'));
    const pagoFee = feeCalls.find(f => f.bizIds.includes('pago-biz'));
    expect(lagosFee!.gteArg).toBe(LAGOS_Q_START);
    expect(lagosFee!.ltArg).toBe(LAGOS_Q_END);
    expect(pagoFee!.gteArg).toBe(PAGO_Q_START);
    expect(pagoFee!.ltArg).toBe(PAGO_Q_END);

    // ── Dedup: lagos-biz already has NGN → only USD inserted for lagos, NGN for pago ──
    // lagos-biz: NGN already exists (seeded), USD is new → INSERT USD
    // pago-biz: no existing → INSERT NGN
    const lagosInserts = insertPayloads.filter(p => p.business_id === 'lagos-biz');
    const pagoInserts = insertPayloads.filter(p => p.business_id === 'pago-biz');
    expect(lagosInserts.length).toBe(1);
    expect(lagosInserts[0].currency).toBe('USD');
    expect(lagosInserts[0].period_start).toBe(LAGOS_START);
    expect(lagosInserts[0].period_end).toBe(LAGOS_END);
    // M521: USD reuses the week's recorded range; the fee at the exclusive end is not counted
    expect(lagosInserts[0].covered_from).toBe(LAGOS_Q_START);
    expect(lagosInserts[0].covered_to).toBe(LAGOS_Q_END);
    expect(Number(lagosInserts[0].gross_amount)).toBeLessThan(999999);
    expect(pagoInserts.length).toBe(1);
    expect(pagoInserts[0].currency).toBe('NGN');
    expect(pagoInserts[0].period_start).toBe(PAGO_START);
    expect(pagoInserts[0].period_end).toBe(PAGO_END);
    expect(pagoInserts[0].covered_from).toBe(PAGO_Q_START);
    expect(pagoInserts[0].covered_to).toBe(PAGO_Q_END);

    // ── Held-release queried exactly once across all groups, zero release writes ──
    expect(heldQueryCount).toBe(1);
    expect(heldReleaseCount).toBe(0);
  });

  it('ENABLE_PAYOUTS=false returns 503', async () => {
    process.env.ENABLE_PAYOUTS = 'false';
    vi.doMock('@/lib/supabase/service', () => ({ createServiceClient: vi.fn(() => ({ from: () => chainMock(), rpc: vi.fn().mockImplementation((name: string) => Promise.resolve({
          data: name === 'tax_refund_payout_currencies_980' ? [] : name === 'tax_refund_payout_projection_980' ? { affected: false } : null, error: null,
        })) })) }));
    cronModule = await import('@/app/api/cron/auto-payout/route');
    const res = await cronModule.GET(makeGetRequest('/api/cron/auto-payout'));
    expect(res.status).toBe(503);
  });

  it('M521: a business whose range overlaps a recorded payout is excluded from fees and release; paired control released', async () => {
    let heldPayoutsQueried = false;
    let heldAccountLookupReached = false;
    const releaseUpdatedIds: string[] = [];
    const feeBizIds: string[][] = [];
    let bpCallIdx = 0;
    let bizCallIdx = 0;

    mockFromImpl = (table: string) => {
      const c = chainMock();
      if (table === 'businesses') {
        if (bizCallIdx++ === 0) {
          c.eq = vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({
            data: [
              { id: 'ok-biz', name: 'OK', created_at: '2025-01-01', country_code: 'NG', verification_level: 'basic', timezone: 'Africa/Lagos' },
              { id: 'conflict-biz', name: 'Conflict', created_at: '2025-01-01', country_code: 'NG', verification_level: 'basic', timezone: 'Africa/Lagos' },
            ], error: null,
          }) });
        } else {
          c.limit = vi.fn().mockResolvedValue({ data: [
            { id: 'ok-biz', created_at: '2025-01-01', verification_level: 'basic' },
            { id: 'conflict-biz', created_at: '2025-01-01', verification_level: 'basic' },
          ], error: null });
        }
      } else if (table === 'business_payouts') {
        const idx = bpCallIdx++;
        if (idx === 0) {
          c.limit = vi.fn().mockResolvedValue({ data: [], error: null }); // legacy preflight
        } else if (idx <= 2) {
          // Per-business dedup + anchor reads: conflict-biz has a later-labelled payout whose
          // recorded range starts inside this Lagos week; ok-biz has no history.
          let bizId = '';
          c.eq = vi.fn().mockImplementation((col: string, id: string) => { if (col === 'business_id') bizId = id; return c; });
          c.limit = vi.fn().mockImplementation(() => Promise.resolve({ data: bizId === 'conflict-biz' ? [
            { business_id: 'conflict-biz', currency: 'NGN', period_start: '2026-11-02', period_end: '2026-11-08', covered_from: '2026-11-01T10:00:00.000Z', covered_to: '2026-11-08T10:00:00.000Z' },
          ] : [], error: null }));
        } else if (!heldPayoutsQueried) {
          heldPayoutsQueried = true;
          c.eq = vi.fn().mockResolvedValue({ data: [
            { id: 'held-ok', business_id: 'ok-biz', currency: 'NGN', flags: [] },
            { id: 'held-conflict', business_id: 'conflict-biz', currency: 'NGN', flags: [] },
          ], error: null });
        } else {
          c.update = vi.fn().mockImplementation(() => ({
            eq: vi.fn().mockImplementation((_col: string, val: string) => { releaseUpdatedIds.push(val); return Promise.resolve({ error: null }); }),
          }));
        }
      } else if (table === 'platform_fees') {
        c.in = vi.fn().mockImplementation((_col: string, ids: string[]) => { feeBizIds.push(ids); return c; });
        c.limit = vi.fn().mockResolvedValue({ data: [], error: null });
      } else if (table === 'payout_adjustments') {
        c.limit = vi.fn().mockResolvedValue({ data: [], error: null });
      } else if (table === 'payout_accounts') {
        c.limit = vi.fn().mockResolvedValue(heldAccountLookupReached
          ? { data: [{ business_id: 'ok-biz' }, { business_id: 'conflict-biz' }], error: null }
          : { data: [], error: null });
        heldAccountLookupReached = true;
      }
      return c;
    };
    vi.doMock('@/lib/supabase/service', () => ({ createServiceClient: vi.fn(() => ({ from: (t: string) => mockFromImpl(t), rpc: vi.fn().mockImplementation((name: string) => Promise.resolve({
          data: name === 'tax_refund_payout_currencies_980' ? [] : name === 'tax_refund_payout_projection_980' ? { affected: false } : null, error: null,
        })) })) }));

    cronModule = await import('@/app/api/cron/auto-payout/route');
    const res = await cronModule.GET(makeGetRequest('/api/cron/auto-payout'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.generated).toBe(0);
    // Fee read covers only the business with a safe range
    expect(feeBizIds).toEqual([['ok-biz']]);
    // Conflict logged; held payout of the conflicted business is not released, the control is
    expect(mockLoggerError).toHaveBeenCalledWith(expect.stringContaining('Payout range conflict'), expect.objectContaining({ business_id: 'conflict-biz' }));
    expect(releaseUpdatedIds).toEqual(['held-ok']);
  });

  it('held-release: invalid-tz blocked, valid-tz released; paired positive/negative', async () => {
    // Two held payouts: one for invalid-tz biz (must NOT release), one for valid-tz biz (must release).
    // Both are otherwise eligible: old enough, verified, has account, NGN currency, no flags.
    // This test fails if invalidTimezoneBizIds guard is removed because both would release.
    let heldPayoutsQueried = false;
    let heldBizLookupReached = false;
    let heldAccountLookupReached = false;
    const releaseUpdatedIds: string[] = [];
    let bpCallIdx = 0;
    let bizCallIdx = 0;

    mockFromImpl = (table: string) => {
      const c = chainMock();

      if (table === 'businesses') {
        const idx = bizCallIdx++;
        if (idx === 0) {
          // Main businesses query: one valid, one invalid timezone
          c.eq = vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({
            data: [
              { id: 'valid-biz', name: 'Valid', created_at: '2025-01-01', country_code: 'NG', verification_level: 'basic', timezone: 'Africa/Lagos' },
              { id: 'badtz-biz', name: 'BadTZ', created_at: '2025-01-01', country_code: 'NG', verification_level: 'basic', timezone: 'Fake/Zone' },
            ], error: null,
          }) });
        } else {
          // Held-release: businesses lookup. Track that it was reached.
          heldBizLookupReached = true;
          c.limit = vi.fn().mockResolvedValue({
            data: [
              { id: 'valid-biz', created_at: '2025-01-01', verification_level: 'basic' },
              { id: 'badtz-biz', created_at: '2025-01-01', verification_level: 'basic' },
            ], error: null,
          });
        }
      } else if (table === 'business_payouts') {
        const idx = bpCallIdx++;
        if (idx === 0) {
          // Legacy payouts
          c.limit = vi.fn().mockResolvedValue({ data: [], error: null });
        } else if (idx === 1) {
          // Per-group dedup (only Lagos group — badtz has no group)
          c.limit = vi.fn().mockResolvedValue({ data: [], error: null });
        } else if (!heldPayoutsQueried) {
          // Held payouts query: select('id, business_id, currency, flags').eq('status', 'held')
          heldPayoutsQueried = true;
          c.eq = vi.fn().mockImplementation((_col: string, _val: string) => {
            // .eq('status', 'held') returns the held rows
            return Promise.resolve({
              data: [
                { id: 'held-valid', business_id: 'valid-biz', currency: 'NGN', flags: [] },
                { id: 'held-badtz', business_id: 'badtz-biz', currency: 'NGN', flags: [] },
              ], error: null,
            });
          });
        } else {
          // Release update — track which payout ID was released
          c.update = vi.fn().mockImplementation(() => ({
            eq: vi.fn().mockImplementation((_col: string, val: string) => {
              releaseUpdatedIds.push(val);
              return Promise.resolve({ error: null });
            }),
          }));
        }
      } else if (table === 'platform_fees') {
        // No fees — no generation, only held-release matters
        c.limit = vi.fn().mockResolvedValue({ data: [], error: null });
      } else if (table === 'payout_adjustments') {
        c.limit = vi.fn().mockResolvedValue({ data: [], error: null });
      } else if (table === 'payout_accounts') {
        if (!heldAccountLookupReached) {
          // Period-independent accounts
          c.limit = vi.fn().mockResolvedValue({ data: [], error: null });
        } else {
          // Held-release: accounts lookup
          c.limit = vi.fn().mockResolvedValue({
            data: [
              { business_id: 'valid-biz' },
              { business_id: 'badtz-biz' },
            ], error: null,
          });
        }
        heldAccountLookupReached = true;
      }
      return c;
    };

    vi.doMock('@/lib/supabase/service', () => ({ createServiceClient: vi.fn(() => ({ from: (t: string) => mockFromImpl(t), rpc: vi.fn().mockImplementation((name: string) => Promise.resolve({
          data: name === 'tax_refund_payout_currencies_980' ? [] : name === 'tax_refund_payout_projection_980' ? { affected: false } : null, error: null,
        })) })) }));

    cronModule = await import('@/app/api/cron/auto-payout/route');
    const res = await cronModule.GET(makeGetRequest('/api/cron/auto-payout'));
    expect(res.status).toBe(200);
    const body = await res.json();

    // Held-payouts query was reached
    expect(heldPayoutsQueried).toBe(true);
    // Held business/account lookups were reached
    expect(heldBizLookupReached).toBe(true);
    expect(heldAccountLookupReached).toBe(true);

    // Positive control: valid-biz held payout was released
    expect(releaseUpdatedIds).toContain('held-valid');
    // Negative control: badtz-biz held payout was NOT released
    expect(releaseUpdatedIds).not.toContain('held-badtz');
    // Exactly one release
    expect(releaseUpdatedIds.length).toBe(1);
    expect(body.released).toBe(1);
    expect(body.generated).toBe(0);
  });
});
