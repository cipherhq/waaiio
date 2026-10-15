/**
 * Slice 5A F3 — full translation → claim → delivery → transport proof
 * Uses same mock pattern as P0 + ChannelResolver for transport visibility.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRpc = vi.fn();
const mockFrom = vi.fn();
const mockTransportSend = vi.fn().mockResolvedValue({ success: true, messageId: 'wamid-1' });
const mockCalLinks = vi.fn().mockReturnValue('');
const mockProactiveResolve = vi.fn<any[], Promise<any>>();

const mockLogError = vi.fn();
const mockLogWarn = vi.fn();
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: (...a: unknown[]) => mockLogWarn(...a), error: (...a: unknown[]) => mockLogError(...a), debug: vi.fn(), withContext: () => ({ error: (...a: unknown[]) => mockLogError(...a), warn: (...a: unknown[]) => mockLogWarn(...a), info: vi.fn() }) } }));
const mockCaptureException = vi.fn();
vi.mock('@sentry/nextjs', () => ({ captureException: (...a: unknown[]) => mockCaptureException(...a) }));
vi.mock('@/lib/constants', () => ({ formatCurrency: (a: number) => `$${a}` }));
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
      return { channelId: 'ch-1', sender: { sendText: (...a: unknown[]) => mockTransportSend(...a), sendButtons: vi.fn().mockResolvedValue({}), sendDocument: vi.fn().mockResolvedValue({}), sendImage: vi.fn().mockResolvedValue({}) } };
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

function setupRpc(eventLog: string[], opts: { failPreDelivery?: boolean } = {}) {
  let renewCount = 0;
  mockRpc.mockImplementation((name: string) => {
    eventLog.push(name);
    if (name === 'claim_payment_confirmation') return Promise.resolve(CLAIM_OK);
    if (name === 'renew_payment_confirmation_claim') {
      renewCount++;
      if (opts.failPreDelivery && renewCount >= 2) return Promise.resolve({ data: { renewed: false, reason: 'lost' }, error: null });
      return Promise.resolve({ data: { renewed: true }, error: null });
    }
    if (name === 'claim_confirmation_delivery') return Promise.resolve({ data: { claimed: true, attempt_id: 'att-1', claim_token: 'dtok-1' }, error: null });
    if (name === 'begin_confirmation_send') return Promise.resolve({ data: { authorized: true }, error: null });
    if (name === 'complete_confirmation_send') return Promise.resolve({ data: { completed: true }, error: null });
    if (name === 'finalize_payment_confirmation') return Promise.resolve(FIN_OK);
    return Promise.resolve({ data: null, error: null });
  });
}

function setupDb() {
  mockFrom.mockImplementation((table: string) => {
    const c = chain();
    if (table === 'bookings') c.single = vi.fn().mockResolvedValue({ data: { guest_phone: '+234123', guest_email: null, business_id: 'b1', reference_code: 'X1', date: '2026-08-10', time: '14:00', flow_type: 'scheduling', total_amount: 100, deposit_amount: 50, businesses: { name: 'Biz', country_code: 'NG', address: '1 Main' }, services: { name: 'S', duration_minutes: 30, service_type: 'booking' } }, error: null });
    if (table === 'businesses') { c.single = vi.fn().mockResolvedValue({ data: { subscription_tier: 'growth', owner_id: 'o1' }, error: null }); c.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null }); }
    if (table === 'payments') c.single = vi.fn().mockResolvedValue({ data: { currency: 'NGN', gateway: 'paystack', metadata: {} }, error: null });
    if (table === 'profiles') { c.single = vi.fn().mockResolvedValue({ data: { email: 'o@t.com', phone: '+234' }, error: null }); c.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null }); }
    return c;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockTransportSend.mockResolvedValue({ success: true, messageId: 'wamid-1' });
  mockCalLinks.mockReturnValue('');
  mockProactiveResolve.mockImplementation(async () => ({
    language: 'en', translationContext: { entitlement: { allowedLanguages: ['en'], llmAllowed: false, translationAllowed: false }, businessId: 'b1', supabase: {} },
    translate: async (text: string) => text,
  }));
});

describe('F3: five-step delivery sequence', () => {
  it('non-English: translate → renew → delivery → begin → sender, exactly once', async () => {
    const eventLog: string[] = [];
    mockProactiveResolve.mockResolvedValueOnce({
      language: 'fr',
      translationContext: { entitlement: { allowedLanguages: ['en', 'fr'], llmAllowed: true, translationAllowed: true }, businessId: 'b1', supabase: {} },
      translate: vi.fn().mockImplementation(async (text: string) => { eventLog.push('translate'); return `[FR] ${text}`; }),
    });
    mockTransportSend.mockImplementation(async () => { eventLog.push('sender.sendText'); return { success: true, messageId: 'wamid-fr' }; });

    setupDb();
    setupRpc(eventLog);
    const s = { rpc: mockRpc, from: mockFrom, storage: { from: vi.fn(() => ({ upload: vi.fn(), getPublicUrl: vi.fn() })) } } as any;
    const { sendProactiveConfirmation } = await import('@/lib/payments/send-confirmation');
    const result = await sendProactiveConfirmation(s, pay);

    // Event verification only — no debug output
    console.log('WARNS:', mockLogWarn.mock.calls.map(c => String(c[0]).slice(0, 100)));
    const tIdx = eventLog.indexOf('translate');
    const rIdx = eventLog.indexOf('renew_payment_confirmation_claim', tIdx > -1 ? tIdx + 1 : 0);
    const dIdx = eventLog.indexOf('claim_confirmation_delivery');
    const bIdx = eventLog.indexOf('begin_confirmation_send');
    const sIdx = eventLog.indexOf('sender.sendText');

    expect(tIdx).toBeGreaterThan(-1);
    expect(rIdx).toBeGreaterThan(tIdx);
    expect(dIdx).toBeGreaterThan(rIdx);
    expect(bIdx).toBeGreaterThan(dIdx);
    expect(sIdx).toBeGreaterThan(bIdx);
    expect(eventLog.filter(e => e === 'sender.sendText').length).toBe(1);
    expect(result.status).toBe('completed');
  });

  it('partial-balance: translator receives balance + guidance + calendar', async () => {
    let captured = '';
    mockProactiveResolve.mockResolvedValueOnce({
      language: 'fr',
      translationContext: { entitlement: { allowedLanguages: ['en', 'fr'], llmAllowed: true, translationAllowed: true }, businessId: 'b1', supabase: {} },
      translate: vi.fn().mockImplementation(async (text: string) => { captured = text; return text; }),
    });
    mockCalLinks.mockReturnValue('\n📅 Cal: https://cal.google.com/test');
    const { getEntityBalance } = await import('@/lib/payments/entity-balance');
    vi.mocked(getEntityBalance).mockResolvedValueOnce({ balanceDue: 25 } as any);

    const eventLog: string[] = [];
    setupDb();
    setupRpc(eventLog);
    const s = { rpc: mockRpc, from: mockFrom, storage: { from: vi.fn(() => ({ upload: vi.fn(), getPublicUrl: vi.fn() })) } } as any;
    const { sendProactiveConfirmation } = await import('@/lib/payments/send-confirmation');
    await sendProactiveConfirmation(s, pay);

    expect(captured).toContain('Confirmed');
    expect(captured).toContain('Remaining balance');
    expect(captured).toContain('receipt');
    expect(captured).toContain('my bookings');
    expect(captured).toContain('cal.google.com/test');
  });

  it('calendar URL exact in transport sendText', async () => {
    mockProactiveResolve.mockResolvedValueOnce({
      language: 'fr',
      translationContext: { entitlement: { allowedLanguages: ['en', 'fr'], llmAllowed: true, translationAllowed: true }, businessId: 'b1', supabase: {} },
      translate: vi.fn().mockImplementation(async (text: string) => text),
    });
    mockCalLinks.mockReturnValue('\n📅 Cal: https://calendar.google.com/exact-url');

    const eventLog: string[] = [];
    setupDb();
    setupRpc(eventLog);
    const s = { rpc: mockRpc, from: mockFrom, storage: { from: vi.fn(() => ({ upload: vi.fn(), getPublicUrl: vi.fn() })) } } as any;
    const { sendProactiveConfirmation } = await import('@/lib/payments/send-confirmation');
    await sendProactiveConfirmation(s, pay);

    expect(mockTransportSend).toHaveBeenCalled();
    expect(mockTransportSend.mock.calls[0][0].text).toContain('https://calendar.google.com/exact-url');
  });

  it('ownership loss after translate → no delivery/send/finalize', async () => {
    let translateCalled = false;
    const eventLog: string[] = [];
    mockProactiveResolve.mockResolvedValueOnce({
      language: 'fr',
      translationContext: { entitlement: { allowedLanguages: ['en', 'fr'], llmAllowed: true, translationAllowed: true }, businessId: 'b1', supabase: {} },
      translate: vi.fn().mockImplementation(async () => { translateCalled = true; return '[FR] text'; }),
    });

    setupDb();
    setupRpc(eventLog, { failPreDelivery: true });
    const s = { rpc: mockRpc, from: mockFrom, storage: { from: vi.fn(() => ({ upload: vi.fn(), getPublicUrl: vi.fn() })) } } as any;
    const { sendProactiveConfirmation } = await import('@/lib/payments/send-confirmation');
    const result = await sendProactiveConfirmation(s, pay);

    expect(translateCalled).toBe(true);
    expect(eventLog).not.toContain('claim_confirmation_delivery');
    expect(eventLog).not.toContain('begin_confirmation_send');
    expect(mockTransportSend).not.toHaveBeenCalled();
    expect(result.status).toBe('processing');
  });

  it('translate throws → exact English in transport', async () => {
    mockProactiveResolve.mockResolvedValueOnce({
      language: 'fr',
      translationContext: { entitlement: { allowedLanguages: ['en', 'fr'], llmAllowed: true, translationAllowed: true }, businessId: 'b1', supabase: {} },
      translate: vi.fn().mockRejectedValue(new Error('LLM fail')),
    });
    mockCalLinks.mockReturnValue('\n📅 Cal: https://cal.example.com/en');

    const eventLog: string[] = [];
    setupDb();
    setupRpc(eventLog);
    const s = { rpc: mockRpc, from: mockFrom, storage: { from: vi.fn(() => ({ upload: vi.fn(), getPublicUrl: vi.fn() })) } } as any;
    const { sendProactiveConfirmation } = await import('@/lib/payments/send-confirmation');
    const result = await sendProactiveConfirmation(s, pay);

    expect(mockTransportSend).toHaveBeenCalledTimes(1);
    const sent = mockTransportSend.mock.calls[0][0].text;
    expect(sent).toContain('Confirmed');
    expect(sent).toContain('receipt');
    expect(sent).toContain('cal.example.com/en');
    expect(sent).not.toContain('[FR]');
    expect(eventLog).toContain('claim_confirmation_delivery');
    expect(eventLog).toContain('begin_confirmation_send');
    expect(result.status).toBe('completed');
  });
});
