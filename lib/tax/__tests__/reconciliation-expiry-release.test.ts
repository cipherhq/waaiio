/**
 * Owner decision #980 (2026-11-11): a customer may pay again after a taxed
 * checkout ends. Real reconciliation cron with mocked Supabase and Stripe: when
 * the expiry webhook was missed, Stripe's own "expired" status releases the
 * taxed hold. Nothing else releases it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const state = vi.hoisted(() => ({
  stale: [] as Array<Record<string, unknown>>,
  rpcCalls: [] as Array<{ fn: string; args: any }>,
  reconcile: vi.fn(),
}));

function client() {
  const chain = (table: string, kind: 'stale' | 'dispatched' | 'other'): any => new Proxy({}, {
    get(_t, prop: string) {
      if (prop === 'then') return (resolve: (v: unknown) => unknown) =>
        resolve({ data: kind === 'stale' ? state.stale : [], error: null });
      // The stale query uses .or(...); the dispatched-recovery query uses .eq('provider_init_state', ...).
      if (prop === 'select') return (cols: string) => chain(table, table === 'payments' && cols.includes('confirmation_sent_at') ? 'stale' : (table === 'payments' ? 'dispatched' : 'other'));
      return () => chain(table, kind);
    },
  });
  return {
    from: (table: string) => chain(table, 'other'),
    rpc: vi.fn(async (fn: string, args: unknown) => { state.rpcCalls.push({ fn, args }); return { data: true, error: null }; }),
  };
}

vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => client() }));
vi.mock('@/lib/cron-auth', () => ({ verifyCronAuth: () => null }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), withContext: vi.fn(() => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() })) },
}));
vi.mock('@/lib/observability/cron', () => ({ createCronLogger: () => ({ started: vi.fn(), completed: vi.fn(), failed: vi.fn() }) }));
vi.mock('@/lib/payments/process-success', () => ({ processSuccessfulPayment: vi.fn() }));
vi.mock('@/lib/payments/send-confirmation', () => ({ sendProactiveConfirmation: vi.fn() }));
vi.mock('@/lib/payments/reconcile', () => ({ reconcilePayment: (...args: unknown[]) => state.reconcile(...args) }));

vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_reconcile_only');
const { GET } = await import('@/app/api/cron/payment-reconciliation/route');

const stripeSession = vi.fn();
vi.stubGlobal('fetch', vi.fn(async (url: string) => {
  const status = stripeSession(url);
  return new Response(JSON.stringify({ id: 'cs', status, payment_status: 'unpaid' }), { status: 200 });
}));

const taxed = { id: 'pay-tax', amount: 12, gateway: 'stripe', gateway_reference: 'cs_tax_open', status: 'pending',
  provider_init_state: 'provider_confirmed', tax_allocation: { grossAmount: 1200 }, metadata: {} };

async function run() { return GET(new NextRequest('https://example.com/api/cron/payment-reconciliation')); }

describe('reconciliation releases an expired taxed Stripe checkout (#980)', () => {
  beforeEach(() => {
    state.rpcCalls = []; state.reconcile.mockReset(); stripeSession.mockReset();
    state.reconcile.mockResolvedValue({ providerOutcome: 'not_paid' });
  });

  it('releases when Stripe reports the session expired', async () => {
    state.stale = [taxed]; stripeSession.mockReturnValue('expired');
    expect((await run()).status).toBe(200);
    expect(state.rpcCalls).toEqual([{ fn: 'confirm_merchant_tax_payment_failure_980',
      args: { p_payment_id: 'pay-tax', p_gateway: 'stripe', p_reference: 'cs_tax_open', p_status: 'expired' } }]);
  });

  it('keeps the hold while the Stripe session is still open', async () => {
    state.stale = [taxed]; stripeSession.mockReturnValue('open');
    await run();
    expect(state.rpcCalls).toEqual([]);
  });

  it('does not touch untaxed or non-Stripe payments', async () => {
    state.stale = [{ ...taxed, tax_allocation: null }, { ...taxed, id: 'pay-ps', gateway: 'paystack', gateway_reference: 'ref-ps' }];
    stripeSession.mockReturnValue('expired');
    await run();
    expect(state.rpcCalls).toEqual([]);
    expect(stripeSession).not.toHaveBeenCalled();
  });
});
