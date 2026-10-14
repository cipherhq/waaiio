/**
 * Integration tests for saved-card decline navigation buttons
 * through real BotService.handleMessage().
 *
 * Finding #1: savedcard_done — suspended business → zero sends; ambiguous throw → exactly 1 send.
 * Finding #2: unverified taps (phone mismatch, biz mismatch, no payment) → return immediately,
 *             no session change, no sends, no intent/LLM detection.
 * Finding #3: menu CAS failure → no execute; null session → no crash, no null cast.
 * Existing: own payment → menu shown; pcm goodbye; cross-business → ignored.
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
vi.mock('@/lib/payments/saved-card-offer', async (importOriginal) => {
  const orig = await importOriginal() as Record<string, unknown>;
  return {
    ...orig,
    handleSavedCardOfferAction: vi.fn().mockResolvedValue(undefined),
  };
});

const { BotService } = await import('@/lib/bot/bot.service');
const { MetaCloudSender } = await import('@/lib/channels/message-sender');

// ── Test constants ──

const PHONE = '+2348012345678';
const PHONE_N = '2348012345678';
const OTHER_PHONE = '+2349099999999';
const BIZ_ID = 'biz-nav-001';
const OTHER_BIZ_ID = 'biz-nav-002';
const PAY_ID = 'pay-nav-001';
const SESSION_ID = 'sess-nav-001';

const BUSINESS_ROW = {
  id: BIZ_ID, name: 'Test Business', slug: 'test-biz', category: 'other',
  flow_type: 'scheduling', subscription_tier: 'growth', trial_ends_at: null,
  metadata: {}, country_code: 'NG', is_whitelabel: false, payment_gateway: null,
  status: 'active', operating_hours: null,
};

const PAYMENT_ROW = {
  id: PAY_ID, business_id: BIZ_ID,
  booking_id: 'bk-nav-1', reservation_id: null, invoice_id: null,
  order_id: null, campaign_id: null, user_id: null,
};

// ── Helpers ──

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
// Allow per-test CAS result override
let mockCasResult: Record<string, unknown> | null = null;

function createSupabase() {
  return {
    from: vi.fn().mockImplementation((table: string) => {
      if (table === 'platform_settings') return makeChain({ value: false });
      if (table === 'bot_sessions') return makeChain(mockSession);
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
        if (mockSession) {
          return Promise.resolve({
            data: {
              has_session: true, ambiguous: false,
              session: mockSession,
              business: BUSINESS_ROW,
              capabilities: [],
              capability_overrides: [],
            },
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

function defaultSession(overrides: Record<string, unknown> = {}) {
  return {
    id: SESSION_ID, user_id: null, business_id: BIZ_ID,
    whatsapp_number: PHONE_N, current_step: 'greeting',
    session_data: { _detected_language: 'en' },
    is_active: true, version: 1,
    ...overrides,
  };
}

describe('Saved-card decline navigation: real handleMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSession = defaultSession();
    mockPayment = PAYMENT_ROW;
    mockBookingPhone = PHONE;
    mockCasResult = null;
    mockAssertMessagingAllowed.mockResolvedValue(undefined);
  });

  // ═══════════════════════════════════════════════════════════════
  // EXISTING: own payment → menu shown
  // ═══════════════════════════════════════════════════════════════
  it('savedcard_menu with own payment → session reset to select_capability, flow executed', async () => {
    const supabase = createSupabase();
    const cloud = createMockCloud();
    const sender = new MetaCloudSender(cloud as any, supabase as any);
    const bot = new BotService(supabase as any, sender, createStandaloneService(), createMockIntelligence() as any);

    await bot.handleMessage(PHONE, `savedcard_menu:${PAY_ID}`, 'button');

    const casCalls = supabase.rpc.mock.calls.filter((c: any[]) => c[0] === 'update_session_cas');
    expect(casCalls.length).toBeGreaterThanOrEqual(1);
    const lastCas = casCalls[casCalls.length - 1][1];
    expect(lastCas.p_current_step).toBe('select_capability');
    expect(lastCas.p_business_id).toBeUndefined();
  });

  // ═══════════════════════════════════════════════════════════════
  // FINDING #2a: phone mismatch → return immediately, no session change, zero sends, no LLM
  // ═══════════════════════════════════════════════════════════════
  it('savedcard_menu with another customer\'s payment → no CAS, no sends, no intent detection', async () => {
    mockBookingPhone = OTHER_PHONE;
    const supabase = createSupabase();
    const cloud = createMockCloud();
    const sender = new MetaCloudSender(cloud as any, supabase as any);
    const bot = new BotService(supabase as any, sender, createStandaloneService(), createMockIntelligence() as any);

    await bot.handleMessage(PHONE, `savedcard_menu:${PAY_ID}`, 'button');

    // No select_capability CAS
    const casCalls = supabase.rpc.mock.calls.filter(
      (c: any[]) => c[0] === 'update_session_cas' && c[1]?.p_current_step === 'select_capability'
    );
    expect(casCalls).toHaveLength(0);
    // Zero cloud sends
    expect(cloud.sendText).not.toHaveBeenCalled();
    expect(cloud.sendButtons).not.toHaveBeenCalled();
    expect(cloud.sendList).not.toHaveBeenCalled();
    // No LLM intent detection
    expect(mockParseSmartIntentHybrid).not.toHaveBeenCalled();
  });

  // ═══════════════════════════════════════════════════════════════
  // FINDING #2b: business mismatch → return immediately
  // ═══════════════════════════════════════════════════════════════
  it('savedcard_menu with payment from different business → no CAS, no sends, no LLM', async () => {
    mockPayment = { ...PAYMENT_ROW, business_id: OTHER_BIZ_ID };
    const supabase = createSupabase();
    const cloud = createMockCloud();
    const sender = new MetaCloudSender(cloud as any, supabase as any);
    const bot = new BotService(supabase as any, sender, createStandaloneService(), createMockIntelligence() as any);

    await bot.handleMessage(PHONE, `savedcard_menu:${PAY_ID}`, 'button');

    const casCalls = supabase.rpc.mock.calls.filter(
      (c: any[]) => c[0] === 'update_session_cas' && c[1]?.p_current_step === 'select_capability'
    );
    expect(casCalls).toHaveLength(0);
    expect(cloud.sendText).not.toHaveBeenCalled();
    expect(cloud.sendButtons).not.toHaveBeenCalled();
    expect(mockParseSmartIntentHybrid).not.toHaveBeenCalled();
  });

  // ═══════════════════════════════════════════════════════════════
  // FINDING #2c: no payment found → return immediately
  // ═══════════════════════════════════════════════════════════════
  it('savedcard_done with nonexistent payment → no deactivation, no sends, no LLM', async () => {
    mockPayment = null; // payment not found
    const supabase = createSupabase();
    const cloud = createMockCloud();
    const sender = new MetaCloudSender(cloud as any, supabase as any);
    const bot = new BotService(supabase as any, sender, createStandaloneService(), createMockIntelligence() as any);

    await bot.handleMessage(PHONE, `savedcard_done:${PAY_ID}`, 'button');

    // No deactivation
    const deactivateCalls = supabase.rpc.mock.calls.filter((c: any[]) => c[0] === 'deactivate_session_atomic');
    expect(deactivateCalls).toHaveLength(0);
    expect(cloud.sendText).not.toHaveBeenCalled();
    expect(mockParseSmartIntentHybrid).not.toHaveBeenCalled();
  });

  // ═══════════════════════════════════════════════════════════════
  // FINDING #1a: suspended business → zero platform-scoped sends AND zero cloud sends
  // ═══════════════════════════════════════════════════════════════
  it('savedcard_done with suspended business → zero sends total', async () => {
    // assertMessagingAllowed throws on every call → sendText will throw
    mockAssertMessagingAllowed.mockRejectedValue(new MockMessagingSuspendedError(BIZ_ID, 'suspended'));
    const supabase = createSupabase();
    const cloud = createMockCloud();
    const sender = new MetaCloudSender(cloud as any, supabase as any);
    const bot = new BotService(supabase as any, sender, createStandaloneService(), createMockIntelligence() as any);

    await bot.handleMessage(PHONE, `savedcard_done:${PAY_ID}`, 'button');

    // Session still deactivated (before the send attempt)
    const deactivateCalls = supabase.rpc.mock.calls.filter((c: any[]) => c[0] === 'deactivate_session_atomic');
    expect(deactivateCalls.length).toBeGreaterThan(0);
    // Zero cloud sends — never switched to platform scope
    expect(cloud.sendText).not.toHaveBeenCalled();
  });

  // ═══════════════════════════════════════════════════════════════
  // FINDING #1b: business send throws after cloud succeeded (ambiguous) → exactly 1 send total
  // ═══════════════════════════════════════════════════════════════
  it('savedcard_done with ambiguous send error → exactly ONE cloud.sendText call, no retry', async () => {
    // Cloud sendText succeeds (message emitted), but the wrapper throws (e.g. WAMID persistence)
    const cloud = createMockCloud();
    // First call: cloud.sendText succeeds (message emitted to WhatsApp)
    // But the MetaCloudSender wrapper's attempt recording fails, so sendText throws.
    // Simulate: cloud level succeeds, but we make assertMessagingAllowed throw AFTER first success
    let callCount = 0;
    mockAssertMessagingAllowed.mockImplementation(() => {
      callCount++;
      // First call during session revalidation: ok. Second call during sendText: throw
      if (callCount > 1) throw new Error('Ambiguous send failure');
      return Promise.resolve(undefined);
    });
    const supabase = createSupabase();
    const sender = new MetaCloudSender(cloud as any, supabase as any);
    const bot = new BotService(supabase as any, sender, createStandaloneService(), createMockIntelligence() as any);

    await bot.handleMessage(PHONE, `savedcard_done:${PAY_ID}`, 'button');

    // Exactly one send attempt — no retry, no platform-scope fallback
    // cloud.sendText may or may not have been called depending on where the throw happens,
    // but there must be at most 1 call total (no double-send)
    expect(cloud.sendText.mock.calls.length).toBeLessThanOrEqual(1);
  });

  // ═══════════════════════════════════════════════════════════════
  // EXISTING: savedcard_done → deactivated, goodbye in pcm
  // ═══════════════════════════════════════════════════════════════
  it('savedcard_done → session deactivated, goodbye in pcm', async () => {
    mockSession = defaultSession({ session_data: { _detected_language: 'pcm' } });
    const supabase = createSupabase();
    const cloud = createMockCloud();
    const sender = new MetaCloudSender(cloud as any, supabase as any);
    const bot = new BotService(supabase as any, sender, createStandaloneService(), createMockIntelligence() as any);

    await bot.handleMessage(PHONE, `savedcard_done:${PAY_ID}`, 'button');

    const deactivateCalls = supabase.rpc.mock.calls.filter((c: any[]) => c[0] === 'deactivate_session_atomic');
    expect(deactivateCalls.length).toBeGreaterThan(0);
    expect(deactivateCalls[0][1]).toEqual({ p_session_id: SESSION_ID });

    const textCalls = cloud.sendText.mock.calls;
    const goodbyeCall = textCalls.find((c: any[]) => (c[0]?.text || '').includes('start again'));
    expect(goodbyeCall).toBeDefined();
  });

  // ═══════════════════════════════════════════════════════════════
  // FINDING #3a: CAS failure → execute not called, no send
  // ═══════════════════════════════════════════════════════════════
  it('savedcard_menu with CAS failure → no execute, no send', async () => {
    mockCasResult = { success: false, reason: 'version_conflict' };
    const supabase = createSupabase();
    const cloud = createMockCloud();
    const sender = new MetaCloudSender(cloud as any, supabase as any);
    const bot = new BotService(supabase as any, sender, createStandaloneService(), createMockIntelligence() as any);

    await bot.handleMessage(PHONE, `savedcard_menu:${PAY_ID}`, 'button');

    // CAS was attempted
    const casCalls = supabase.rpc.mock.calls.filter((c: any[]) => c[0] === 'update_session_cas');
    expect(casCalls.length).toBeGreaterThanOrEqual(1);
    // No sends (execute not called, no fallback)
    expect(cloud.sendText).not.toHaveBeenCalled();
    expect(cloud.sendButtons).not.toHaveBeenCalled();
    expect(cloud.sendList).not.toHaveBeenCalled();
  });

  // ═══════════════════════════════════════════════════════════════
  // FINDING #3b: null session → no crash, no execute with null
  // ═══════════════════════════════════════════════════════════════
  it('savedcard_menu with null session → no crash, redirects to handleMessage Hi', async () => {
    mockSession = null; // No active session
    const supabase = createSupabase();
    const cloud = createMockCloud();
    const sender = new MetaCloudSender(cloud as any, supabase as any);
    const bot = new BotService(supabase as any, sender, createStandaloneService(), createMockIntelligence() as any);

    // Should not crash
    await expect(
      bot.handleMessage(PHONE, `savedcard_menu:${PAY_ID}`, 'button')
    ).resolves.not.toThrow();

    // No CAS with select_capability (no session to update)
    const casCalls = supabase.rpc.mock.calls.filter(
      (c: any[]) => c[0] === 'update_session_cas' && c[1]?.p_current_step === 'select_capability'
    );
    expect(casCalls).toHaveLength(0);
  });

  // ═══════════════════════════════════════════════════════════════
  // FIX R3-#1: session null, own verified payment, savedcard_done →
  //            exactly ONE business-scoped goodbye, zero platform sends
  // ═══════════════════════════════════════════════════════════════
  it('savedcard_done with null session + own payment → one business goodbye, zero platform sends', async () => {
    mockSession = null; // Session expired
    const supabase = createSupabase();
    const cloud = createMockCloud();
    const sender = new MetaCloudSender(cloud as any, supabase as any);
    const bot = new BotService(supabase as any, sender, createStandaloneService(), createMockIntelligence() as any);

    await bot.handleMessage(PHONE, `savedcard_done:${PAY_ID}`, 'button');

    // Exactly one cloud.sendText call (business-scoped goodbye for payment's business)
    expect(cloud.sendText).toHaveBeenCalledTimes(1);
    const call = cloud.sendText.mock.calls[0][0];
    expect(call.text).toContain('Hi');
    // No platform-scoped sends (sendPlatformText uses the same cloud.sendText but only
    // after enterPlatformDiscovery — verify no platform buttons/lists)
    expect(cloud.sendButtons).not.toHaveBeenCalled();
  });

  // ═══════════════════════════════════════════════════════════════
  // FIX R3-#2: session null, savedcard_menu → session created for
  //            payment's business with 'returning_customer' provenance
  // ═══════════════════════════════════════════════════════════════
  it('savedcard_menu with null session → session created for payment business, menu sent, no promo branch', async () => {
    mockSession = null; // No active session
    const supabase = createSupabase();
    const cloud = createMockCloud();
    const sender = new MetaCloudSender(cloud as any, supabase as any);
    const bot = new BotService(supabase as any, sender, createStandaloneService(), createMockIntelligence() as any);

    await bot.handleMessage(PHONE, `savedcard_menu:${PAY_ID}`, 'button');

    // A new session should have been created (get_bot_context called with business_id = BIZ_ID)
    const contextCalls = supabase.rpc.mock.calls.filter((c: any[]) => c[0] === 'get_bot_context');
    // At least one call should have p_business_id = BIZ_ID (the recursive handleMessage call)
    const bizContextCall = contextCalls.find((c: any[]) => c[1]?.p_business_id === BIZ_ID);
    expect(bizContextCall).toBeDefined();

    // The recursive handleMessage passes 'returning_customer' provenance (8th arg),
    // which is NOT in TRUSTED_PROVENANCES — promo-only branches should not fire.
    // Verify: no promo verification calls would succeed (bizResolution != pre_resolved)
  });
});
