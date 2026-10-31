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
    vi.doMock('@/lib/supabase/service', () => ({ createServiceClient: vi.fn(() => ({ from: (t: string) => mockFromImpl(t), rpc: vi.fn().mockResolvedValue({ data: null, error: null }) })) }));
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
        // Dedup: .select().eq(biz).eq(start).eq(end) → last eq resolves
        let eqCount = 0;
        c.eq = vi.fn().mockImplementation(() => {
          eqCount++;
          if (eqCount >= 3) return Promise.resolve({ data: [], error: null });
          return c;
        });
        c.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
        c.is = vi.fn().mockReturnValue({ maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }) });
        c.insert = vi.fn().mockImplementation((payload: Record<string, unknown>) => {
          capturedInsert = payload;
          return { select: vi.fn().mockReturnValue({ single: vi.fn().mockResolvedValue({ data: { id: 'p1' }, error: null }) }) };
        });
        c.gte = vi.fn().mockResolvedValue({ data: [], error: null });
      } else if (table === 'payout_adjustments') {
        c.is = vi.fn().mockResolvedValue({ data: [], error: null });
      } else if (table === 'payout_accounts') {
        c.maybeSingle = vi.fn().mockResolvedValue({ data: { id: 'pa-1' }, error: null });
      }
      return c;
    };
    vi.doMock('@/lib/supabase/service', () => ({ createServiceClient: vi.fn(() => ({ from: (t: string) => mockFromImpl(t), rpc: vi.fn().mockResolvedValue({ data: null, error: null }) })) }));

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
    vi.doMock('@/lib/supabase/service', () => ({ createServiceClient: vi.fn(() => ({ from: (t: string) => mockFromImpl(t), rpc: vi.fn().mockResolvedValue({ data: null, error: null }) })) }));
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
    const dedupCalls: { bizIds: string[]; periodStart: string; periodEnd: string }[] = [];
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
          // Per-group dedup: track .eq('period_start',...).eq('period_end',...)
          let capturedBizIds: string[] = [];
          let capturedPeriodStart = '';
          let capturedPeriodEnd = '';
          c.in = vi.fn().mockImplementation((_col: string, ids: string[]) => { capturedBizIds = ids; return c; });
          c.eq = vi.fn().mockImplementation((_col: string, val: string) => {
            if (_col === 'period_start') capturedPeriodStart = val;
            if (_col === 'period_end') capturedPeriodEnd = val;
            return c;
          });
          c.limit = vi.fn().mockImplementation(() => {
            dedupCalls.push({ bizIds: capturedBizIds, periodStart: capturedPeriodStart, periodEnd: capturedPeriodEnd });
            // Seed: lagos-biz already has NGN payout for its period
            const seeded = capturedBizIds.includes('lagos-biz') && capturedPeriodStart === LAGOS_START
              ? [{ business_id: 'lagos-biz', currency: 'NGN' }] : [];
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
              { business_id: 'lagos-biz', transaction_amount: 10000, fee_total: 500, gateway_fee: 100, waived: false, is_direct_transfer: false, payments: { currency: 'NGN' } },
              { business_id: 'lagos-biz', transaction_amount: 100, fee_total: 5, gateway_fee: 1, waived: false, is_direct_transfer: false, payments: { currency: 'USD' } },
            ], error: null });
          }
          if (isPago) {
            return Promise.resolve({ data: [
              { business_id: 'pago-biz', transaction_amount: 5000, fee_total: 250, gateway_fee: 50, waived: false, is_direct_transfer: false, payments: { currency: 'NGN' } },
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

    vi.doMock('@/lib/supabase/service', () => ({ createServiceClient: vi.fn(() => ({ from: (t: string) => mockFromImpl(t), rpc: vi.fn().mockResolvedValue({ data: null, error: null }) })) }));

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
    const lagosDedup = dedupCalls.find(d => d.periodStart === LAGOS_START);
    const pagoDedup = dedupCalls.find(d => d.periodStart === PAGO_START);
    expect(lagosDedup).toBeDefined();
    expect(lagosDedup!.periodEnd).toBe(LAGOS_END);
    expect(lagosDedup!.bizIds).toContain('lagos-biz');
    expect(pagoDedup).toBeDefined();
    expect(pagoDedup!.periodEnd).toBe(PAGO_END);
    expect(pagoDedup!.bizIds).toContain('pago-biz');

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
    expect(pagoInserts.length).toBe(1);
    expect(pagoInserts[0].currency).toBe('NGN');
    expect(pagoInserts[0].period_start).toBe(PAGO_START);
    expect(pagoInserts[0].period_end).toBe(PAGO_END);

    // ── Held-release queried exactly once across all groups, zero release writes ──
    expect(heldQueryCount).toBe(1);
    expect(heldReleaseCount).toBe(0);
  });

  it('ENABLE_PAYOUTS=false returns 503', async () => {
    process.env.ENABLE_PAYOUTS = 'false';
    vi.doMock('@/lib/supabase/service', () => ({ createServiceClient: vi.fn(() => ({ from: () => chainMock(), rpc: vi.fn().mockResolvedValue({ data: null, error: null }) })) }));
    cronModule = await import('@/app/api/cron/auto-payout/route');
    const res = await cronModule.GET(makeGetRequest('/api/cron/auto-payout'));
    expect(res.status).toBe(503);
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

    vi.doMock('@/lib/supabase/service', () => ({ createServiceClient: vi.fn(() => ({ from: (t: string) => mockFromImpl(t), rpc: vi.fn().mockResolvedValue({ data: null, error: null }) })) }));

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
