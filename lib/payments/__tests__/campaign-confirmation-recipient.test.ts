/**
 * Campaign donation confirmation — recipient/business resolution tests.
 *
 * Issue #736: sendProactiveConfirmation had no resolution step for
 * payment.campaign_id. When a standalone campaign donation succeeded
 * (no booking_id, reservation_id, invoice_id, or order_id), both
 * customerPhone and businessId remained null, causing the function to
 * return retryable_failed with 'no_business_resolved' — forever.
 *
 * These tests execute the real sendProactiveConfirmation function with
 * mocked Supabase, verifying:
 * 1. Campaign donations resolve donor_phone, business_id, campaign title
 * 2. Invalid/missing donation context produces no incorrect recipient
 * 3. Lookup failures don't produce false completion
 * 4. Existing booking/reservation/invoice/order paths remain unaffected
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Static dependency mocks (same as send-confirmation-boundary.test.ts) ──
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    withContext: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }),
  },
}));
vi.mock('@/lib/errors', () => ({ safeLogErrorContext: () => ({}) }));
vi.mock('@/lib/utils/phone', () => ({
  stripPlus: (p: string) => p.replace(/^\+/, ''),
}));
vi.mock('@/lib/calendar/generate-links', () => ({
  getCalendarLinksText: vi.fn().mockReturnValue(null),
}));
vi.mock('@/lib/utils/sanitize', () => ({
  sanitizeFilterValue: (v: string) => v,
}));
vi.mock('@/lib/constants', () => ({
  formatCurrency: vi.fn().mockReturnValue('₦5,000'),
}));
vi.mock('@/lib/whitelabel', () => ({
  isWhiteLabel: vi.fn().mockReturnValue(false),
}));
vi.mock('@/lib/bot/flows/shared/user', () => ({
  getCustomerName: vi.fn().mockResolvedValue('Ayo Donor'),
}));
vi.mock('@/lib/channels/channel-resolver', () => {
  const MockChannelResolver = class {
    resolveByChannelId = vi.fn().mockResolvedValue(null);
    resolveByBusinessId = vi.fn().mockResolvedValue({
      sender: {
        sendText: vi.fn().mockResolvedValue(undefined),
        sendDocument: vi.fn().mockResolvedValue(undefined),
      },
    });
  };
  return { ChannelResolver: MockChannelResolver };
});
vi.mock('@/lib/bot/flows/shared/notify-owner', () => ({
  notifyOwnerNewBooking: vi.fn().mockResolvedValue(undefined),
  notifyOwnerNewOrder: vi.fn().mockResolvedValue(undefined),
  notifyOwnerNewInvoicePayment: vi.fn().mockResolvedValue(undefined),
  notifyOwnerNewDonation: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/email/client', () => ({
  sendEmail: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/email/templates', () => ({
  paymentReceivedEmail: vi.fn().mockReturnValue({ subject: 't', html: '<p/>' }),
  bookingConfirmationEmail: vi.fn().mockReturnValue({ subject: 't', html: '<p/>' }),
  donationReceiptEmail: vi.fn().mockReturnValue({ subject: 't', html: '<p/>' }),
}));
vi.mock('@/lib/bot/flows/shared/send-tickets', () => ({
  sendTicketsAfterPurchase: vi.fn().mockResolvedValue({ success: true, tickets: [] }),
}));
vi.mock('@/lib/bot/flows/shared/post-completion', () => ({
  handlePostCompletion: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/payments/saved-card-offer', () => ({
  checkAndOfferSavedCard: vi.fn().mockResolvedValue(undefined),
  retryPendingSavedCardOffer: vi.fn().mockResolvedValue(undefined),
}));

// ── Mock Supabase for campaign donations ──
function buildCampaignSupabase(opts: {
  donationData?: Record<string, unknown> | null;
  donationError?: { message: string } | null;
} = {}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function chain(): Record<string, any> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const c: Record<string, any> = {};
    ['select', 'eq', 'neq', 'not', 'is', 'in', 'or', 'order', 'limit', 'update', 'insert', 'delete'].forEach(
      m => c[m] = vi.fn().mockReturnValue(c),
    );
    c.single = vi.fn().mockResolvedValue({ data: null, error: null });
    c.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
    return c;
  }

  const donationData = opts.donationData !== undefined ? opts.donationData : {
    donor_phone: '+2349012345678',
    donor_name: 'Ayo Donor',
    reference_code: 'DON-001',
    business_id: 'biz-campaign-1',
    campaigns: {
      title: 'Help Build a School',
      businesses: { name: 'Ayo Foundation', country_code: 'NG' },
    },
  };

  return {
    rpc: vi.fn().mockImplementation((name: string) => {
      if (name === 'claim_payment_confirmation') {
        return Promise.resolve({
          data: {
            claimed: true, claim_token: 'tok-campaign',
            payment_id: 'pay-campaign-1', amount: 5000,
            booking_id: null, reservation_id: null, invoice_id: null,
            campaign_id: 'camp-1', order_id: null,
          },
          error: null,
        });
      }
      if (name === 'renew_payment_confirmation_claim') {
        return Promise.resolve({ data: { renewed: true }, error: null });
      }
      if (name === 'finalize_payment_confirmation') {
        return Promise.resolve({ data: { finalized: true }, error: null });
      }
      if (name === 'release_payment_confirmation') {
        return Promise.resolve({ data: { released: true }, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    }),
    from: vi.fn().mockImplementation((table: string) => {
      const c = chain();

      if (table === 'campaign_donations') {
        c.maybeSingle = vi.fn().mockResolvedValue({
          data: opts.donationError ? null : donationData,
          error: opts.donationError || null,
        });
      }

      if (table === 'payments') {
        c.single = vi.fn().mockResolvedValue({
          data: { user_id: null, gateway: 'paystack', currency: 'NGN', metadata: {} },
          error: null,
        });
        c.maybeSingle = vi.fn().mockResolvedValue({
          data: { user_id: null, gateway: 'paystack', currency: 'NGN', metadata: {} },
          error: null,
        });
      }

      if (table === 'businesses') {
        c.single = vi.fn().mockResolvedValue({
          data: { subscription_tier: 'growth', owner_id: 'owner-1' },
          error: null,
        });
      }

      if (table === 'profiles') {
        c.maybeSingle = vi.fn().mockResolvedValue({
          data: { email: 'ayo@example.com' },
          error: null,
        });
        c.single = vi.fn().mockResolvedValue({
          data: { phone: '+2349012345678' },
          error: null,
        });
      }

      return c;
    }),
  };
}

describe('campaign donation confirmation — recipient resolution (#736)', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('resolves donor_phone and business_id from campaign_donations', async () => {
    const { sendProactiveConfirmation } = await import('../send-confirmation');
    const { handlePostCompletion } = await import('@/lib/bot/flows/shared/post-completion');
    const supabase = buildCampaignSupabase();

    const result = await sendProactiveConfirmation(
      supabase as never,
      { id: 'pay-campaign-1', amount: 5000, booking_id: null, invoice_id: null, campaign_id: 'camp-1', reservation_id: null, order_id: null },
    );

    expect(result.status).toBe('completed');
    expect(handlePostCompletion).toHaveBeenCalledOnce();
    const args = (handlePostCompletion as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(args.customerPhone).toBe('+2349012345678');
    expect(args.businessId).toBe('biz-campaign-1');
    expect(args.amountPaid).toBe(5000);
    expect(args.skipAutomation).toBe(true); // campaign_id → skipAutomation
  });

  it('donation lookup failure → retryable_failed, no false completion', async () => {
    const { sendProactiveConfirmation } = await import('../send-confirmation');
    const { handlePostCompletion } = await import('@/lib/bot/flows/shared/post-completion');
    const supabase = buildCampaignSupabase({
      donationData: null,
      donationError: { message: 'connection timeout' },
    });

    const result = await sendProactiveConfirmation(
      supabase as never,
      { id: 'pay-campaign-1', amount: 5000, booking_id: null, invoice_id: null, campaign_id: 'camp-1', reservation_id: null, order_id: null },
    );

    // Should fail to resolve business → retryable_failed, NOT completed
    expect(result.status).not.toBe('completed');
    expect(handlePostCompletion).not.toHaveBeenCalled();
  });

  it('no matching donation record → retryable_failed, no incorrect recipient', async () => {
    const { sendProactiveConfirmation } = await import('../send-confirmation');
    const { handlePostCompletion } = await import('@/lib/bot/flows/shared/post-completion');
    const supabase = buildCampaignSupabase({ donationData: null });

    const result = await sendProactiveConfirmation(
      supabase as never,
      { id: 'pay-campaign-1', amount: 5000, booking_id: null, invoice_id: null, campaign_id: 'camp-1', reservation_id: null, order_id: null },
    );

    expect(result.status).not.toBe('completed');
    expect(handlePostCompletion).not.toHaveBeenCalled();
  });

  it('campaign with booking_id uses booking resolution (campaign block skipped)', async () => {
    const { sendProactiveConfirmation } = await import('../send-confirmation');
    const { handlePostCompletion } = await import('@/lib/bot/flows/shared/post-completion');

    // Build a supabase that has both booking and campaign data
    const supabase = buildCampaignSupabase();
    // Override: claim returns both booking_id and campaign_id
    (supabase.rpc as ReturnType<typeof vi.fn>).mockImplementation((name: string) => {
      if (name === 'claim_payment_confirmation') {
        return Promise.resolve({
          data: {
            claimed: true, claim_token: 'tok-both',
            payment_id: 'pay-both', amount: 5000,
            booking_id: 'bk-event-1', reservation_id: null, invoice_id: null,
            campaign_id: 'camp-1', order_id: null,
          },
          error: null,
        });
      }
      if (name === 'renew_payment_confirmation_claim') return Promise.resolve({ data: { renewed: true }, error: null });
      if (name === 'finalize_payment_confirmation') return Promise.resolve({ data: { finalized: true }, error: null });
      if (name === 'release_payment_confirmation') return Promise.resolve({ data: { released: true }, error: null });
      return Promise.resolve({ data: null, error: null });
    });
    // Override: bookings table returns event booking data
    (supabase.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      const c = buildCampaignSupabase().from(table);
      if (table === 'bookings') {
        c.single = vi.fn().mockResolvedValue({
          data: {
            guest_phone: '+2341111111111', guest_email: null,
            reference_code: 'EVT-001', business_id: 'biz-event-1',
            date: '2025-06-01', time: '18:00', flow_type: 'ticketing',
            total_amount: 5000, deposit_amount: 0,
            businesses: { name: 'Event Biz', country_code: 'NG', address: null, payment_gateway: 'paystack' },
            services: { name: 'Concert Ticket', duration_minutes: null },
          },
          error: null,
        });
      }
      return c;
    });

    const result = await sendProactiveConfirmation(
      supabase as never,
      { id: 'pay-both', amount: 5000, booking_id: 'bk-event-1', invoice_id: null, campaign_id: 'camp-1', reservation_id: null, order_id: null },
    );

    expect(result.status).toBe('completed');
    expect(handlePostCompletion).toHaveBeenCalledOnce();
    const args = (handlePostCompletion as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // Should use booking phone, not donation phone
    expect(args.customerPhone).toBe('+2341111111111');
    expect(args.businessId).toBe('biz-event-1');
  });
});
