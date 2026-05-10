import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the factory before importing
vi.mock('../factory', () => ({
  getPaymentGatewayByName: vi.fn(),
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
      const selectFn = vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue(config.selectResult || { data: null, error: null }),
          maybeSingle: vi.fn().mockResolvedValue(config.maybeSingleResult || { data: null, error: null }),
          is: vi.fn().mockResolvedValue(config.updateResult || { data: null, error: null }),
        }),
        in: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue(config.selectResult || { data: null, error: null }),
        }),
      });

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
      refundPayment: vi.fn().mockResolvedValue({ success: true, gatewayRefundReference: 'gw-ref-1' }),
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

    const result = await processRefund({
      supabase: supabase as any,
      paymentId: 'pay-1',
      businessId: 'biz-1',
      amount: 3000, // Only 2000 remaining
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

  it('processes full refund via gateway and updates payment to refunded', async () => {
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

  it('processes partial refund without changing payment status', async () => {
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

  it('handles direct_split refund (record-only, no gateway call)', async () => {
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

  it('returns failure when gateway refund fails', async () => {
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
    expect(result.refundId).toBe('refund-4');
  });

  it('allows refund on already-partially-refunded payment', async () => {
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
