/**
 * Square Integration Tests — Behavioral scenarios for refund claims,
 * finalization idempotency, verification transitions, and webhook reconciliation.
 *
 * Uses mocked Supabase RPC responses to test the handler logic without a live DB.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── 1. Claim replay with planned fee and parameter mismatch ──
describe('claim_refund_balance replay behavior', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('returns existing claim with planned_fee_reversal on retry', async () => {
    vi.resetModules();
    const { processRefund } = await import('@/lib/payments/refund-handler');

    const rpcResults: Record<string, unknown> = {
      claim_refund_balance: {
        claimed: true,
        refund_id: 'existing-refund-uuid',
        existing: true,
        planned_fee_reversal: 2.50,
      },
    };

    const mockSupabase = createMockSupabase({
      payment: {
        id: 'pay-1', amount: 100, currency: 'USD', refund_amount: 0, status: 'success',
        gateway: 'square', gateway_reference: 'link-1', booking_id: null, invoice_id: null,
        campaign_id: null, order_id: null, reservation_id: null, business_id: 'biz-1',
        metadata: { square_payment_id: 'sq-pay-1' }, payout_account_id: 'pa-1',
        collection_mode: 'connect', waaiio_fee: 2.50,
      },
      rpcResults,
      refundStatus: 'success', // existing refund already completed
    });

    const result = await processRefund({
      supabase: mockSupabase as never,
      paymentId: 'pay-1',
      businessId: 'biz-1',
      amount: 100,
      initiatedBy: 'user-1',
      initiatedByRole: 'business',
      logicalRefundId: 'idempotency-key-1',
    });

    // Should return existing state without re-calling Square
    expect(result.refundId).toBe('existing-refund-uuid');
    expect(result.providerStatus).toBe('success');
  });

  it('rejects parameter mismatch on claim replay', async () => {
    vi.resetModules();
    const { processRefund } = await import('@/lib/payments/refund-handler');

    const rpcResults: Record<string, unknown> = {
      claim_refund_balance: {
        claimed: false,
        reason: 'parameter_mismatch',
        detail: 'amount',
      },
    };

    const mockSupabase = createMockSupabase({
      payment: {
        id: 'pay-1', amount: 100, currency: 'USD', refund_amount: 0, status: 'success',
        gateway: 'square', gateway_reference: 'link-1', booking_id: null, invoice_id: null,
        campaign_id: null, order_id: null, reservation_id: null, business_id: 'biz-1',
        metadata: { square_payment_id: 'sq-pay-1' }, payout_account_id: 'pa-1',
        collection_mode: 'connect', waaiio_fee: 2.50,
      },
      rpcResults,
    });

    const result = await processRefund({
      supabase: mockSupabase as never,
      paymentId: 'pay-1',
      businessId: 'biz-1',
      amount: 50, // different from original 100
      initiatedBy: 'user-1',
      initiatedByRole: 'business',
      logicalRefundId: 'idempotency-key-1',
    });

    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('parameter_mismatch');
  });
});

// ── 2. finalize_square_refund idempotency (already_finalized) ──
describe('finalize_square_refund idempotency', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('treats already_finalized as success in refund handler', async () => {
    vi.resetModules();
    process.env.SQUARE_ACCESS_TOKEN = 'mock-token';

    vi.doMock('@/lib/payments/factory', () => ({
      getPaymentGatewayByName: vi.fn().mockReturnValue({
        refundPayment: vi.fn().mockResolvedValue({
          success: true,
          gatewayRefundReference: 'sq-refund-1',
          gatewayResponse: { refund: { id: 'sq-refund-1', status: 'COMPLETED', app_fee_money: { amount: 250 } } },
        }),
      }),
    }));
    vi.doMock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

    const { processRefund } = await import('@/lib/payments/refund-handler');

    const rpcResults: Record<string, unknown> = {
      claim_refund_balance: {
        claimed: true,
        refund_id: 'refund-uuid',
        planned_fee_reversal: 2.50,
      },
      finalize_square_refund: {
        success: false,
        reason: 'already_finalized',
      },
    };

    const mockSupabase = createMockSupabase({
      payment: {
        id: 'pay-1', amount: 100, currency: 'USD', refund_amount: 0, status: 'success',
        gateway: 'square', gateway_reference: 'link-1', booking_id: null, invoice_id: null,
        campaign_id: null, order_id: null, reservation_id: null, business_id: 'biz-1',
        metadata: { square_payment_id: 'sq-pay-1', square_order_id: 'order-1' },
        payout_account_id: null, collection_mode: 'platform', waaiio_fee: 2.50,
      },
      rpcResults,
    });

    const result = await processRefund({
      supabase: mockSupabase as never,
      paymentId: 'pay-1',
      businessId: 'biz-1',
      amount: 100,
      initiatedBy: 'user-1',
      initiatedByRole: 'admin',
      logicalRefundId: 'idem-key-2',
    });

    // already_finalized should not cause a failure return
    expect(result.success).toBe(true);
    expect(result.providerStatus).toBe('COMPLETED');
  });
});

// ── 3. No payout adjustment for connect collection_mode ──
describe('finalize_square_refund payout adjustment', () => {
  it('finalize_square_refund RPC guards payout adjustment with collection_mode check', async () => {
    // Verify the migration SQL contains the collection_mode guard
    const fs = await import('fs');
    const sql = fs.readFileSync('supabase/migrations/291_square_connection_support.sql', 'utf-8');
    expect(sql).toContain("IN ('platform', 'managed_split')");
    expect(sql).toContain('payout_adjustments');
  });
});

// ── 4. Concurrent refund claims (second claim returns existing) ──
describe('concurrent refund claims', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('second claim returns existing refund_id without creating a new one', async () => {
    vi.resetModules();
    const { processRefund } = await import('@/lib/payments/refund-handler');

    // Simulate: first claim created row, second call with same key returns existing
    const rpcResults: Record<string, unknown> = {
      claim_refund_balance: {
        claimed: true,
        refund_id: 'first-refund-uuid',
        existing: true,
        planned_fee_reversal: 1.25,
      },
    };

    const mockSupabase = createMockSupabase({
      payment: {
        id: 'pay-2', amount: 50, currency: 'USD', refund_amount: 0, status: 'success',
        gateway: 'square', gateway_reference: 'link-2', booking_id: null, invoice_id: null,
        campaign_id: null, order_id: null, reservation_id: null, business_id: 'biz-2',
        metadata: { square_payment_id: 'sq-pay-2' }, payout_account_id: 'pa-2',
        collection_mode: 'connect', waaiio_fee: 1.25,
      },
      rpcResults,
      refundStatus: 'processing',
    });

    const result = await processRefund({
      supabase: mockSupabase as never,
      paymentId: 'pay-2',
      businessId: 'biz-2',
      amount: 50,
      initiatedBy: 'user-2',
      initiatedByRole: 'business',
      logicalRefundId: 'shared-idem-key',
    });

    // Second call should see existing processing status and attempt provider call
    expect(result.refundId).toBe('first-refund-uuid');
  });
});

// ── 5. Zero-row payment transition in verification ──
describe('Square verifyPayment zero-row transition', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('returns false when payment is already success (updatedRow is null)', async () => {
    vi.resetModules();
    process.env.SQUARE_ACCESS_TOKEN = 'mock-token';
    process.env.SQUARE_LOCATION_ID = 'LOC_PLATFORM'; // Set expected platform location

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: () => Promise.resolve({
        order: {
          state: 'COMPLETED',
          location_id: 'LOC_PLATFORM', // Must match SQUARE_LOCATION_ID
          total_money: { amount: 5000, currency: 'USD' },
          tenders: [{ payment_id: 'sq-pay-1', type: 'CARD' }],
        },
      }),
    }));

    const { SquareGateway } = await import('@/lib/payments/square');
    const gw = new SquareGateway();

    // Mock supabase: payment lookup succeeds, but conditional update returns no row
    // payout_account_id is null so it takes the platform location path
    const mockSupabase = {
      from: vi.fn((table: string) => {
        if (table === 'payments') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            single: vi.fn().mockResolvedValue({
              data: {
                id: 'pay-1', booking_id: null, amount: 50, currency: 'USD',
                metadata: { square_order_id: 'order-1' }, payout_account_id: null,
              },
            }),
            update: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                in: vi.fn().mockReturnValue({
                  select: vi.fn().mockReturnValue({
                    maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
                  }),
                }),
              }),
            }),
          };
        }
        return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis() };
      }),
    };

    const result = await gw.verifyPayment(mockSupabase as never, 'link-1');
    expect(result).toBe(false);
  });
});

// ── 6. Caller-owned idempotency keys are required ──
describe('refund API requires idempotencyKey', () => {
  it('rejects requests without idempotencyKey', async () => {
    // This is a structural test verifying the route rejects missing keys.
    // The actual validation is in the route handler; we verify the pattern exists.
    // In a real integration test, we'd call the API endpoint.
    // Here we just verify the import doesn't have randomUUID fallback.
    const routeSource = await import('fs').then(fs =>
      fs.readFileSync(require.resolve('../../app/api/payments/refund/route.ts'), 'utf-8')
    );
    expect(routeSource).not.toContain('randomUUID');
    expect(routeSource).toContain('idempotencyKey is required');
  });
});

// ── Helper: create a mock Supabase client for refund handler tests ──
function createMockSupabase(opts: {
  payment: Record<string, unknown>;
  rpcResults: Record<string, unknown>;
  refundStatus?: string;
  businessPayoutMode?: string;
}) {
  const { payment, rpcResults, refundStatus, businessPayoutMode } = opts;

  return {
    from: vi.fn((table: string) => {
      if (table === 'payments') {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          single: vi.fn().mockResolvedValue({ data: payment, error: null }),
          update: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({ error: null }),
          }),
        };
      }
      if (table === 'businesses') {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          single: vi.fn().mockResolvedValue({
            data: { payout_mode: businessPayoutMode || 'direct_split' },
            error: null,
          }),
        };
      }
      if (table === 'refunds') {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          single: vi.fn().mockResolvedValue({
            data: { status: refundStatus || 'pending', gateway_refund_reference: null },
            error: null,
          }),
          update: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({ error: null }),
          }),
          limit: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: null }),
        };
      }
      return {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({ data: null, error: null }),
        maybeSingle: vi.fn().mockResolvedValue({ data: null }),
      };
    }),
    rpc: vi.fn((name: string) => {
      const result = rpcResults[name];
      return Promise.resolve({ data: result, error: null });
    }),
  };
}
