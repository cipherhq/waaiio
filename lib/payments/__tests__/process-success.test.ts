import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/getPlatformFees', () => ({
  getPlatformFees: vi.fn().mockResolvedValue({ feePercentage: 2.0, feeFlat: 0, feeTotal: 100 }),
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { processSuccessfulPayment, recordPlatformFee, processInvoicePayment, processCampaignDonation } from '../process-success';

function mockSupabase(overrides: Record<string, unknown> = {}) {
  const updateResult = { eq: vi.fn().mockReturnThis(), in: vi.fn().mockReturnThis(), is: vi.fn().mockReturnThis(), select: vi.fn().mockReturnValue({ maybeSingle: vi.fn().mockResolvedValue({ data: null }), single: vi.fn().mockResolvedValue({ data: { status: 'confirmed', deposit_status: 'paid' }, error: null }) }), ...overrides };
  const insertFn = vi.fn().mockResolvedValue({ data: null, error: null });

  return {
    from: vi.fn().mockImplementation((table: string) => ({
      update: vi.fn().mockReturnValue(updateResult),
      insert: insertFn,
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({
            data: table === 'bookings'
              ? { business_id: 'biz1', total_amount: 5000, status: 'confirmed', deposit_status: 'paid' }
              : table === 'businesses'
              ? { subscription_tier: 'free', trial_ends_at: '2025-01-01', payout_mode: 'platform_managed' }
              : table === 'invoices'
              ? { business_id: 'biz1', total_amount: 1000, amount_paid: 0 }
              : table === 'campaigns'
              ? { raised_amount: 0, donor_count: 0, business_id: 'biz1' }
              : null,
          }),
          maybeSingle: vi.fn().mockResolvedValue({ data: null }),
        }),
      }),
    })),
    rpc: vi.fn().mockResolvedValue({ data: { applied: true, is_legacy: false, amount: 500, new_amount_paid: 1000, is_fully_paid: true }, error: null }),
    _insertFn: insertFn,
  };
}

describe('processSuccessfulPayment', () => {
  it('confirms booking and records platform fee', async () => {
    const supabase = mockSupabase();
    await processSuccessfulPayment(supabase as any, {
      id: 'pay1', amount: 5000, booking_id: 'bk1', invoice_id: null, campaign_id: null,
    });

    // Should call from('bookings') to update status
    expect(supabase.from).toHaveBeenCalledWith('bookings');
    // Should call from('platform_fees') to insert fee
    expect(supabase.from).toHaveBeenCalledWith('platform_fees');
  });

  it('skips booking when booking_id is null', async () => {
    const supabase = mockSupabase();
    await processSuccessfulPayment(supabase as any, {
      id: 'pay1', amount: 100, booking_id: null, invoice_id: null, campaign_id: null,
    });

    const bookingCalls = (supabase.from as any).mock.calls.filter((c: string[]) => c[0] === 'bookings');
    expect(bookingCalls.length).toBe(0);
  });
});

describe('processInvoicePayment', () => {
  it('calls apply_invoice_payment RPC (no caller-supplied amount)', async () => {
    const supabase = mockSupabase();
    await processInvoicePayment(supabase as any, 'inv1', 'pay1', 1000);

    // Should call the atomic RPC with only invoice_id and payment_id
    expect(supabase.rpc).toHaveBeenCalledWith('apply_invoice_payment', {
      p_invoice_id: 'inv1',
      p_payment_id: 'pay1',
    });
  });
});

describe('processCampaignDonation', () => {
  it('calls apply_campaign_donation RPC (no caller-supplied amount)', async () => {
    const supabase = mockSupabase();
    await processCampaignDonation(supabase as any, 'pay1', 'camp1', 500);

    // Should call the atomic RPC with only campaign_id and payment_id
    expect(supabase.rpc).toHaveBeenCalledWith('apply_campaign_donation', {
      p_campaign_id: 'camp1',
      p_payment_id: 'pay1',
    });
    // Should look up campaign business_id for fee recording
    expect(supabase.from).toHaveBeenCalledWith('campaigns');
  });
});

describe('recordPlatformFee', () => {
  it('skips fee for direct_split businesses', async () => {
    const supabase = mockSupabase();
    // Override business to be direct_split
    supabase.from = vi.fn().mockImplementation((table: string) => ({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({
            data: table === 'businesses'
              ? { subscription_tier: 'free', trial_ends_at: '2025-01-01', payout_mode: 'direct_split' }
              : { business_id: 'biz1', total_amount: 5000 },
          }),
        }),
      }),
      insert: vi.fn().mockResolvedValue({ data: null }),
    }));

    await recordPlatformFee(supabase as any, { bookingId: 'bk1', paymentAmount: 5000 });

    // Should NOT insert a platform fee for direct_split
    const insertCalls = (supabase.from as any).mock.calls.filter(
      (c: string[]) => c[0] === 'platform_fees'
    );
    expect(insertCalls.length).toBe(0);
  });
});
