/**
 * Owner rule 2026-11-05: a payment confirmed by Stage 3 ends with a next-steps
 * menu carrying "Powered by Waaiio.com". Drives the real sendProactiveConfirmation
 * through the claimed delivery sequence (same harness as slice-5a).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRpc = vi.fn();
const mockFrom = vi.fn();
const mockTransportSend = vi.fn().mockResolvedValue({ success: true, messageId: 'wamid-1' });
const mockButtons = vi.fn().mockResolvedValue({ success: true, messageId: 'wamid-menu' });
let channelType = 'dedicated';
const mockCalLinks = vi.fn().mockReturnValue('');
const mockProactiveResolve = vi.fn<any[], Promise<any>>();

const mockLogError = vi.fn();
const mockLogWarn = vi.fn();
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: (...a: unknown[]) => mockLogWarn(...a), error: (...a: unknown[]) => mockLogError(...a), debug: vi.fn(), withContext: () => ({ error: (...a: unknown[]) => mockLogError(...a), warn: (...a: unknown[]) => mockLogWarn(...a), info: vi.fn() }) } }));
const mockCaptureException = vi.fn();
vi.mock('@sentry/nextjs', () => ({ captureException: (...a: unknown[]) => mockCaptureException(...a) }));
vi.mock('@/lib/constants', () => ({ formatCurrency: (a: number) => `$${a}`, PRICING_TIERS: { free: { whitelabel: false }, growth: { whitelabel: false }, business: { whitelabel: true } } }));
vi.mock('@/lib/utils/phone', () => ({ stripPlus: (p: string) => p.replace(/^\+/, '') }));
vi.mock('@/lib/bot/flows/shared/user', () => ({ getCustomerName: vi.fn().mockResolvedValue('U') }));
vi.mock('@/lib/calendar/generate-links', () => ({ getCalendarLinksText: (...a: unknown[]) => mockCalLinks(...a) }));
vi.mock('@/lib/utils/sanitize', () => ({ sanitizeFilterValue: (v: string) => v }));
vi.mock('@/lib/bot/flows/shared/payment', () => ({ initializePayment: vi.fn() }));
vi.mock('@/lib/errors', () => ({ safeLogErrorContext: vi.fn().mockReturnValue({}) }));
vi.mock('@/lib/payments/entity-balance', () => ({ getEntityBalance: vi.fn().mockResolvedValue(null) }));
vi.mock('@/lib/payments/proactive-localization', () => ({
  resolveProactiveLocalization: (...a: unknown[]) => mockProactiveResolve(...a),
}));
vi.mock('@/lib/channels/channel-resolver', () => {
  class MockResolver {
    async resolveByChannelIdForBusiness() { return null; }
    async resolveByBusinessId() {
      return { channel: { id: 'ch-1', channel_type: channelType }, channelId: 'ch-1', sender: { sendText: (...a: unknown[]) => mockTransportSend(...a), sendButtons: (...a: unknown[]) => mockButtons(...a), sendDocument: vi.fn().mockResolvedValue({}), sendImage: vi.fn().mockResolvedValue({}) } };
    }
  }
  return { ChannelResolver: MockResolver };
});
// Prevent post-completion and other dynamic imports from throwing
vi.mock('@/lib/bot/flows/shared/post-completion', () => ({ handlePostCompletion: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/bot/flows/shared/send-tickets', () => ({ sendTicketsAfterPurchase: vi.fn(), ensureCanonicalTicketRows: vi.fn(), deliverTicketsWhatsApp: vi.fn(), deliverTicketsEmail: vi.fn() }));
vi.mock('@/lib/payments/saved-card-compat', () => ({ canonicalSavedCardPhone: vi.fn(() => null), isSharedPlatformPaystackCompatible: vi.fn().mockResolvedValue({ compatible: false }) }));
vi.mock('@/lib/payments/saved-card-offer', () => ({ checkAndOfferSavedCard: vi.fn().mockResolvedValue(undefined), retryPendingSavedCardOffer: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/payments/terminal-effects', () => ({
  initializeManifest: vi.fn().mockResolvedValue({ ok: true }),
  computeApplicableEffects: vi.fn().mockReturnValue([]),
  driveInternalEffect: vi.fn().mockResolvedValue({ ok: true }),
  driveExternalEffect: vi.fn().mockResolvedValue({ ok: true }),
  skipOptionalEffect: vi.fn().mockResolvedValue({ ok: true }),
  readFrozenRuleActions: vi.fn().mockResolvedValue([]),
  readRuleActionManifest: vi.fn().mockResolvedValue(null),
  advanceRuleAction: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock('@/lib/bot/automation/sealed-rule-actions', () => ({ executeSealedActions: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/bot/flows/shared/notify-owner', () => ({ notifyOwnerNewPayment: vi.fn().mockResolvedValue(undefined), notifyOwnerNewBooking: vi.fn().mockResolvedValue(undefined), notifyOwnerNewDonation: vi.fn().mockResolvedValue(undefined), notifyOwnerNewInvoicePayment: vi.fn().mockResolvedValue(undefined), notifyOwnerNewTicketSale: vi.fn().mockResolvedValue(undefined), notifyOwnerGeneric: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/email/client', () => ({ sendEmail: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/email/templates', () => ({ bookingConfirmationEmail: vi.fn(() => ({ subject: '', html: '' })), donationReceiptEmail: vi.fn(() => ({ subject: '', html: '' })), businessNotificationEmail: vi.fn(() => ({ subject: '', html: '' })), paymentReceivedEmail: vi.fn(() => ({ subject: '', html: '' })) }));

const mockEnroll = vi.fn().mockResolvedValue(undefined);
const mockResume = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/bot/transaction-followups', () => ({ startTransactionFollowup: (...a: unknown[]) => mockEnroll(...a) }));
vi.mock('@/lib/payments/transaction-followup', () => ({ resumePaidTransactionFollowup: (...a: unknown[]) => mockResume(...a) }));

function chain() {
  const c: Record<string, any> = {};
  ['select','eq','is','in','or','not','order','limit','update','gte','neq','insert','ilike','like','lte'].forEach(m => c[m] = vi.fn().mockReturnValue(c));
  c.single = vi.fn().mockResolvedValue({ data: null, error: null });
  c.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
  return c;
}

const CLAIM_OK = { data: { claimed: true, claim_token: 'tok-1', payment_id: 'p1', amount: 50, booking_id: 'bk1', invoice_id: null, campaign_id: null, reservation_id: null, order_id: null, payment_authority_version: 1 } };
const FIN_OK = { data: { finalized: true }, error: null };
const pay = { id: 'p1', amount: 50, booking_id: 'bk1', invoice_id: null, campaign_id: null };

function setupRpc(eventLog: string[], opts: { failPreDelivery?: boolean; deliveryClaim?: Record<string, unknown> } = {}) {
  let renewCount = 0;
  mockRpc.mockImplementation((name: string) => {
    eventLog.push(name);
    if (name === 'claim_payment_confirmation') return Promise.resolve(CLAIM_OK);
    if (name === 'renew_payment_confirmation_claim') {
      renewCount++;
      if (opts.failPreDelivery && renewCount >= 2) return Promise.resolve({ data: { renewed: false, reason: 'lost' }, error: null });
      return Promise.resolve({ data: { renewed: true }, error: null });
    }
    if (name === 'claim_confirmation_delivery') return Promise.resolve({ data: opts.deliveryClaim ?? { claimed: true, attempt_id: 'att-1', claim_token: 'dtok-1' }, error: null });
    if (name === 'begin_confirmation_send') return Promise.resolve({ data: { authorized: true }, error: null });
    if (name === 'complete_confirmation_send') return Promise.resolve({ data: { completed: true }, error: null });
    if (name === 'finalize_payment_confirmation') return Promise.resolve(FIN_OK);
    return Promise.resolve({ data: null, error: null });
  });
}

function setupDb(tier = 'growth', isWhitelabel: boolean | null = false) {
  mockFrom.mockImplementation((table: string) => {
    const c = chain();
    if (table === 'bookings') c.single = vi.fn().mockResolvedValue({ data: { guest_phone: '+234123', guest_email: null, business_id: 'b1', reference_code: 'X1', date: '2026-08-10', time: '14:00', flow_type: 'scheduling', total_amount: 100, deposit_amount: 50, businesses: { name: 'Biz', country_code: 'NG', address: '1 Main' }, services: { name: 'S', duration_minutes: 30, service_type: 'booking' } }, error: null });
    if (table === 'businesses') { c.single = vi.fn().mockResolvedValue({ data: { subscription_tier: tier, is_whitelabel: isWhitelabel, owner_id: 'o1' }, error: null }); c.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null }); }
    if (table === 'payments') c.single = vi.fn().mockResolvedValue({ data: { currency: 'NGN', gateway: 'paystack', metadata: {} }, error: null });
    if (table === 'profiles') { c.single = vi.fn().mockResolvedValue({ data: { email: 'o@t.com', phone: '+234' }, error: null }); c.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null }); }
    return c;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  channelType = 'dedicated';
  mockTransportSend.mockResolvedValue({ success: true, messageId: 'wamid-1' });
  mockButtons.mockResolvedValue({ success: true, messageId: 'wamid-menu' });
  mockCalLinks.mockReturnValue('');
  mockProactiveResolve.mockImplementation(async () => ({
    language: 'en', translationContext: { entitlement: { allowedLanguages: ['en'], llmAllowed: false, translationAllowed: false }, businessId: 'b1', supabase: {} },
    translate: async (text: string) => text,
  }));
});

async function confirm(eventLog: string[] = []) {
  const s = { rpc: mockRpc, from: mockFrom, storage: { from: vi.fn(() => ({ upload: vi.fn(), getPublicUrl: vi.fn() })) } } as any;
  const { sendProactiveConfirmation } = await import('@/lib/payments/send-confirmation');
  return sendProactiveConfirmation(s, pay);
}

describe('Stage 3 hands off menus after fulfillment and finalization', () => {
  it('enrolls recovery before finalization, resumes after it, and sends no early options', async () => {
    const eventLog: string[] = [];
    mockEnroll.mockImplementation(async () => { eventLog.push('enroll'); });
    mockResume.mockImplementation(async () => { eventLog.push('resume'); });
    setupDb(); setupRpc(eventLog);
    const result = await confirm(eventLog);
    expect(result.status).toBe('completed');
    expect(mockButtons).not.toHaveBeenCalled();
    expect(mockEnroll).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      completionKey: 'payment:p1', paymentId: 'p1', businessId: 'b1', channelId: 'ch-1', waitForCard: true,
    }));
    expect(eventLog.indexOf('complete_confirmation_send')).toBeLessThan(eventLog.indexOf('enroll'));
    expect(eventLog.indexOf('enroll')).toBeLessThan(eventLog.indexOf('finalize_payment_confirmation'));
    expect(eventLog.indexOf('finalize_payment_confirmation')).toBeLessThan(eventLog.indexOf('resume'));
  });

  it('enrollment failure leaves confirmation retryable instead of losing its continuation', async () => {
    mockEnroll.mockRejectedValueOnce(new Error('database unavailable'));
    const events: string[] = [];
    setupDb(); setupRpc(events);
    expect((await confirm()).status).toBe('retryable_failed');
    expect(events).not.toContain('finalize_payment_confirmation');
    expect(mockResume).not.toHaveBeenCalled();
    expect(mockButtons).not.toHaveBeenCalled();
  });

  it.each([
    ['already delivered', { claimed: false, reason: 'already_delivered' }],
    ['active delivery', { claimed: false, reason: 'active_delivery_sending' }],
  ])('%s: no duplicate direct message or menu', async (_label, deliveryClaim) => {
    setupDb(); setupRpc([], { deliveryClaim });
    await confirm();
    expect(mockTransportSend).not.toHaveBeenCalled();
    expect(mockButtons).not.toHaveBeenCalled();
  });

  it('no WAMID: Stage 3 does not emit a direct follow-up', async () => {
    mockTransportSend.mockResolvedValue({ success: true });
    setupDb(); setupRpc([]);
    await confirm();
    expect(mockButtons).not.toHaveBeenCalled();
    // The coordinator independently checks durable confirmation acceptance before card setup.

  });
});
