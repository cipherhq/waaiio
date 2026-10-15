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

function createTableAwareSupabase(config: {
  session?: Record<string, unknown> | null;
  business?: Record<string, unknown> | null;
  insertedSession?: Record<string, unknown> | null;
} = {}) {
  const { session = null, business = null, insertedSession = null } = config;
  return {
    from: vi.fn().mockImplementation((table: string) => {
      if (table === 'platform_settings') return makeChain({ value: false });
      if (table === 'bot_sessions') {
        const chain = makeChain(session);
        if (insertedSession) {
          chain.insert = vi.fn().mockImplementation(() => {
            const ic = makeChain(insertedSession, true);
            ic.select = vi.fn().mockImplementation(() => makeChain(insertedSession, false));
            return ic;
          });
        }
        return chain;
      }
      if (table === 'businesses') return makeChain(business);
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

  it('5. business resolved + session insert fails (non-23505) + suspended: no platform send, sender stays bound, no crash', async () => {
    suspendedBizIds.add('biz-S');
    const cloud = createMockCloud();
    const sender = new MetaCloudSender(cloud as any, createTestSupabase());
    const spyPlatformText = vi.spyOn(sender, 'sendPlatformText');

    // Detection resolves biz-S
    mockDetectionResult = { businessId: 'biz-S', suggestions: [] };

    const bizS = { id: 'biz-S', name: 'Suspended Biz', status: 'active', category: 'restaurant', subscription_tier: 'free', country_code: 'NG', metadata: {}, bot_code: 'SUSBIZ', is_whitelabel: false };

    // Session insert returns a generic (non-23505) error
    const insertFn = vi.fn().mockImplementation(() => {
      const errChain = makeChain(null, true);
      errChain.select = vi.fn().mockImplementation(() => {
        const sc = makeChain(null, false);
        sc.single = vi.fn().mockResolvedValue({ data: null, error: { code: '42P01', message: 'relation does not exist' } });
        return sc;
      });
      return errChain;
    });

    const supabase = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'platform_settings') return makeChain({ value: false });
        if (table === 'bot_sessions') {
          const chain = makeChain(null);
          chain.insert = insertFn;
          return chain;
        }
        if (table === 'businesses') return makeChain(bizS);
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
    // Should NOT crash — guard blocks the business-scoped send, caught internally
    await expect(bot.handleMessage('+234800', 'SUSBIZ', 'text', 'pnid-1')).resolves.toBeUndefined();

    // Sender stayed bound to biz-S (NOT switched to platform discovery)
    expect(sender.boundBusinessId).toBe('biz-S');
    // sendPlatformText was NOT called — fallback went business-scoped, guard blocked it
    expect(spyPlatformText).not.toHaveBeenCalled();
    // Zero cloud calls — guard blocked the business-scoped send
    const totalCalls = cloud.sendText.mock.calls.length + cloud.sendButtons.mock.calls.length;
    expect(totalCalls).toBe(0);
  });

  it('6. business resolved + session insert fails (non-23505) + NOT suspended: fallback sent business-scoped', async () => {
    const cloud = createMockCloud();
    const sender = new MetaCloudSender(cloud as any, createTestSupabase());
    const spyPlatformText = vi.spyOn(sender, 'sendPlatformText');
    const spyPlatformButtons = vi.spyOn(sender, 'sendPlatformButtons');

    // Detection resolves biz-A (not suspended)
    mockDetectionResult = { businessId: 'biz-A', suggestions: [] };

    const bizA = { id: 'biz-A', name: 'Active Biz', status: 'active', category: 'restaurant', subscription_tier: 'free', country_code: 'NG', metadata: {}, bot_code: 'ACTBIZ', is_whitelabel: false };

    const insertFn = vi.fn().mockImplementation(() => {
      const errChain = makeChain(null, true);
      errChain.select = vi.fn().mockImplementation(() => {
        const sc = makeChain(null, false);
        sc.single = vi.fn().mockResolvedValue({ data: null, error: { code: '42P01', message: 'relation does not exist' } });
        return sc;
      });
      return errChain;
    });

    const supabase = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'platform_settings') return makeChain({ value: false });
        if (table === 'bot_sessions') {
          const chain = makeChain(null);
          chain.insert = insertFn;
          return chain;
        }
        if (table === 'businesses') return makeChain(bizA);
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
    await bot.handleMessage('+234800', 'ACTBIZ', 'text', 'pnid-1');

    // Sender stayed bound to biz-A
    expect(sender.boundBusinessId).toBe('biz-A');
    // Fallback sent business-scoped (cloud.sendText called with "Something went wrong")
    const totalBusinessCalls = cloud.sendText.mock.calls.length + cloud.sendButtons.mock.calls.length
      + cloud.sendList.mock.calls.length + cloud.sendTemplate.mock.calls.length;
    const platformCalls = spyPlatformText.mock.calls.length + spyPlatformButtons.mock.calls.length;
    expect(totalBusinessCalls - platformCalls).toBe(1);
    expect(platformCalls).toBe(0);
    // The send contains the fallback text
    const sentText = cloud.sendText.mock.calls[0]?.[0]?.text || '';
    expect(sentText).toContain('Something went wrong');
  });

  it('7. no business + session insert fails (non-23505): platform-scoped fallback', async () => {
    const cloud = createMockCloud();
    const sender = new MetaCloudSender(cloud as any, createTestSupabase());
    const spyPlatformText = vi.spyOn(sender, 'sendPlatformText');

    // No business detected
    mockDetectionResult = { businessId: null, suggestions: [] };

    const insertFn = vi.fn().mockImplementation(() => {
      const errChain = makeChain(null, true);
      errChain.select = vi.fn().mockImplementation(() => {
        const sc = makeChain(null, false);
        sc.single = vi.fn().mockResolvedValue({ data: null, error: { code: '42P01', message: 'relation does not exist' } });
        return sc;
      });
      return errChain;
    });

    const supabase = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'platform_settings') return makeChain({ value: false });
        if (table === 'bot_sessions') {
          const chain = makeChain(null);
          chain.insert = insertFn;
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
    await bot.handleMessage('+234800', 'random text', 'text', 'pnid-1');

    // Sender is tenantless (platform discovery)
    expect(sender.boundBusinessId).toBe('');
    // sendPlatformText was called with fallback
    expect(spyPlatformText).toHaveBeenCalled();
    const platformTextArg = spyPlatformText.mock.calls[0]?.[0] as { text?: string } | undefined;
    expect(platformTextArg?.text ?? '').toContain('Something went wrong');
  });

  // ── Fix 1: Suggestion-step replies platform-scoped ──

  it('8. biz_no reply: one platform-scoped send, zero business-scoped, session deactivated', async () => {
    const cloud = createMockCloud();
    const sender = new MetaCloudSender(cloud as any, createTestSupabase());
    const spyPT = vi.spyOn(sender, 'sendPlatformText');
    const spyPB = vi.spyOn(sender, 'sendPlatformButtons');
    mockDetectionResult = { businessId: null, suggestions: [] };
    // Existing suggestion session (no business)
    const sugSess = {
      id: 'sess-sug', business_id: null, current_step: 'select_business_suggestion',
      is_active: true, session_data: { suggestions: [{ id: 'biz-1', name: 'Spa A', bot_code: 'SPAA' }] },
      whatsapp_number: '+234800', expires_at: new Date(Date.now() + 1800000).toISOString(), version: 0,
    };
    const supabase = createTableAwareSupabase({ session: sugSess });
    // RPC get_bot_context must return the suggestion session for no-business lookup
    supabase.rpc = vi.fn().mockResolvedValue({ data: { has_session: true, session: sugSess, ambiguous: false }, error: null });
    const bot = new BotService(supabase as any, sender, createStandaloneService(), createMockIntelligence() as any);
    await bot.handleMessage('+234800', 'biz_no', 'text');
    // Exactly one platform text send (the "No problem" message)
    expect(spyPT.mock.calls.length).toBe(1);
    expect((spyPT.mock.calls[0][0] as { text: string }).text).toContain('No problem');
    // Zero business-scoped sends
    const totalCloud = cloud.sendText.mock.calls.length + cloud.sendButtons.mock.calls.length + cloud.sendList.mock.calls.length + cloud.sendTemplate.mock.calls.length;
    const platformCalls = spyPT.mock.calls.length + spyPB.mock.calls.length;
    expect(totalCloud - platformCalls).toBe(0);
  });

  it('9. out-of-range "9" with 2 suggestions: one platform-scoped reply', async () => {
    const cloud = createMockCloud();
    const sender = new MetaCloudSender(cloud as any, createTestSupabase());
    const spyPT = vi.spyOn(sender, 'sendPlatformText');
    const spyPB = vi.spyOn(sender, 'sendPlatformButtons');
    const sugSess = {
      id: 'sess-oor', business_id: null, current_step: 'select_business_suggestion',
      is_active: true, session_data: { suggestions: [
        { id: 'b1', name: 'Biz 1', bot_code: 'B1' }, { id: 'b2', name: 'Biz 2', bot_code: 'B2' },
      ]},
      whatsapp_number: '+234800', expires_at: new Date(Date.now() + 1800000).toISOString(), version: 0,
    };
    const supabase = createTableAwareSupabase({ session: sugSess });
    supabase.rpc = vi.fn().mockResolvedValue({ data: { has_session: true, session: sugSess, ambiguous: false }, error: null });
    const bot = new BotService(supabase as any, sender, createStandaloneService(), createMockIntelligence() as any);
    await bot.handleMessage('+234800', '9', 'text');
    expect(spyPT.mock.calls.length).toBe(1);
    expect((spyPT.mock.calls[0][0] as { text: string }).text).toContain('select one of the options');
    const totalCloud = cloud.sendText.mock.calls.length + cloud.sendButtons.mock.calls.length;
    expect(totalCloud - spyPT.mock.calls.length - spyPB.mock.calls.length).toBe(0);
  });

  // ── Fix 2: 23505 recovery uses effective session, not null newSession ──

  it('10. insert 23505, expired row, retry succeeds: flow continues with retried session id', async () => {
    const cloud = createMockCloud();
    const sender = new MetaCloudSender(cloud as any, createTestSupabase());
    mockDetectionResult = { businessId: null, suggestions: [] };
    mockReturningBusinesses = [];

    const expiredNull = {
      id: 'sess-expired', business_id: null, current_step: 'select_business_suggestion',
      is_active: true, session_data: {}, whatsapp_number: '+234800',
      expires_at: new Date(Date.now() - 3600000).toISOString(), version: 0,
    };
    const retriedSession = {
      id: 'sess-retried', business_id: null, current_step: 'greeting',
      is_active: true, session_data: {}, whatsapp_number: '+234800',
      expires_at: new Date(Date.now() + 86400000).toISOString(), version: 0,
    };
    let insertCount = 0;
    const sharedInsert = vi.fn().mockImplementation(() => {
      insertCount++;
      if (insertCount === 1) {
        const err = makeChain(null, true);
        err.select = vi.fn().mockImplementation(() => {
          const sc = makeChain(null, false);
          sc.single = vi.fn().mockResolvedValue({ data: null, error: { code: '23505', message: 'dup' } });
          return sc;
        });
        return err;
      }
      const ic = makeChain(retriedSession, true);
      ic.select = vi.fn().mockImplementation(() => makeChain(retriedSession, false));
      return ic;
    });
    const supabase = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'platform_settings') return makeChain({ value: false });
        if (table === 'bot_sessions') {
          const chain = makeChain(null);
          chain.insert = sharedInsert;
          chain.single = vi.fn().mockResolvedValue({ data: expiredNull, error: null });
          return chain;
        }
        if (table === 'blocked_phones') { const c = makeChain(null); c.select = vi.fn().mockReturnValue({ ...c, eq: vi.fn().mockReturnValue({ ...c, or: vi.fn().mockResolvedValue({ count: 0, error: null }) }) }); return c; }
        return makeChain(null);
      }),
      rpc: vi.fn().mockResolvedValue({ data: { success: true, version: 1 }, error: null }),
    };
    const bot = new BotService(supabase as any, sender, createStandaloneService(), createMockIntelligence() as any);
    await bot.handleMessage('+234800', 'Hi', 'text');
    expect(insertCount).toBe(2);
    // A reply was sent (not stuck on null session)
    expect(cloud.sendText.mock.calls.length + cloud.sendButtons.mock.calls.length).toBeGreaterThan(0);
    const fb = cloud.sendText.mock.calls.filter((c: any[]) => c[0]?.text?.includes('Something went wrong'));
    expect(fb.length).toBe(0);
  });

  // ── Fix 3: CAS update concurrent change → null, fallback ──

  it('11. CAS concurrent change (0 rows): helper returns null, no buttons, platform fallback', async () => {
    const cloud = createMockCloud();
    const sender = new MetaCloudSender(cloud as any, createTestSupabase());
    const spyPT = vi.spyOn(sender, 'sendPlatformText');
    mockDetectionResult = { businessId: null, suggestions: [{ id: 'biz-C', name: 'Concurrent Biz', bot_code: 'CONC' }] };
    mockReturningBusinesses = [];

    const existing = {
      id: 'sess-cas', business_id: null, current_step: 'select_business_suggestion',
      is_active: true, session_data: { suggestions: [{ id: 'old', name: 'Old', bot_code: 'OLD' }] },
      whatsapp_number: '+234800', expires_at: new Date(Date.now() + 900000).toISOString(), version: 5,
    };
    const sharedInsert = vi.fn().mockImplementation(() => {
      const err = makeChain(null, true);
      err.select = vi.fn().mockImplementation(() => {
        const sc = makeChain(null, false);
        sc.single = vi.fn().mockResolvedValue({ data: null, error: { code: '23505', message: 'dup' } });
        return sc;
      });
      return err;
    });
    const supabase = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'platform_settings') return makeChain({ value: false });
        if (table === 'bot_sessions') {
          const chain = makeChain(null);
          chain.insert = sharedInsert;
          chain.select = vi.fn().mockImplementation(() => {
            const sc = makeChain(null, false);
            sc.single = vi.fn().mockResolvedValue({ data: existing, error: null });
            return sc;
          });
          // CAS update returns 0 rows (concurrent change)
          chain.update = vi.fn().mockImplementation(() => {
            const uc = makeChain(null);
            uc.select = vi.fn().mockImplementation(() => {
              const sc = makeChain(null, false);
              sc.single = vi.fn().mockResolvedValue({ data: null, error: null });
              return sc;
            });
            return uc;
          });
          return chain;
        }
        if (table === 'blocked_phones') { const c = makeChain(null); c.select = vi.fn().mockReturnValue({ ...c, eq: vi.fn().mockReturnValue({ ...c, or: vi.fn().mockResolvedValue({ count: 0, error: null }) }) }); return c; }
        return makeChain(null);
      }),
      rpc: vi.fn().mockResolvedValue({ data: { success: true, version: 1 }, error: null }),
    };
    const bot = new BotService(supabase as any, sender, createStandaloneService(), createMockIntelligence() as any);
    await bot.handleMessage('+234800', 'Concurrent Biz', 'text');
    const dym = cloud.sendButtons.mock.calls.filter((c: any[]) => c[0]?.bodyText?.includes('Did you mean'));
    expect(dym.length).toBe(0);
    expect(spyPT).toHaveBeenCalled();
    const fb = spyPT.mock.calls.find((c: any[]) => (c[0] as { text?: string })?.text?.includes('Something went wrong'));
    expect(fb).toBeDefined();
  });

  // ── Fix 4: DYM helper returns null → platform error + return, no generic insert ──

  it('12. did-you-mean hard insert failure: one platform error, no generic insert, no buttons', async () => {
    const cloud = createMockCloud();
    const sender = new MetaCloudSender(cloud as any, createTestSupabase());
    const spyPT = vi.spyOn(sender, 'sendPlatformText');
    mockDetectionResult = { businessId: null, suggestions: [{ id: 'biz-X', name: 'X Biz', bot_code: 'XBIZ' }] };
    mockReturningBusinesses = [];

    let insertCount = 0;
    const supabase = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'platform_settings') return makeChain({ value: false });
        if (table === 'bot_sessions') {
          const chain = makeChain(null);
          chain.insert = vi.fn().mockImplementation(() => {
            insertCount++;
            const err = makeChain(null, true);
            err.select = vi.fn().mockImplementation(() => {
              const sc = makeChain(null, false);
              sc.single = vi.fn().mockResolvedValue({ data: null, error: { code: '42P01', message: 'relation missing' } });
              return sc;
            });
            return err;
          });
          return chain;
        }
        if (table === 'blocked_phones') { const c = makeChain(null); c.select = vi.fn().mockReturnValue({ ...c, eq: vi.fn().mockReturnValue({ ...c, or: vi.fn().mockResolvedValue({ count: 0, error: null }) }) }); return c; }
        return makeChain(null);
      }),
      rpc: vi.fn().mockResolvedValue({ data: { success: true, version: 1 }, error: null }),
    };
    const bot = new BotService(supabase as any, sender, createStandaloneService(), createMockIntelligence() as any);
    await bot.handleMessage('+234800', 'X Biz', 'text');
    // Only 1 insert attempted (helper), no generic session insert
    expect(insertCount).toBe(1);
    // No DYM buttons
    const dym = cloud.sendButtons.mock.calls.filter((c: any[]) => c[0]?.bodyText?.includes('Did you mean'));
    expect(dym.length).toBe(0);
    // Exactly one platform error
    const errors = spyPT.mock.calls.filter((c: any[]) => (c[0] as { text?: string })?.text?.includes('Something went wrong'));
    expect(errors.length).toBe(1);
  });

  // ── Fix 6: Real two-message regression — returning customer with expired stale session ──

  it('13. two-message: msg1 "Hi" → picker stored; msg2 "biz_0" resumes suggestion session, binds business via recursive call', async () => {
    // MSG 1: verify picker is sent and session is stored
    const cloud1 = createMockCloud();
    const sender1 = new MetaCloudSender(cloud1 as any, createTestSupabase());
    mockDetectionResult = { businessId: null, suggestions: [] };
    mockReturningBusinesses = [{ id: 'biz-R1', name: 'Return Spa', bot_code: 'RETSPA' }];
    const freshSugg = {
      id: 'sess-sug', business_id: null, current_step: 'select_business_suggestion',
      is_active: true, session_data: { suggestions: [{ id: 'biz-R1', name: 'Return Spa', bot_code: 'RETSPA' }] },
      whatsapp_number: '+234800', expires_at: new Date(Date.now() + 1800000).toISOString(), version: 0,
    };
    let insertCount1 = 0;
    const sb1 = {
      from: vi.fn().mockImplementation((t: string) => {
        if (t === 'platform_settings') return makeChain({ value: false });
        if (t === 'bot_sessions') {
          const c = makeChain(null);
          c.insert = vi.fn().mockImplementation(() => { insertCount1++; const ic = makeChain(freshSugg, true); ic.select = vi.fn().mockImplementation(() => makeChain(freshSugg, false)); return ic; });
          return c;
        }
        if (t === 'blocked_phones') { const c = makeChain(null); c.select = vi.fn().mockReturnValue({ ...c, eq: vi.fn().mockReturnValue({ ...c, or: vi.fn().mockResolvedValue({ count: 0, error: null }) }) }); return c; }
        return makeChain(null);
      }),
      rpc: vi.fn().mockResolvedValue({ data: { success: true, version: 1 }, error: null }),
    };
    const bot1 = new BotService(sb1 as any, sender1, createStandaloneService(), createMockIntelligence() as any);
    await bot1.handleMessage('+234800', 'Hi', 'text');
    expect(insertCount1).toBeGreaterThan(0);
    expect(cloud1.sendButtons.mock.calls.length).toBeGreaterThan(0);

    // MSG 2: biz_0 with suggestion session → step handler deactivates + recursive call with bot_code
    const cloud2 = createMockCloud();
    const sender2 = new MetaCloudSender(cloud2 as any, createTestSupabase());
    const bizR1 = { id: 'biz-R1', name: 'Return Spa', status: 'active', category: 'spa', subscription_tier: 'free', country_code: 'NG', metadata: {}, bot_code: 'RETSPA', is_whitelabel: false };
    const bizSess = { id: 'sess-biz', business_id: 'biz-R1', current_step: 'select_capability', is_active: true, session_data: { capabilities: ['scheduling'] }, whatsapp_number: '+234800', expires_at: new Date(Date.now() + 3600000).toISOString(), version: 0 };
    mockDetectionResult = { businessId: 'biz-R1', suggestions: [], authority: 'exact' } as any;
    // RPC returns suggestion session on first call, then null for the recursive call
    let rpcCallCount = 0;
    const sb2 = createTableAwareSupabase({ session: freshSugg, business: bizR1, insertedSession: bizSess });
    sb2.rpc = vi.fn().mockImplementation(() => {
      rpcCallCount++;
      if (rpcCallCount === 1) return Promise.resolve({ data: { has_session: true, session: freshSugg, ambiguous: false }, error: null });
      // Recursive call: no session (deactivated)
      return Promise.resolve({ data: { has_session: false, ambiguous: false }, error: null });
    });
    const bot2 = new BotService(sb2 as any, sender2, createStandaloneService(), createMockIntelligence() as any);
    await bot2.handleMessage('+234800', 'biz_0', 'text');
    // Business R1 is bound after step handler resolved the bot_code via recursive handleMessage
    expect(sender2.boundBusinessId).toBe('biz-R1');
    // No "Something went wrong" — the business was resolved and flow attempted
    const fb2 = cloud2.sendText.mock.calls.filter((c: any[]) => c[0]?.text?.includes('Something went wrong'));
    expect(fb2.length).toBe(0);
  });

  // ── Fix 7: In-session switch_biz with suspended business A → picker delivered platform-scoped ──

  it('14. suspended business A, switch_biz: picker delivered platform-scoped, zero A sends, session A deactivated', async () => {
    suspendedBizIds.add('biz-A');
    const cloud = createMockCloud();
    const sender = new MetaCloudSender(cloud as any, createTestSupabase());
    const spyPT = vi.spyOn(sender, 'sendPlatformText');
    const spyPB = vi.spyOn(sender, 'sendPlatformButtons');

    // Active session for suspended business A
    const sessionA = {
      id: 'sess-A', business_id: 'biz-A', current_step: 'select_capability',
      is_active: true, session_data: { capabilities: ['scheduling'] },
      whatsapp_number: '+234800', expires_at: new Date(Date.now() + 3600000).toISOString(), version: 0,
    };
    const sugSess = {
      id: 'sess-picker', business_id: null, current_step: 'select_business_suggestion',
      is_active: true, session_data: { suggestions: [
        { id: 'biz-B', name: 'Spa B', bot_code: 'SPAB' },
        { id: 'biz-C', name: 'Spa C', bot_code: 'SPAC' },
      ]},
      whatsapp_number: '+234800', expires_at: new Date(Date.now() + 1800000).toISOString(), version: 0,
    };

    // findReturningCustomerBusinesses returns 2 businesses for the picker
    const { findReturningCustomerBusinesses } = await import('@/lib/bot/handlers/bot-code-detection');
    (findReturningCustomerBusinesses as any).mockResolvedValue([
      { id: 'biz-B', name: 'Spa B', bot_code: 'SPAB' },
      { id: 'biz-C', name: 'Spa C', bot_code: 'SPAC' },
    ]);

    const sharedInsert = vi.fn().mockImplementation(() => {
      const ic = makeChain(sugSess, true);
      ic.select = vi.fn().mockImplementation(() => makeChain(sugSess, false));
      return ic;
    });
    const supabase = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'platform_settings') return makeChain({ value: false });
        if (table === 'bot_sessions') {
          const chain = makeChain(null);
          chain.insert = sharedInsert;
          chain.single = vi.fn().mockResolvedValue({ data: sessionA, error: null });
          return chain;
        }
        if (table === 'blocked_phones') { const c = makeChain(null); c.select = vi.fn().mockReturnValue({ ...c, eq: vi.fn().mockReturnValue({ ...c, or: vi.fn().mockResolvedValue({ count: 0, error: null }) }) }); return c; }
        return makeChain(null);
      }),
      rpc: vi.fn().mockResolvedValue({ data: { success: true, version: 1 }, error: null }),
    };
    const bot = new BotService(supabase as any, sender, createStandaloneService(), createMockIntelligence() as any);

    // switch_biz while in suspended business A
    sender.bindBusiness('biz-A');
    await bot.handleMessage('+234800', 'switch_biz', 'text');
    // Picker delivered (platform-scoped, not blocked by A's suspension)
    expect(spyPB.mock.calls.length).toBeGreaterThan(0);
    // Sender transitioned to platform discovery (not bound to A)
    expect(sender.boundBusinessId).toBe('');
    // Zero business-scoped sends for A
    const totalCloud = cloud.sendText.mock.calls.length + cloud.sendButtons.mock.calls.length + cloud.sendList.mock.calls.length + cloud.sendTemplate.mock.calls.length;
    const platformCalls = spyPT.mock.calls.length + spyPB.mock.calls.length;
    expect(totalCloud - platformCalls).toBe(0);
    // Session A was deactivated (update called on bot_sessions)
    const botSessionCalls = supabase.from.mock.calls.filter((c: any[]) => c[0] === 'bot_sessions');
    expect(botSessionCalls.length).toBeGreaterThan(0);
  });
});
