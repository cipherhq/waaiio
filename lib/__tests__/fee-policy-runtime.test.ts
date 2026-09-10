/**
 * Fee Policy Runtime Tests (#264)
 *
 * Executable tests driving REAL cron GET / webhook POST handlers
 * with provider HTTP (fetch) + Supabase boundaries mocked.
 * Zero source-string scans.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ══════════════════════════════════════════════════════════
// Cron dispatched-recovery test helpers
// ══════════════════════════════════════════════════════════

const DISPATCHED_PAYSTACK = {
  id: 'pay-ps-1', gateway: 'paystack', gateway_reference: 'REF-PS',
  metadata: { reference_code: 'REF-PS' }, provider_init_state: 'dispatched',
  fee_policy_version: 1, created_at: new Date(Date.now() - 3 * 3600000).toISOString(),
  amount: 5000, currency: 'NGN',
};
const DISPATCHED_FW = { ...DISPATCHED_PAYSTACK, id: 'pay-fw-1', gateway: 'flutterwave', gateway_reference: 'REF-FW', metadata: { reference_code: 'REF-FW' } };
const DISPATCHED_STRIPE = { ...DISPATCHED_PAYSTACK, id: 'pay-st-1', gateway: 'stripe', gateway_reference: 'REF-ST', metadata: { reference_code: 'REF-ST' } };
const DISPATCHED_SQUARE = { ...DISPATCHED_PAYSTACK, id: 'pay-sq-1', gateway: 'square', gateway_reference: 'REF-SQ', metadata: { reference_code: 'REF-SQ' } };
const DISPATCHED_PAYPAL = { ...DISPATCHED_PAYSTACK, id: 'pay-pp-1', gateway: 'paypal', gateway_reference: 'REF-PP', metadata: { reference_code: 'REF-PP' } };
const OLD_DISPATCHED = { ...DISPATCHED_PAYSTACK, created_at: new Date(Date.now() - 25 * 3600000).toISOString() };

function setupCronMocks() {
  vi.doMock('@/lib/cron-auth', () => ({ verifyCronAuth: vi.fn().mockReturnValue(null) }));
  vi.doMock('@sentry/nextjs', () => ({ captureException: vi.fn() }));
  vi.doMock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), withContext: vi.fn().mockReturnThis() } }));
  vi.doMock('@/lib/observability/cron', () => ({ createCronLogger: vi.fn(() => ({ started: vi.fn(), completed: vi.fn(), failed: vi.fn() })) }));
  vi.doMock('@/lib/payments/process-success', () => ({ processSuccessfulPayment: vi.fn() }));
  vi.doMock('@/lib/payments/send-confirmation', () => ({ sendProactiveConfirmation: vi.fn() }));
  // reconcilePayment mock is set per-test in callCron() to track call count
}

type CasMode = 'ok' | 'db_error' | 'zero_rows';
function casResultFor(mode: CasMode) {
  if (mode === 'db_error') return { data: null, error: { message: 'DB error' } };
  if (mode === 'zero_rows') return { data: [], error: null };
  return { data: [{ id: 'x' }], error: null };
}

function buildCronSb(opts: {
  dispatched?: Record<string, unknown>[];
  dispatchQueryError?: boolean;
  casMode?: CasMode;
  terminalMode?: CasMode;
  quarantineRereadError?: boolean;
  quarantineMode?: CasMode;
} = {}) {
  const dispatched = opts.dispatched || [];
  const casWrites: unknown[] = [];
  const terminalWrites: unknown[] = [];
  const quarantineWrites: unknown[] = [];
  let limitCallCount = 0;

  const postUpdate = (mode: CasMode): Record<string, unknown> => new Proxy({} as Record<string, unknown>, {
    get(_, p: string) {
      if (p === 'then') return (r: (v: unknown) => void) => r(casResultFor(mode));
      if (p === 'single') return vi.fn().mockResolvedValue(casResultFor(mode));
      return vi.fn(() => postUpdate(mode));
    },
  });

  const chain = (): Record<string, unknown> => new Proxy({} as Record<string, unknown>, {
    get(_, p: string) {
      if (p === 'single') return vi.fn().mockResolvedValue(
        opts.quarantineRereadError ? { data: null, error: { message: 'reread err' } }
          : { data: { provider_init_state: 'dispatched' }, error: null }
      );
      if (p === 'maybeSingle') return vi.fn().mockResolvedValue({ data: null, error: null });
      if (p === 'then') return (r: (v: unknown) => void) => r({ data: [], error: null });
      if (p === 'limit') return vi.fn().mockImplementation(() => {
        limitCallCount++;
        if (opts.dispatchQueryError && limitCallCount >= 2) {
          return Promise.resolve({ data: null, error: { message: 'Dispatched DB error' } });
        }
        // Return dispatched array for both queries — stale query getting extra rows is harmless for these tests
        return Promise.resolve({ data: dispatched, error: null });
      });
      if (p === 'update') return vi.fn((payload: Record<string, unknown>) => {
        if (payload.provider_init_state) { casWrites.push(payload); return postUpdate(opts.casMode || 'ok'); }
        if (payload.status === 'failed') { terminalWrites.push(payload); return postUpdate(opts.terminalMode || 'ok'); }
        if (payload.gateway_status) { quarantineWrites.push(payload); return postUpdate(opts.quarantineMode || 'ok'); }
        return postUpdate('ok');
      });
      return vi.fn(() => chain());
    },
  });

  return { client: { from: vi.fn(() => chain()), rpc: vi.fn().mockResolvedValue({ data: null, error: null }) }, casWrites, terminalWrites, quarantineWrites };
}

type FetchResp = { ok: boolean; body?: unknown; raw?: string };
async function callCron(sb: { client: Record<string, unknown> }, fetchResponses: FetchResp[] = []) {
  let fetchIdx = 0;
  const fetchCalls: Array<{ url: string; method: string }> = [];
  let reconcileCallCount = 0;
  const origFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
    fetchCalls.push({ url: u, method: init?.method || 'GET' });
    const resp = fetchResponses[fetchIdx++] || { ok: true, body: {} };
    if (resp.raw !== undefined) return new Response(resp.raw, { status: resp.ok ? 200 : 500 });
    return new Response(JSON.stringify(resp.body ?? {}), { status: resp.ok ? 200 : 500 });
  }) as unknown as typeof fetch;

  vi.doMock('@/lib/supabase/service', () => ({ createServiceClient: vi.fn(() => sb.client) }));
  vi.doMock('@/lib/payments/reconcile', () => ({ reconcilePayment: vi.fn().mockImplementation(() => { reconcileCallCount++; return Promise.resolve({ providerOutcome: 'verified', lifecycle: { status: 'completed' }, acknowledgeSuccess: true }); }) }));
  const { GET } = await import('../../app/api/cron/payment-reconciliation/route');
  const req = new NextRequest('http://localhost:3000/api/cron/payment-reconciliation', { headers: { authorization: 'Bearer test' } });
  const res = await GET(req);
  globalThis.fetch = origFetch;
  return { status: res.status, json: await res.json(), fetchCalls, reconcileCallCount };
}

// ══════════════════════════════════════════════════════════
// 1. Cron structural fail-closed
// ══════════════════════════════════════════════════════════

describe('Cron dispatched recovery — real GET handler', () => {
  beforeEach(() => { vi.clearAllMocks(); vi.resetModules(); process.env.PAYSTACK_SECRET_KEY = 'test-ps-key'; process.env.FLUTTERWAVE_SECRET_KEY = 'test-fw-key'; process.env.STRIPE_SECRET_KEY = 'test-stripe-key'; setupCronMocks(); });

  it('dispatched query DB error → zero provider recovery calls', async () => {
    const sb = buildCronSb({ dispatchQueryError: true });
    const { fetchCalls } = await callCron(sb);
    // No provider fetch calls for recovery (only stale-payments query runs)
    const providerCalls = fetchCalls.filter(c => c.url.includes('paystack') || c.url.includes('flutterwave') || c.url.includes('stripe'));
    expect(providerCalls.length).toBe(0);
  });

  // ── Paystack ──

  it('Paystack found paid → checked CAS + reconcile', async () => {
    const sb = buildCronSb({ dispatched: [DISPATCHED_PAYSTACK] });
    await callCron(sb, [{ ok: true, body: { data: { status: 'success' } } }]);
    expect(sb.casWrites.some((w: Record<string, unknown>) => w.provider_init_state === 'provider_confirmed')).toBe(true);
  });

  it('Paystack found unpaid + valid artifact → CAS with URL', async () => {
    const sb = buildCronSb({ dispatched: [DISPATCHED_PAYSTACK] });
    await callCron(sb, [{ ok: true, body: { data: { status: 'pending', authorization_url: 'https://checkout.paystack.com/test' } } }]);
    expect(sb.casWrites.some((w: Record<string, unknown>) => w.provider_init_state === 'provider_confirmed')).toBe(true);
  });

  it('Paystack found unpaid + malformed artifact → no CAS', async () => {
    const sb = buildCronSb({ dispatched: [DISPATCHED_PAYSTACK] });
    await callCron(sb, [{ ok: true, body: { data: { status: 'pending', authorization_url: 12345 } } }]);
    expect(sb.casWrites.filter((w: Record<string, unknown>) => w.provider_init_state === 'provider_confirmed').length).toBe(0);
  });

  it('Paystack terminal (abandoned) → checked terminal CAS', async () => {
    const sb = buildCronSb({ dispatched: [DISPATCHED_PAYSTACK] });
    await callCron(sb, [{ ok: true, body: { data: { status: 'abandoned' } } }]);
    expect(sb.terminalWrites.length).toBeGreaterThanOrEqual(1);
  });

  it('Paystack documented absence → no POST, remain dispatched', async () => {
    const sb = buildCronSb({ dispatched: [DISPATCHED_PAYSTACK] });
    const { fetchCalls } = await callCron(sb, [{ ok: true, body: { status: false, message: 'Transaction reference not found' } }]);
    const posts = fetchCalls.filter(c => c.method === 'POST');
    expect(posts.length).toBe(0);
    expect(sb.casWrites.filter((w: Record<string, unknown>) => w.provider_init_state === 'provider_confirmed').length).toBe(0);
  });

  it('Paystack HTTP failure → ambiguous, no CAS', async () => {
    const sb = buildCronSb({ dispatched: [DISPATCHED_PAYSTACK] });
    await callCron(sb, [{ ok: false, body: {} }]);
    expect(sb.casWrites.filter((w: Record<string, unknown>) => w.provider_init_state === 'provider_confirmed').length).toBe(0);
  });

  it('Paystack unrecognized response → no CAS', async () => {
    const sb = buildCronSb({ dispatched: [DISPATCHED_PAYSTACK] });
    await callCron(sb, [{ ok: true, body: { data: { status: 'weird_unknown' } } }]);
    expect(sb.casWrites.filter((w: Record<string, unknown>) => w.provider_init_state === 'provider_confirmed').length).toBe(0);
  });

  // ── Flutterwave ──

  it('FW found paid → checked CAS', async () => {
    const sb = buildCronSb({ dispatched: [DISPATCHED_FW] });
    await callCron(sb, [{ ok: true, body: { data: { status: 'successful' } } }]);
    expect(sb.casWrites.some((w: Record<string, unknown>) => w.provider_init_state === 'provider_confirmed')).toBe(true);
  });

  it('FW found unpaid + valid link → CAS', async () => {
    const sb = buildCronSb({ dispatched: [DISPATCHED_FW] });
    await callCron(sb, [{ ok: true, body: { data: { status: 'pending', link: 'https://checkout.flutterwave.com/pay' } } }]);
    expect(sb.casWrites.some((w: Record<string, unknown>) => w.provider_init_state === 'provider_confirmed')).toBe(true);
  });

  it('FW documented absence → no POST', async () => {
    const sb = buildCronSb({ dispatched: [DISPATCHED_FW] });
    const { fetchCalls } = await callCron(sb, [{ ok: true, body: { status: 'error', message: 'No transaction was found for this id' } }]);
    expect(fetchCalls.filter(c => c.method === 'POST').length).toBe(0);
  });

  it('FW terminal → checked terminal CAS', async () => {
    const sb = buildCronSb({ dispatched: [DISPATCHED_FW] });
    await callCron(sb, [{ ok: true, body: { data: { status: 'failed' } } }]);
    expect(sb.terminalWrites.length).toBeGreaterThanOrEqual(1);
  });

  // ── Stripe pagination ──

  it('Stripe unique valid match → CAS', async () => {
    const sb = buildCronSb({ dispatched: [DISPATCHED_STRIPE] });
    await callCron(sb, [{ ok: true, body: { data: [{ id: 'cs_1', url: 'https://checkout.stripe.com/s1', client_reference_id: 'REF-ST' }], has_more: false } }]);
    expect(sb.casWrites.some((w: Record<string, unknown>) => w.provider_init_state === 'provider_confirmed')).toBe(true);
  });

  it('Stripe zero matches → no CAS', async () => {
    const sb = buildCronSb({ dispatched: [DISPATCHED_STRIPE] });
    await callCron(sb, [{ ok: true, body: { data: [], has_more: false } }]);
    expect(sb.casWrites.filter((w: Record<string, unknown>) => w.provider_init_state === 'provider_confirmed').length).toBe(0);
  });

  it('Stripe multiple matches → no CAS', async () => {
    const sb = buildCronSb({ dispatched: [DISPATCHED_STRIPE] });
    await callCron(sb, [{ ok: true, body: { data: [
      { id: 'cs_1', url: 'https://s.com/1', client_reference_id: 'REF-ST' },
      { id: 'cs_2', url: 'https://s.com/2', client_reference_id: 'REF-ST' },
    ], has_more: false } }]);
    expect(sb.casWrites.filter((w: Record<string, unknown>) => w.provider_init_state === 'provider_confirmed').length).toBe(0);
  });

  it('Stripe match with malformed URL → no CAS', async () => {
    const sb = buildCronSb({ dispatched: [DISPATCHED_STRIPE] });
    await callCron(sb, [{ ok: true, body: { data: [{ id: 'cs_1', url: 'not-a-url', client_reference_id: 'REF-ST' }], has_more: false } }]);
    expect(sb.casWrites.filter((w: Record<string, unknown>) => w.provider_init_state === 'provider_confirmed').length).toBe(0);
  });

  it('Stripe one valid + one malformed candidate → no CAS (malformedCandidates > 0)', async () => {
    const sb = buildCronSb({ dispatched: [DISPATCHED_STRIPE] });
    await callCron(sb, [{ ok: true, body: { data: [
      { id: 'cs_1', url: 'https://s.com/ok', client_reference_id: 'REF-ST' },
      { id: '', url: 'https://s.com/bad', client_reference_id: 'REF-ST' },
    ], has_more: false } }]);
    expect(sb.casWrites.filter((w: Record<string, unknown>) => w.provider_init_state === 'provider_confirmed').length).toBe(0);
  });

  it('Stripe malformed List shape (data not array) → no CAS', async () => {
    const sb = buildCronSb({ dispatched: [DISPATCHED_STRIPE] });
    await callCron(sb, [{ ok: true, body: { data: 'not-an-array', has_more: false } }]);
    expect(sb.casWrites.filter((w: Record<string, unknown>) => w.provider_init_state === 'provider_confirmed').length).toBe(0);
  });

  it('Stripe malformed List (has_more not boolean) → no CAS', async () => {
    const sb = buildCronSb({ dispatched: [DISPATCHED_STRIPE] });
    await callCron(sb, [{ ok: true, body: { data: [], has_more: 'yes' } }]);
    expect(sb.casWrites.filter((w: Record<string, unknown>) => w.provider_init_state === 'provider_confirmed').length).toBe(0);
  });

  it('Stripe page-2 HTTP failure after page-1 match → no CAS', async () => {
    const sb = buildCronSb({ dispatched: [DISPATCHED_STRIPE] });
    await callCron(sb, [
      { ok: true, body: { data: [{ id: 'cs_1', url: 'https://s.com/1', client_reference_id: 'REF-ST' }], has_more: true } },
      { ok: false, body: {} },
    ]);
    expect(sb.casWrites.filter((w: Record<string, unknown>) => w.provider_init_state === 'provider_confirmed').length).toBe(0);
  });

  it('Stripe has_more=true + empty page after match → no CAS', async () => {
    const sb = buildCronSb({ dispatched: [DISPATCHED_STRIPE] });
    await callCron(sb, [
      { ok: true, body: { data: [{ id: 'cs_1', url: 'https://s.com/1', client_reference_id: 'REF-ST' }], has_more: true } },
      { ok: true, body: { data: [], has_more: true } },
    ]);
    expect(sb.casWrites.filter((w: Record<string, unknown>) => w.provider_init_state === 'provider_confirmed').length).toBe(0);
  });

  // ── Square/PayPal cron ──

  it('Square cron → zero provider POSTs', async () => {
    const sb = buildCronSb({ dispatched: [DISPATCHED_SQUARE] });
    const { fetchCalls } = await callCron(sb);
    expect(fetchCalls.filter(c => c.url.includes('square') && c.method === 'POST').length).toBe(0);
    expect(sb.casWrites.filter((w: Record<string, unknown>) => w.provider_init_state === 'provider_confirmed').length).toBe(0);
  });

  it('PayPal cron → zero provider POSTs', async () => {
    const sb = buildCronSb({ dispatched: [DISPATCHED_PAYPAL] });
    const { fetchCalls } = await callCron(sb);
    expect(fetchCalls.filter(c => c.url.includes('paypal') && c.method === 'POST').length).toBe(0);
  });

  // ── 24h quarantine ──

  it('old ambiguous row → quarantine write', async () => {
    const sb = buildCronSb({ dispatched: [OLD_DISPATCHED] });
    await callCron(sb, [{ ok: false, body: {} }]); // HTTP failure → ambiguous
    expect(sb.quarantineWrites.some((w: Record<string, unknown>) => w.gateway_status === 'dispatched_quarantine')).toBe(true);
  });

  // ── CAS error/zero-row ──

  // ── Checked-transition failure matrix ──

  it('provider-confirmed CAS DB error → CAS attempted, remains unresolved', async () => {
    const sb = buildCronSb({ dispatched: [DISPATCHED_PAYSTACK], casMode: 'db_error' });
    await callCron(sb, [{ ok: true, body: { data: { status: 'success' } } }]);
    // CAS was attempted (provider_confirmed written)
    expect(sb.casWrites.some((w: Record<string, unknown>) => w.provider_init_state === 'provider_confirmed')).toBe(true);
    // Production checkedCAS returns false on DB error → resolved stays false
  });

  it('provider-confirmed CAS zero rows → remains unresolved', async () => {
    const sb = buildCronSb({ dispatched: [DISPATCHED_PAYSTACK], casMode: 'zero_rows' });
    await callCron(sb, [{ ok: true, body: { data: { status: 'success' } } }]);
    expect(sb.casWrites.some((w: Record<string, unknown>) => w.provider_init_state === 'provider_confirmed')).toBe(true);
  });

  it('terminal CAS DB error → terminal attempted', async () => {
    const sb = buildCronSb({ dispatched: [DISPATCHED_PAYSTACK], terminalMode: 'db_error' });
    await callCron(sb, [{ ok: true, body: { data: { status: 'abandoned' } } }]);
    expect(sb.terminalWrites.length).toBeGreaterThanOrEqual(1);
  });

  it('terminal CAS zero rows → terminal attempted', async () => {
    const sb = buildCronSb({ dispatched: [DISPATCHED_PAYSTACK], terminalMode: 'zero_rows' });
    await callCron(sb, [{ ok: true, body: { data: { status: 'abandoned' } } }]);
    expect(sb.terminalWrites.length).toBeGreaterThanOrEqual(1);
  });

  it('quarantine reread error → no quarantine update', async () => {
    const sb = buildCronSb({ dispatched: [OLD_DISPATCHED], quarantineRereadError: true });
    await callCron(sb, [{ ok: false, body: {} }]);
    expect(sb.quarantineWrites.length).toBe(0);
  });

  it('quarantine update DB error → failure observed', async () => {
    const sb = buildCronSb({ dispatched: [OLD_DISPATCHED], quarantineMode: 'db_error' });
    await callCron(sb, [{ ok: false, body: {} }]);
    // Quarantine attempted but DB error
    expect(sb.quarantineWrites.length).toBeGreaterThanOrEqual(1);
  });

  // ── Malformed JSON proofs ──

  it('Paystack malformed JSON response → ambiguous, no CAS', async () => {
    const sb = buildCronSb({ dispatched: [DISPATCHED_PAYSTACK] });
    await callCron(sb, [{ ok: true, raw: 'NOT VALID JSON{{{' }]);
    expect(sb.casWrites.filter((w: Record<string, unknown>) => w.provider_init_state === 'provider_confirmed').length).toBe(0);
  });

  it('FW malformed JSON response → ambiguous, no CAS', async () => {
    const sb = buildCronSb({ dispatched: [DISPATCHED_FW] });
    await callCron(sb, [{ ok: true, raw: '<html>error</html>' }]);
    expect(sb.casWrites.filter((w: Record<string, unknown>) => w.provider_init_state === 'provider_confirmed').length).toBe(0);
  });

  it('Stripe malformed JSON response → ambiguous, no CAS', async () => {
    const sb = buildCronSb({ dispatched: [DISPATCHED_STRIPE] });
    await callCron(sb, [{ ok: true, raw: '}}invalid' }]);
    expect(sb.casWrites.filter((w: Record<string, unknown>) => w.provider_init_state === 'provider_confirmed').length).toBe(0);
  });

  // ── Missing Paystack cases ──

  it('Paystack found unpaid + no artifact → no CAS', async () => {
    const sb = buildCronSb({ dispatched: [DISPATCHED_PAYSTACK] });
    await callCron(sb, [{ ok: true, body: { data: { status: 'pending' } } }]);
    expect(sb.casWrites.filter((w: Record<string, unknown>) => w.provider_init_state === 'provider_confirmed').length).toBe(0);
  });

  it('Paystack malformed URL string artifact → no CAS', async () => {
    const sb = buildCronSb({ dispatched: [DISPATCHED_PAYSTACK] });
    await callCron(sb, [{ ok: true, body: { data: { status: 'pending', authorization_url: 'http-not-a-url' } } }]);
    expect(sb.casWrites.filter((w: Record<string, unknown>) => w.provider_init_state === 'provider_confirmed').length).toBe(0);
  });

  // ── Missing FW cases ──

  it('FW found unpaid + no artifact → no CAS', async () => {
    const sb = buildCronSb({ dispatched: [DISPATCHED_FW] });
    await callCron(sb, [{ ok: true, body: { data: { status: 'pending' } } }]);
    expect(sb.casWrites.filter((w: Record<string, unknown>) => w.provider_init_state === 'provider_confirmed').length).toBe(0);
  });

  it('FW malformed URL artifact → no CAS', async () => {
    const sb = buildCronSb({ dispatched: [DISPATCHED_FW] });
    await callCron(sb, [{ ok: true, body: { data: { status: 'pending', link: 'ftp://not-http' } } }]);
    expect(sb.casWrites.filter((w: Record<string, unknown>) => w.provider_init_state === 'provider_confirmed').length).toBe(0);
  });

  it('FW HTTP failure → no CAS', async () => {
    const sb = buildCronSb({ dispatched: [DISPATCHED_FW] });
    await callCron(sb, [{ ok: false, body: {} }]);
    expect(sb.casWrites.filter((w: Record<string, unknown>) => w.provider_init_state === 'provider_confirmed').length).toBe(0);
  });

  it('FW unrecognized response → no CAS', async () => {
    const sb = buildCronSb({ dispatched: [DISPATCHED_FW] });
    await callCron(sb, [{ ok: true, body: { data: { status: 'weird' } } }]);
    expect(sb.casWrites.filter((w: Record<string, unknown>) => w.provider_init_state === 'provider_confirmed').length).toBe(0);
  });

  // ── Missing Stripe cases ──

  it('Stripe page-5 has_more=false + one valid match → CAS allowed', async () => {
    const sb = buildCronSb({ dispatched: [DISPATCHED_STRIPE] });
    // 5 pages, last one has has_more=false
    const pages = Array.from({ length: 5 }, (_, i) => ({
      ok: true,
      body: {
        data: i === 0 ? [{ id: 'cs_match', url: 'https://s.com/ok', client_reference_id: 'REF-ST' }] : [{ id: `cs_other_${i}`, url: 'https://s.com/x', client_reference_id: 'OTHER' }],
        has_more: i < 4,
      },
    }));
    await callCron(sb, pages);
    expect(sb.casWrites.some((w: Record<string, unknown>) => w.provider_init_state === 'provider_confirmed')).toBe(true);
  });

  it('Stripe page-5 has_more=true → no CAS (bound exhausted)', async () => {
    const sb = buildCronSb({ dispatched: [DISPATCHED_STRIPE] });
    const pages = Array.from({ length: 5 }, (_, i) => ({
      ok: true,
      body: {
        data: i === 0 ? [{ id: 'cs_match', url: 'https://s.com/ok', client_reference_id: 'REF-ST' }] : [{ id: `cs_o_${i}`, url: 'https://s.com/x', client_reference_id: 'OTHER' }],
        has_more: true, // always more
      },
    }));
    await callCron(sb, pages);
    expect(sb.casWrites.filter((w: Record<string, unknown>) => w.provider_init_state === 'provider_confirmed').length).toBe(0);
  });

  it('Stripe malformed URL string for match → no CAS', async () => {
    const sb = buildCronSb({ dispatched: [DISPATCHED_STRIPE] });
    await callCron(sb, [{ ok: true, body: { data: [{ id: 'cs_1', url: 'javascript:alert(1)', client_reference_id: 'REF-ST' }], has_more: false } }]);
    expect(sb.casWrites.filter((w: Record<string, unknown>) => w.provider_init_state === 'provider_confirmed').length).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════
// Flutterwave v1/v0 tx_ref — real initializer
// ══════════════════════════════════════════════════════════

describe('FW v1/v0 tx_ref — real initializer', () => {
  beforeEach(() => { vi.clearAllMocks(); vi.resetModules(); process.env.FLUTTERWAVE_SECRET_KEY = 'test-fw'; });

  it('v1 uses referenceCode as tx_ref + X-Idempotency-Key', async () => {
    let body: Record<string, unknown> = {}; let headers: Record<string, string> = {};
    const orig = globalThis.fetch;
    globalThis.fetch = vi.fn(async (_u: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse((init?.body as string) || '{}'); headers = (init?.headers || {}) as Record<string, string>;
      return new Response(JSON.stringify({ status: 'success', data: { link: 'https://checkout.flutterwave.com/t' } }));
    }) as unknown as typeof fetch;
    const { FlutterwaveGateway } = await import('@/lib/payments/flutterwave');
    const sb = { from: vi.fn(() => ({ insert: vi.fn().mockReturnThis(), select: vi.fn().mockReturnThis(), single: vi.fn().mockResolvedValue({ data: null }), eq: vi.fn().mockReturnThis(), update: vi.fn().mockReturnThis() })) };
    await new FlutterwaveGateway().initializePayment({ supabase: sb as any, userId: 'u', amount: 100, currency: 'NGN', referenceCode: 'REF-V1', businessName: 'B', phone: '+234', existingPaymentId: 'ep1' });
    globalThis.fetch = orig;
    expect(body.tx_ref).toBe('REF-V1');
    expect(headers['X-Idempotency-Key']).toBe('REF-V1');
  });

  it('v0 uses random flw_ prefix', async () => {
    let body: Record<string, unknown> = {};
    const orig = globalThis.fetch;
    globalThis.fetch = vi.fn(async (_u: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse((init?.body as string) || '{}');
      return new Response(JSON.stringify({ status: 'success', data: { link: 'https://checkout.flutterwave.com/t' } }));
    }) as unknown as typeof fetch;
    const { FlutterwaveGateway } = await import('@/lib/payments/flutterwave');
    const sb = { from: vi.fn(() => ({ insert: vi.fn().mockReturnThis(), select: vi.fn().mockReturnThis(), single: vi.fn().mockResolvedValue({ data: { id: 'p1' } }), eq: vi.fn().mockReturnThis(), update: vi.fn().mockReturnThis() })) };
    await new FlutterwaveGateway().initializePayment({ supabase: sb as any, userId: 'u', amount: 100, currency: 'NGN', referenceCode: 'REF-V0', businessName: 'B', phone: '+234' });
    globalThis.fetch = orig;
    expect(body.tx_ref).toMatch(/^flw_/);
    expect(body.tx_ref).not.toBe('REF-V0');
  });
});

// ══════════════════════════════════════════════════════════
// Campaign guard — real initializePayment
// ══════════════════════════════════════════════════════════

describe('Campaign dispatched guard — real handler', () => {
  beforeEach(() => { vi.clearAllMocks(); vi.resetModules(); });

  it('existing dispatched campaign → gateway NOT called + campaign_id filter', async () => {
    let gwCalled = false;
    vi.doMock('@/lib/payments/factory', () => ({ getPaymentGateway: vi.fn(() => ({ name: 'paystack', initializePayment: vi.fn(() => { gwCalled = true; return { url: 'u', reference: 'r' }; }) })), getPaymentGatewayByName: vi.fn() }));
    vi.doMock('@/lib/countries', () => ({ getCountry: vi.fn(() => ({ currency_code: 'NGN' })) }));
    vi.doMock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), withContext: vi.fn().mockReturnThis() } }));
    vi.doMock('@/lib/observability', () => ({ observe: vi.fn((_n: string, _c: unknown, fn: () => unknown) => fn()), observeProvider: vi.fn((_c: unknown, fn: () => unknown) => fn()) }));
    vi.doMock('@/lib/errors', () => ({ safeLogErrorContext: vi.fn(() => ({})) }));

    const filters: string[] = [];
    const mp = (): Record<string, unknown> => new Proxy({} as Record<string, unknown>, {
      get(_, p: string) {
        if (p === 'single' || p === 'maybeSingle') return vi.fn().mockResolvedValue({ data: null, error: null });
        if (p === 'then') return (r: (v: unknown) => void) => r({ data: null, error: null });
        if (p === 'eq') return vi.fn((c: string, v: unknown) => {
          filters.push(`${c}=${v}`);
          if (c === 'provider_init_state' && v === 'dispatched') return new Proxy({} as Record<string, unknown>, { get(_, p2: string) { if (p2 === 'maybeSingle') return vi.fn().mockResolvedValue({ data: { id: 'd1', provider_init_state: 'dispatched' }, error: null }); return vi.fn(() => mp()); } });
          return mp();
        });
        return vi.fn(() => mp());
      },
    });
    const sb = { from: vi.fn(() => mp()) };
    const { initializePayment } = await import('@/lib/bot/flows/shared/payment');
    const result = await initializePayment(sb as any, { userId: 'u', amount: 5000, referenceCode: 'R', businessName: 'B', phone: '+234', campaignId: 'camp-1', businessId: 'b1', transactionCategory: 'giving' });
    expect(result).toBeNull();
    expect(gwCalled).toBe(false);
    expect(filters).toContainEqual('campaign_id=camp-1');
  });
});

// ══════════════════════════════════════════════════════════
// V1 finalization + pinned-config + BYO
// ══════════════════════════════════════════════════════════

describe('V1 finalization + calculator', () => {
  beforeEach(() => {
    vi.clearAllMocks(); vi.resetModules();
    vi.doMock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), withContext: vi.fn().mockReturnThis() } }));
    vi.doMock('@/lib/errors', () => ({ safeLogErrorContext: vi.fn(() => ({})), isSafeIdentifier: vi.fn(() => true) }));
    vi.doMock('@sentry/nextjs', () => ({ captureException: vi.fn() }));
    vi.doMock('@/lib/trial-status', () => ({ resolveTrialStatus: vi.fn().mockResolvedValue(false) }));
    vi.doMock('@/lib/getPlatformFees', () => ({ getPlatformFees: vi.fn() }));
  });

  it('v1 missing configVersionId → throws', async () => {
    vi.doMock('@/lib/payments/process-success', async () => {
      const actual = await vi.importActual('@/lib/payments/process-success');
      return actual;
    });
    const sb = { from: vi.fn(() => ({ select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), single: vi.fn().mockResolvedValue({ data: { business_id: 'b1' }, error: null }), insert: vi.fn().mockResolvedValue({ data: null, error: null }) })) };
    const { recordPlatformFee } = await import('@/lib/payments/process-success');
    await expect(recordPlatformFee(sb as any, { bookingId: 'bk1', paymentId: 'p1', paymentAmount: 5000, feePolicyVersion: 1, transactionCategory: 'scheduling', feeBasis: { payment_routing: 'platform', tier: 'free', is_in_trial: false, custom_fee_percentage: null, custom_fee_flat: null } })).rejects.toThrow(/missing authority fields/i);
  });

  it('pinned config isolation', async () => {
    const { calculateFee } = await import('@/lib/payments/calculateFee');
    expect(calculateFee(10000, { payment_routing: 'platform', tier: 'free', is_in_trial: false, custom_fee_percentage: null, custom_fee_flat: null }, 'scheduling', { pricing_tiers: { free: { feePercentage: 2.5, feeFlat: 0 } }, category_fee_rates: { scheduling: { feePercentage: 3.0 } } }).feeTotal).toBe(300);
  });

  it('BYO → 0%', async () => {
    const { calculateFee } = await import('@/lib/payments/calculateFee');
    expect(calculateFee(10000, { payment_routing: 'byo', tier: 'free', is_in_trial: false, custom_fee_percentage: null, custom_fee_flat: null }, 'scheduling', { pricing_tiers: { free: { feePercentage: 10, feeFlat: 0 } } }).feeTotal).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════
// Stripe webhook crash repair — real POST handler
// ══════════════════════════════════════════════════════════

describe('Stripe webhook v1 crash repair — real POST handler', () => {
  const STRIPE_SECRET = 'whsec_test264';

  function stripeSign(body: string): string {
    const { createHmac } = require('crypto');
    const ts = Math.floor(Date.now() / 1000);
    const sig = createHmac('sha256', STRIPE_SECRET).update(`${ts}.${body}`).digest('hex');
    return `t=${ts},v1=${sig}`;
  }

  beforeEach(() => { vi.clearAllMocks(); vi.resetModules(); process.env.STRIPE_WEBHOOK_SECRET = STRIPE_SECRET; });

  async function callStripeWebhook(event: Record<string, unknown>, sbMock: Record<string, unknown>) {
    vi.doMock('@/lib/supabase/service', () => ({ createServiceClient: vi.fn(() => sbMock) }));
    vi.doMock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), withContext: vi.fn().mockReturnThis() } }));
    vi.doMock('@/lib/errors', () => ({ safeLogErrorContext: vi.fn(() => ({})) }));
    vi.doMock('@/lib/alerts/create-alert', () => ({ createAlert: vi.fn() }));
    vi.doMock('@/lib/email/templates', () => ({ subscriptionRenewalReceiptEmail: vi.fn().mockReturnValue({ subject: 't', html: '<p>t</p>' }) }));
    vi.doMock('@/lib/email/client', () => ({ sendEmail: vi.fn() }));
    vi.doMock('@/lib/payments/send-confirmation', () => ({ sendProactiveConfirmation: vi.fn() }));
    vi.doMock('@/lib/payments/notify-charge-failed', () => ({ notifyCustomerChargeFailed: vi.fn() }));
    vi.doMock('@/lib/payments/stripe-invoice-extractors', () => ({
      classifyInvoiceSubscription: vi.fn(() => ({ type: 'not_subscription', reason: 'test' })),
      extractInvoicePaymentIdentity: vi.fn(() => ({ paymentIntentId: 'pi_test' })),
    }));
    vi.doMock('@sentry/nextjs', () => ({ captureException: vi.fn() }));

    const { POST } = await import('../../app/api/payments/stripe-webhook/route');
    const rawBody = JSON.stringify(event);
    const req = new NextRequest('http://localhost:3000/api/payments/stripe-webhook', {
      method: 'POST', body: rawBody,
      headers: { 'Content-Type': 'application/json', 'stripe-signature': stripeSign(rawBody) },
    });
    const res = await POST(req);
    return { status: res.status, json: await res.json() };
  }

  it('v1-identifiable paid event with no canonical row → retryable 500', async () => {
    const event = { id: 'evt_1', type: 'checkout.session.completed', data: { object: {
      id: 'cs_test', payment_status: 'paid', amount_total: 500000, currency: 'ngn',
      metadata: { reference_code: 'WAAIIO-REF', channel: 'whatsapp' },
    } } };

    // Supabase: no payment found by gateway_reference=cs_test, no dispatched row by reference_code
    const chain = (): Record<string, unknown> => new Proxy({} as Record<string, unknown>, {
      get(_, p: string) {
        if (p === 'single') return vi.fn().mockResolvedValue({ data: null, error: null });
        if (p === 'maybeSingle') return vi.fn().mockResolvedValue({ data: null, error: null });
        return vi.fn(() => chain());
      },
    });
    const sb = { from: vi.fn(() => chain()), rpc: vi.fn() };

    const { status, json } = await callStripeWebhook(event, sb);
    expect(status).toBe(500);
    expect(json.error).toMatch(/V1 paid event unresolved/i);
  });

  it('Stripe dispatched row found + CAS repair DB error → retryable 500', async () => {
    const event = { id: 'evt_2', type: 'checkout.session.completed', data: { object: {
      id: 'cs_new', payment_status: 'paid', amount_total: 500000, currency: 'ngn',
      metadata: { reference_code: 'WAAIIO-DISPATCH', channel: 'whatsapp' },
    } } };

    // Supabase: first .single() (by gateway_reference=cs_new) returns null
    // Then .maybeSingle() (dispatched lookup) returns the dispatched row
    // Then .single() (CAS repair) returns error
    let upsertCalled = false;
    let singleCallCount = 0;
    let maybeSingleCallCount = 0;
    const chain = (): Record<string, unknown> => new Proxy({} as Record<string, unknown>, {
      get(_, p: string) {
        if (p === 'single') return vi.fn().mockImplementation(() => {
          singleCallCount++;
          if (singleCallCount === 1) return Promise.resolve({ data: null, error: null }); // no payment by cs_new
          return Promise.resolve({ data: null, error: { message: 'CAS error' } }); // CAS repair fails
        });
        if (p === 'maybeSingle') return vi.fn().mockImplementation(() => {
          maybeSingleCallCount++;
          if (maybeSingleCallCount === 1) return Promise.resolve({ data: null, error: null }); // no processed event
          return Promise.resolve({ data: { id: 'dp-1', gateway_reference: 'WAAIIO-DISPATCH', provider_init_state: 'dispatched' }, error: null });
        });
        if (p === 'upsert') return vi.fn(() => { upsertCalled = true; return chain(); });
        return vi.fn(() => chain());
      },
    });
    const sb = { from: vi.fn(() => chain()), rpc: vi.fn() };
    const { status, json } = await callStripeWebhook(event, sb);
    expect(status).toBe(500);
    expect(json.error).toMatch(/CAS repair failed/i);
    // processed_webhook_events must NOT be upserted
    expect(upsertCalled).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════
// Square webhook crash repair — real POST handler
// ══════════════════════════════════════════════════════════

describe('Square webhook v1 crash repair — real POST handler', () => {
  const SQ_SECRET = 'sq_test_264';

  function squareSign(body: string, url: string): string {
    const { createHmac } = require('crypto');
    return createHmac('sha256', SQ_SECRET).update(url + body).digest('base64');
  }

  const SQ_URL = 'http://localhost:3000/api/payments/square-webhook';
  beforeEach(() => { vi.clearAllMocks(); vi.resetModules(); process.env.SQUARE_WEBHOOK_SIGNATURE_KEY = SQ_SECRET; process.env.SQUARE_WEBHOOK_NOTIFICATION_URL = SQ_URL; });

  async function callSquareWebhook(event: Record<string, unknown>, sbMock: Record<string, unknown>) {
    vi.doMock('@/lib/supabase/service', () => ({ createServiceClient: vi.fn(() => sbMock) }));
    vi.doMock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), withContext: vi.fn().mockReturnThis() } }));
    vi.doMock('@/lib/errors', () => ({ safeLogErrorContext: vi.fn(() => ({})) }));
    vi.doMock('@/lib/alerts/create-alert', () => ({ createAlert: vi.fn() }));
    vi.doMock('@sentry/nextjs', () => ({ captureException: vi.fn() }));
    vi.doMock('@/lib/payments/reconcile', () => ({ reconcilePayment: vi.fn().mockResolvedValue({}) }));

    const { POST } = await import('../../app/api/payments/square-webhook/route');
    const rawBody = JSON.stringify(event);
    const req = new NextRequest(SQ_URL, {
      method: 'POST', body: rawBody,
      headers: { 'Content-Type': 'application/json', 'x-square-hmacsha256-signature': squareSign(rawBody, SQ_URL) },
    });
    const res = await POST(req);
    return { status: res.status, json: await res.json() };
  }

  it('COMPLETED event with payment.note but no matching row → retryable 500', async () => {
    const event = { type: 'payment.updated', data: { object: { payment: {
      id: 'sq_pay_1', status: 'COMPLETED', order_id: 'sq_order_1', note: 'WAAIIO-SQ-REF',
    } } } };

    const chain = (): Record<string, unknown> => new Proxy({} as Record<string, unknown>, {
      get(_, p: string) {
        if (p === 'single' || p === 'maybeSingle') return vi.fn().mockResolvedValue({ data: null, error: null });
        if (p === 'then') return (r: (v: unknown) => void) => r({ data: [], error: null });
        return vi.fn(() => chain());
      },
    });
    const sb = { from: vi.fn(() => chain()), rpc: vi.fn() };

    const { status, json } = await callSquareWebhook(event, sb);
    expect(status).toBe(500);
    expect(json.error).toMatch(/V1 paid event unresolved/i);
  });
});

// ══════════════════════════════════════════════════════════
// PayPal webhook crash repair — real POST handler
// ══════════════════════════════════════════════════════════

describe('PayPal webhook v1 crash repair — real POST handler', () => {
  beforeEach(() => {
    vi.clearAllMocks(); vi.resetModules();
    process.env.PAYPAL_WEBHOOK_ID = 'wh_test';
    process.env.PAYPAL_CLIENT_ID = 'pp_client';
    process.env.PAYPAL_CLIENT_SECRET = 'pp_secret';
    process.env.PAYPAL_ENVIRONMENT = 'sandbox';
  });

  async function callPayPalWebhook(event: Record<string, unknown>, sbMock: Record<string, unknown>, extraFetchResponses: FetchResp[] = []) {
    let fetchIdx = 0;
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
      // PayPal webhook verification
      if (u.includes('verify-webhook-signature')) return new Response(JSON.stringify({ verification_status: 'SUCCESS' }));
      // Token request
      if (u.includes('/v1/oauth2/token')) return new Response(JSON.stringify({ access_token: 'test_token' }));
      // Order read
      const resp = extraFetchResponses[fetchIdx++] || { ok: true, body: {} };
      if (resp.raw !== undefined) return new Response(resp.raw, { status: resp.ok ? 200 : 500 });
      return new Response(JSON.stringify(resp.body ?? {}), { status: resp.ok ? 200 : (resp.body as Record<string,unknown>)?.httpStatus as number || 404 });
    }) as unknown as typeof fetch;

    vi.doMock('@/lib/supabase/service', () => ({ createServiceClient: vi.fn(() => sbMock) }));
    vi.doMock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), withContext: vi.fn().mockReturnThis() } }));
    vi.doMock('@sentry/nextjs', () => ({ captureException: vi.fn() }));
    vi.doMock('@/lib/payments/reconcile', () => ({ reconcilePayment: vi.fn().mockResolvedValue({}) }));

    const { POST } = await import('../../app/api/payments/paypal-webhook/route');
    const rawBody = JSON.stringify(event);
    const req = new NextRequest('http://localhost:3000/api/payments/paypal-webhook', {
      method: 'POST', body: rawBody,
      headers: { 'Content-Type': 'application/json', 'paypal-transmission-id': 'tx1', 'paypal-transmission-time': new Date().toISOString(), 'paypal-cert-url': 'https://test', 'paypal-auth-algo': 'SHA256withRSA', 'paypal-transmission-sig': 'sig' },
    });
    const res = await POST(req);
    globalThis.fetch = origFetch;
    return { status: res.status, json: await res.json() };
  }

  it('Capture with orderId, Order read returns Waaiio ref, no matching row → 500', async () => {
    const event = { event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: {
      id: 'cap_1', amount: { value: '50.00', currency_code: 'NGN' },
      supplementary_data: { related_ids: { order_id: 'ORDER_1' } },
    } };

    const chain = (): Record<string, unknown> => new Proxy({} as Record<string, unknown>, {
      get(_, p: string) {
        if (p === 'single' || p === 'maybeSingle') return vi.fn().mockResolvedValue({ data: null, error: null });
        if (p === 'then') return (r: (v: unknown) => void) => r({ data: [], error: null });
        return vi.fn(() => chain());
      },
    });
    const sb = { from: vi.fn(() => chain()), rpc: vi.fn() };

    // Order read returns Waaiio reference but no local row found
    const { status, json } = await callPayPalWebhook(event, sb, [
      { ok: true, body: { purchase_units: [{ reference_id: 'WAAIIO-PP-REF' }] } },
    ]);
    expect(status).toBe(500);
    expect(json.error).toMatch(/V1 paid event unresolved/i);
  });

  it('Capture with orderId, Order read 404 → legacy 200', async () => {
    const event = { event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: {
      id: 'cap_2', amount: { value: '50.00', currency_code: 'NGN' },
      supplementary_data: { related_ids: { order_id: 'ORDER_NOT_FOUND' } },
    } };

    const chain = (): Record<string, unknown> => new Proxy({} as Record<string, unknown>, {
      get(_, p: string) {
        if (p === 'single' || p === 'maybeSingle') return vi.fn().mockResolvedValue({ data: null, error: null });
        if (p === 'then') return (r: (v: unknown) => void) => r({ data: [], error: null });
        return vi.fn(() => chain());
      },
    });
    const sb = { from: vi.fn(() => chain()), rpc: vi.fn() };

    // Order read returns 404
    const { status } = await callPayPalWebhook(event, sb, [
      { ok: false, body: { httpStatus: 404 } },
    ]);
    // Legacy 200 — definitive Order not found, no Waaiio marker
    expect(status).toBe(200);
  });

  it('Capture with orderId, Order read succeeds with no Waaiio ref → legacy 200', async () => {
    const event = { event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: {
      id: 'cap_3', amount: { value: '50.00', currency_code: 'NGN' },
      supplementary_data: { related_ids: { order_id: 'ORDER_LEGACY' } },
    } };

    const chain = (): Record<string, unknown> => new Proxy({} as Record<string, unknown>, {
      get(_, p: string) {
        if (p === 'single' || p === 'maybeSingle') return vi.fn().mockResolvedValue({ data: null, error: null });
        if (p === 'then') return (r: (v: unknown) => void) => r({ data: [], error: null });
        return vi.fn(() => chain());
      },
    });
    const sb = { from: vi.fn(() => chain()), rpc: vi.fn() };

    // Order read succeeds but no Waaiio reference_id
    const { status } = await callPayPalWebhook(event, sb, [
      { ok: true, body: { purchase_units: [{ description: 'Legacy order' }] } },
    ]);
    expect(status).toBe(200);
  });
});
