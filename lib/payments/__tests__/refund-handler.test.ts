import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../factory', () => ({
  getPaymentGatewayByName: vi.fn(),
}));

const mockServiceClient: Record<string, unknown> = {};
vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: vi.fn(() => mockServiceClient),
}));

import { processRefund } from '../refund-handler';
import { getPaymentGatewayByName } from '../factory';

const mockGetGateway = getPaymentGatewayByName as ReturnType<typeof vi.fn>;

// ── Flexible mock builder ──
// Returns a chainable proxy where every method returns a thenable proxy.
// Terminal methods (.single, .maybeSingle) resolve to configured data.
// Awaiting the chain directly resolves to the array result.
function chain(terminalData: unknown = null, arrayData: unknown[] = []) {
  const result = { data: terminalData, error: null };
  const arrayResult = { data: arrayData, error: null };
  const p: Record<string, unknown> = {};
  const h: ProxyHandler<Record<string, unknown>> = {
    get(_, prop) {
      if (prop === 'then') return (r: (v: unknown) => void) => Promise.resolve(arrayResult).then(r);
      if (prop === 'single') return vi.fn().mockResolvedValue(result);
      if (prop === 'maybeSingle') return vi.fn().mockResolvedValue(result);
      return vi.fn().mockReturnValue(new Proxy(p, h));
    },
  };
  return new Proxy(p, h);
}

function errorChain(error: Record<string, unknown>) {
  const result = { data: null, error };
  const p: Record<string, unknown> = {};
  const h: ProxyHandler<Record<string, unknown>> = {
    get(_, prop) {
      if (prop === 'then') return (r: (v: unknown) => void) => Promise.resolve(result).then(r);
      if (prop === 'single') return vi.fn().mockResolvedValue(result);
      if (prop === 'maybeSingle') return vi.fn().mockResolvedValue(result);
      return vi.fn().mockReturnValue(new Proxy(p, h));
    },
  };
  return new Proxy(p, h);
}

// Track provider call count
let providerCallCount = 0;
let lastProviderIdempotencyKey: string | undefined;

function setupMocks(opts: {
  payment?: Record<string, unknown>;
  business?: Record<string, unknown>;
  ledgerRefunds?: unknown[];
  existingNonTerminal?: Record<string, unknown> | null;
  refundRow?: Record<string, unknown>;
  gatewayOutcome?: Record<string, unknown>;
  insertError?: { code: string } | null;
  credential?: Record<string, unknown> | null;
  claimResult?: unknown[];
  rpcResults?: Record<string, unknown>;
  refundUpdateError?: Record<string, unknown> | null;
}) {
  providerCallCount = 0;
  lastProviderIdempotencyKey = undefined;

  const defaultPayment = { id: 'pay-1', amount: 5000, currency: 'NGN', refund_amount: 0, status: 'success', gateway: 'paystack', gateway_reference: 'ref-1', booking_id: null, metadata: null, business_id: 'biz-1' };
  const defaultRefundRow = { id: 'refund-1', amount: 5000, gateway: 'paystack', refund_type: 'full', reason: null, connect_account_id: null, provider_connection_id: null, is_direct_split: false };

  // Authenticated supabase (for payment/business reads)
  const supabase = {
    from: vi.fn().mockImplementation((table: string) => {
      if (table === 'payments') return chain(opts.payment !== undefined ? opts.payment : defaultPayment);
      if (table === 'businesses') return chain(opts.business || { payout_mode: 'platform_managed' });
      return chain(null);
    }),
  };

  // Service client
  (mockServiceClient as Record<string, unknown>).from = vi.fn().mockImplementation((table: string) => {
    if (table === 'refunds') {
      return {
        select: vi.fn().mockReturnValue(
          chain(
            opts.existingNonTerminal !== undefined ? opts.existingNonTerminal : opts.refundRow || defaultRefundRow,
            opts.ledgerRefunds || [],
          )
        ),
        insert: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue(
              opts.insertError ? { data: null, error: opts.insertError } : { data: { id: 'refund-1' }, error: null }
            ),
          }),
        }),
        update: vi.fn().mockReturnValue(opts.refundUpdateError ? errorChain(opts.refundUpdateError) : chain(null)),
      };
    }
    if (table === 'business_payment_credentials') {
      return chain(opts.credential !== undefined ? opts.credential : null);
    }
    return chain(null);
  });

  (mockServiceClient as Record<string, unknown>).rpc = vi.fn().mockImplementation((name: string) => {
    if (opts.rpcResults?.[name] !== undefined) {
      return Promise.resolve({ data: opts.rpcResults[name], error: null });
    }
    if (name === 'claim_refund_dispatch') {
      return Promise.resolve({ data: opts.claimResult || [{ claimed: true }], error: null });
    }
    if (name === 'finalize_refund_execution') {
      return Promise.resolve({ data: { finalized: true, fully_refunded: false }, error: null });
    }
    if (name === 'recover_ambiguous_refund') {
      return Promise.resolve({ data: { recovered: true, recovery_token: 'tok-1' }, error: null });
    }
    if (name === 'recover_interrupted_dispatch') {
      return Promise.resolve({ data: { recovered: true, recovery_token: 'tok-2' }, error: null });
    }
    if (name === 'reconcile_pending_refund') {
      return Promise.resolve({ data: { reconciled: true, next_action: 'finalize' }, error: null });
    }
    return Promise.resolve({ data: null, error: null });
  });

  const mockRefundPayment = vi.fn().mockImplementation((callOpts: Record<string, unknown>) => {
    providerCallCount++;
    lastProviderIdempotencyKey = callOpts.idempotencyKey as string;
    return Promise.resolve(opts.gatewayOutcome || {
      success: true, outcome: 'terminal_success',
      providerRefundId: 'prov-1', providerStatus: 'succeeded',
      gatewayRefundReference: 'gw-ref-1',
    });
  });

  const mockQueryStatus = vi.fn().mockResolvedValue({
    providerStatus: 'succeeded', outcome: 'terminal_success', providerRefundId: 'prov-1',
  });

  mockGetGateway.mockReturnValue({
    refundPayment: mockRefundPayment,
    queryRefundStatus: mockQueryStatus,
  });

  return { supabase, mockRefundPayment, mockQueryStatus };
}

describe('processRefund', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  // ── Validation tests ──

  it('returns error when payment not found', async () => {
    const { supabase } = setupMocks({ payment: null as any });
    const r = await processRefund({ supabase: supabase as any, paymentId: 'p', businessId: 'biz-1', amount: 1000, initiatedBy: 'u', initiatedByRole: 'admin' });
    expect(r.success).toBe(false);
    expect(r.errorMessage).toBe('Payment not found');
  });

  it('rejects non-refundable payment status', async () => {
    const { supabase } = setupMocks({ payment: { id: 'p', amount: 5000, status: 'pending', gateway: 'paystack', gateway_reference: 'r' } });
    const r = await processRefund({ supabase: supabase as any, paymentId: 'p', businessId: 'biz-1', amount: 1000, initiatedBy: 'u', initiatedByRole: 'admin' });
    expect(r.success).toBe(false);
    expect(r.errorMessage).toContain('not refundable');
  });

  it('rejects amount exceeding remaining', async () => {
    const { supabase } = setupMocks({ ledgerRefunds: [{ amount: 4000 }] });
    const r = await processRefund({ supabase: supabase as any, paymentId: 'p', businessId: 'biz-1', amount: 2000, initiatedBy: 'u', initiatedByRole: 'admin' });
    expect(r.success).toBe(false);
    expect(r.errorMessage).toContain('exceeds remaining');
  });

  // ── Resume: provider_success_unfinalized → finalize locally (0 provider calls) ──

  it('provider_success_unfinalized resumes with local finalization only', async () => {
    const { supabase, mockRefundPayment } = setupMocks({
      insertError: { code: '23505' },
      existingNonTerminal: { id: 'ref-existing', status: 'provider_success_unfinalized', gateway: 'paystack', dispatched_at: new Date().toISOString(), provider_connection_id: null },
    });
    const r = await processRefund({ supabase: supabase as any, paymentId: 'p', businessId: 'biz-1', amount: 5000, initiatedBy: 'u', initiatedByRole: 'admin' });
    expect(r.success).toBe(true);
    expect(r.refundId).toBe('ref-existing');
    expect(providerCallCount).toBe(0); // NO provider call
    expect(mockRefundPayment).not.toHaveBeenCalled();
  });

  // ── Resume: provider_pending → reconciliation (GET query, no dispatch) ──

  it('provider_pending resumes with reconciliation query only', async () => {
    const { supabase, mockRefundPayment, mockQueryStatus } = setupMocks({
      insertError: { code: '23505' },
      existingNonTerminal: { id: 'ref-pending', status: 'provider_pending', gateway: 'paystack', dispatched_at: new Date().toISOString(), provider_refund_id: 'prov-123', provider_connection_id: null },
    });
    const r = await processRefund({ supabase: supabase as any, paymentId: 'p', businessId: 'biz-1', amount: 5000, initiatedBy: 'u', initiatedByRole: 'admin' });
    expect(r.success).toBe(true); // reconciliation found terminal_success → finalized
    expect(mockRefundPayment).not.toHaveBeenCalled(); // NO new dispatch
    expect(mockQueryStatus).toHaveBeenCalled(); // GET reconciliation
  });

  // ── Resume: Tier-2 ambiguous → fail closed ──

  it('Tier-2 ambiguous cannot auto-replay', async () => {
    const { supabase, mockRefundPayment } = setupMocks({
      insertError: { code: '23505' },
      existingNonTerminal: { id: 'ref-amb', status: 'provider_ambiguous', gateway: 'paystack', dispatched_at: new Date().toISOString(), provider_connection_id: null },
    });
    const r = await processRefund({ supabase: supabase as any, paymentId: 'p', businessId: 'biz-1', amount: 5000, initiatedBy: 'u', initiatedByRole: 'admin' });
    expect(r.success).toBe(false);
    expect(r.errorMessage).toContain('reconciliation');
    expect(mockRefundPayment).not.toHaveBeenCalled();
  });

  // ── Resume: Tier-2 interrupted → fail closed ──

  it('Tier-2 interrupted dispatch cannot auto-replay', async () => {
    const { supabase, mockRefundPayment } = setupMocks({
      insertError: { code: '23505' },
      existingNonTerminal: { id: 'ref-int', status: 'pending', gateway: 'paystack', dispatched_at: new Date().toISOString(), provider_connection_id: null },
    });
    const r = await processRefund({ supabase: supabase as any, paymentId: 'p', businessId: 'biz-1', amount: 5000, initiatedBy: 'u', initiatedByRole: 'admin' });
    expect(r.success).toBe(false);
    expect(mockRefundPayment).not.toHaveBeenCalled();
  });

  // ── Resume: Tier-1 ambiguous → same-attempt recovery ──

  it('Tier-1 ambiguous recovery reuses same refund ID', async () => {
    const { supabase } = setupMocks({
      insertError: { code: '23505' },
      existingNonTerminal: { id: 'ref-amb-t1', status: 'provider_ambiguous', gateway: 'stripe', dispatched_at: new Date().toISOString(), provider_connection_id: null },
    });
    const r = await processRefund({ supabase: supabase as any, paymentId: 'p', businessId: 'biz-1', amount: 5000, initiatedBy: 'u', initiatedByRole: 'admin' });
    // Recovery token passed to claim_refund_dispatch
    const rpcCalls = (mockServiceClient as Record<string, unknown>).rpc as ReturnType<typeof vi.fn>;
    const claimCall = rpcCalls.mock.calls.find((c: unknown[]) => c[0] === 'claim_refund_dispatch');
    expect(claimCall).toBeDefined();
    expect(claimCall?.[1]?.p_recovery_token).toBe('tok-1'); // recovery token from RPC
  });

  // ── New attempt: uses refund ID as idempotency key ──

  it('new attempt uses refund row ID as provider idempotency key', async () => {
    const { supabase } = setupMocks({});
    await processRefund({ supabase: supabase as any, paymentId: 'p', businessId: 'biz-1', amount: 5000, initiatedBy: 'u', initiatedByRole: 'admin' });
    expect(lastProviderIdempotencyKey).toBe('refund-1');
  });

  // ── Resume: Tier-1 interrupted → token-bound recovery + re-dispatch ──

  it('Tier-1 interrupted recovery dispatches with recovery token (same attempt)', async () => {
    const { supabase } = setupMocks({
      insertError: { code: '23505' },
      existingNonTerminal: { id: 'ref-int-t1', status: 'pending', gateway: 'stripe', dispatched_at: new Date().toISOString(), provider_connection_id: null, connect_account_id: null },
    });
    const r = await processRefund({ supabase: supabase as any, paymentId: 'p', businessId: 'biz-1', amount: 5000, initiatedBy: 'u', initiatedByRole: 'admin' });
    const rpcCalls = (mockServiceClient as Record<string, unknown>).rpc as ReturnType<typeof vi.fn>;
    // Must call recover_interrupted_dispatch
    const recoverCall = rpcCalls.mock.calls.find((c: unknown[]) => c[0] === 'recover_interrupted_dispatch');
    expect(recoverCall).toBeDefined();
    // Then claim_refund_dispatch with the recovery token
    const claimCall = rpcCalls.mock.calls.find((c: unknown[]) => c[0] === 'claim_refund_dispatch');
    expect(claimCall).toBeDefined();
    expect(claimCall?.[1]?.p_recovery_token).toBe('tok-2');
    // Exactly one provider dispatch (same attempt, not a new one)
    expect(providerCallCount).toBe(1);
  });

  // ── Post-dispatch persistence failure → recovery-required, no replacement ──

  it('post-dispatch persistence failure returns recovery-required without replacement attempt', async () => {
    const { supabase, mockRefundPayment } = setupMocks({
      refundUpdateError: { message: 'DB write failed', code: '42000' },
    });
    const r = await processRefund({ supabase: supabase as any, paymentId: 'p', businessId: 'biz-1', amount: 5000, initiatedBy: 'u', initiatedByRole: 'admin' });
    expect(r.success).toBe(false);
    expect(r.errorMessage).toContain('persistence failed');
    // Only one provider call — no replacement attempt
    expect(providerCallCount).toBe(1);
  });

  // ── BYO credential identity honored on reconciliation ──

  it('reconciliation uses persisted BYO provider credential identity', async () => {
    const { supabase, mockQueryStatus } = setupMocks({
      insertError: { code: '23505' },
      existingNonTerminal: { id: 'ref-byo', status: 'provider_pending', gateway: 'stripe', dispatched_at: new Date().toISOString(), provider_refund_id: 'prov-byo', provider_connection_id: 'cred-123', connect_account_id: null },
      credential: { secret_key: 'test-byo-key-mock', connect_account_id: 'acct_byo' },
    });
    const r = await processRefund({ supabase: supabase as any, paymentId: 'p', businessId: 'biz-1', amount: 5000, initiatedBy: 'u', initiatedByRole: 'admin' });
    // queryRefundStatus must use the persisted BYO credential
    expect(mockQueryStatus).toHaveBeenCalledWith('prov-byo', {
      byoSecretKey: 'test-byo-key-mock',
      connectAccountId: 'acct_byo',
    });
  });
});
