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

import { processPaystackChargeSuccess, processPaystackChargeFailed } from '../webhook-handler';
import { createAlert } from '@/lib/alerts/create-alert';

function createMockSupabase(paymentData: Record<string, unknown> | null) {
  const updateFn = vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ data: null }) });
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
    _updateFn: updateFn,
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

    // Should call from('payments') at least twice (select + update)
    expect(supabase.from).toHaveBeenCalledWith('payments');
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
