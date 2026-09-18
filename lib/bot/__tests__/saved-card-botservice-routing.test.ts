/**
 * E1+E2: BotService saved-card routing behavioral tests.
 *
 * Proves through real BotService.handleMessage():
 * E1: no-session + inbound "save card" → handleSaveCard wins, greeting/keyword/LLM do NOT steal
 * E2: active save_card_pin/replace_card_pin + "save card" → PIN handler wins, not global command
 *
 * Uses the same real BotService pattern as s1-botservice-real-handleMessage.test.ts.
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
vi.mock('@/lib/bot/smart-intent', () => ({
  parseSmartIntent: vi.fn().mockResolvedValue(null),
  parseSmartIntentHybrid: vi.fn().mockResolvedValue(null),
  matchServiceFromKeywords: vi.fn().mockResolvedValue(null),
  matchProductsFromKeywords: vi.fn().mockResolvedValue([]),
  buildAcknowledgment: vi.fn().mockReturnValue(null),
}));
vi.mock('@/lib/channels/send-guard', () => ({
  assertMessagingAllowed: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/bot/handlers/bot-code-detection', () => ({
  detectBotCode: vi.fn().mockResolvedValue(null),
  detectBotCodeWithSuggestions: vi.fn().mockResolvedValue({ businessId: null, suggestions: [] }),
  rankSuggestions: vi.fn().mockReturnValue([]),
  findReturningCustomerBusiness: vi.fn().mockResolvedValue(null),
  findReturningCustomerBusinesses: vi.fn().mockResolvedValue([]),
}));

// Session to return from bot_sessions queries
let mockSessionResult: Record<string, unknown> | null = null;

// Mock all saved-card handlers with trackable spies
const mockHandleSaveCard = vi.fn().mockResolvedValue(undefined);
const mockHandleCardPinStep = vi.fn().mockResolvedValue(undefined);
const mockHandleReplacementPinStep = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/bot/handlers/saved-cards', () => ({
  handleSaveCard: (...args: unknown[]) => mockHandleSaveCard(...args),
  handleRemoveCard: vi.fn().mockResolvedValue(undefined),
  handleCardPinStep: (...args: unknown[]) => mockHandleCardPinStep(...args),
  handleReplacementPinStep: (...args: unknown[]) => mockHandleReplacementPinStep(...args),
  findLatestSavedCardPaymentIdForPhone: vi.fn().mockResolvedValue(null),
}));

const { BotService } = await import('@/lib/bot/bot.service');
const { MetaCloudSender } = await import('@/lib/channels/message-sender');

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

const PHONE = '+2348012345678';
const BIZ_ID = 'biz-citadel-001';

function createSupabase() {
  return {
    from: vi.fn().mockImplementation((table: string) => {
      if (table === 'platform_settings') return makeChain({ value: false });
      if (table === 'bot_sessions') return makeChain(mockSessionResult);
      if (table === 'businesses') return makeChain({ id: BIZ_ID, name: 'Citadel of Grace', slug: 'citadel', category: 'church', flow_type: 'scheduling', subscription_tier: 'growth', trial_ends_at: null, metadata: {}, country_code: 'NG' });
      if (table === 'blocked_phones') {
        const c = makeChain(null);
        c.select = vi.fn().mockReturnValue({ ...c, eq: vi.fn().mockReturnValue({ ...c, or: vi.fn().mockResolvedValue({ count: 0, error: null }) }) });
        return c;
      }
      return makeChain(null);
    }),
    rpc: vi.fn().mockResolvedValue({ data: { success: true, version: 1 }, error: null }),
  };
}

describe('E1+E2: BotService saved-card routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionResult = null;
  });

  // ═══════════════════════════════════════════════════════════════
  // E1: No active session + "save card" → handleSaveCard wins
  // ═══════════════════════════════════════════════════════════════
  it('E1: no active session + "save card" → handleSaveCard called, greeting path NOT reached', async () => {
    mockSessionResult = null; // no active session
    const supabase = createSupabase();
    const cloud = createMockCloud();
    const sender = new MetaCloudSender(cloud as any, 'ch-001', BIZ_ID);
    const bot = new BotService(supabase as any, sender, createStandaloneService(), createMockIntelligence() as any);

    await bot.handleMessage(PHONE, 'save card', { type: 'text' });

    expect(mockHandleSaveCard).toHaveBeenCalledTimes(1);
    // Greeting path should NOT have sent cloud messages
    expect(cloud.sendText).not.toHaveBeenCalled();
    expect(cloud.sendButtons).not.toHaveBeenCalled();
  });

  it('E1: no active session + "save my card" → handleSaveCard called', async () => {
    mockSessionResult = null;
    const supabase = createSupabase();
    const cloud = createMockCloud();
    const sender = new MetaCloudSender(cloud as any, 'ch-001', BIZ_ID);
    const bot = new BotService(supabase as any, sender, createStandaloneService(), createMockIntelligence() as any);

    await bot.handleMessage(PHONE, 'save my card', { type: 'text' });

    expect(mockHandleSaveCard).toHaveBeenCalledTimes(1);
  });

  // ═══════════════════════════════════════════════════════════════
  // E2: Active PIN step + "save card" → PIN handler wins
  // ═══════════════════════════════════════════════════════════════
  it('E2: active save_card_pin + "save card" → PIN handler wins, handleSaveCard NOT called', async () => {
    mockSessionResult = {
      id: 'sess-1', user_id: 'u1', business_id: BIZ_ID, is_active: true, version: 1,
      whatsapp_number: PHONE, current_step: 'save_card_pin',
      session_data: { _save_card_pending: true, _save_card_business_id: BIZ_ID },
      expires_at: new Date(Date.now() + 3600000).toISOString(),
    };
    const supabase = createSupabase();
    const cloud = createMockCloud();
    const sender = new MetaCloudSender(cloud as any, 'ch-001', BIZ_ID);
    const bot = new BotService(supabase as any, sender, createStandaloneService(), createMockIntelligence() as any);

    await bot.handleMessage(PHONE, 'save card', { type: 'text' });

    // PIN step takes precedence: handleSaveCard must NOT be called
    expect(mockHandleSaveCard).not.toHaveBeenCalled();
    // The static import `_handleCardPinStep` is called by BotService — verify
    // by checking that the cloud sendText was triggered (PIN handler sends a message
    // via this.sendText → MessageSender → cloud.sendText)
    expect(cloud.sendText).toHaveBeenCalled();
  });

  it('E2: active replace_card_pin + "save card" → replacement PIN handler wins', async () => {
    mockSessionResult = {
      id: 'sess-2', user_id: 'u1', business_id: BIZ_ID, is_active: true, version: 1,
      whatsapp_number: PHONE, current_step: 'replace_card_pin',
      session_data: { _replace_method_id: 'meth-1', _replace_payment_id: 'pay-1', _replace_expected_state_hash: 'hash' },
      expires_at: new Date(Date.now() + 3600000).toISOString(),
    };
    const supabase = createSupabase();
    const cloud = createMockCloud();
    const sender = new MetaCloudSender(cloud as any, 'ch-001', BIZ_ID);
    const bot = new BotService(supabase as any, sender, createStandaloneService(), createMockIntelligence() as any);

    await bot.handleMessage(PHONE, 'save card', { type: 'text' });

    expect(mockHandleSaveCard).not.toHaveBeenCalled();
    // Replacement PIN handler wins: cloud.sendText called (PIN response), not greeting/buttons
    expect(cloud.sendText).toHaveBeenCalled();
    expect(cloud.sendButtons).not.toHaveBeenCalled();
  });
});
