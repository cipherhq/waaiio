/**
 * sendPlatformLocalizedText behavioral tests (#645)
 *
 * Fix 1 — send exactly once, outside the try:
 *   T1: translation succeeds, then sendPlatformText throws → exactly 1 send attempt
 *   T2: translator throws → exactly 1 English send
 *
 * Fix 2 — platform replies must not use a business's translation context:
 *   T3: session with business_id='biz-a', _detected_language='pcm' →
 *       buildTranslationContext(null, 'free') used, ctx.businessId === ''
 *
 * All three tests exercise the real BotService.handleMessage() → biz_no path in
 * select_business_suggestion, which calls sendPlatformLocalizedText with the session.
 * No source-string tests.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoist translateBotResponse mock — must be captured before module load ──
const { mockTranslateBotResponse } = vi.hoisted(() => ({
  mockTranslateBotResponse: vi.fn(),
}));

vi.mock('@/lib/bot/translate', async () => {
  const actual = await vi.importActual('@/lib/bot/translate');
  return {
    ...(actual as object),
    translateBotResponse: (...args: unknown[]) => mockTranslateBotResponse(...args),
  };
});

// ── Standard infrastructure mocks ──
vi.mock('@/lib/countries', () => ({
  loadCountries: vi.fn().mockResolvedValue([]),
  getCountry: vi.fn(),
  getCountryList: vi.fn().mockReturnValue([]),
  isValidCountryCode: vi.fn().mockReturnValue(true),
  getDialingCodeMap: vi.fn().mockReturnValue({}),
}));

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimitAsync: vi.fn().mockResolvedValue({ allowed: true, remaining: 10 }),
}));

vi.mock('@/lib/platformSettings', () => ({
  loadPlatformSettings: vi.fn().mockResolvedValue({ bot_rate_limit_per_minute: 30 }),
}));

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/bot/handlers/escape-hatches', () => ({
  HOME_PATTERN: /^home$/i,
  handleEscapeHatch: vi.fn().mockResolvedValue({ handled: false }),
}));

vi.mock('@/lib/bot/handlers/global-queries', () => ({
  handleGlobalQuery: vi.fn(async (opts: { session: unknown }) => ({ handled: false, session: opts.session })),
  isOrdersQuery: vi.fn(() => false),
}));

vi.mock('@/lib/bot/keyword-service', () => ({
  loadBotCustomConfig: vi.fn().mockResolvedValue({ welcome_buttons: [], quick_replies: [], default_reply: null }),
  matchQuickReply: vi.fn(() => null),
  loadUnifiedKeywords: vi.fn().mockResolvedValue([]),
  matchUnifiedKeyword: vi.fn(() => null),
}));

vi.mock('@/lib/bot/handlers/bot-code-detection', () => ({
  detectBotCode: vi.fn().mockResolvedValue(null),
  detectBotCodeWithSuggestions: vi.fn().mockResolvedValue({ businessId: null, suggestions: [] }),
  rankSuggestions: vi.fn().mockReturnValue([]),
  findReturningCustomerBusiness: vi.fn().mockResolvedValue(null),
  findReturningCustomerBusinesses: vi.fn().mockResolvedValue([]),
}));

vi.mock('@/lib/bot/handlers/promo-verification', () => ({
  handlePromoVerification: vi.fn().mockResolvedValue({ handled: false }),
}));

vi.mock('@/lib/trial-status', () => ({
  resolveTrialCredit: vi.fn().mockResolvedValue(false),
}));

vi.mock('@/lib/bot/resolve-handler-copy-lang', () => ({
  resolveHandlerCopyLang: vi.fn().mockResolvedValue('en'),
}));

vi.mock('@/lib/bot/language-policy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../language-policy')>();
  return {
    ...actual,
    loadBusinessLanguages: vi.fn().mockResolvedValue(null),
  };
});

vi.mock('@/lib/bot/language-preference', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../language-preference')>();
  return {
    ...actual,
    readPreferredResponseLanguage: vi.fn().mockResolvedValue(null),
    writePreferredResponseLanguage: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('@/lib/bot/automation/rules-engine', () => ({
  evaluateRules: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/bot/handlers/saved-cards', () => ({
  handleSaveCard: vi.fn().mockResolvedValue(undefined),
  handleRemoveCard: vi.fn().mockResolvedValue(undefined),
  handleCardPinStep: vi.fn().mockResolvedValue(undefined),
  handleReplacementPinStep: vi.fn().mockResolvedValue(undefined),
  findLatestSavedCardPaymentIdForPhone: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/lib/bot/step-overrides', () => ({
  loadOverrides: vi.fn().mockResolvedValue(new Map()),
  evaluateBranchConditions: vi.fn(),
}));

vi.mock('@/lib/bot/translations', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../translations')>();
  return {
    ...actual,
    loadBusinessOverrides: vi.fn().mockResolvedValue({}),
    loadPlatformOverrides: vi.fn().mockResolvedValue({}),
    runWithTranslationOverrides: vi.fn(async (_overrides: unknown, fn: () => Promise<unknown>) => fn()),
    createOverridesLoader: vi.fn().mockReturnValue({
      get: vi.fn().mockResolvedValue({}),
      empty: {},
    }),
  };
});

vi.mock('@/lib/bot/customer-intelligence', () => ({
  getCustomerHistory: vi.fn().mockResolvedValue({ isReturning: false, totalVisits: 0 }),
  buildReturnGreeting: vi.fn().mockReturnValue(null),
  buildDefaultWelcomeLine: vi.fn().mockReturnValue(null),
}));

// ── Dynamic imports used inside bot.service.ts ──
vi.mock('@/lib/bot/launch-optin', () => ({
  handleLaunchOptIn: vi.fn().mockResolvedValue(false),
}));

const { BotService } = await import('@/lib/bot/bot.service');

// ── Helpers ──

/** Chainable Supabase query builder that resolves the given data. */
function makeChain(tableData: unknown = null) {
  const chain: Record<string, any> = {};
  for (const m of ['eq', 'neq', 'or', 'is', 'in', 'not', 'lt', 'gt', 'gte', 'lte',
    'ilike', 'like', 'limit', 'order', 'head', 'update', 'delete', 'upsert',
    'filter', 'contains', 'containedBy', 'range', 'overlaps', 'textSearch',
    'match', 'csv', 'returns', 'select', 'insert'])
    chain[m] = vi.fn().mockReturnValue(chain);
  chain.single = vi.fn().mockResolvedValue({ data: tableData, error: tableData ? null : { message: 'not found' } });
  chain.maybeSingle = vi.fn().mockResolvedValue({ data: tableData, error: null });
  const rv = { data: tableData, error: null, count: 0 };
  chain.then = (ok?: (v: any) => any, er?: (e: any) => any) => Promise.resolve(rv).then(ok, er);
  chain.catch = (er?: (e: any) => any) => Promise.resolve(rv).catch(er);
  return chain;
}

/** Minimal sender with trackable sendPlatformText and sendText methods. */
function createPlatformSender() {
  const sendText = vi.fn().mockResolvedValue({ success: true, messageId: 'msg-text-1' });
  const sendPlatformText = vi.fn().mockResolvedValue(undefined);
  return {
    sendText,
    sendPlatformText,
    sendButtons: vi.fn().mockResolvedValue({ success: true }),
    sendPlatformButtons: vi.fn().mockResolvedValue(undefined),
    sendList: vi.fn().mockResolvedValue({ success: true }),
    sendImage: vi.fn().mockResolvedValue({ success: true }),
    sendDocument: vi.fn().mockResolvedValue({ success: true }),
    sendAudio: vi.fn().mockResolvedValue({ success: true }),
    sendTemplate: vi.fn().mockResolvedValue({ success: true }),
    sendFlow: vi.fn().mockResolvedValue({ success: true }),
    sendReaction: vi.fn().mockResolvedValue({ success: true }),
    sendLocation: vi.fn().mockResolvedValue({ success: true }),
    enterPlatformDiscovery: vi.fn(),
    bindBusiness: vi.fn(),
  } as any;
}

/** Minimal BotIntelligenceService stub. */
function createMockIntelligence() {
  return {
    isTimedOut: vi.fn().mockReturnValue({ timedOut: false }),
    containsProfanity: vi.fn().mockReturnValue(false),
    recordProfanity: vi.fn().mockReturnValue({ timeout: false, warn: false }),
    recordGibberish: vi.fn().mockReturnValue({ timeout: false, warn: false }),
    detectBookingIntent: vi.fn().mockReturnValue(null),
    getPersonaGreeting: vi.fn().mockReturnValue(null),
    getHelpText: vi.fn().mockReturnValue('Help'),
    getContextualHelp: vi.fn().mockReturnValue('Help'),
    resetAbuse: vi.fn(),
  } as any;
}

/** Minimal StandaloneService stub. */
function createMockStandalone() {
  return {
    loadWhatsAppConfigBundle: vi.fn().mockResolvedValue({
      templates: {}, alias: null, welcome_buttons: [], quick_replies: [],
      default_reply: null, auto_reply_enabled: false, business_hours: null,
    }),
    checkTierLimitsFromBusiness: vi.fn().mockResolvedValue({ allowed: true, isWhitelabel: false }),
    fillTemplate: vi.fn((t: string) => t),
    getBotAlias: vi.fn().mockResolvedValue(null),
    checkTierLimits: vi.fn().mockResolvedValue({ allowed: true }),
  } as any;
}

const PHONE = '+2348001234567';

// ══════════════════════════════════════════════════════════════
// Tests 1 & 2 — null-biz select_business_suggestion, biz_no path
// ══════════════════════════════════════════════════════════════

/** Build supabase mock with a null-biz select_business_suggestion session. */
function createNullBizSupabase(sessionData?: Record<string, unknown>) {
  const session = {
    id: 'sess-null-biz-1',
    user_id: null,
    business_id: null,
    current_step: 'select_business_suggestion',
    is_active: true,
    whatsapp_number: PHONE,
    session_data: {
      _detected_language: 'pcm',
      suggestions: [],
      ...(sessionData || {}),
    },
    conversation_log: [],
    version: 1,
    expires_at: new Date(Date.now() + 86400000).toISOString(),
    last_active_at: new Date().toISOString(),
  };

  return {
    from: vi.fn().mockImplementation((table: string) => {
      if (table === 'platform_settings') return makeChain({ value: false });
      return makeChain(null);
    }),
    rpc: vi.fn().mockImplementation((name: string, params?: Record<string, unknown>) => {
      if (name === 'get_bot_context' && params?.p_business_id === null) {
        return Promise.resolve({
          data: {
            has_session: true,
            ambiguous: false,
            session,
            business: null,
            capabilities: null,
            capability_overrides: null,
          },
          error: null,
        });
      }
      // deactivate_session_atomic and update_session_cas
      return Promise.resolve({ data: { success: true, version: 2 }, error: null });
    }),
  } as any;
}

describe('T1 — translation succeeds, sendPlatformText throws: exactly 1 send attempt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends exactly once even when sendPlatformText throws after successful translation', async () => {
    // Arrange
    mockTranslateBotResponse.mockResolvedValueOnce('Abeg, send bizness code make yu connect.');

    const sender = createPlatformSender();
    // sendPlatformText throws on the first (and only) call
    const sendError = new Error('Meta API timeout');
    sender.sendPlatformText.mockRejectedValueOnce(sendError);

    const supabase = createNullBizSupabase();
    const bot = new BotService(supabase, sender, createMockStandalone(), createMockIntelligence());

    // Act — biz_no triggers sendPlatformLocalizedText via select_business_suggestion handler
    await bot.handleMessage(PHONE, 'biz_no', 'text');

    // Assert: sendPlatformText called exactly once (not twice)
    expect(sender.sendPlatformText).toHaveBeenCalledTimes(1);
    // The outer catch may call sendText with a fallback — verify it's NOT sendPlatformText
    const ptCalls = sender.sendPlatformText.mock.calls.length;
    expect(ptCalls).toBe(1);
  });
});

describe('T2 — translator throws: exactly 1 English send', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends English text exactly once when translateBotResponse throws', async () => {
    // Arrange
    mockTranslateBotResponse.mockRejectedValueOnce(new Error('Anthropic unavailable'));

    const sender = createPlatformSender();
    const supabase = createNullBizSupabase();
    const bot = new BotService(supabase, sender, createMockStandalone(), createMockIntelligence());

    // Act
    await bot.handleMessage(PHONE, 'biz_no', 'text');

    // Assert: sendPlatformText called exactly once, with English text
    expect(sender.sendPlatformText).toHaveBeenCalledTimes(1);
    const [callArg] = sender.sendPlatformText.mock.calls[0];
    // English fallback text must contain the key phrase (not a translation)
    expect(callArg.text).toContain('business code');
    expect(callArg.to).toBe(PHONE);
  });
});

// ══════════════════════════════════════════════════════════════
// Test 3 — platform context isolation: session with biz-a
// ══════════════════════════════════════════════════════════════

/** Build supabase mock with a session that has business_id='biz-a'. */
function createBizASupabase() {
  const session = {
    id: 'sess-biz-a-1',
    user_id: null,
    business_id: 'biz-a',
    current_step: 'select_business_suggestion',
    is_active: true,
    whatsapp_number: PHONE,
    session_data: {
      _detected_language: 'pcm',
      suggestions: [],
      // No active_capability → capability revocation check skips
    },
    conversation_log: [],
    version: 1,
    expires_at: new Date(Date.now() + 86400000).toISOString(),
    last_active_at: new Date().toISOString(),
  };

  const business = {
    id: 'biz-a',
    name: 'Test Biz A',
    slug: 'biz-a',
    category: 'salon',
    flow_type: 'scheduling',
    subscription_tier: 'growth',
    trial_ends_at: null,
    metadata: {},
    country_code: 'NG',
    payment_gateway: null,
    status: 'active',
    is_whitelabel: false,
    operating_hours: null,
    owner_id: 'owner-1',
  };

  return {
    from: vi.fn().mockImplementation((table: string) => {
      if (table === 'platform_settings') return makeChain({ value: false });
      if (table === 'businesses') return makeChain(business);
      return makeChain(null);
    }),
    rpc: vi.fn().mockImplementation((name: string, params?: Record<string, unknown>) => {
      if (name === 'get_bot_context' && params?.p_business_id === null) {
        return Promise.resolve({
          data: {
            has_session: true,
            ambiguous: false,
            session,
            business,
            // Provide capabilities → fast path in capability revalidation
            capabilities: [{ capability: 'scheduling', is_enabled: true, sort_order: 0 }],
            capability_overrides: [],
          },
          error: null,
        });
      }
      // deactivate_session_atomic, update_session_cas
      return Promise.resolve({ data: { success: true, version: 2 }, error: null });
    }),
  } as any;
}

describe('T3 — platform context isolation: biz-a session uses (null, free) context', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses buildTranslationContext(null, free) even when session.business_id is biz-a', async () => {
    // Arrange — capture the ctx argument passed to translateBotResponse
    let capturedCtx: any = null;
    mockTranslateBotResponse.mockImplementation(
      async (_text: string, _lang: string, ctx: any) => {
        capturedCtx = ctx;
        return _text; // return original text — we only care about ctx
      },
    );

    const sender = createPlatformSender();
    const supabase = createBizASupabase();
    const bot = new BotService(supabase, sender, createMockStandalone(), createMockIntelligence());

    // Act — session has business_id='biz-a' but sendPlatformLocalizedText must use platform context
    await bot.handleMessage(PHONE, 'biz_no', 'text');

    // Assert: translateBotResponse was called (language='pcm' triggers translation path)
    expect(mockTranslateBotResponse).toHaveBeenCalledTimes(1);

    // ctx.businessId MUST be '' (buildTranslationContext(null, 'free') sets businessId='')
    // NOT 'biz-a' (the session's business_id)
    expect(capturedCtx).not.toBeNull();
    expect(capturedCtx.businessId).toBe('');

    // Entitlement must be free-tier (no translation allowed — but the function still
    // calls translateBotResponse, which returns original text since translationAllowed=false)
    expect(capturedCtx.entitlement.translationAllowed).toBe(false);
    expect(capturedCtx.entitlement.allowedLanguages).toEqual(['en']);

    // sendPlatformText was still called once
    expect(sender.sendPlatformText).toHaveBeenCalledTimes(1);
  });
});
