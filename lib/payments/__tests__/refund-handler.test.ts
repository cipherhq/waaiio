import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the factory and service client before importing
vi.mock('../factory', () => ({
  getPaymentGatewayByName: vi.fn(),
}));

// Mock service client — the handler uses it for execution-ledger writes
const mockServiceClient: Record<string, unknown> = {};
vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: vi.fn(() => mockServiceClient),
}));

import { processRefund } from '../refund-handler';
import { getPaymentGatewayByName } from '../factory';

const mockGetGateway = getPaymentGatewayByName as ReturnType<typeof vi.fn>;

// ── Mock Supabase Builder ──

interface MockTableConfig {
  selectResult?: { data: unknown; error: unknown };
  maybeSingleResult?: { data: unknown; error: unknown };
  updateResult?: { data: unknown; error: unknown };
  insertResult?: { data: unknown; error: unknown };
}

function createMockSupabase(tableConfigs: Record<string, MockTableConfig> = {}) {
  const calls: Record<string, { update: ReturnType<typeof vi.fn>; insert: ReturnType<typeof vi.fn> }> = {};

  // Build a chainable terminal object that supports arbitrary chaining
  // and resolves to the configured result at terminal methods (single/maybeSingle)
  function makeChainable(result: { data: unknown; error: unknown }) {
    const chain: Record<string, unknown> = {};
    const handler: ProxyHandler<Record<string, unknown>> = {
      get(_target, prop) {
        if (prop === 'then') return undefined; // not a thenable
        if (prop === 'single') return vi.fn().mockResolvedValue(result);
        if (prop === 'maybeSingle') return vi.fn().mockResolvedValue(result);
        // All other methods return the proxy for chaining
        return vi.fn().mockReturnValue(new Proxy(chain, handler));
      },
    };
    return new Proxy(chain, handler);
  }

  return {
    from: vi.fn((table: string) => {
      const config = tableConfigs[table] || {};
      const updateFn = vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          is: vi.fn().mockResolvedValue(config.updateResult || { data: null, error: null }),
        }),
      });
      const insertFn = vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue(config.insertResult || { data: { id: 'refund-1' }, error: null }),
        }),
      });

      // Use Proxy-based chaining for select to handle arbitrary .eq().eq().limit().maybeSingle() chains
      const selectResult = config.selectResult || { data: null, error: null };
      const maybeSingleResult = config.maybeSingleResult || { data: null, error: null };
      const selectFn = vi.fn().mockReturnValue(
        makeChainable(selectResult),
      );

      if (!calls[table]) {
        calls[table] = { update: updateFn, insert: insertFn };
      }

      return {
        select: selectFn,
        update: updateFn,
        insert: insertFn,
      };
    }),
    _calls: calls,
  };
}

describe('processRefund', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetGateway.mockReturnValue({
      refundPayment: vi.fn().mockResolvedValue({ success: true, outcome: 'terminal_success', gatewayRefundReference: 'gw-ref-1', providerRefundId: 'prov-1', providerStatus: 'succeeded' }),
    });

    // Set up service client mock for execution-ledger writes
    const makeServiceChain = () => {
      const chain: Record<string, unknown> = {};
      const handler: ProxyHandler<Record<string, unknown>> = {
        get(_target, prop) {
          if (prop === 'then') return undefined;
          if (prop === 'single') return vi.fn().mockResolvedValue({ data: { id: 'refund-1' }, error: null });
          if (prop === 'maybeSingle') return vi.fn().mockResolvedValue({ data: null, error: null });
          return vi.fn().mockReturnValue(new Proxy(chain, handler));
        },
      };
      return new Proxy(chain, handler);
    };

    // Service client mock — Proxy-based to handle arbitrary chaining
    const refundRow = { id: 'refund-1', amount: 5000, gateway: 'paystack', refund_type: 'full', reason: null, connect_account_id: null, provider_connection_id: null, is_direct_split: false };
    // Create a chainable mock that resolves to {data, error} when awaited
    const makeChainProxy = (terminalData: unknown = null, arrayData: unknown[] = []) => {
      const result = { data: terminalData, error: null };
      const arrayResult = { data: arrayData, error: null };
      const chain: Record<string, unknown> = {};
      const ph: ProxyHandler<Record<string, unknown>> = {
        get(_, prop) {
          // When awaited directly (no .single/.maybeSingle), resolve to array result
          if (prop === 'then') return (resolve: (v: unknown) => void) => Promise.resolve(arrayResult).then(resolve);
          if (prop === 'single') return vi.fn().mockResolvedValue(result);
          if (prop === 'maybeSingle') return vi.fn().mockResolvedValue(result);
          return vi.fn().mockReturnValue(new Proxy(chain, ph));
        },
      };
      return new Proxy(chain, ph);
    };

    (mockServiceClient as Record<string, unknown>).from = vi.fn().mockImplementation((table: string) => ({
      select: vi.fn().mockReturnValue(
        table === 'refunds' ? makeChainProxy(refundRow) : makeChainProxy(null)
      ),
      insert: vi.fn().mockReturnValue({ select: vi.fn().mockReturnValue({ single: vi.fn().mockResolvedValue({ data: { id: 'refund-1' }, error: null }) }) }),
      update: vi.fn().mockReturnValue(makeChainProxy(null)),
    }));

    // Service client: rpc() for claim + finalize
    (mockServiceClient as Record<string, unknown>).rpc = vi.fn().mockImplementation((name: string) => {
      if (name === 'claim_refund_dispatch') {
        return Promise.resolve({ data: [{ claimed: true, refund_id: 'refund-1', payment_id: 'pay-1', amount: 5000, gateway: 'paystack', gateway_reference: 'ref-1', refund_type: 'full', is_direct_split: false }], error: null });
      }
      if (name === 'finalize_refund_execution') {
        return Promise.resolve({ data: { finalized: true, fully_refunded: false }, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    });
  });

  it('returns error when payment is not found', async () => {
    const supabase = createMockSupabase({
      payments: { selectResult: { data: null, error: { message: 'not found' } } },
    });

    const result = await processRefund({
      supabase: supabase as any,
      paymentId: 'pay-1',
      businessId: 'biz-1',
      amount: 1000,
      initiatedBy: 'admin-1',
      initiatedByRole: 'admin',
    });

    expect(result.success).toBe(false);
    expect(result.errorMessage).toBe('Payment not found');
  });

  it('rejects refund on non-refundable payment status', async () => {
    const supabase = createMockSupabase({
      payments: {
        selectResult: {
          data: { id: 'pay-1', amount: 5000, refund_amount: 0, status: 'pending', gateway: 'paystack', gateway_reference: 'ref-1' },
          error: null,
        },
      },
    });

    const result = await processRefund({
      supabase: supabase as any,
      paymentId: 'pay-1',
      businessId: 'biz-1',
      amount: 5000,
      initiatedBy: 'admin-1',
      initiatedByRole: 'admin',
    });

    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('not refundable');
  });

  it('rejects refund amount exceeding remaining refundable', async () => {
    const supabase = createMockSupabase({
      payments: {
        selectResult: {
          data: { id: 'pay-1', amount: 5000, refund_amount: 3000, status: 'success', gateway: 'paystack', gateway_reference: 'ref-1' },
          error: null,
        },
      },
    });

    // Override service client to return existing 3000 in ledger
    (mockServiceClient as Record<string, unknown>).from = vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          eq: vi.fn().mockResolvedValue({ data: [{ amount: 3000 }], error: null }),
        }),
      }),
      insert: vi.fn().mockReturnValue({ select: vi.fn().mockReturnValue({ single: vi.fn().mockResolvedValue({ data: { id: 'refund-1' }, error: null }) }) }),
      update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ data: null, error: null }) }),
    });

    const result = await processRefund({
      supabase: supabase as any,
      paymentId: 'pay-1',
      businessId: 'biz-1',
      amount: 3000, // Only 2000 remaining (5000 - 3000 from ledger)
      initiatedBy: 'admin-1',
      initiatedByRole: 'admin',
    });

    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('exceeds remaining');
  });

  it('rejects zero or negative refund amount', async () => {
    const supabase = createMockSupabase({
      payments: {
        selectResult: {
          data: { id: 'pay-1', amount: 5000, refund_amount: 0, status: 'success', gateway: 'paystack', gateway_reference: 'ref-1' },
          error: null,
        },
      },
    });

    const result = await processRefund({
      supabase: supabase as any,
      paymentId: 'pay-1',
      businessId: 'biz-1',
      amount: 0,
      initiatedBy: 'admin-1',
      initiatedByRole: 'admin',
    });

    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('greater than 0');
  });

  it.skip('processes full refund via gateway and updates payment to refunded', async () => {
    const mockRefundPayment = vi.fn().mockResolvedValue({
      success: true,
      gatewayRefundReference: 'gw-ref-1',
      gatewayResponse: { status: 'reversed' },
    });
    mockGetGateway.mockReturnValue({ refundPayment: mockRefundPayment });

    const supabase = createMockSupabase({
      payments: {
        selectResult: {
          data: {
            id: 'pay-1', amount: 5000, refund_amount: 0, status: 'success',
            gateway: 'paystack', gateway_reference: 'ref-1', booking_id: 'book-1', metadata: null,
          },
          error: null,
        },
      },
      businesses: {
        selectResult: { data: { payout_mode: 'platform_managed' }, error: null },
      },
      refunds: {
        insertResult: { data: { id: 'refund-1' }, error: null },
      },
    });

    const result = await processRefund({
      supabase: supabase as any,
      paymentId: 'pay-1',
      businessId: 'biz-1',
      amount: 5000,
      reason: 'Customer request',
      initiatedBy: 'admin-1',
      initiatedByRole: 'admin',
    });

    expect(result.success).toBe(true);
    expect(result.refundId).toBe('refund-1');
    expect(mockRefundPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        gatewayReference: 'ref-1',
        amount: undefined, // Full refund with no prior partial = undefined
      }),
    );
  });

  it.skip('processes partial refund without changing payment status', async () => {
    const mockRefundPayment = vi.fn().mockResolvedValue({ success: true });
    mockGetGateway.mockReturnValue({ refundPayment: mockRefundPayment });

    const supabase = createMockSupabase({
      payments: {
        selectResult: {
          data: {
            id: 'pay-1', amount: 5000, refund_amount: 0, status: 'success',
            gateway: 'paystack', gateway_reference: 'ref-1', booking_id: null, metadata: null,
          },
          error: null,
        },
      },
      businesses: {
        selectResult: { data: { payout_mode: 'platform_managed' }, error: null },
      },
      refunds: {
        insertResult: { data: { id: 'refund-2' }, error: null },
      },
    });

    const result = await processRefund({
      supabase: supabase as any,
      paymentId: 'pay-1',
      businessId: 'biz-1',
      amount: 2000, // Partial: 2000 of 5000
      initiatedBy: 'admin-1',
      initiatedByRole: 'admin',
    });

    expect(result.success).toBe(true);
    // For partial refund, amount should be explicitly passed
    expect(mockRefundPayment).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 2000 }),
    );
  });

  it.skip('handles direct_split refund (record-only, no gateway call)', async () => {
    const mockRefundPayment = vi.fn();
    mockGetGateway.mockReturnValue({ refundPayment: mockRefundPayment });

    const supabase = createMockSupabase({
      payments: {
        selectResult: {
          data: {
            id: 'pay-1', amount: 5000, refund_amount: 0, status: 'success',
            gateway: 'paystack', gateway_reference: 'ref-1', booking_id: null, metadata: null,
          },
          error: null,
        },
      },
      businesses: {
        selectResult: { data: { payout_mode: 'direct_split' }, error: null },
      },
      refunds: {
        insertResult: { data: { id: 'refund-3' }, error: null },
      },
    });

    const result = await processRefund({
      supabase: supabase as any,
      paymentId: 'pay-1',
      businessId: 'biz-1',
      amount: 5000,
      initiatedBy: 'admin-1',
      initiatedByRole: 'admin',
    });

    expect(result.success).toBe(true);
    expect(result.isDirectSplit).toBe(true);
    // Gateway refund should NOT be called for direct_split
    expect(mockRefundPayment).not.toHaveBeenCalled();
  });

  it.skip('returns failure when gateway refund fails', async () => {
    mockGetGateway.mockReturnValue({
      refundPayment: vi.fn().mockResolvedValue({
        success: false,
        errorMessage: 'Insufficient balance',
        gatewayResponse: { error: 'Insufficient balance' },
      }),
    });

    const supabase = createMockSupabase({
      payments: {
        selectResult: {
          data: {
            id: 'pay-1', amount: 5000, refund_amount: 0, status: 'success',
            gateway: 'paystack', gateway_reference: 'ref-1', booking_id: null, metadata: null,
          },
          error: null,
        },
      },
      businesses: {
        selectResult: { data: { payout_mode: 'platform_managed' }, error: null },
      },
      refunds: {
        insertResult: { data: { id: 'refund-4' }, error: null },
      },
    });

    const result = await processRefund({
      supabase: supabase as any,
      paymentId: 'pay-1',
      businessId: 'biz-1',
      amount: 5000,
      initiatedBy: 'admin-1',
      initiatedByRole: 'admin',
    });

    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('Insufficient balance');
    expect(result.refundId).toBe('refund-1'); // from service client mock
  });

  it.skip('allows refund on already-partially-refunded payment', async () => {
    const mockRefundPayment = vi.fn().mockResolvedValue({ success: true });
    mockGetGateway.mockReturnValue({ refundPayment: mockRefundPayment });

    const supabase = createMockSupabase({
      payments: {
        selectResult: {
          data: {
            id: 'pay-1', amount: 5000, refund_amount: 2000, status: 'success',
            gateway: 'paystack', gateway_reference: 'ref-1', booking_id: null, metadata: null,
          },
          error: null,
        },
      },
      businesses: {
        selectResult: { data: { payout_mode: 'platform_managed' }, error: null },
      },
      refunds: {
        insertResult: { data: { id: 'refund-5' }, error: null },
      },
    });

    const result = await processRefund({
      supabase: supabase as any,
      paymentId: 'pay-1',
      businessId: 'biz-1',
      amount: 3000, // Remaining 3000
      initiatedBy: 'admin-1',
      initiatedByRole: 'admin',
    });

    expect(result.success).toBe(true);
    // Should pass explicit amount since there are prior partial refunds
    expect(mockRefundPayment).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 3000 }),
    );
  });
});
