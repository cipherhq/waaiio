/**
 * Customer updates opt-in on the Stage 3 payment next-steps menu (Owner decision
 * 2026-11-06). Drives the real sendProactiveConfirmation (harness copied from
 * link-payment-next-steps-menu.test.ts); consent tables are an in-memory database.
 */
import { createMemoryDb, type MemoryDb } from './helpers/memory-db';
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';

const mockRpc = vi.fn();
const mockFrom = vi.fn();
const mockTransportSend = vi.fn().mockResolvedValue({ success: true, messageId: 'wamid-1' });
const mockButtons = vi.fn().mockResolvedValue({ success: true, messageId: 'wamid-menu' });
const mockList = vi.fn().mockResolvedValue({ success: true, messageId: 'wamid-list' });
const BIZ = '11111111-1111-4111-8111-111111111111';
let consentDb: MemoryDb;
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
      return { channel: { id: 'ch-1', channel_type: channelType }, channelId: 'ch-1', sender: { sendText: (...a: unknown[]) => mockTransportSend(...a), sendButtons: (...a: unknown[]) => mockButtons(...a), sendList: (...a: unknown[]) => mockList(...a), sendDocument: vi.fn().mockResolvedValue({}), sendImage: vi.fn().mockResolvedValue({}) } };
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

function setupDb(tier = 'growth', isWhitelabel: boolean | null = false, nameKnown = true) {
  mockFrom.mockImplementation((table: string) => {
    const c = chain();
    if (table === 'bookings') c.single = vi.fn().mockResolvedValue({ data: { guest_phone: '+234123', guest_email: null, business_id: BIZ, reference_code: 'X1', date: '2026-08-10', time: '14:00', flow_type: 'scheduling', total_amount: 100, deposit_amount: 50, businesses: { name: 'Biz', country_code: 'NG', address: '1 Main' }, services: { name: 'S', duration_minutes: 30, service_type: 'booking' } }, error: null });
    if (['customer_consents', 'messaging_opt_outs', 'launch_subscribers', 'bot_sessions', 'customer_profiles'].includes(table)) return consentDb.from(table);
    if (table === 'businesses') { c.single = vi.fn().mockResolvedValue({ data: { name: nameKnown ? 'Mama Put Kitchen' : null, subscription_tier: tier, is_whitelabel: isWhitelabel, owner_id: 'o1' }, error: null }); c.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null }); }
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

function seedConsents(extra: Record<string, Array<Record<string, unknown>>> = {}) {
  consentDb = createMemoryDb({ customer_consents: [], messaging_opt_outs: [], launch_subscribers: [], customer_profiles: [],
    bot_sessions: [{ id: 's1', business_id: BIZ, whatsapp_number: '234123', session_data: {} }], ...extra });
}

describe('Stage 3 payment menu: updates opt-in', () => {
  // Cold import of this module is slow on a busy machine; load it once up front.
  beforeAll(async () => { await import('@/lib/payments/send-confirmation'); }, 120_000);

  beforeEach(() => { mockList.mockResolvedValue({ success: true, messageId: 'wamid-list' }); seedConsents(); });

  it('not yet agreed → one list menu: opt-in first, then the same options, footer kept, after the accepted confirmation', async () => {
    const eventLog: string[] = [];
    mockList.mockImplementation(async () => { eventLog.push('sendList'); return { success: true, messageId: 'wamid-list' }; });
    setupDb(); setupRpc(eventLog);
    const result = await confirm(eventLog);
    expect(result.status).toBe('completed');
    expect(mockButtons).not.toHaveBeenCalled();
    expect(mockList).toHaveBeenCalledTimes(1);
    const menu = mockList.mock.calls[0][0];
    expect(menu).toMatchObject({ to: '234123', body: 'What would you like to do next?', footer: 'Powered by Waaiio.com', messageCategory: 'service' });
    expect(menu.items[0]).toEqual({ title: '🎁 Get first dibs', description: 'Offers & updates from Mama Put Kitchen and Waaiio. Stop anytime.', postbackText: `updates_yes:menu:${BIZ}` });
    expect(menu.items.slice(1)).toEqual([{ title: 'My Bookings', postbackText: 'my bookings' }, { title: 'View Options', postbackText: 'menu' }]);
    expect(eventLog.indexOf('complete_confirmation_send')).toBeLessThan(eventLog.indexOf('sendList'));
  });

  it('already agreed → the usual buttons, unchanged', async () => {
    seedConsents({ customer_consents: [{ id: 'c1', business_id: BIZ, phone: '+234123', channel: 'whatsapp', purpose: 'marketing', status: 'granted', created_at: '2026-11-06T00:00:00Z' }] });
    setupDb(); setupRpc([]);
    await confirm();
    expect(mockList).not.toHaveBeenCalled();
    expect(mockButtons.mock.calls[0][0].buttons.map((b: { id: string }) => b.id)).toEqual(['my bookings', 'menu']);
  });

  it('unsubscribed from the business → no opt-in', async () => {
    seedConsents({ messaging_opt_outs: [{ id: 'o1', phone: '+234123', business_id: BIZ, channel: 'whatsapp', resubscribed_at: null }] });
    setupDb(); setupRpc([]);
    await confirm();
    expect(mockList).not.toHaveBeenCalled();
    expect(mockButtons).toHaveBeenCalledTimes(1);
  });

  it('business branding unknown (lookup returned no name) → no opt-in, so Waaiio is never named for a white-label business by mistake', async () => {
    setupDb('growth', false, false); setupRpc([]);
    await confirm();
    expect(mockList).not.toHaveBeenCalled();
    expect(mockButtons).toHaveBeenCalledTimes(1);
  });

  it('white-label business → opt-in names only the business, no footer', async () => {
    setupDb('growth', true); setupRpc([]);
    await confirm();
    const menu = mockList.mock.calls[0][0];
    expect(menu.items[0].description).toBe('Offers, reminders & updates from Mama Put Kitchen. Stop anytime.');
    expect(menu.footer).toBeUndefined();
  });

  it('a list send failure does not mark the accepted confirmation as failed', async () => {
    const eventLog: string[] = [];
    mockList.mockRejectedValue(new Error('meta 500'));
    setupDb(); setupRpc(eventLog);
    const result = await confirm(eventLog);
    expect(result.status).toBe('completed');
    expect(eventLog).not.toContain('fail_confirmation_send');
  });
});
