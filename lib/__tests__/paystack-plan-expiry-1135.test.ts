// #1135 / M554: a Waaiio plan billed by Paystack whose renewal was stopped
// moves to Free after its paid period, through the same evidence authority as
// Stripe and Flutterwave.
//
// Part 1: paystackPlanExpiryEvidence decides the evidence from Paystack's own
// subscription record (fetch is synthetic; no network call). It is terminal
// only when Paystack will not renew and lists no paid invoice in the window.
// Part 2: the subscription-renewal-recovery Paystack pass picks exactly the
// stopped, ended, cooled-down Paystack plans and records evidence for their
// exact period boundary (in-memory database). The SQL authority itself
// (expire_subscription_with_authority with the M554 Paystack branch) is proved
// on the full-history database in provider-neutral-subscriptions-db.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createMemoryDb, type MemoryDb } from './helpers/memory-db';

const PERIOD_END = '2026-11-01T00:00:00.000Z';
const DAY = 86_400_000;
const at = (offsetDays: number) => new Date(Date.parse(PERIOD_END) + offsetDays * DAY).toISOString();

describe('paystackPlanExpiryEvidence', () => {
  const fetchMock = vi.fn();
  const reply = (data: Record<string, unknown>, status = 200) =>
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ status: true, data }), { status }));
  const load = async () => (await import('@/lib/payments/paystack-plan-expiry-evidence')).paystackPlanExpiryEvidence;

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('PAYSTACK_SECRET_KEY', 'sk_test_synthetic');
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  it('cancelled with no paid invoice in the window → terminal_no_payment', async () => {
    reply({ status: 'cancelled', invoices: [{ status: 'success', paid_at: at(-30) }, { status: 'failed', created_at: at(0) }] });
    const evidence = await (await load())('SUB_x', PERIOD_END);
    expect(evidence).toEqual({ outcome: 'terminal_no_payment', providerStatus: 'cancelled', invoiceCount: 2, paidInWindow: 0 });
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://api.paystack.co/subscription/SUB_x');
  });

  it('completed and non-renewing are also terminal when nothing was paid', async () => {
    reply({ status: 'completed', invoices: [] });
    expect((await (await load())('SUB_x', PERIOD_END)).outcome).toBe('terminal_no_payment');
    reply({ status: 'non-renewing', invoices: [] });
    expect((await (await load())('SUB_x', PERIOD_END)).outcome).toBe('terminal_no_payment');
  });

  it('a paid invoice in the window (or one with no date) is ambiguous, never terminal', async () => {
    reply({ status: 'cancelled', invoices: [{ status: 'success', paid_at: at(-0.5) }] });
    expect((await (await load())('SUB_x', PERIOD_END)).outcome).toBe('ambiguous');
    reply({ status: 'cancelled', invoices: [], most_recent_invoice: { paid: true } });
    expect((await (await load())('SUB_x', PERIOD_END))).toMatchObject({ outcome: 'ambiguous', paidInWindow: 1 });
  });

  it('only a payment date rules a paid invoice out: an old created_at or period_start does not (review B S2)', async () => {
    reply({ status: 'cancelled', invoices: [{ status: 'success', created_at: at(-30), period_start: at(-30) }] });
    expect((await (await load())('SUB_x', PERIOD_END))).toMatchObject({ outcome: 'ambiguous', paidInWindow: 1 });
  });

  it('no invoice list in the reply is unavailable, never terminal (review B S1)', async () => {
    reply({ status: 'cancelled' });
    expect((await (await load())('SUB_x', PERIOD_END)).outcome).toBe('unavailable');
    reply({ status: 'cancelled', most_recent_invoice: { status: 'failed' } });
    expect((await (await load())('SUB_x', PERIOD_END)).outcome).toBe('unavailable');
  });

  it('active or attention means Paystack may still charge', async () => {
    reply({ status: 'active' });
    expect((await (await load())('SUB_x', PERIOD_END)).outcome).toBe('provider_active_or_retrying');
    reply({ status: 'attention' });
    expect((await (await load())('SUB_x', PERIOD_END)).outcome).toBe('provider_active_or_retrying');
  });

  it('read problems are unavailable, never terminal', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 500 }));
    expect((await (await load())('SUB_x', PERIOD_END)).outcome).toBe('unavailable');
    fetchMock.mockRejectedValueOnce(new Error('timeout'));
    expect((await (await load())('SUB_x', PERIOD_END)).outcome).toBe('unavailable');
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ status: false, message: 'Subscription not found' })));
    expect((await (await load())('SUB_x', PERIOD_END)).outcome).toBe('unavailable');
    reply({ status: 'something_new' });
    expect((await (await load())('SUB_x', PERIOD_END)).outcome).toBe('unavailable');
    reply({ status: 'cancelled', invoices: 'not-a-list' });
    expect((await (await load())('SUB_x', PERIOD_END)).outcome).toBe('unavailable');
  });

  it('no key, no code or a bad period end: unavailable without calling Paystack', async () => {
    const evidence = await load();
    vi.stubEnv('PAYSTACK_SECRET_KEY', '');
    expect((await evidence('SUB_x', PERIOD_END)).outcome).toBe('unavailable');
    vi.stubEnv('PAYSTACK_SECRET_KEY', 'sk_test_synthetic');
    expect((await evidence('', PERIOD_END)).outcome).toBe('unavailable');
    expect((await evidence('SUB_x', 'not-a-date')).outcome).toBe('unavailable');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ── Part 2: the cron pass ──

const c = vi.hoisted(() => ({
  db: null as unknown as MemoryDb,
  rpc: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  recordError: null as null | { message: string },
  evidence: vi.fn(),
}));

vi.mock('@/lib/cron-auth', () => ({ verifyCronAuth: () => null }));
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }));
vi.mock('@/lib/observability/report-failure', () => ({ reportFailure: vi.fn() }));
vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    from: (table: string) => c.db.from(table),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      c.rpc.push({ fn, args });
      if (fn === 'claim_overdue_subscription_batch') return { data: [], error: null };
      if (fn === 'record_reconciliation_evidence') return c.recordError ? { data: null, error: c.recordError } : { data: { recorded: true }, error: null };
      throw new Error(`unexpected rpc ${fn}`);
    },
  }),
}));

describe('subscription-renewal-recovery: Paystack expiry evidence pass', () => {
  const NOW = Date.now();
  const iso = (ms: number) => new Date(ms).toISOString();
  const row = (id: string, patch: Record<string, unknown> = {}) => ({
    id, business_id: `biz-${id}`, plan: 'growth', status: 'active', gateway: 'paystack',
    paystack_subscription_code: `SUB_${id}`, cancelled_at: iso(NOW - 40 * DAY),
    current_period_end: iso(NOW - 2 * DAY), last_reconciliation_attempt_at: null, ...patch,
  });

  beforeEach(async () => {
    c.rpc = []; c.recordError = null;
    c.evidence.mockReset();
    c.evidence.mockResolvedValue({ outcome: 'terminal_no_payment', providerStatus: 'cancelled', invoiceCount: 1, paidInWindow: 0 });
    vi.doMock('@/lib/payments/paystack-plan-expiry-evidence', () => ({ paystackPlanExpiryEvidence: c.evidence }));
    c.db = createMemoryDb({
      subscriptions: [
        row('due'),
        row('cooled', { last_reconciliation_attempt_at: iso(NOW - 5 * 60 * 60 * 1000) }),
        // Not picked:
        row('renewing', { cancelled_at: null }),
        row('in-period', { current_period_end: iso(NOW + 3 * DAY) }),
        row('recent-attempt', { last_reconciliation_attempt_at: iso(NOW - 60 * 60 * 1000) }),
        row('stripe', { gateway: 'stripe' }),
        row('expired', { status: 'expired' }),
        row('no-code', { paystack_subscription_code: null }),
      ],
    });
  });
  afterEach(() => { vi.doUnmock('@/lib/payments/paystack-plan-expiry-evidence'); vi.resetModules(); });

  const run = async () => {
    const { GET } = await import('@/app/api/cron/subscription-renewal-recovery/route');
    return (await GET(new NextRequest('https://app.test/api/cron/subscription-renewal-recovery'))).json();
  };
  const records = () => c.rpc.filter(r => r.fn === 'record_reconciliation_evidence');

  it('records evidence only for stopped, ended, cooled-down Paystack plans, for their exact period boundary', async () => {
    const body = await run();
    expect(body).toMatchObject({ ok: true, paystackExpiryEvidence: 2 });
    expect(records().map(r => r.args.p_subscription_id).sort()).toEqual(['cooled', 'due']);
    expect(records().find(r => r.args.p_subscription_id === 'due')!.args).toEqual({
      p_subscription_id: 'due', p_gateway: 'paystack', p_provider_subscription_id: 'SUB_due',
      p_period_boundary: c.db.tables.subscriptions[0].current_period_end, p_outcome: 'terminal_no_payment',
      p_source_key: 'renewal_recovery_paystack_due', p_evidence_tx_count: 1, p_evidence_matched_count: 0,
      p_evidence_provider_status: 'cancelled',
    });
    expect(c.evidence.mock.calls.map(call => call[0]).sort()).toEqual(['SUB_cooled', 'SUB_due']);
    // The attempt is stamped so the next run cools down.
    expect(c.db.tables.subscriptions.find(r => r.id === 'due')!.last_reconciliation_attempt_at).toEqual(expect.any(String));
    // The pass never changes a plan's status; only the expiry authority can.
    expect(c.db.tables.subscriptions.every(r => r.id === 'expired' ? r.status === 'expired' : r.status === 'active')).toBe(true);
  });

  it('records whatever the evidence says (ambiguous stays ambiguous)', async () => {
    c.evidence.mockResolvedValue({ outcome: 'ambiguous', providerStatus: 'cancelled', invoiceCount: 2, paidInWindow: 1 });
    await run();
    expect(records().every(r => r.args.p_outcome === 'ambiguous' && r.args.p_evidence_matched_count === 1)).toBe(true);
  });

  it('a failed evidence write is not counted', async () => {
    c.recordError = { message: 'boom' };
    const body = await run();
    expect(body).toMatchObject({ paystackExpiryEvidence: 0 });
  });
});
