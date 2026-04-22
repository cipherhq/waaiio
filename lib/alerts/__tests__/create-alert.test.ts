import { describe, it, expect, vi } from 'vitest';
import { createAlert } from '../create-alert';

function mockSupabase(insertResult: { error: null | Error } = { error: null }) {
  const insertFn = vi.fn().mockResolvedValue(insertResult);
  const fromFn = vi.fn().mockReturnValue({ insert: insertFn });
  return { from: fromFn, insertFn };
}

describe('createAlert', () => {
  it('inserts an alert with correct fields', async () => {
    const { from, insertFn } = mockSupabase();
    const supabase = { from } as any;

    await createAlert(supabase, {
      businessId: 'biz-123',
      type: 'payment_failed',
      severity: 'warning',
      title: 'Payment Failed',
      message: 'A payment of 5000 failed',
      metadata: { gateway: 'paystack', amount: 5000 },
    });

    expect(from).toHaveBeenCalledWith('alerts');
    expect(insertFn).toHaveBeenCalledWith({
      business_id: 'biz-123',
      type: 'payment_failed',
      severity: 'warning',
      title: 'Payment Failed',
      message: 'A payment of 5000 failed',
      metadata: { gateway: 'paystack', amount: 5000 },
    });
  });

  it('defaults metadata to empty object', async () => {
    const { from, insertFn } = mockSupabase();
    const supabase = { from } as any;

    await createAlert(supabase, {
      businessId: 'biz-456',
      type: 'subscription_payment_failed',
      severity: 'critical',
      title: 'Sub Failed',
      message: 'Recurring payment failed',
    });

    expect(insertFn).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: {} }),
    );
  });
});
