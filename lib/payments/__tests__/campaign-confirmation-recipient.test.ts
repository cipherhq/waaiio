/**
 * Campaign donation confirmation — recipient/business resolution + delivery tests.
 *
 * Issue #736: sendProactiveConfirmation had no resolution step for
 * payment.campaign_id. Standalone campaign donations left customerPhone
 * and businessId null → retryable_failed forever.
 *
 * These are mocked behavioral tests exercising real sendProactiveConfirmation.
 * They are NOT live-provider acceptance tests.
 *
 * Mock pattern follows lib/__tests__/phase-2d-stage3-runtime.test.ts:
 * - authority-v1 claim with payment_authority_version
 * - WhatsApp provenance via _inbound_channel_id + _confirmation_origin
 * - resolveByChannelIdForBusiness for authorized channel
 * - Terminal effect manifest RPCs
 * - Sender returning message ID for delivery proof
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Sender mocks with message ID for delivery proof ──
const campaignSender = { sendText: vi.fn().mockResolvedValue({ success: true, messageId: 'wamid.campaign-confirm-001' }), sendDocument: vi.fn().mockResolvedValue({ success: true }) };
const mockResolveByChForBiz = vi.fn();
const mockResolveByBiz = vi.fn();
const mockSendEmail = vi.fn();

// ── Module mocks (following phase-2d-stage3-runtime.test.ts pattern) ──
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), withContext: vi.fn(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() })) } }));
vi.mock('@/lib/errors', () => ({ safeLogErrorContext: () => ({}) }));
vi.mock('@/lib/utils/phone', () => ({ stripPlus: (p: string) => p.replace('+', '') }));
vi.mock('@/lib/bot/flows/shared/user', () => ({ getCustomerName: vi.fn().mockResolvedValue('Ayo Donor') }));
vi.mock('@/lib/calendar/generate-links', () => ({ getCalendarLinksText: () => '' }));
vi.mock('@/lib/utils/sanitize', () => ({ sanitizeFilterValue: (v: string) => v }));
vi.mock('@/lib/constants', () => ({ formatCurrency: (a: number) => `₦${a}`, COUNTRIES: [] }));
vi.mock('@/lib/channels/channel-resolver', () => ({
  ChannelResolver: class {
    resolveByChannelIdForBusiness(...a: unknown[]) { return mockResolveByChForBiz(...a); }
    resolveByBusinessId(...a: unknown[]) { return mockResolveByBiz(...a); }
  },
}));
vi.mock('@/lib/channels/send-or-email', () => ({ sendOrEmail: vi.fn().mockResolvedValue(undefined), findCustomerEmail: vi.fn().mockResolvedValue('donor@test.com') }));
vi.mock('@/lib/email/client', () => ({ sendEmail: (...a: unknown[]) => mockSendEmail(...a) }));
vi.mock('@/lib/email/templates', () => ({
  paymentReceivedEmail: () => ({ subject: 'P', html: '<p/>' }),
  bookingConfirmationEmail: () => ({ subject: 'B', html: '<p/>' }),
  donationReceiptEmail: () => ({ subject: 'D', html: '<p/>' }),
  businessNotificationEmail: () => ({ subject: 'N', html: '<p/>' }),
}));
vi.mock('@/lib/bot/flows/shared/send-tickets', () => ({ sendTicketsAfterPurchase: vi.fn().mockResolvedValue({ success: true, tickets: [] }) }));
vi.mock('@/lib/bot/flows/shared/post-completion', () => ({ handlePostCompletion: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/bot/flows/shared/notify-owner', () => ({
  notifyOwnerNewBooking: vi.fn(), notifyOwnerNewOrder: vi.fn(),
  notifyOwnerNewInvoicePayment: vi.fn(), notifyOwnerNewDonation: vi.fn(),
}));
vi.mock('@/lib/payments/saved-card-offer', () => ({ checkAndOfferSavedCard: vi.fn().mockResolvedValue(undefined), retryPendingSavedCardOffer: vi.fn() }));
vi.mock('@/lib/payments/recurring-offer', () => ({ checkAndOfferRecurring: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/capabilities/service', () => ({ getEnabledCapabilities: vi.fn().mockResolvedValue([]) }));
vi.mock('@/lib/observability', () => ({ observe: (_n: string, fn: () => unknown) => fn(), observeProvider: vi.fn() }));
vi.mock('@/lib/whitelabel', () => ({ isWhiteLabel: vi.fn().mockReturnValue(false) }));
vi.mock('@/lib/bot/flows/shared/notifications', () => ({ createNotification: vi.fn() }));

// ── Supabase mock builder (phase-2d pattern) ──
function chain(data: unknown = null) {
  const c: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'in', 'neq', 'not', 'is', 'update', 'insert', 'delete', 'order', 'limit', 'or', 'gte', 'lte', 'gt', 'lt']) {
    (c as Record<string, () => typeof c>)[m] = () => c;
  }
  c.single = vi.fn().mockResolvedValue({ data, error: null });
  c.maybeSingle = vi.fn().mockResolvedValue({ data, error: null });
  c.then = (resolve: (v: unknown) => void) => resolve({ data: data ? [data] : [], error: null });
  return c;
}

const CAMPAIGN_DONATION = {
  donor_phone: '+2349012345678',
  donor_name: 'Ayo Donor',
  reference_code: 'DON-001',
  business_id: 'biz-campaign-1',
  campaign_id: 'camp-1',
  campaigns: {
    title: 'Help Build a School',
    business_id: 'biz-campaign-1',
    businesses: { name: 'Ayo Foundation', country_code: 'NG' },
  },
};

function buildCampaignSb(opts: {
  donationData?: typeof CAMPAIGN_DONATION | null;
  donationError?: { message: string } | null;
  paymentMeta?: Record<string, unknown>;
  authorityVersion?: number | null;
  claimOverrides?: Record<string, unknown>;
} = {}) {
  const donationData = opts.donationData !== undefined ? opts.donationData : CAMPAIGN_DONATION;
  const paymentMeta = opts.paymentMeta ?? { _inbound_channel_id: 'ch-campaign-1', _confirmation_origin: 'whatsapp' };
  const authorityVersion = opts.authorityVersion === undefined ? 1 : opts.authorityVersion;
  let initializedEffects: string[] = [];

  return {
    from: vi.fn((t: string) => {
      if (t === 'campaign_donations') return chain(opts.donationError ? null : donationData);
      if (t === 'payments') return chain({ id: 'pay-campaign-1', user_id: null, gateway: 'paystack', currency: 'NGN', metadata: paymentMeta, payment_authority_version: authorityVersion });
      if (t === 'businesses') return chain({ id: 'biz-campaign-1', name: 'Ayo Foundation', country_code: 'NG', owner_id: 'owner-1', metadata: {}, subscription_tier: 'growth' });
      if (t === 'profiles') { const c = chain({ email: 'owner@ayo.org', phone: '+2349012345678' }); return c; }
      if (t === 'customer_profiles') return chain({ email: 'donor@test.com' });
      return chain();
    }),
    rpc: vi.fn(async (name: string, params?: Record<string, unknown>) => {
      if (name === 'claim_payment_confirmation') {
        return {
          data: {
            claimed: true, claim_token: 'tok-campaign',
            payment_id: 'pay-campaign-1', amount: 5000,
            booking_id: null, reservation_id: null, invoice_id: null,
            campaign_id: 'camp-1', order_id: null,
            customer_phone: '+2349012345678',
            payment_authority_version: authorityVersion,
            ...opts.claimOverrides,
          },
          error: null,
        };
      }
      if (name === 'initialize_terminal_effects') {
        initializedEffects = (params?.p_effect_keys as string[]) || [];
        return { data: { initialized: true, already_initialized: false, effect_count: initializedEffects.length }, error: null };
      }
      if (name === 'reserve_terminal_effect') {
        const effectKey = params?.p_effect_key as string;
        if (effectKey && !initializedEffects.includes(effectKey)) {
          return { data: { reserved: false, reason: 'effect_not_in_manifest' }, error: null };
        }
        return { data: { reserved: true, effect_token: 'et-' + effectKey }, error: null };
      }
      if (name === 'begin_terminal_external_emission') return { data: { authorized: true }, error: null };
      if (name === 'complete_external_effect') return { data: { completed: true }, error: null };
      if (name === 'complete_internal_effect') return { data: { completed: true }, error: null };
      if (name === 'fail_external_effect') return { data: { failed: true }, error: null };
      if (name === 'mark_effect_indeterminate') return { data: { marked: true }, error: null };
      if (name === 'skip_optional_effect') return { data: { skipped: true }, error: null };
      if (name === 'seal_terminal_manifest') return { data: { sealed: true }, error: null };
      if (name === 'finalize_payment_confirmation') return { data: { finalized: true }, error: null };
      if (name === 'renew_payment_confirmation_claim') return { data: { renewed: true }, error: null };
      if (name === 'release_payment_confirmation') return { data: { released: true }, error: null };
      if (name === 'claim_confirmation_delivery') return { data: { claimed: true, attempt_id: 'att-camp-1', claim_token: 'dct-camp-1' }, error: null };
      if (name === 'begin_confirmation_send') return { data: { authorized: true }, error: null };
      if (name === 'complete_confirmation_send') return { data: { completed: true }, error: null };
      if (name === 'recover_wamid_attachment') return { data: null, error: null };
      if (name === 'terminate_payment_confirmation') return { data: { terminated: true }, error: null };
      return { data: null, error: null };
    }),
  };
}

const CAMPAIGN_PAYMENT = { id: 'pay-campaign-1', amount: 5000, booking_id: null, invoice_id: null, campaign_id: 'camp-1', reservation_id: null, order_id: null };

describe('campaign donation confirmation — recipient resolution (#736)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: channel resolves to campaignSender via WhatsApp provenance
    mockResolveByChForBiz.mockResolvedValue({ sender: campaignSender });
    mockResolveByBiz.mockResolvedValue({ sender: campaignSender });
  });

  it('resolves donor_phone and business_id, delivers via authorized WhatsApp channel', async () => {
    const { sendProactiveConfirmation } = await import('../send-confirmation');
    const { handlePostCompletion } = await import('@/lib/bot/flows/shared/post-completion');
    const supabase = buildCampaignSb();

    const result = await sendProactiveConfirmation(supabase as never, CAMPAIGN_PAYMENT);

    expect(result.status).toBe('completed');

    // Verify recipient resolution
    expect(handlePostCompletion).toHaveBeenCalledOnce();
    const args = (handlePostCompletion as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(args.customerPhone).toBe('+2349012345678');
    expect(args.businessId).toBe('biz-campaign-1');
    expect(args.amountPaid).toBe(5000);
    expect(args.skipAutomation).toBe(true);

    // Verify channel resolution used WhatsApp provenance
    expect(mockResolveByChForBiz).toHaveBeenCalledWith('ch-campaign-1', 'biz-campaign-1');

    // Verify sender was actually called (delivery proof)
    expect(campaignSender.sendText).toHaveBeenCalled();
    const sendCall = campaignSender.sendText.mock.calls[0][0];
    // stripPlus mock removes '+' prefix; sender receives bare number
    expect(sendCall.to).toBe('2349012345678');
    expect(sendCall.text).toContain('5000'); // amount in confirmation message
  });

  it('donation lookup error → retryable_failed, no delivery attempted', async () => {
    const { sendProactiveConfirmation } = await import('../send-confirmation');
    const supabase = buildCampaignSb({ donationData: null, donationError: { message: 'connection timeout' } });

    const result = await sendProactiveConfirmation(supabase as never, CAMPAIGN_PAYMENT);

    expect(result.status).not.toBe('completed');
    expect(campaignSender.sendText).not.toHaveBeenCalled();
    expect(mockResolveByChForBiz).not.toHaveBeenCalled();
  });

  it('no matching donation → retryable_failed, no incorrect recipient', async () => {
    const { sendProactiveConfirmation } = await import('../send-confirmation');
    const supabase = buildCampaignSb({ donationData: null });

    const result = await sendProactiveConfirmation(supabase as never, CAMPAIGN_PAYMENT);

    expect(result.status).not.toBe('completed');
    expect(campaignSender.sendText).not.toHaveBeenCalled();
  });

  it('campaign/donation business_id mismatch → safe fallback, no wrong-tenant delivery', async () => {
    const { sendProactiveConfirmation } = await import('../send-confirmation');
    const mismatchedDonation = {
      ...CAMPAIGN_DONATION,
      business_id: 'biz-wrong-tenant',
      campaigns: { ...CAMPAIGN_DONATION.campaigns, business_id: 'biz-campaign-1' },
    };
    const supabase = buildCampaignSb({ donationData: mismatchedDonation });

    const result = await sendProactiveConfirmation(supabase as never, CAMPAIGN_PAYMENT);

    // Should NOT adopt the mismatched context — falls through to order/profile fallback
    // which also fails → retryable_failed
    expect(result.status).not.toBe('completed');
    expect(campaignSender.sendText).not.toHaveBeenCalled();
  });

  it('donation without donor_phone → safe fallback, no empty-phone send', async () => {
    const { sendProactiveConfirmation } = await import('../send-confirmation');
    const noPhoneDonation = { ...CAMPAIGN_DONATION, donor_phone: null as unknown as string };
    const supabase = buildCampaignSb({ donationData: noPhoneDonation });

    const result = await sendProactiveConfirmation(supabase as never, CAMPAIGN_PAYMENT);

    expect(result.status).not.toBe('completed');
    expect(campaignSender.sendText).not.toHaveBeenCalled();
  });

  it('WhatsApp channel denied → no forbidden send, safe outcome', async () => {
    const { sendProactiveConfirmation } = await import('../send-confirmation');
    // Channel resolver returns null for the provenance channel
    mockResolveByChForBiz.mockResolvedValue(null);
    const supabase = buildCampaignSb();

    const result = await sendProactiveConfirmation(supabase as never, CAMPAIGN_PAYMENT);

    // WhatsApp origin with missing channel → whatsappOriginMissingChannel path
    // No sender available → customer WhatsApp delivery skipped
    expect(campaignSender.sendText).not.toHaveBeenCalled();
  });

  it('already-completed/replay → claim returns not-claimed, no duplicate send', async () => {
    const { sendProactiveConfirmation } = await import('../send-confirmation');
    const supabase = buildCampaignSb();
    // Override: claim returns already completed
    (supabase.rpc as ReturnType<typeof vi.fn>).mockImplementation(async (name: string) => {
      if (name === 'claim_payment_confirmation') {
        return { data: { claimed: false, already_completed: true }, error: null };
      }
      return { data: null, error: null };
    });

    const result = await sendProactiveConfirmation(supabase as never, CAMPAIGN_PAYMENT);

    expect(result.status).toBe('already_completed');
    expect(campaignSender.sendText).not.toHaveBeenCalled();
  });

  it('booking+campaign coexistence: booking resolution takes priority', async () => {
    const { sendProactiveConfirmation } = await import('../send-confirmation');
    const { handlePostCompletion } = await import('@/lib/bot/flows/shared/post-completion');
    const supabase = buildCampaignSb({
      claimOverrides: { booking_id: 'bk-event-1' },
    });
    // Add booking data
    const origFrom = supabase.from;
    (supabase as Record<string, unknown>).from = vi.fn((t: string) => {
      if (t === 'bookings') return chain({
        guest_phone: '+2341111111111', guest_email: null,
        reference_code: 'EVT-001', business_id: 'biz-event-1',
        date: '2025-06-01', time: '18:00', flow_type: 'ticketing',
        total_amount: 5000, deposit_amount: 0,
        businesses: { name: 'Event Biz', country_code: 'NG', address: null, payment_gateway: 'paystack' },
        services: { name: 'Concert', duration_minutes: null },
      });
      return origFrom(t);
    });

    const result = await sendProactiveConfirmation(
      supabase as never,
      { ...CAMPAIGN_PAYMENT, booking_id: 'bk-event-1' },
    );

    expect(result.status).toBe('completed');
    const args = (handlePostCompletion as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(args.customerPhone).toBe('+2341111111111'); // booking phone, not donation
    expect(args.businessId).toBe('biz-event-1');
  });
});
