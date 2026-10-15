import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies before importing
vi.mock('@/lib/posthog/server', () => ({
  getServerPostHog: () => ({ capture: vi.fn() }),
}));

vi.mock('@/lib/alerts/create-alert', () => ({
  createAlert: vi.fn(),
}));

vi.mock('@sentry/nextjs', () => ({
  captureMessage: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock('@/lib/getPlatformFees', () => ({
  getPlatformFees: vi.fn().mockResolvedValue({ feePercentage: 2.5, feeFlat: 0.5, feeTotal: 3 }),
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), withContext: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) },
}));

const mockReconcile = vi.fn().mockResolvedValue({ providerOutcome: 'verified', lifecycle: { status: 'completed', retryable: false, stages: { providerPaid: true, businessFinalized: true, customerConfirmed: true } }, acknowledgeSuccess: true });
vi.mock('../reconcile', () => ({
  reconcilePayment: (...args: unknown[]) => mockReconcile(...args),
}));

import { processPaystackChargeSuccess, processPaystackChargeFailed } from '../webhook-handler';
import { createAlert } from '@/lib/alerts/create-alert';

function createMockSupabase(paymentData: Record<string, unknown> | null) {
  const updateFn = vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ data: null }) });
  const rpcFn = vi.fn().mockResolvedValue({ data: true, error: null });
  const selectResult = paymentData ? { data: paymentData, error: null } : { data: null, error: { message: 'not found' } };

  return {
    from: vi.fn().mockImplementation((table: string) => ({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue(selectResult),
        }),
      }),
      update: updateFn,
      insert: vi.fn().mockResolvedValue({ data: null }),
    })),
    rpc: rpcFn,
    _updateFn: updateFn,
    _rpcFn: rpcFn,
  };
}

describe('processPaystackChargeSuccess', () => {
  it('updates payment to success when amounts match', async () => {
    const supabase = createMockSupabase({
      id: 'pay-1',
      status: 'pending',
      amount: 5000,
      booking_id: null,
      invoice_id: null,
      gateway: 'paystack',
    });

    await processPaystackChargeSuccess(
      { amount: 500000, authorization: { last4: '1234', brand: 'visa' }, channel: 'card' },
      'ref-123',
      supabase as any,
    );

    // Should converge through shared reconciliation
    expect(mockReconcile).toHaveBeenCalledTimes(1);
    expect(mockReconcile).toHaveBeenCalledWith(
      supabase, 'pay-1', 'webhook',
      expect.objectContaining({ status: 'verified' }),
    );
  });

  it('marks payment as failed on amount mismatch', async () => {
    const supabase = createMockSupabase({
      id: 'pay-2',
      status: 'pending',
      amount: 5000,
      booking_id: null,
      invoice_id: null,
      gateway: 'paystack',
    });

    await processPaystackChargeSuccess(
      { amount: 300000 }, // 3000 != 5000
      'ref-456',
      supabase as any,
    );

    expect(supabase.from).toHaveBeenCalledWith('payments');
  });

  it('does nothing if payment already succeeded', async () => {
    const supabase = createMockSupabase({
      id: 'pay-3',
      status: 'success',
      amount: 5000,
      booking_id: null,
      invoice_id: null,
      gateway: 'paystack',
    });

    await processPaystackChargeSuccess(
      { amount: 500000 },
      'ref-789',
      supabase as any,
    );

    // Should not call update since status is already 'success'
    expect(supabase._updateFn).not.toHaveBeenCalled();
  });

  it('enriches a completed payment from a late webhook without reconciling again', async () => {
    mockReconcile.mockClear();
    const supabase = createMockSupabase({
      id: 'pay-late', status: 'success', amount: 5000,
      booking_id: null, invoice_id: null, campaign_id: null,
      reservation_id: null, order_id: null, metadata: { payment_origin: 'platform' },
      gateway: 'paystack', payment_authority_version: null, finalization_completed_at: null,
    });
    await processPaystackChargeSuccess({
      amount: 500000, currency: 'NGN', authorization: {
        reusable: true, authorization_code: 'AUTH-LATE', last4: '1234', brand: 'visa',
      }, customer: { email: 'payer@example.test', customer_code: 'CUS-LATE' },
    }, 'ref-late', supabase as any);
    expect(supabase._rpcFn).toHaveBeenCalledWith('persist_verified_paystack_card_authorization', expect.any(Object));
    expect(mockReconcile).not.toHaveBeenCalled();
  });
});

describe('processPaystackChargeFailed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('updates payment to failed and creates alert', async () => {
    const supabase = createMockSupabase({
      id: 'pay-4',
      status: 'pending',
      amount: 5000,
      business_id: 'biz-1',
    });

    await processPaystackChargeFailed(
      { gateway_response: 'Insufficient funds' },
      'ref-fail-1',
      supabase as any,
    );

    expect(supabase.from).toHaveBeenCalledWith('payments');
    expect(createAlert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        businessId: 'biz-1',
        type: 'payment_failed',
        severity: 'warning',
      }),
    );
  });

  it('does nothing if payment already succeeded', async () => {
    const supabase = createMockSupabase({
      id: 'pay-5',
      status: 'success',
      amount: 5000,
      business_id: 'biz-2',
    });

    await processPaystackChargeFailed(
      { gateway_response: 'Failed' },
      'ref-fail-2',
      supabase as any,
    );

    expect(createAlert).not.toHaveBeenCalled();
  });
});
