/**
 * Campaign donation confirmation — recipient resolution + delivery + denial tests.
 *
 * Issue #736: sendProactiveConfirmation had no resolution step for
 * payment.campaign_id. Standalone campaign donations left customerPhone
 * and businessId null → retryable_failed forever.
 *
 * Mocked behavioral tests following phase-2d-stage3-runtime.test.ts pattern.
 * NOT live-provider acceptance tests.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Sender mock with message ID ──
const campaignSender = { sendText: vi.fn().mockResolvedValue({ success: true, messageId: 'wamid.campaign-001' }), sendDocument: vi.fn().mockResolvedValue({ success: true }) };
const mockResolveByChForBiz = vi.fn();
const mockResolveByBiz = vi.fn();
const mockSendEmail = vi.fn();
const mockNotifyOwnerNewDonation = vi.fn().mockResolvedValue(undefined);

// ── Module mocks (phase-2d pattern) ──
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
  notifyOwnerNewInvoicePayment: vi.fn(),
  notifyOwnerNewDonation: (...a: unknown[]) => mockNotifyOwnerNewDonation(...a),
}));
vi.mock('@/lib/payments/saved-card-offer', () => ({ checkAndOfferSavedCard: vi.fn().mockResolvedValue(undefined), retryPendingSavedCardOffer: vi.fn() }));
vi.mock('@/lib/payments/recurring-offer', () => ({ checkAndOfferRecurring: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/capabilities/service', () => ({ getEnabledCapabilities: vi.fn().mockResolvedValue([]) }));
vi.mock('@/lib/observability', () => ({ observe: (_n: string, fn: () => unknown) => fn(), observeProvider: vi.fn() }));
vi.mock('@/lib/whitelabel', () => ({ isWhiteLabel: vi.fn().mockReturnValue(false) }));
vi.mock('@/lib/bot/flows/shared/notifications', () => ({ createNotification: vi.fn() }));

// ── Supabase mock builder ──
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

const DONATION = {
  donor_phone: '+2349012345678', donor_name: 'Ayo Donor',
  reference_code: 'DON-001', business_id: 'biz-camp-1', campaign_id: 'camp-1',
  campaigns: { title: 'Help Build a School', business_id: 'biz-camp-1', businesses: { name: 'Ayo Foundation', country_code: 'NG' } },
};

function buildSb(opts: {
  donationData?: typeof DONATION | null;
  donationError?: { message: string } | null;
  paymentCampaignId?: string | null;
  claimOverrides?: Record<string, unknown>;
  renewDenied?: boolean;
} = {}) {
  const donationData = opts.donationData !== undefined ? opts.donationData : DONATION;
  const paymentCampaignId = opts.paymentCampaignId !== undefined ? opts.paymentCampaignId : 'camp-1';
  let initializedEffects: string[] = [];

  return {
    from: vi.fn((t: string) => {
      if (t === 'campaign_donations') {
        const c = chain(null);
        c.maybeSingle = vi.fn().mockResolvedValue({
          data: opts.donationError ? null : donationData,
          error: opts.donationError || null,
        });
        return c;
      }
      if (t === 'payments') return chain({ id: 'pay-camp-1', user_id: null, gateway: 'paystack', currency: 'NGN', campaign_id: paymentCampaignId, metadata: { _inbound_channel_id: 'ch-camp-1', _confirmation_origin: 'whatsapp' }, payment_authority_version: 1 });
      if (t === 'businesses') return chain({ id: 'biz-camp-1', name: 'Ayo Foundation', country_code: 'NG', owner_id: 'own-1', metadata: {}, subscription_tier: 'growth' });
      if (t === 'profiles') return chain({ email: 'owner@ayo.org', phone: '+2349012345678' });
      if (t === 'customer_profiles') return chain({ email: 'donor@test.com' });
      return chain();
    }),
    rpc: vi.fn(async (name: string, params?: Record<string, unknown>) => {
      if (name === 'claim_payment_confirmation') return { data: { claimed: true, claim_token: 'tok-c', payment_id: 'pay-camp-1', amount: 5000, booking_id: null, reservation_id: null, invoice_id: null, campaign_id: 'camp-1', order_id: null, customer_phone: '+2349012345678', payment_authority_version: 1, ...opts.claimOverrides }, error: null };
      if (name === 'renew_payment_confirmation_claim') {
        if (opts.renewDenied) return { data: { renewed: false, reason: 'claim_expired' }, error: null };
        return { data: { renewed: true }, error: null };
      }
      if (name === 'initialize_terminal_effects') { initializedEffects = (params?.p_effect_keys as string[]) || []; return { data: { initialized: true, already_initialized: false, effect_count: initializedEffects.length }, error: null }; }
      if (name === 'reserve_terminal_effect') { const k = params?.p_effect_key as string; if (k && !initializedEffects.includes(k)) return { data: { reserved: false, reason: 'effect_not_in_manifest' }, error: null }; return { data: { reserved: true, effect_token: 'et-' + k }, error: null }; }
      if (name === 'begin_terminal_external_emission') return { data: { authorized: true }, error: null };
      if (name === 'complete_external_effect') return { data: { completed: true }, error: null };
      if (name === 'complete_internal_effect') return { data: { completed: true }, error: null };
      if (name === 'fail_external_effect') return { data: { failed: true }, error: null };
      if (name === 'mark_effect_indeterminate') return { data: { marked: true }, error: null };
      if (name === 'skip_optional_effect') return { data: { skipped: true }, error: null };
      if (name === 'seal_terminal_manifest') return { data: { sealed: true }, error: null };
      if (name === 'finalize_payment_confirmation') return { data: { finalized: true }, error: null };
      if (name === 'release_payment_confirmation') return { data: { released: true }, error: null };
      if (name === 'claim_confirmation_delivery') return { data: { claimed: true, attempt_id: 'att-c1', claim_token: 'dct-c1' }, error: null };
      if (name === 'begin_confirmation_send') return { data: { authorized: true }, error: null };
      if (name === 'complete_confirmation_send') return { data: { completed: true }, error: null };
      if (name === 'recover_wamid_attachment') return { data: null, error: null };
      if (name === 'terminate_payment_confirmation') return { data: { terminated: true }, error: null };
      return { data: null, error: null };
    }),
  };
}

const PAY = { id: 'pay-camp-1', amount: 5000, booking_id: null, invoice_id: null, campaign_id: 'camp-1', reservation_id: null, order_id: null };

describe('campaign donation confirmation (#736)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveByChForBiz.mockResolvedValue({ channel: { id: 'ch-shared', channel_type: 'shared' }, sender: campaignSender });
    mockResolveByBiz.mockResolvedValue({ channel: { id: 'ch-shared', channel_type: 'shared' }, sender: campaignSender });
  });

  // ── Success path ──

  it('resolves donor + business, delivers via authorized WhatsApp channel, notifies merchant', async () => {
    const { sendProactiveConfirmation } = await import('../send-confirmation');
    const { handlePostCompletion } = await import('@/lib/bot/flows/shared/post-completion');
    const sb = buildSb();

    const result = await sendProactiveConfirmation(sb as never, PAY);

    expect(result.status).toBe('completed');
    // Recipient resolution
    const args = (handlePostCompletion as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(args.customerPhone).toBe('+2349012345678');
    expect(args.businessId).toBe('biz-camp-1');
    expect(args.amountPaid).toBe(5000);
    expect(args.skipAutomation).toBe(true);
    // Channel resolved via WhatsApp provenance
    expect(mockResolveByChForBiz).toHaveBeenCalledWith('ch-camp-1', 'biz-camp-1');
    // Sender called with donor phone and amount
    expect(campaignSender.sendText).toHaveBeenCalled();
    const sendCall = campaignSender.sendText.mock.calls[0][0];
    expect(sendCall.to).toBe('2349012345678');
    expect(sendCall.text).toContain('5000');
    // Merchant notification
    expect(mockNotifyOwnerNewDonation).toHaveBeenCalled();
    // Claim finalized (not just released)
    const rpcCalls = (sb.rpc as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0]);
    expect(rpcCalls).toContain('finalize_payment_confirmation');
  });

  // ── Denial paths: each releases claim, no delivery, no finalization ──

  it('donation lookup error → retryable_failed, claim released, no delivery', async () => {
    const { sendProactiveConfirmation } = await import('../send-confirmation');
    const sb = buildSb({ donationError: { message: 'connection timeout' } });

    const result = await sendProactiveConfirmation(sb as never, PAY);

    expect(result).toMatchObject({ status: 'retryable_failed', reason: 'campaign_donation_lookup_error' });
    expect(campaignSender.sendText).not.toHaveBeenCalled();
    const rpcCalls = (sb.rpc as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0]);
    expect(rpcCalls).toContain('release_payment_confirmation');
    expect(rpcCalls).not.toContain('finalize_payment_confirmation');
  });

  it('no matching donation → retryable_failed, claim released, no fallthrough to order/profile', async () => {
    const { sendProactiveConfirmation } = await import('../send-confirmation');
    const sb = buildSb({ donationData: null });

    const result = await sendProactiveConfirmation(sb as never, PAY);

    expect(result).toMatchObject({ status: 'retryable_failed', reason: 'campaign_donation_not_found' });
    expect(campaignSender.sendText).not.toHaveBeenCalled();
    const rpcCalls = (sb.rpc as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0]);
    expect(rpcCalls).toContain('release_payment_confirmation');
    expect(rpcCalls).not.toContain('finalize_payment_confirmation');
  });

  it('campaign/donation business_id mismatch → retryable_failed, claim released', async () => {
    const { sendProactiveConfirmation } = await import('../send-confirmation');
    const mismatch = { ...DONATION, business_id: 'biz-wrong-tenant', campaigns: { ...DONATION.campaigns, business_id: 'biz-camp-1' } };
    const sb = buildSb({ donationData: mismatch });

    const result = await sendProactiveConfirmation(sb as never, PAY);

    expect(result).toMatchObject({ status: 'retryable_failed', reason: 'campaign_business_mismatch' });
    expect(campaignSender.sendText).not.toHaveBeenCalled();
    const rpcCalls = (sb.rpc as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0]);
    expect(rpcCalls).toContain('release_payment_confirmation');
  });

  it('missing joined campaign context → retryable_failed, claim released', async () => {
    const { sendProactiveConfirmation } = await import('../send-confirmation');
    const noCampaignJoin = { ...DONATION, campaigns: null as unknown as typeof DONATION.campaigns };
    const sb = buildSb({ donationData: noCampaignJoin });

    const result = await sendProactiveConfirmation(sb as never, PAY);

    expect(result).toMatchObject({ status: 'retryable_failed', reason: 'campaign_context_missing' });
    expect(campaignSender.sendText).not.toHaveBeenCalled();
    const rpcCalls = (sb.rpc as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0]);
    expect(rpcCalls).toContain('release_payment_confirmation');
  });

  it('donation without donor_phone → retryable_failed, claim released', async () => {
    const { sendProactiveConfirmation } = await import('../send-confirmation');
    const noPhone = { ...DONATION, donor_phone: null as unknown as string };
    const sb = buildSb({ donationData: noPhone });

    const result = await sendProactiveConfirmation(sb as never, PAY);

    expect(result).toMatchObject({ status: 'retryable_failed', reason: 'campaign_donor_phone_missing' });
    expect(campaignSender.sendText).not.toHaveBeenCalled();
  });

  it('WhatsApp channel denied → no forbidden send, no business-channel fallback', async () => {
    const { sendProactiveConfirmation } = await import('../send-confirmation');
    mockResolveByChForBiz.mockResolvedValue(null);
    const sb = buildSb();

    const result = await sendProactiveConfirmation(sb as never, PAY);

    // WhatsApp origin with missing channel → whatsappOriginMissingChannel
    expect(campaignSender.sendText).not.toHaveBeenCalled();
    // Must NOT fall back to resolveByBusinessId for WhatsApp-origin payments
    expect(mockResolveByBiz).not.toHaveBeenCalled();
  });

  it('already-completed replay → no duplicate send, no finalization', async () => {
    const { sendProactiveConfirmation } = await import('../send-confirmation');
    const sb = buildSb();
    (sb.rpc as ReturnType<typeof vi.fn>).mockImplementation(async (name: string) => {
      if (name === 'claim_payment_confirmation') return { data: { claimed: false, already_completed: true }, error: null };
      return { data: null, error: null };
    });

    const result = await sendProactiveConfirmation(sb as never, PAY);

    expect(result.status).toBe('already_completed');
    expect(campaignSender.sendText).not.toHaveBeenCalled();
  });

  it('claim renewal denied → processing retryable, no send or finalization', async () => {
    const { sendProactiveConfirmation } = await import('../send-confirmation');
    const sb = buildSb({ renewDenied: true });

    const result = await sendProactiveConfirmation(sb as never, PAY);

    // Renewal failure → processing, retryable
    expect(result).toMatchObject({ status: 'processing', retryable: true });
    expect(campaignSender.sendText).not.toHaveBeenCalled();
    const rpcCalls = (sb.rpc as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0]);
    expect(rpcCalls).not.toContain('finalize_payment_confirmation');
  });

  // ── Entity precedence ──

  it('booking+campaign: booking resolution takes priority', async () => {
    const { sendProactiveConfirmation } = await import('../send-confirmation');
    const { handlePostCompletion } = await import('@/lib/bot/flows/shared/post-completion');
    const sb = buildSb({ claimOverrides: { booking_id: 'bk-ev-1' } });
    const originalRpc = sb.rpc.getMockImplementation()!;
    sb.rpc.mockImplementation(async (name: string, params?: Record<string, unknown>) => {
      if (name === 'terminate_cancelled_event_confirmation') {
        expect(params).toEqual({ p_payment_id: 'pay-camp-1', p_claim_token: 'tok-c' });
        return { data: { terminated: false, reason: 'not_cancelled' }, error: null };
      }
      return originalRpc(name, params);
    });
    const origFrom = sb.from;
    sb.from = vi.fn((t: string) => {
      if (t === 'bookings') return chain({
        guest_phone: '+2341111111111', guest_email: null, reference_code: 'EVT-001',
        business_id: 'biz-ev-1', date: '2025-06-01', time: '18:00', flow_type: 'ticketing',
        total_amount: 5000, deposit_amount: 0,
        businesses: { name: 'Event Biz', country_code: 'NG', address: null, payment_gateway: 'paystack' },
        services: { name: 'Concert', duration_minutes: null },
      });
      return origFrom(t);
    }) as typeof sb.from;

    const result = await sendProactiveConfirmation(sb as never, { ...PAY, booking_id: 'bk-ev-1' });

    expect(result.status).toBe('completed');
    const args = (handlePostCompletion as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(args.customerPhone).toBe('+2341111111111');
    expect(args.businessId).toBe('biz-ev-1');
  });
});
