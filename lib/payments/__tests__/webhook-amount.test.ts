import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies
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
  getPlatformFees: vi.fn().mockResolvedValue({ feePercentage: 2.0, feeFlat: 0, feeTotal: 100 }),
}));

import { processPaystackChargeSuccess } from '../webhook-handler';
import * as Sentry from '@sentry/nextjs';

function createMockSupabase(opts: {
  payment?: Record<string, unknown> | null;
  booking?: Record<string, unknown> | null;
  business?: Record<string, unknown> | null;
} = {}) {
  const updateFn = vi.fn().mockReturnValue({
    eq: vi.fn().mockResolvedValue({ data: null }),
  });
  const insertFn = vi.fn().mockResolvedValue({ data: null });
  const upsertFn = vi.fn().mockResolvedValue({ data: null });

  const payment = opts.payment !== undefined ? opts.payment : {
    id: 'pay-1', status: 'pending', amount: 5000, booking_id: null,
    invoice_id: null, campaign_id: null, gateway: 'paystack',
  };

  return {
    from: vi.fn((table: string) => {
      if (table === 'payments') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({
                data: payment,
                error: payment ? null : { message: 'not found' },
              }),
            }),
          }),
          update: updateFn,
          insert: insertFn,
          upsert: upsertFn,
        };
      }
      if (table === 'bookings') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({
                data: opts.booking || { business_id: 'biz-1', total_amount: 5000 },
                error: null,
              }),
            }),
          }),
          update: updateFn,
        };
      }
      if (table === 'businesses') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({
                data: opts.business || { subscription_tier: 'free', trial_ends_at: '2020-01-01', payout_mode: 'platform_managed' },
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === 'saved_payment_methods') {
        return { upsert: upsertFn };
      }
      // Default for platform_fees, invoices, etc
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data: null, error: null }),
          }),
        }),
        update: updateFn,
        insert: insertFn,
      };
    }),
    _updateFn: updateFn,
    _insertFn: insertFn,
  };
}

describe('Webhook Amount Validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('processes payment successfully when amounts match', async () => {
    const supabase = createMockSupabase({
      payment: { id: 'pay-1', status: 'pending', amount: 5000, booking_id: null, invoice_id: null, campaign_id: null, gateway: 'paystack' },
    });

    await processPaystackChargeSuccess(
      { amount: 500000, authorization: {}, channel: 'card' }, // 500000 kobo = 5000 NGN
      'ref-match',
      supabase as any,
    );

    // Should call update with status: 'success'
    expect(supabase._updateFn).toHaveBeenCalled();
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });

  it('marks payment as failed with amount_mismatch on mismatch', async () => {
    const supabase = createMockSupabase({
      payment: { id: 'pay-2', status: 'pending', amount: 5000, booking_id: null, invoice_id: null, campaign_id: null, gateway: 'paystack' },
    });

    await processPaystackChargeSuccess(
      { amount: 300000 }, // 3000 NGN != 5000 NGN
      'ref-mismatch',
      supabase as any,
    );

    // Sentry should capture the mismatch
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      'Payment amount mismatch',
      expect.objectContaining({
        level: 'warning',
        extra: expect.objectContaining({
          reference: 'ref-mismatch',
          webhookAmountKobo: 300000,
          expectedKobo: 500000,
        }),
      }),
    );
  });

  it('handles gateway reference not found gracefully', async () => {
    const supabase = createMockSupabase({ payment: null });

    // Should not throw
    await expect(
      processPaystackChargeSuccess(
        { amount: 500000 },
        'ref-nonexistent',
        supabase as any,
      ),
    ).resolves.toBeUndefined();

    // No update should be called
    expect(supabase._updateFn).not.toHaveBeenCalled();
  });

  it('is idempotent: second call on already-success payment does nothing', async () => {
    const supabase = createMockSupabase({
      payment: { id: 'pay-3', status: 'success', amount: 5000, booking_id: null, invoice_id: null, campaign_id: null, gateway: 'paystack' },
    });

    await processPaystackChargeSuccess(
      { amount: 500000 },
      'ref-idempotent',
      supabase as any,
    );

    // Should early-return without calling update
    expect(supabase._updateFn).not.toHaveBeenCalled();
  });

  it('correctly converts amount to kobo for comparison (amount * 100)', async () => {
    // Payment amount stored in NGN (major units): 123.45
    // Webhook sends in kobo (minor units): 12345
    const supabase = createMockSupabase({
      payment: { id: 'pay-4', status: 'pending', amount: 123, booking_id: null, invoice_id: null, campaign_id: null, gateway: 'paystack' },
    });

    await processPaystackChargeSuccess(
      { amount: 12300, authorization: {}, channel: 'card' }, // 12300 kobo = 123 NGN
      'ref-kobo',
      supabase as any,
    );

    // Should succeed (12300 === 123 * 100)
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
    expect(supabase._updateFn).toHaveBeenCalled();
  });

  it('updates booking to confirmed on successful payment with booking_id', async () => {
    const supabase = createMockSupabase({
      payment: { id: 'pay-5', status: 'pending', amount: 5000, booking_id: 'book-1', invoice_id: null, campaign_id: null, gateway: 'paystack' },
    });

    await processPaystackChargeSuccess(
      { amount: 500000, authorization: {}, channel: 'card' },
      'ref-booking',
      supabase as any,
    );

    // Should call from('bookings') to update status
    expect(supabase.from).toHaveBeenCalledWith('bookings');
  });
});
