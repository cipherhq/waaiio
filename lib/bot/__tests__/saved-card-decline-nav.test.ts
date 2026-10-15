/**
 * Integration tests: saved-card button pre-verification (all 6 payload types)
 * through real BotService.handleMessage().
 *
 * The pre-verification block runs BEFORE CAP-001 revalidation.
 * Default session has active_capability='ticketing' (not in RPC caps [scheduling]),
 * so revalidation WOULD call update_session_cas + send a recovery message if it ran.
 * Unauthorized tests assert zero CAS/deactivation/sends/LLM, proving revalidation
 * was skipped entirely.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/countries', () => ({ loadCountries: vi.fn().mockResolvedValue([]), getCountry: vi.fn(), getCountryList: vi.fn().mockReturnValue([]), isValidCountryCode: vi.fn().mockReturnValue(true), getDialingCodeMap: vi.fn().mockReturnValue({}) }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimitAsync: vi.fn().mockResolvedValue({ allowed: true, remaining: 10 }) }));
vi.mock('@/lib/platformSettings', () => ({ loadPlatformSettings: vi.fn().mockResolvedValue({ bot_rate_limit_per_minute: 30, abuse_cooldown_soft_minutes: 5, abuse_cooldown_hard_minutes: 30, conversation_limits: { free: 200, growth: 1000, business: 5000 } }) }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('@/lib/bot/translate', () => ({ translateBotResponse: vi.fn(async (t: string) => t), detectLanguage: vi.fn(async () => 'en'), getLanguageName: vi.fn(() => 'English') }));
vi.mock('@/lib/bot/handlers/global-queries', () => ({ handleGlobalQuery: vi.fn(async (opts: { session: unknown }) => ({ handled: false, session: opts.session })), isOrdersQuery: vi.fn(() => false) }));
vi.mock('@/lib/bot/handlers/escape-hatches', () => ({ HOME_PATTERN: /^home$/i, handleEscapeHatch: vi.fn().mockResolvedValue({ handled: false }) }));
vi.mock('@/lib/bot/keyword-service', () => ({ loadBotCustomConfig: vi.fn().mockResolvedValue({ welcome_buttons: [], quick_replies: [], default_reply: null }), matchQuickReply: vi.fn(() => null), loadUnifiedKeywords: vi.fn().mockResolvedValue([]), matchUnifiedKeyword: vi.fn(() => null) }));
vi.mock('@/lib/circuit-breaker', () => ({ isCircuitOpen: () => false, recordSuccess: vi.fn(), recordFailure: vi.fn(), CircuitBreakerOpenError: class extends Error {} }));
vi.mock('@/lib/bot/customer-intelligence', () => ({
  getCustomerHistory: vi.fn().mockResolvedValue({ isReturning: false, totalVisits: 0, ltvTier: 'new', lastServiceId: null, lastServiceName: null, lastFlowType: null, favoriteServiceId: null, favoriteServiceName: null }),
  buildReturnGreeting: vi.fn().mockReturnValue(null),
}));
vi.mock('@/lib/capabilities/service', () => ({
  getConfiguredCapabilities: vi.fn().mockResolvedValue({ ok: true, rows: [{ capability: 'scheduling', is_enabled: true, sort_order: 0 }] }),
  getCapabilityCustomLabels: vi.fn().mockResolvedValue({}),
  getEnabledCapabilities: vi.fn().mockResolvedValue([]),
  hasCapability: vi.fn().mockResolvedValue(false),
  setCapabilities: vi.fn().mockResolvedValue(undefined),
  getCapabilityConfig: vi.fn().mockResolvedValue(null),
  initCapabilities: vi.fn().mockResolvedValue(undefined),
}));

const mockParseSmartIntentHybrid = vi.fn().mockResolvedValue(null);
vi.mock('@/lib/bot/smart-intent', () => ({
  parseSmartIntent: vi.fn().mockResolvedValue(null),
  parseSmartIntentHybrid: (...args: unknown[]) => mockParseSmartIntentHybrid(...args),
  matchServiceFromKeywords: vi.fn().mockResolvedValue(null),
  matchProductsFromKeywords: vi.fn().mockResolvedValue([]),
  buildAcknowledgment: vi.fn().mockReturnValue(null),
}));

class MockMessagingSuspendedError extends Error {
  constructor(businessId: string, reason: string) {
    super(`Messaging suspended for business ${businessId}: ${reason}`);
    this.name = 'MessagingSuspendedError';
  }
}
const mockAssertMessagingAllowed = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/channels/send-guard', () => ({
  assertMessagingAllowed: (...args: unknown[]) => mockAssertMessagingAllowed(...args),
  MessagingSuspendedError: MockMessagingSuspendedError,
}));

vi.mock('@/lib/bot/handlers/bot-code-detection', () => ({
  detectBotCode: vi.fn().mockResolvedValue(null),
  detectBotCodeWithSuggestions: vi.fn().mockResolvedValue({ businessId: null, suggestions: [] }),
  rankSuggestions: vi.fn().mockReturnValue([]),
  findReturningCustomerBusiness: vi.fn().mockResolvedValue(null),
  findReturningCustomerBusinesses: vi.fn().mockResolvedValue([]),
}));
vi.mock('@/lib/bot/handlers/saved-cards', () => ({
  handleSaveCard: vi.fn().mockResolvedValue(undefined),
  handleRemoveCard: vi.fn().mockResolvedValue(undefined),
  handleCardPinStep: vi.fn().mockResolvedValue(undefined),
  handleReplacementPinStep: vi.fn().mockResolvedValue(undefined),
  findLatestSavedCardPaymentIdForPhone: vi.fn().mockResolvedValue(null),
}));
vi.mock('@/lib/payments/bot-recovery', () => ({
  recoverSavedCardPaymentForFlow: vi.fn().mockResolvedValue({ type: 'not_applicable' }),
}));
vi.mock('@/lib/payments/stale-payment-recovery', () => ({
  recoverByOrderReference: vi.fn().mockResolvedValue({ type: 'error', message: 'n/a' }),
  recoverByPaymentReference: vi.fn().mockResolvedValue({ type: 'error', message: 'n/a' }),
  recoverGeneric: vi.fn().mockResolvedValue({ type: 'error', message: 'n/a' }),
}));
const mockHandleSavedCardOfferAction = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/payments/saved-card-offer', async (importOriginal) => {
  const orig = await importOriginal() as Record<string, unknown>;
  return { ...orig, handleSavedCardOfferAction: (...args: unknown[]) => mockHandleSavedCardOfferAction(...args) };
});
const mockHandlePromoVerification = vi.fn().mockResolvedValue({ handled: false });
vi.mock('@/lib/bot/handlers/promo-verification', () => ({
  handlePromoVerification: (...args: unknown[]) => mockHandlePromoVerification(...args),
}));

const { BotService } = await import('@/lib/bot/bot.service');
const { MetaCloudSender } = await import('@/lib/channels/message-sender');

const PHONE = '+2348012345678';
const PHONE_N = '2348012345678';
const OTHER_PHONE = '+2349099999999';
const BIZ_A = 'biz-nav-001';
const BIZ_B = 'biz-nav-002';
const PAY_ID = 'pay-nav-001';
const SESSION_ID = 'sess-nav-001';

const BUSINESS_ROW = {
  id: BIZ_A, name: 'Test Business', slug: 'test-biz', category: 'other',
  flow_type: 'scheduling', subscription_tier: 'growth', trial_ends_at: null,
  metadata: {}, country_code: 'NG', is_whitelabel: false, payment_gateway: null,
  status: 'active', operating_hours: null,
};

const PAYMENT_ROW = {
  id: PAY_ID, business_id: BIZ_A,
  booking_id: 'bk-nav-1', reservation_id: null, invoice_id: null,
  order_id: null, campaign_id: null, user_id: null,
};

function createMockCloud() {
  return {
    sendText: vi.fn().mockResolvedValue({ messages: [{ id: 'msg-1' }] }),
    sendButtons: vi.fn().mockResolvedValue({ messages: [{ id: 'msg-2' }] }),
    sendTemplate: vi.fn().mockResolvedValue({ messages: [{ id: 'msg-3' }] }),
    sendList: vi.fn().mockResolvedValue({ messages: [{ id: 'msg-4' }] }),
    sendImage: vi.fn(), sendDocument: vi.fn(), sendAudio: vi.fn(),
    sendFlow: vi.fn(), sendReaction: vi.fn(), sendLocation: vi.fn(),
    sendProduct: vi.fn(), sendProductList: vi.fn(),
  };
}

function createMockIntelligence() {
  return {
    isTimedOut: vi.fn().mockReturnValue({ timedOut: false }),
    containsProfanity: vi.fn().mockReturnValue(false),
    recordProfanity: vi.fn().mockReturnValue({ timeout: false, warn: false }),
    recordGibberish: vi.fn().mockReturnValue({ timeout: false, warn: false }),
    detectBookingIntent: vi.fn().mockReturnValue(null),
    getPersonaGreeting: vi.fn().mockReturnValue(null),
  };
}

function createStandaloneService() {
  return {
    parseNaturalBooking: vi.fn().mockResolvedValue(null),
    detectLanguage: vi.fn().mockResolvedValue(null),
    loadWhatsAppConfigBundle: vi.fn().mockResolvedValue({
      templates: { greeting: 'Welcome!', confirmation: '', reminder: '', orderConfirmation: '', paymentReceipt: '', orderStatus: '' },
      alias: null, welcome_buttons: [], quick_replies: [], default_reply: null,
      auto_reply_enabled: false, business_hours: null, away_message: null,
      instant_reply_enabled: false, instant_reply_message: null,
    }),
    checkTierLimitsFromBusiness: vi.fn().mockResolvedValue({ allowed: true, plan: 'free', monthlyBookings: 0, monthlyLimit: 999, isWhitelabel: false }),
    fillTemplate: vi.fn().mockImplementation((t: string) => t),
    checkTierLimits: vi.fn().mockResolvedValue({ allowed: true, plan: 'free', monthlyBookings: 0, monthlyLimit: 999, isWhitelabel: false }),
  } as any;
}

function makeChain(tableData: unknown, thenable = true) {
  const chain: Record<string, any> = {};
  for (const m of ['eq', 'neq', 'or', 'is', 'in', 'not', 'lt', 'gt', 'gte', 'lte', 'ilike', 'like', 'limit', 'order', 'head', 'update', 'delete', 'upsert', 'filter', 'contains', 'containedBy', 'range', 'overlaps', 'textSearch', 'match', 'csv', 'returns']) chain[m] = vi.fn().mockReturnValue(chain);
  chain.single = vi.fn().mockResolvedValue({ data: tableData, error: null });
  chain.maybeSingle = vi.fn().mockResolvedValue({ data: tableData, error: null });
  chain.select = vi.fn().mockReturnValue(chain);
  chain.insert = vi.fn().mockImplementation(() => {
    const ic = makeChain(tableData, true);
    ic.select = vi.fn().mockImplementation(() => makeChain(tableData, false));
    return ic;
  });
  if (thenable) {
    const rv = { data: tableData, error: null, count: 0 };
    chain.then = (ok?: (v: any) => any, er?: (e: any) => any) => Promise.resolve(rv).then(ok, er);
    chain.catch = (er?: (e: any) => any) => Promise.resolve(rv).catch(er);
  }
  return chain;
}

let mockSession: Record<string, unknown> | null = null;
let mockPayment: Record<string, unknown> | null = PAYMENT_ROW;
let mockBookingPhone: string = PHONE;
let mockCasResult: Record<string, unknown> | null = null;
let capturedSessionInserts: Record<string, unknown>[] = [];

function createSupabase() {
  capturedSessionInserts = [];
  return {
    from: vi.fn().mockImplementation((table: string) => {
      if (table === 'platform_settings') return makeChain({ value: false });
      if (table === 'bot_sessions') {
        const chain = makeChain(mockSession);
        chain.insert = vi.fn().mockImplementation((row: Record<string, unknown>) => {
          capturedSessionInserts.push(row);
          const inserted = { id: 'sess-created', ...row, session_data: row.session_data || {}, version: 0 };
          const ic = makeChain(inserted, true);
          ic.select = vi.fn().mockImplementation(() => makeChain(inserted, false));
          return ic;
        });
        return chain;
      }
      if (table === 'businesses') return makeChain(BUSINESS_ROW);
      if (table === 'payments') return makeChain(mockPayment);
      if (table === 'bookings') return makeChain({ guest_phone: mockBookingPhone });
      if (table === 'blocked_phones') {
        const c = makeChain(null);
        c.select = vi.fn().mockReturnValue({ ...c, eq: vi.fn().mockReturnValue({ ...c, or: vi.fn().mockResolvedValue({ count: 0, error: null }) }) });
        return c;
      }
      return makeChain(null);
    }),
    rpc: vi.fn().mockImplementation((name: string, params?: Record<string, unknown>) => {
      if (name === 'get_bot_context') {
        if (params?.p_business_id === BIZ_A && !mockSession) {
          return Promise.resolve({
            data: { has_session: false, ambiguous: false, session: null, business: BUSINESS_ROW,
              capabilities: [{ capability: 'scheduling', is_enabled: true, sort_order: 0 }], capability_overrides: [] },
            error: null,
          });
        }
        if (mockSession) {
          return Promise.resolve({
            data: { has_session: true, ambiguous: false, session: mockSession, business: BUSINESS_ROW,
              capabilities: [{ capability: 'scheduling', is_enabled: true, sort_order: 0 }], capability_overrides: [] },
            error: null,
          });
        }
        return Promise.resolve({ data: { has_session: false, session: null, business: null, capabilities: [], capability_overrides: [] }, error: null });
      }
      if (name === 'update_session_cas') {
        if (mockCasResult) return Promise.resolve({ data: mockCasResult, error: null });
        return Promise.resolve({ data: { success: true, version: (params?.p_expected_version as number || 0) + 1 }, error: null });
      }
      return Promise.resolve({ data: { success: true, version: 1 }, error: null });
    }),
  };
}

/** Session with revocable active_capability='ticketing' (not in RPC caps [scheduling]).
 *  If revalidation runs, it WILL call update_session_cas + send recovery message. */
function revocableSession(overrides: Record<string, unknown> = {}) {
  return {
    id: SESSION_ID, user_id: null, business_id: BIZ_A,
    whatsapp_number: PHONE_N, current_step: 'select_date',
    session_data: { _detected_language: 'en', active_capability: 'ticketing', capabilities: ['ticketing', 'scheduling'] },
    is_active: true, version: 1,
    ...overrides,
  };
}

function assertZeroSideEffects(supabase: ReturnType<typeof createSupabase>, cloud: ReturnType<typeof createMockCloud>) {
  expect(supabase.rpc.mock.calls.filter((c: any[]) => c[0] === 'update_session_cas')).toHaveLength(0);
  expect(supabase.rpc.mock.calls.filter((c: any[]) => c[0] === 'deactivate_session_atomic')).toHaveLength(0);
  expect(cloud.sendText).not.toHaveBeenCalled();
  expect(cloud.sendButtons).not.toHaveBeenCalled();
  expect(cloud.sendList).not.toHaveBeenCalled();
  expect(mockParseSmartIntentHybrid).not.toHaveBeenCalled();
}

describe('Saved-card pre-verification: real handleMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSession = revocableSession();
    mockPayment = PAYMENT_ROW;
    mockBookingPhone = PHONE;
    mockCasResult = null;
    mockAssertMessagingAllowed.mockResolvedValue(undefined);
  });

  // ════════════════════════════════════
  // Rule (b): payment.business_id null
  // ════════════════════════════════════
  it('savedcard_menu: payment.business_id null → zero side effects', async () => {
    mockPayment = { ...PAYMENT_ROW, business_id: null };
    const supabase = createSupabase();
    const cloud = createMockCloud();
    const bot = new BotService(supabase as any, new MetaCloudSender(cloud as any, supabase as any), createStandaloneService(), createMockIntelligence() as any);
    await bot.handleMessage(PHONE, `savedcard_menu:${PAY_ID}`, 'button');
    assertZeroSideEffects(supabase, cloud);
  });

  it('save_card_accept: payment.business_id null → zero side effects, accept RPC not called', async () => {
    mockPayment = { ...PAYMENT_ROW, business_id: null };
    const supabase = createSupabase();
    const cloud = createMockCloud();
    const bot = new BotService(supabase as any, new MetaCloudSender(cloud as any, supabase as any), createStandaloneService(), createMockIntelligence() as any);
    await bot.handleMessage(PHONE, `save_card_accept:${PAY_ID}`, 'button');
    assertZeroSideEffects(supabase, cloud);
    expect(mockHandleSavedCardOfferAction).not.toHaveBeenCalled();
  });

  // ════════════════════════════════════
  // Rule (d): dedicated channel A, payment at B
  // ════════════════════════════════════
  it('dedicated channel BIZ_A, payment at BIZ_B → zero side effects, sender never bound to B', async () => {
    mockSession = null; // no active session
    mockPayment = { ...PAYMENT_ROW, business_id: BIZ_B };
    const supabase = createSupabase();
    const cloud = createMockCloud();
    const sender = new MetaCloudSender(cloud as any, supabase as any);
    const bot = new BotService(supabase as any, sender, createStandaloneService(), createMockIntelligence() as any);
    // preResolvedBusinessId = BIZ_A (5th arg)
    await bot.handleMessage(PHONE, `savedcard_done:${PAY_ID}`, 'button', undefined, BIZ_A);
    assertZeroSideEffects(supabase, cloud);
    expect(sender.boundBusinessId).not.toBe(BIZ_B);
  });

  // ════════════════════════════════════
  // Offer buttons: another customer's payment → zero side effects, RPC not called
  // ════════════════════════════════════
  it('save_card_accept: another customer\'s payment → zero side effects, RPC not called', async () => {
    mockBookingPhone = OTHER_PHONE;
    const supabase = createSupabase();
    const cloud = createMockCloud();
    const bot = new BotService(supabase as any, new MetaCloudSender(cloud as any, supabase as any), createStandaloneService(), createMockIntelligence() as any);
    await bot.handleMessage(PHONE, `save_card_accept:${PAY_ID}`, 'button');
    assertZeroSideEffects(supabase, cloud);
    expect(mockHandleSavedCardOfferAction).not.toHaveBeenCalled();
  });

  it('save_card_decline: another customer\'s payment → zero side effects, RPC not called', async () => {
    mockBookingPhone = OTHER_PHONE;
    const supabase = createSupabase();
    const cloud = createMockCloud();
    const bot = new BotService(supabase as any, new MetaCloudSender(cloud as any, supabase as any), createStandaloneService(), createMockIntelligence() as any);
    await bot.handleMessage(PHONE, `save_card_decline:${PAY_ID}`, 'button');
    assertZeroSideEffects(supabase, cloud);
    expect(mockHandleSavedCardOfferAction).not.toHaveBeenCalled();
  });

  it('replace_card_accept: another customer\'s payment → zero side effects, RPC not called', async () => {
    mockBookingPhone = OTHER_PHONE;
    const supabase = createSupabase();
    const cloud = createMockCloud();
    const bot = new BotService(supabase as any, new MetaCloudSender(cloud as any, supabase as any), createStandaloneService(), createMockIntelligence() as any);
    await bot.handleMessage(PHONE, `replace_card_accept:${PAY_ID}`, 'button');
    assertZeroSideEffects(supabase, cloud);
    expect(mockHandleSavedCardOfferAction).not.toHaveBeenCalled();
  });

  it('replace_card_decline: another customer\'s payment → zero side effects, RPC not called', async () => {
    mockBookingPhone = OTHER_PHONE;
    const supabase = createSupabase();
    const cloud = createMockCloud();
    const bot = new BotService(supabase as any, new MetaCloudSender(cloud as any, supabase as any), createStandaloneService(), createMockIntelligence() as any);
    await bot.handleMessage(PHONE, `replace_card_decline:${PAY_ID}`, 'button');
    assertZeroSideEffects(supabase, cloud);
    expect(mockHandleSavedCardOfferAction).not.toHaveBeenCalled();
  });

  // ════════════════════════════════════
  // Positive: offer buttons work end to end
  // ════════════════════════════════════
  it('save_card_accept: own payment → handleSavedCardOfferAction called with save_accept', async () => {
    mockSession = revocableSession({ current_step: 'greeting', session_data: { active_capability: 'scheduling', capabilities: ['scheduling'] } });
    const supabase = createSupabase();
    const cloud = createMockCloud();
    const bot = new BotService(supabase as any, new MetaCloudSender(cloud as any, supabase as any), createStandaloneService(), createMockIntelligence() as any);
    await bot.handleMessage(PHONE, `save_card_accept:${PAY_ID}`, 'button');
    expect(mockHandleSavedCardOfferAction).toHaveBeenCalledTimes(1);
    expect(mockHandleSavedCardOfferAction.mock.calls[0][4]).toBe('save_accept');
  });

  it('save_card_decline: own payment → handleSavedCardOfferAction called with save_decline', async () => {
    mockSession = revocableSession({ current_step: 'greeting', session_data: { active_capability: 'scheduling', capabilities: ['scheduling'] } });
    const supabase = createSupabase();
    const cloud = createMockCloud();
    const bot = new BotService(supabase as any, new MetaCloudSender(cloud as any, supabase as any), createStandaloneService(), createMockIntelligence() as any);
    await bot.handleMessage(PHONE, `save_card_decline:${PAY_ID}`, 'button');
    expect(mockHandleSavedCardOfferAction).toHaveBeenCalledTimes(1);
    expect(mockHandleSavedCardOfferAction.mock.calls[0][4]).toBe('save_decline');
  });

  it('replace_card_accept: own payment → handleSavedCardOfferAction called with replace_accept', async () => {
    mockSession = revocableSession({ current_step: 'greeting', session_data: { active_capability: 'scheduling', capabilities: ['scheduling'] } });
    const supabase = createSupabase();
    const cloud = createMockCloud();
    const bot = new BotService(supabase as any, new MetaCloudSender(cloud as any, supabase as any), createStandaloneService(), createMockIntelligence() as any);
    await bot.handleMessage(PHONE, `replace_card_accept:${PAY_ID}`, 'button');
    expect(mockHandleSavedCardOfferAction).toHaveBeenCalledTimes(1);
    expect(mockHandleSavedCardOfferAction.mock.calls[0][4]).toBe('replace_accept');
  });

  it('replace_card_decline: own payment → handleSavedCardOfferAction called with replace_decline', async () => {
    mockSession = revocableSession({ current_step: 'greeting', session_data: { active_capability: 'scheduling', capabilities: ['scheduling'] } });
    const supabase = createSupabase();
    const cloud = createMockCloud();
    const bot = new BotService(supabase as any, new MetaCloudSender(cloud as any, supabase as any), createStandaloneService(), createMockIntelligence() as any);
    await bot.handleMessage(PHONE, `replace_card_decline:${PAY_ID}`, 'button');
    expect(mockHandleSavedCardOfferAction).toHaveBeenCalledTimes(1);
    expect(mockHandleSavedCardOfferAction.mock.calls[0][4]).toBe('replace_decline');
  });

  // ════════════════════════════════════
  // Positive: savedcard_menu own payment → CAS select_capability
  // ════════════════════════════════════
  it('savedcard_menu with own payment → session reset to select_capability', async () => {
    const supabase = createSupabase();
    const cloud = createMockCloud();
    const bot = new BotService(supabase as any, new MetaCloudSender(cloud as any, supabase as any), createStandaloneService(), createMockIntelligence() as any);
    await bot.handleMessage(PHONE, `savedcard_menu:${PAY_ID}`, 'button');
    const menuCas = supabase.rpc.mock.calls.find((c: any[]) => c[0] === 'update_session_cas' && c[1]?.p_current_step === 'select_capability');
    expect(menuCas).toBeDefined();
  });

  // ════════════════════════════════════
  // savedcard_done → deactivated, goodbye in pcm
  // ════════════════════════════════════
  it('savedcard_done → deactivated, goodbye in pcm', async () => {
    mockSession = revocableSession({ current_step: 'greeting', session_data: { _detected_language: 'pcm', active_capability: 'scheduling', capabilities: ['scheduling'] } });
    const supabase = createSupabase();
    const cloud = createMockCloud();
    const bot = new BotService(supabase as any, new MetaCloudSender(cloud as any, supabase as any), createStandaloneService(), createMockIntelligence() as any);
    await bot.handleMessage(PHONE, `savedcard_done:${PAY_ID}`, 'button');
    expect(supabase.rpc.mock.calls.filter((c: any[]) => c[0] === 'deactivate_session_atomic').length).toBeGreaterThan(0);
    expect(cloud.sendText.mock.calls.find((c: any[]) => (c[0]?.text || '').includes('start again'))).toBeDefined();
  });

  // ════════════════════════════════════
  // Suspended → zero cloud sends
  // ════════════════════════════════════
  it('savedcard_done suspended → zero cloud sends', async () => {
    mockSession = revocableSession({ current_step: 'greeting', session_data: { _detected_language: 'en', active_capability: 'scheduling', capabilities: ['scheduling'] } });
    mockAssertMessagingAllowed.mockRejectedValue(new MockMessagingSuspendedError(BIZ_A, 'suspended'));
    const supabase = createSupabase();
    const cloud = createMockCloud();
    const bot = new BotService(supabase as any, new MetaCloudSender(cloud as any, supabase as any), createStandaloneService(), createMockIntelligence() as any);
    await bot.handleMessage(PHONE, `savedcard_done:${PAY_ID}`, 'button');
    expect(cloud.sendText).not.toHaveBeenCalled();
  });

  // ════════════════════════════════════
  // Ambiguous: post-emission throw → exactly 1 cloud send
  // ════════════════════════════════════
  it('savedcard_done post-emission throw → exactly 1 cloud.sendText, no retry', async () => {
    mockSession = revocableSession({ current_step: 'greeting', session_data: { _detected_language: 'en', active_capability: 'scheduling', capabilities: ['scheduling'] } });
    const cloud = createMockCloud();
    // First cloud.sendText succeeds (emits to Meta), but the attempt-recording
    // insert inside MetaCloudSender's withAttemptAndGuard throws on persist.
    // The supabase mock returns error for message_send_attempts inserts.
    const supabase = createSupabase();
    const origFrom = supabase.from;
    supabase.from = vi.fn().mockImplementation((table: string) => {
      if (table === 'message_send_attempts') {
        const chain = makeChain(null);
        chain.insert = vi.fn().mockResolvedValue({ data: null, error: { message: 'Persist failed' } });
        return chain;
      }
      return origFrom(table);
    }) as any;
    const sender = new MetaCloudSender(cloud as any, supabase as any);
    const bot = new BotService(supabase as any, sender, createStandaloneService(), createMockIntelligence() as any);
    await bot.handleMessage(PHONE, `savedcard_done:${PAY_ID}`, 'button');
    // Exactly 1 cloud send (provider call succeeded), no retry
    expect(cloud.sendText).toHaveBeenCalledTimes(1);
  });

  // ════════════════════════════════════
  // CAS failure → no send
  // ════════════════════════════════════
  it('savedcard_menu CAS failure → no send', async () => {
    mockCasResult = { success: false, reason: 'version_conflict' };
    const supabase = createSupabase();
    const cloud = createMockCloud();
    const bot = new BotService(supabase as any, new MetaCloudSender(cloud as any, supabase as any), createStandaloneService(), createMockIntelligence() as any);
    await bot.handleMessage(PHONE, `savedcard_menu:${PAY_ID}`, 'button');
    expect(cloud.sendText).not.toHaveBeenCalled();
    expect(cloud.sendButtons).not.toHaveBeenCalled();
    expect(cloud.sendList).not.toHaveBeenCalled();
  });

  // ════════════════════════════════════
  // Null session + done → business-scoped
  // ════════════════════════════════════
  it('savedcard_done null session → business-scoped goodbye for BIZ_A', async () => {
    mockSession = null;
    const supabase = createSupabase();
    const cloud = createMockCloud();
    const sender = new MetaCloudSender(cloud as any, supabase as any);
    const bot = new BotService(supabase as any, sender, createStandaloneService(), createMockIntelligence() as any);
    await bot.handleMessage(PHONE, `savedcard_done:${PAY_ID}`, 'button');
    expect(cloud.sendText).toHaveBeenCalledTimes(1);
    expect(sender.boundBusinessId).toBe(BIZ_A);
  });

  // ════════════════════════════════════
  // Null session + menu → returning_customer, menu sent, no promo
  // ════════════════════════════════════
  it('savedcard_menu null session → biz_resolution=returning_customer, menu sent, no promo', async () => {
    mockSession = null;
    const supabase = createSupabase();
    const cloud = createMockCloud();
    const sender = new MetaCloudSender(cloud as any, supabase as any);
    const bot = new BotService(supabase as any, sender, createStandaloneService(), createMockIntelligence() as any);
    await bot.handleMessage(PHONE, `savedcard_menu:${PAY_ID}`, 'button');
    expect(capturedSessionInserts.length).toBeGreaterThanOrEqual(1);
    const sessionRow = capturedSessionInserts.find((r) => r.business_id === BIZ_A);
    expect(sessionRow).toBeDefined();
    expect((sessionRow!.session_data as Record<string, unknown>).biz_resolution).toBe('returning_customer');
    expect([...cloud.sendText.mock.calls, ...cloud.sendButtons.mock.calls, ...cloud.sendList.mock.calls].length).toBeGreaterThan(0);
    expect(mockHandlePromoVerification).not.toHaveBeenCalled();
    expect(sender.boundBusinessId).toBe(BIZ_A);
  });
});
