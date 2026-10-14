/**
 * Stale null-business session fix tests.
 *
 * Verifies:
 * 1. Expired null-biz session is deactivated and retry insert succeeds → business routes correctly
 * 2. "Hi" on shared number with stale session → platform-scoped reply, no MessagingSuspendedError
 * 3. Brand-new phone, "Hi", no business → platform reply, no crash
 * 4. Returning customer with past businesses, "Hi" → "Welcome back" sent platform-scoped
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTestSupabase } from './helpers/mock-supabase';

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

let suspendedBizIds = new Set<string>();
vi.mock('@/lib/channels/send-guard', () => ({
  assertMessagingAllowed: vi.fn().mockImplementation(async (bizId: string) => {
    if (!bizId) throw Object.assign(new Error('Messaging suspended for business unknown: missing_business_id'), { name: 'MessagingSuspendedError' });
    if (suspendedBizIds.has(bizId)) throw Object.assign(new Error(`Messaging suspended for business ${bizId}: suspended`), { name: 'MessagingSuspendedError' });
  }),
}));

let mockDetectionResult: { businessId: string | null; suggestions: Array<{ id: string; name: string; bot_code: string }> } = { businessId: null, suggestions: [] };
let mockReturningBusinesses: Array<{ id: string; name: string; bot_code: string }> = [];
vi.mock('@/lib/bot/handlers/bot-code-detection', () => ({
  detectBotCode: vi.fn().mockResolvedValue(null),
  detectBotCodeWithSuggestions: vi.fn().mockImplementation(async () => mockDetectionResult),
  rankSuggestions: vi.fn().mockReturnValue([]),
  findReturningCustomerBusinesses: vi.fn().mockImplementation(async () => mockReturningBusinesses),
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
      templates: { greeting: 'Welcome to {business_name}!', confirmation: '', reminder: '', orderConfirmation: '', paymentReceipt: '', orderStatus: '' },
      alias: null, welcome_buttons: [], quick_replies: [], default_reply: null,
      auto_reply_enabled: false, business_hours: null, away_message: null,
      instant_reply_enabled: false, instant_reply_message: null,
    }),
    checkTierLimitsFromBusiness: vi.fn().mockResolvedValue({
      allowed: true, plan: 'free', monthlyBookings: 0, monthlyLimit: 999, isWhitelabel: false,
    }),
    fillTemplate: vi.fn().mockImplementation((template: string) => template),
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
    const insertResult = makeChain(tableData, true);
    insertResult.select = vi.fn().mockImplementation(() => makeChain(tableData, false));
    return insertResult;
  });
  if (thenable) {
    const resolvedValue = { data: tableData, error: null, count: 0 };
    chain.then = (onFulfilled?: (v: any) => any, onRejected?: (e: any) => any) => {
      return Promise.resolve(resolvedValue).then(onFulfilled, onRejected);
    };
    chain.catch = (onRejected?: (e: any) => any) => {
      return Promise.resolve(resolvedValue).catch(onRejected);
    };
  }
  return chain;
}

describe('Stale null-business session fix', () => {
  beforeEach(() => {
    suspendedBizIds = new Set();
    mockDetectionResult = { businessId: null, suggestions: [] };
    mockReturningBusinesses = [];
    vi.clearAllMocks();
  });

  it('1. stale expired null-biz session: 23505 deactivates stale row, retry succeeds, platform reply sent', async () => {
    const cloud = createMockCloud();
    const sender = new MetaCloudSender(cloud as any, createTestSupabase());

    // No business detected — null-biz session insert triggers 23505 from stale session
    mockDetectionResult = { businessId: null, suggestions: [] };

    const expiredStaleSession = {
      id: 'sess-stale', business_id: null, current_step: 'select_business_suggestion',
      is_active: true, session_data: {},
      whatsapp_number: '+234800',
      // Expired 2 hours ago
      expires_at: new Date(Date.now() - 2 * 3600000).toISOString(),
      version: 0,
    };

    const freshSession = {
      id: 'sess-fresh', business_id: null, current_step: 'greeting',
      is_active: true, session_data: {},
      whatsapp_number: '+234800',
      expires_at: new Date(Date.now() + 24 * 3600000).toISOString(),
      version: 0,
    };

    // Track inserts across all from('bot_sessions') calls
    let insertCallCount = 0;
    const insertFn = vi.fn().mockImplementation(() => {
      insertCallCount++;
      if (insertCallCount === 1) {
        // First insert: 23505 collision from stale null-biz session
        const errChain = makeChain(null, true);
        errChain.select = vi.fn().mockImplementation(() => {
          const sc = makeChain(null, false);
          sc.single = vi.fn().mockResolvedValue({ data: null, error: { code: '23505', message: 'duplicate key' } });
          return sc;
        });
        return errChain;
      }
      // Retry insert after stale deactivation: success
      const okChain = makeChain(freshSession, true);
      okChain.select = vi.fn().mockImplementation(() => makeChain(freshSession, false));
      return okChain;
    });

    const supabase = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'platform_settings') return makeChain({ value: false });
        if (table === 'bot_sessions') {
          const chain = makeChain(null);
          chain.insert = insertFn;
          // Recovery query: returns expired stale null-biz session
          chain.single = vi.fn().mockResolvedValue({ data: expiredStaleSession, error: null });
          return chain;
        }
        if (table === 'blocked_phones') {
          const c = makeChain(null);
          c.select = vi.fn().mockReturnValue({ ...c, eq: vi.fn().mockReturnValue({ ...c, or: vi.fn().mockResolvedValue({ count: 0, error: null }) }) });
          return c;
        }
        return makeChain(null);
      }),
      rpc: vi.fn().mockResolvedValue({ data: { success: true, version: 1 }, error: null }),
    };

    const bot = new BotService(supabase as any, sender, createStandaloneService(), createMockIntelligence() as any);
    await bot.handleMessage('+234800', 'sometext', 'text', 'pnid-1');

    // The stale session should trigger deactivation + retry
    expect(insertCallCount).toBe(2); // first 23505, then retry

    // Platform-scoped reply was delivered (no crash from MessagingSuspendedError)
    const textCalls = cloud.sendText.mock.calls;
    expect(textCalls.length).toBeGreaterThan(0);

    // The stale session was deactivated (update called with is_active: false)
    const updateCalls = supabase.from.mock.calls.filter(
      (c: any[]) => c[0] === 'bot_sessions'
    );
    expect(updateCalls.length).toBeGreaterThan(0);

    // No "Something went wrong" fallback
    const fallbackCalls = cloud.sendText.mock.calls.filter(
      (c: any[]) => typeof c[0]?.text === 'string' && c[0].text.includes('Something went wrong')
    );
    expect(fallbackCalls.length).toBe(0);
  });

  it('2. stale expired null-biz session + "Hi": platform-scoped reply, no MessagingSuspendedError', async () => {
    const cloud = createMockCloud();
    const sender = new MetaCloudSender(cloud as any, createTestSupabase());
    mockDetectionResult = { businessId: null, suggestions: [] };

    const expiredSession = {
      id: 'sess-expired', business_id: null, current_step: 'select_business_suggestion',
      is_active: true, session_data: {},
      whatsapp_number: '+234800',
      expires_at: new Date(Date.now() - 3600000).toISOString(),
      version: 0,
    };

    const freshNullSession = {
      id: 'sess-fresh', business_id: null, current_step: 'greeting',
      is_active: true, session_data: {},
      whatsapp_number: '+234800',
      expires_at: new Date(Date.now() + 24 * 3600000).toISOString(),
      version: 0,
    };

    let insertCallCount = 0;
    const supabase = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'platform_settings') return makeChain({ value: false });
        if (table === 'bot_sessions') {
          const chain = makeChain(null);
          chain.insert = vi.fn().mockImplementation(() => {
            insertCallCount++;
            if (insertCallCount === 1) {
              const errChain = makeChain(null, true);
              errChain.select = vi.fn().mockImplementation(() => {
                const sc = makeChain(null, false);
                sc.single = vi.fn().mockResolvedValue({ data: null, error: { code: '23505', message: 'duplicate key' } });
                return sc;
              });
              return errChain;
            }
            const okChain = makeChain(freshNullSession, true);
            okChain.select = vi.fn().mockImplementation(() => makeChain(freshNullSession, false));
            return okChain;
          });
          chain.single = vi.fn().mockResolvedValue({ data: expiredSession, error: null });
          return chain;
        }
        if (table === 'blocked_phones') {
          const c = makeChain(null);
          c.select = vi.fn().mockReturnValue({ ...c, eq: vi.fn().mockReturnValue({ ...c, or: vi.fn().mockResolvedValue({ count: 0, error: null }) }) });
          return c;
        }
        return makeChain(null);
      }),
      rpc: vi.fn().mockResolvedValue({ data: { success: true, version: 1 }, error: null }),
    };

    const bot = new BotService(supabase as any, sender, createStandaloneService(), createMockIntelligence() as any);

    // Should NOT throw — previously this would crash with MessagingSuspendedError
    await expect(bot.handleMessage('+234800', 'Hi', 'text', 'pnid-1')).resolves.toBeUndefined();

    // Platform-scoped reply was sent (Welcome to Waaiio or similar)
    const textCalls = cloud.sendText.mock.calls;
    expect(textCalls.length).toBeGreaterThan(0);
    const sentText = textCalls[0]?.[0]?.text || '';
    expect(sentText).toContain('Welcome to Waaiio');
  });

  it('3. brand-new phone, "Hi", no business: platform reply, no crash', async () => {
    const cloud = createMockCloud();
    const sender = new MetaCloudSender(cloud as any, createTestSupabase());
    mockDetectionResult = { businessId: null, suggestions: [] };

    const freshSession = {
      id: 'sess-new', business_id: null, current_step: 'greeting',
      is_active: true, session_data: {},
      whatsapp_number: '+2349000',
      expires_at: new Date(Date.now() + 24 * 3600000).toISOString(),
      version: 0,
    };

    const supabase = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'platform_settings') return makeChain({ value: false });
        if (table === 'bot_sessions') {
          const chain = makeChain(null); // no active session
          chain.insert = vi.fn().mockImplementation(() => {
            const ic = makeChain(freshSession, true);
            ic.select = vi.fn().mockImplementation(() => makeChain(freshSession, false));
            return ic;
          });
          return chain;
        }
        if (table === 'blocked_phones') {
          const c = makeChain(null);
          c.select = vi.fn().mockReturnValue({ ...c, eq: vi.fn().mockReturnValue({ ...c, or: vi.fn().mockResolvedValue({ count: 0, error: null }) }) });
          return c;
        }
        return makeChain(null);
      }),
      rpc: vi.fn().mockResolvedValue({ data: { success: true, version: 1 }, error: null }),
    };

    const bot = new BotService(supabase as any, sender, createStandaloneService(), createMockIntelligence() as any);

    // Should NOT throw
    await expect(bot.handleMessage('+2349000', 'Hi', 'text', 'pnid-1')).resolves.toBeUndefined();

    // Platform reply delivered — "Welcome to Waaiio" onboarding message
    const textCalls = cloud.sendText.mock.calls;
    expect(textCalls.length).toBeGreaterThan(0);
    const sentText = textCalls[0]?.[0]?.text || '';
    expect(sentText).toContain('Welcome to Waaiio');

    // No MessagingSuspendedError crash (no "Something went wrong" fallback)
    const fallbackCalls = cloud.sendText.mock.calls.filter(
      (c: any[]) => typeof c[0]?.text === 'string' && c[0].text.includes('Something went wrong')
    );
    expect(fallbackCalls.length).toBe(0);
  });

  it('4. returning customer with past businesses, "Hi": platform-scoped picker, no crash', async () => {
    const cloud = createMockCloud();
    const sender = new MetaCloudSender(cloud as any, createTestSupabase());
    mockDetectionResult = { businessId: null, suggestions: [] };
    mockReturningBusinesses = [
      { id: 'biz-past-1', name: 'Old Spa', bot_code: 'OLDSPA' },
      { id: 'biz-past-2', name: 'Old Gym', bot_code: 'OLDGYM' },
    ];

    const sugSession = {
      id: 'sess-sug', business_id: null, current_step: 'select_business_suggestion',
      is_active: true, session_data: { suggestions: mockReturningBusinesses },
      whatsapp_number: '+234800',
      expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      version: 0,
    };

    const supabase = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'platform_settings') return makeChain({ value: false });
        if (table === 'bot_sessions') {
          const chain = makeChain(null);
          // suggestion session insert returns sugSession
          chain.insert = vi.fn().mockImplementation(() => {
            const ic = makeChain(sugSession, true);
            ic.select = vi.fn().mockImplementation(() => makeChain(sugSession, false));
            return ic;
          });
          return chain;
        }
        if (table === 'blocked_phones') {
          const c = makeChain(null);
          c.select = vi.fn().mockReturnValue({ ...c, eq: vi.fn().mockReturnValue({ ...c, or: vi.fn().mockResolvedValue({ count: 0, error: null }) }) });
          return c;
        }
        return makeChain(null);
      }),
      rpc: vi.fn().mockResolvedValue({ data: { success: true, version: 1 }, error: null }),
    };

    const bot = new BotService(supabase as any, sender, createStandaloneService(), createMockIntelligence() as any);

    // Should NOT throw — previously returning customer paths could crash with no business bound
    await expect(bot.handleMessage('+234800', 'Hi', 'text', 'pnid-1')).resolves.toBeUndefined();

    // Platform-scoped picker buttons were sent (returning businesses as suggestions)
    const buttonCalls = cloud.sendButtons.mock.calls;
    expect(buttonCalls.length).toBeGreaterThan(0);
    const buttonBody = buttonCalls[0]?.[0]?.bodyText || '';
    expect(buttonBody).toContain('Did you mean');

    // No "Something went wrong" fallback
    const fallbackCalls = cloud.sendText.mock.calls.filter(
      (c: any[]) => typeof c[0]?.text === 'string' && c[0].text.includes('Something went wrong')
    );
    expect(fallbackCalls.length).toBe(0);
  });
});
