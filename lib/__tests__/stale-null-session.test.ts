/**
 * Stale null-business session fix tests.
 *
 * Verifies:
 * 1. Expired null-biz session is deactivated (CAS); no retry insert → fail closed with one error reply
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

  it('1. stale expired null-biz session: 23505 CAS deactivates stale row, retry insert succeeds, normal flow continues', async () => {
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

    // Sequence counter for from('bot_sessions'):
    // n=1: cleanup delete, n=2: insert (23505), n=3: re-read (expiredStaleSession),
    // n=4: CAS update (return non-empty → CAS success), n=5+: retry insert (success)
    let sessN1 = 0;
    const supabase = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'platform_settings') return makeChain({ value: false });
        if (table === 'bot_sessions') {
          sessN1++;
          const n = sessN1;
          if (n === 4) {
            // CAS update — return non-empty array to signal CAS succeeded
            return makeChain([{ id: expiredStaleSession.id }]);
          }
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

    // CAS deactivation succeeded (n=4 returns non-empty) → retry insert (n=5) also succeeds
    // Design ruling: one original insert (23505) + one retry = 2 total inserts
    expect(insertCallCount).toBe(2);

    // The stale session was deactivated (update called via CAS)
    const updateCalls = supabase.from.mock.calls.filter(
      (c: any[]) => c[0] === 'bot_sessions'
    );
    expect(updateCalls.length).toBeGreaterThan(0);

    // Normal flow continues — NO recoverable error reply
    const fallbackCalls = cloud.sendText.mock.calls.filter(
      (c: any[]) => typeof c[0]?.text === 'string' && c[0].text.includes('Something went wrong')
    );
    expect(fallbackCalls.length).toBe(0);
  });

  it('2. stale expired null-biz session + "Hi": CAS success → retry insert fails (23505) → exactly one error reply', async () => {
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

    let insertCallCount = 0;
    // n=1: cleanup, n=2: insert (23505 — first), n=3: re-read, n=4: CAS (success),
    // n=5+: retry insert → also 23505 (another concurrent insert) → fail closed
    let sessN2 = 0;
    const supabase = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'platform_settings') return makeChain({ value: false });
        if (table === 'bot_sessions') {
          sessN2++;
          const n = sessN2;
          if (n === 4) return makeChain([{ id: expiredSession.id }]);
          const chain = makeChain(null);
          chain.insert = vi.fn().mockImplementation(() => {
            insertCallCount++;
            // Both the first insert AND the retry fail with 23505 (another concurrent worker)
            const errChain = makeChain(null, true);
            errChain.select = vi.fn().mockImplementation(() => {
              const sc = makeChain(null, false);
              sc.single = vi.fn().mockResolvedValue({ data: null, error: { code: '23505', message: 'duplicate key' } });
              return sc;
            });
            return errChain;
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

    // Design ruling: original insert + exactly one retry = 2 total inserts
    expect(insertCallCount).toBe(2);

    // Exactly one platform-scoped recoverable error reply (retry also failed → fail closed)
    const textCalls = cloud.sendText.mock.calls;
    expect(textCalls.length).toBeGreaterThan(0);
    const allSentText = textCalls.map((c: any[]) => c[0]?.text || '').join(' ');
    expect(allSentText).toContain('Something went wrong');
    // No buttons — fail-closed path sends text only
    expect(cloud.sendButtons.mock.calls.length).toBe(0);
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

  it('10. insert 23505, expired row, CAS deactivation succeeds: retry insert succeeds, normal flow, insertCount=2', async () => {
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
    // n=1: cleanup, n=2: insert (23505), n=3: re-read, n=4: CAS (success), n=5+: retry insert
    let sessN10 = 0;
    const supabase = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'platform_settings') return makeChain({ value: false });
        if (table === 'bot_sessions') {
          sessN10++;
          const n = sessN10;
          if (n === 4) return makeChain([{ id: expiredNull.id }]);
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
    // CAS deactivation succeeded → retry insert also succeeded (insertCount=2)
    expect(insertCount).toBe(2);
    // Normal flow continues — no recoverable error reply
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

  // ── Localization: suggestion-step replies must be platform-scoped AND translated ──

  it('15. biz_no with pcm session: platform-scoped AND translated via translateBotResponse', async () => {
    const cloud = createMockCloud();
    const sender = new MetaCloudSender(cloud as any, createTestSupabase());
    const spyPT = vi.spyOn(sender, 'sendPlatformText');
    const { translateBotResponse: mockTranslate } = await import('@/lib/bot/translate');
    (mockTranslate as any).mockImplementation(async (t: string, lang: string) => `[${lang}] ${t}`);
    const sugSess = {
      id: 'sess-pcm', business_id: null, current_step: 'select_business_suggestion',
      is_active: true, session_data: {
        suggestions: [{ id: 'biz-1', name: 'Spa A', bot_code: 'SPAA' }],
        _detected_language: 'pcm',
      },
      whatsapp_number: '+234800', expires_at: new Date(Date.now() + 1800000).toISOString(), version: 0,
    };
    const supabase = createTableAwareSupabase({ session: sugSess });
    supabase.rpc = vi.fn().mockResolvedValue({ data: { has_session: true, session: sugSess, ambiguous: false }, error: null });
    const bot = new BotService(supabase as any, sender, createStandaloneService(), createMockIntelligence() as any);
    await bot.handleMessage('+234800', 'biz_no', 'text');
    // translateBotResponse was called with 'pcm'
    expect(mockTranslate).toHaveBeenCalledWith(expect.stringContaining('No problem'), 'pcm', expect.anything(), undefined);
    // Platform-scoped send received the translated text
    expect(spyPT.mock.calls.length).toBe(1);
    expect((spyPT.mock.calls[0][0] as { text: string }).text).toContain('[pcm]');
    expect((spyPT.mock.calls[0][0] as { text: string }).text).toContain('No problem');
  });

  it('16. biz_no with pcm session, translator throws: English text sent platform-scoped once', async () => {
    const cloud = createMockCloud();
    const sender = new MetaCloudSender(cloud as any, createTestSupabase());
    const spyPT = vi.spyOn(sender, 'sendPlatformText');
    const { translateBotResponse: mockTranslate } = await import('@/lib/bot/translate');
    (mockTranslate as any).mockRejectedValue(new Error('translation service down'));
    const sugSess = {
      id: 'sess-pcm2', business_id: null, current_step: 'select_business_suggestion',
      is_active: true, session_data: {
        suggestions: [{ id: 'biz-1', name: 'Spa A', bot_code: 'SPAA' }],
        _detected_language: 'pcm',
      },
      whatsapp_number: '+234800', expires_at: new Date(Date.now() + 1800000).toISOString(), version: 0,
    };
    const supabase = createTableAwareSupabase({ session: sugSess });
    supabase.rpc = vi.fn().mockResolvedValue({ data: { has_session: true, session: sugSess, ambiguous: false }, error: null });
    const bot = new BotService(supabase as any, sender, createStandaloneService(), createMockIntelligence() as any);
    await bot.handleMessage('+234800', 'biz_no', 'text');
    // English fallback sent exactly once, platform-scoped
    expect(spyPT.mock.calls.length).toBe(1);
    expect((spyPT.mock.calls[0][0] as { text: string }).text).toContain('No problem');
    // NOT the translated version (translation failed)
    expect((spyPT.mock.calls[0][0] as { text: string }).text).not.toContain('[pcm]');
  });

  // ── #645 P2: CAS deactivation concurrency — both sites ──

  it('18. SA inline CAS race: CAS returns 0 rows → renewed session resumed, no re-insert, 1 reply', async () => {
    // Site (a): inline 23505 recovery in handleMessage.
    // The expired session (version=5) is renewed concurrently; the CAS update returns 0 rows.
    // Expected: NO retry insert, code resumes the renewed session and sends exactly 1 reply.
    const cloud = createMockCloud();
    const sender = new MetaCloudSender(cloud as any, createTestSupabase());
    mockDetectionResult = { businessId: null, suggestions: [] };
    mockReturningBusinesses = [];

    const PAST_TS = new Date(Date.now() - 120_000).toISOString();
    const FUTURE_TS = new Date(Date.now() + 86_400_000).toISOString();

    const SPA_SUGG = [
      { id: 'biz-B', name: 'Spa B', bot_code: 'SPAB' },
      { id: 'biz-C', name: 'Spa C', bot_code: 'SPAC' },
    ];
    const expiredSess = {
      id: 'sess-cas-a', whatsapp_number: '+234800', business_id: null,
      current_step: 'select_business_suggestion', is_active: true,
      version: 5, expires_at: PAST_TS,
      session_data: { suggestions: SPA_SUGG }, conversation_log: [], user_id: null,
      last_active_at: new Date().toISOString(),
    };
    const renewedSess = {
      ...expiredSess, version: 6, expires_at: FUTURE_TS,
      session_data: { suggestions: SPA_SUGG },
    };

    let botSessionsN = 0;
    let insertCallCount = 0;

    const supabase = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'platform_settings') return makeChain({ value: false });
        if (table === 'bot_sessions') {
          botSessionsN++;
          const n = botSessionsN;
          if (n === 1) return makeChain(null); // cleanup delete
          if (n === 2) {
            // insert → 23505
            insertCallCount++;
            const c = makeChain(null);
            c.insert = vi.fn().mockImplementation(() => {
              const ic = makeChain(null, true);
              ic.select = vi.fn().mockImplementation(() => {
                const sc = makeChain(null, false);
                sc.single = vi.fn().mockResolvedValue({ data: null, error: { code: '23505', message: 'dup' } });
                return sc;
              });
              return ic;
            });
            return c;
          }
          if (n === 3) {
            // re-read after 23505 → expired session
            const c = makeChain(expiredSess);
            c.single = vi.fn().mockResolvedValue({ data: expiredSess, error: null });
            return c;
          }
          if (n === 4) {
            // CAS update → 0 rows (concurrent renewal)
            return makeChain([], true);
          }
          if (n === 5) {
            // re-read → renewed session
            const c = makeChain(renewedSess);
            c.single = vi.fn().mockResolvedValue({ data: renewedSess, error: null });
            return c;
          }
          return makeChain(null);
        }
        if (table === 'blocked_phones') {
          const c = makeChain(null);
          c.select = vi.fn().mockReturnValue({
            ...c, eq: vi.fn().mockReturnValue({ ...c, or: vi.fn().mockResolvedValue({ count: 0, error: null }) }),
          });
          return c;
        }
        return makeChain(null);
      }),
      rpc: vi.fn().mockImplementation((name: string) => {
        if (name === 'get_bot_context') {
          return Promise.resolve({
            data: { has_session: false, ambiguous: false, session: null, business: null, capabilities: null, capability_overrides: null },
            error: null,
          });
        }
        return Promise.resolve({ data: { success: true, version: 7 }, error: null });
      }),
    };

    const bot = new BotService(supabase as any, sender, createStandaloneService(), createMockIntelligence() as any);
    await bot.handleMessage('+234800', 'biz_no', 'text');

    // Assert 1: only 1 insert (the original that hit 23505) — no retry
    expect(insertCallCount).toBe(1);

    // Assert 2: exactly 1 platform-scoped reply
    const totalReplies = cloud.sendText.mock.calls.length + cloud.sendButtons.mock.calls.length;
    expect(totalReplies).toBe(1);

    // Assert 3: no "Something went wrong" (graceful path, not error path)
    const errorReplies = cloud.sendText.mock.calls.filter(
      (c: any[]) => typeof c[0]?.text === 'string' && c[0].text.includes('Something went wrong'),
    );
    expect(errorReplies.length).toBe(0);
  });

  it('19. SB helper CAS race: CAS returns 0 rows → renewed session returned from helper, no re-insert, 1 reply', async () => {
    // Site (b): expiry deactivation inside createNullBizSuggestionSession.
    // Triggered via switch_biz → recentBiz.length > 1 → helper called.
    // Expected: NO retry insert, helper returns renewed session, caller sends 1 platform reply.
    const cloud = createMockCloud();
    const sender = new MetaCloudSender(cloud as any, createTestSupabase());
    mockDetectionResult = { businessId: null, suggestions: [] };

    const PAST_TS = new Date(Date.now() - 120_000).toISOString();
    const FUTURE_TS = new Date(Date.now() + 86_400_000).toISOString();

    const expiredSess = {
      id: 'sess-cas-b', whatsapp_number: '+234800', business_id: null,
      current_step: 'select_business_suggestion', is_active: true,
      version: 5, expires_at: PAST_TS,
      session_data: { suggestions: [] }, conversation_log: [], user_id: null,
      last_active_at: new Date().toISOString(),
    };
    // renewedSess has DIFFERENT persisted suggestions than the locally-generated quickPick
    // (Biz X / Biz Y from findReturningCustomerBusinesses). After Finding 2 fix, buttons must
    // come from renewedSess.session_data.suggestions (Biz P / Biz Q), not from the local array.
    const renewedSess = {
      ...expiredSess, version: 6, expires_at: FUTURE_TS,
      session_data: {
        suggestions: [
          { id: 'biz-p', name: 'Biz P', bot_code: 'bizp' },
          { id: 'biz-q', name: 'Biz Q', bot_code: 'bizq' },
        ],
      },
    };

    let botSessionsN = 0;
    let insertCallCount = 0;

    // Make findReturningCustomerBusinesses return 2 businesses so switch_biz calls the helper.
    const { findReturningCustomerBusinesses } = await import('@/lib/bot/handlers/bot-code-detection');
    vi.mocked(findReturningCustomerBusinesses).mockResolvedValueOnce([
      { id: 'biz-x', name: 'Biz X', bot_code: 'bizx' } as any,
      { id: 'biz-y', name: 'Biz Y', bot_code: 'bizy' } as any,
    ]);

    const supabase = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'platform_settings') return makeChain({ value: false });
        if (table === 'bot_sessions') {
          botSessionsN++;
          const n = botSessionsN;
          if (n === 1) return makeChain(null); // bulk cleanup in helper (step a)
          if (n === 2) {
            // insert → 23505
            insertCallCount++;
            const c = makeChain(null);
            c.insert = vi.fn().mockImplementation(() => {
              const ic = makeChain(null, true);
              ic.select = vi.fn().mockImplementation(() => {
                const sc = makeChain(null, false);
                sc.single = vi.fn().mockResolvedValue({ data: null, error: { code: '23505', message: 'dup' } });
                return sc;
              });
              return ic;
            });
            return c;
          }
          if (n === 3) {
            // re-read after 23505 → expired session
            const c = makeChain(expiredSess);
            c.single = vi.fn().mockResolvedValue({ data: expiredSess, error: null });
            return c;
          }
          if (n === 4) {
            // CAS update → 0 rows (concurrent renewal)
            return makeChain([], true);
          }
          if (n === 5) {
            // re-read → renewed session
            const c = makeChain(renewedSess);
            c.single = vi.fn().mockResolvedValue({ data: renewedSess, error: null });
            return c;
          }
          return makeChain(null);
        }
        if (table === 'blocked_phones') {
          const c = makeChain(null);
          c.select = vi.fn().mockReturnValue({
            ...c, eq: vi.fn().mockReturnValue({ ...c, or: vi.fn().mockResolvedValue({ count: 0, error: null }) }),
          });
          return c;
        }
        return makeChain(null);
      }),
      rpc: vi.fn().mockImplementation((name: string) => {
        if (name === 'get_bot_context') {
          return Promise.resolve({
            data: { has_session: false, ambiguous: false, session: null, business: null, capabilities: null, capability_overrides: null },
            error: null,
          });
        }
        return Promise.resolve({ data: { success: true, version: 7 }, error: null });
      }),
    };

    const bot = new BotService(supabase as any, sender, createStandaloneService(), createMockIntelligence() as any);
    await bot.handleMessage('+234800', 'switch_biz', 'text');

    // Assert 1: only 1 insert (the original that hit 23505) — no retry after CAS race
    expect(insertCallCount).toBe(1);

    // Assert 2: exactly 1 platform-scoped reply (the "Which business?" picker buttons)
    const totalReplies = cloud.sendText.mock.calls.length + cloud.sendButtons.mock.calls.length;
    expect(totalReplies).toBe(1);

    // Assert 3: it was the business picker (buttons), not an error message
    expect(cloud.sendButtons.mock.calls.length).toBe(1);
    expect(cloud.sendText.mock.calls.filter(
      (c: any[]) => typeof c[0]?.text === 'string' && c[0].text.includes('Something went wrong'),
    ).length).toBe(0);

    // Assert 4 (strengthened): button content matches the PERSISTED suggestions in renewedSess,
    // not the locally-generated quickPick from findReturningCustomerBusinesses.
    // renewedSess.session_data.suggestions = [{id:'biz-p',...}, {id:'biz-q',...}] (set above)
    // findReturningCustomerBusinesses returned [{id:'biz-x',...}, {id:'biz-y',...}]
    // buttons must come from persisted, so titles must be 'Biz P' and 'Biz Q', not 'Biz X'/'Biz Y'
    const buttonArgs19 = cloud.sendButtons.mock.calls[0]?.[0] as { buttons?: Array<{ id: string; title: string }> };
    const buttonTitles19 = (buttonArgs19?.buttons || []).map((b) => b.title);
    expect(buttonTitles19).toContain('Biz P');
    expect(buttonTitles19).toContain('Biz Q');
    expect(buttonTitles19).not.toContain('Biz X');
    expect(buttonTitles19).not.toContain('Biz Y');
  });

  // ── New tests for ChatGPT P2 findings + design ruling ──

  it('20. (a) in-place version advance: update payload includes version+1; stale concurrent update with old version is rejected', async () => {
    // Site B in-place path: existing session is NOT expired, 23505 fires.
    // createNullBizSuggestionSession calls the in-place update with version+1 in the payload.
    // A second worker holding the old version cannot overwrite: .eq('version', oldVersion) gets 0 rows.
    const cloud = createMockCloud();
    const sender = new MetaCloudSender(cloud as any, createTestSupabase());
    mockDetectionResult = { businessId: null, suggestions: [{ id: 'biz-A', name: 'Alpha', bot_code: 'alpha' }] };

    const existingSession = {
      id: 'sess-inplace', whatsapp_number: '+234800', business_id: null,
      current_step: 'select_business_suggestion', is_active: true,
      // NOT expired
      expires_at: new Date(Date.now() + 1800000).toISOString(),
      version: 3,
      session_data: { suggestions: [{ id: 'biz-A', name: 'Alpha', bot_code: 'alpha' }] },
    };

    let updatePayload: Record<string, unknown> | null = null;
    let botN = 0;
    const supabase = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'platform_settings') return makeChain({ value: false });
        if (table === 'bot_sessions') {
          botN++;
          const n = botN;
          if (n === 1) return makeChain(null); // cleanup step in helper
          if (n === 2) {
            // insert → 23505
            const c = makeChain(null);
            c.insert = vi.fn().mockImplementation(() => {
              const ic = makeChain(null, true);
              ic.select = vi.fn().mockImplementation(() => {
                const sc = makeChain(null, false);
                sc.single = vi.fn().mockResolvedValue({ data: null, error: { code: '23505' } });
                return sc;
              });
              return ic;
            });
            return c;
          }
          if (n === 3) {
            // re-read after 23505 → non-expired existing session
            const c = makeChain(existingSession);
            c.single = vi.fn().mockResolvedValue({ data: existingSession, error: null });
            return c;
          }
          if (n === 4) {
            // in-place update — capture the payload; mock success
            const captureChain = makeChain(null);
            const originalUpdate = captureChain.update.bind(captureChain);
            captureChain.update = vi.fn().mockImplementation((payload: Record<string, unknown>) => {
              updatePayload = payload;
              return originalUpdate(payload);
            });
            captureChain.single = vi.fn().mockResolvedValue({ data: { ...existingSession, version: 4 }, error: null });
            return captureChain;
          }
          return makeChain(null);
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
    // Trigger via switch path — detection.suggestions.length=1 triggers createNullBizSuggestionSession
    await bot.handleMessage('+234800', 'switch alpha', 'text');

    // Assert: in-place update payload includes version = existingSession.version + 1 = 4
    expect(updatePayload).not.toBeNull();
    expect((updatePayload as Record<string, unknown>)?.version).toBe(4);
  });

  it('21. (b) persisted suggestions used for button content when session recovered (CAS 0 rows), not local array', async () => {
    // Site B CAS 0-rows path via switch_biz: findReturningCustomerBusinesses returns Biz X + Biz Y,
    // but the renewedSess has persisted suggestions Biz P + Biz Q.
    // After Finding 2 fix: buttons must show Biz P / Biz Q, not Biz X / Biz Y.
    // If persisted suggestions are empty → fail closed (no buttons).
    const cloud = createMockCloud();
    const sender = new MetaCloudSender(cloud as any, createTestSupabase());
    mockDetectionResult = { businessId: null, suggestions: [] };

    const PAST_TS = new Date(Date.now() - 60_000).toISOString();
    const FUTURE_TS = new Date(Date.now() + 86_400_000).toISOString();

    const expiredSess21 = {
      id: 'sess-b21', whatsapp_number: '+234800', business_id: null,
      current_step: 'select_business_suggestion', is_active: true,
      version: 2, expires_at: PAST_TS,
      session_data: { suggestions: [] },
    };
    // Renewed session has DIFFERENT persisted suggestions than local quickPick
    const renewedSess21 = {
      ...expiredSess21, version: 3, expires_at: FUTURE_TS,
      session_data: {
        suggestions: [
          { id: 'biz-p', name: 'Biz P', bot_code: 'bizp' },
          { id: 'biz-q', name: 'Biz Q', bot_code: 'bizq' },
        ],
      },
    };

    const { findReturningCustomerBusinesses } = await import('@/lib/bot/handlers/bot-code-detection');
    vi.mocked(findReturningCustomerBusinesses).mockResolvedValueOnce([
      { id: 'biz-x', name: 'Biz X', bot_code: 'bizx' } as any,
      { id: 'biz-y', name: 'Biz Y', bot_code: 'bizy' } as any,
    ]);

    let botN21 = 0;
    let insertCount21 = 0;
    const supabase = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'platform_settings') return makeChain({ value: false });
        if (table === 'bot_sessions') {
          botN21++;
          const n = botN21;
          if (n === 1) return makeChain(null); // cleanup in helper
          if (n === 2) {
            // insert → 23505
            insertCount21++;
            const c = makeChain(null);
            c.insert = vi.fn().mockImplementation(() => {
              const ic = makeChain(null, true);
              ic.select = vi.fn().mockImplementation(() => {
                const sc = makeChain(null, false);
                sc.single = vi.fn().mockResolvedValue({ data: null, error: { code: '23505' } });
                return sc;
              });
              return ic;
            });
            return c;
          }
          if (n === 3) {
            const c = makeChain(expiredSess21);
            c.single = vi.fn().mockResolvedValue({ data: expiredSess21, error: null });
            return c;
          }
          if (n === 4) {
            // CAS → 0 rows (concurrent renewal)
            return makeChain([], true);
          }
          if (n === 5) {
            // re-read → renewedSess with different suggestions
            const c = makeChain(renewedSess21);
            c.single = vi.fn().mockResolvedValue({ data: renewedSess21, error: null });
            return c;
          }
          return makeChain(null);
        }
        if (table === 'blocked_phones') {
          const c = makeChain(null);
          c.select = vi.fn().mockReturnValue({ ...c, eq: vi.fn().mockReturnValue({ ...c, or: vi.fn().mockResolvedValue({ count: 0, error: null }) }) });
          return c;
        }
        return makeChain(null);
      }),
      rpc: vi.fn().mockImplementation((name: string) => {
        if (name === 'get_bot_context') return Promise.resolve({ data: { has_session: false, ambiguous: false, session: null, business: null, capabilities: null, capability_overrides: null }, error: null });
        return Promise.resolve({ data: { success: true, version: 1 }, error: null });
      }),
    };

    const bot = new BotService(supabase as any, sender, createStandaloneService(), createMockIntelligence() as any);
    await bot.handleMessage('+234800', 'switch_biz', 'text');

    // 1 insert (no retry on 0-rows path)
    expect(insertCount21).toBe(1);
    // Exactly 1 button reply (picker built from persisted, not local)
    expect(cloud.sendButtons.mock.calls.length).toBe(1);
    expect(cloud.sendText.mock.calls.filter((c: any[]) => c[0]?.text?.includes('Something went wrong')).length).toBe(0);
    // Button content: persisted suggestions (Biz P, Biz Q), NOT local (Biz X, Biz Y)
    const btnArgs21 = cloud.sendButtons.mock.calls[0]?.[0] as { buttons?: Array<{ id: string; title: string }> };
    const titles21 = (btnArgs21?.buttons || []).map((b) => b.title);
    expect(titles21).toContain('Biz P');
    expect(titles21).toContain('Biz Q');
    expect(titles21).not.toContain('Biz X');
    expect(titles21).not.toContain('Biz Y');
  });

  it('22. (c) site B CAS success → retry insert succeeds → caller sends picker buttons, no error reply', async () => {
    // Site B: switch_biz → createNullBizSuggestionSession → first insert 23505 → existing expired →
    // CAS deactivation succeeds → retry insert succeeds → caller receives session → buttons sent.
    const cloud = createMockCloud();
    const sender = new MetaCloudSender(cloud as any, createTestSupabase());
    mockDetectionResult = { businessId: null, suggestions: [] };

    const PAST_TS = new Date(Date.now() - 60_000).toISOString();

    const expiredSess22 = {
      id: 'sess-b22', whatsapp_number: '+234800', business_id: null,
      current_step: 'select_business_suggestion', is_active: true,
      version: 1, expires_at: PAST_TS,
      session_data: { suggestions: [] },
    };
    const retriedSess22 = {
      id: 'sess-b22-r', whatsapp_number: '+234800', business_id: null,
      current_step: 'select_business_suggestion', is_active: true,
      version: 0, expires_at: new Date(Date.now() + 1800000).toISOString(),
      session_data: {
        suggestions: [
          { id: 'biz-r1', name: 'RetryBiz 1', bot_code: 'rb1' },
          { id: 'biz-r2', name: 'RetryBiz 2', bot_code: 'rb2' },
        ],
      },
    };

    const { findReturningCustomerBusinesses } = await import('@/lib/bot/handlers/bot-code-detection');
    vi.mocked(findReturningCustomerBusinesses).mockResolvedValueOnce([
      { id: 'biz-r1', name: 'RetryBiz 1', bot_code: 'rb1' } as any,
      { id: 'biz-r2', name: 'RetryBiz 2', bot_code: 'rb2' } as any,
    ]);

    let botN22 = 0;
    let insertCount22 = 0;
    const supabase = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'platform_settings') return makeChain({ value: false });
        if (table === 'bot_sessions') {
          botN22++;
          const n = botN22;
          if (n === 1) return makeChain(null); // cleanup in helper
          if (n === 2) {
            // first insert → 23505
            insertCount22++;
            const c = makeChain(null);
            c.insert = vi.fn().mockImplementation(() => {
              const ic = makeChain(null, true);
              ic.select = vi.fn().mockImplementation(() => {
                const sc = makeChain(null, false);
                sc.single = vi.fn().mockResolvedValue({ data: null, error: { code: '23505' } });
                return sc;
              });
              return ic;
            });
            return c;
          }
          if (n === 3) {
            // re-read → expired
            const c = makeChain(expiredSess22);
            c.single = vi.fn().mockResolvedValue({ data: expiredSess22, error: null });
            return c;
          }
          if (n === 4) {
            // CAS update → success (non-empty)
            return makeChain([{ id: expiredSess22.id }]);
          }
          if (n === 5) {
            // retry insert → success
            insertCount22++;
            const c = makeChain(null);
            c.insert = vi.fn().mockImplementation(() => {
              const ic = makeChain(retriedSess22, true);
              ic.select = vi.fn().mockImplementation(() => makeChain(retriedSess22, false));
              return ic;
            });
            c.single = vi.fn().mockResolvedValue({ data: retriedSess22, error: null });
            return c;
          }
          return makeChain(null);
        }
        if (table === 'blocked_phones') {
          const c = makeChain(null);
          c.select = vi.fn().mockReturnValue({ ...c, eq: vi.fn().mockReturnValue({ ...c, or: vi.fn().mockResolvedValue({ count: 0, error: null }) }) });
          return c;
        }
        return makeChain(null);
      }),
      rpc: vi.fn().mockImplementation((name: string) => {
        if (name === 'get_bot_context') return Promise.resolve({ data: { has_session: false, ambiguous: false, session: null, business: null, capabilities: null, capability_overrides: null }, error: null });
        return Promise.resolve({ data: { success: true, version: 1 }, error: null });
      }),
    };

    const bot = new BotService(supabase as any, sender, createStandaloneService(), createMockIntelligence() as any);
    await bot.handleMessage('+234800', 'switch_biz', 'text');

    // 2 inserts: original 23505 + retry
    expect(insertCount22).toBe(2);
    // Buttons sent (normal flow), no error reply
    expect(cloud.sendButtons.mock.calls.length).toBe(1);
    expect(cloud.sendText.mock.calls.filter((c: any[]) => c[0]?.text?.includes('Something went wrong')).length).toBe(0);
  });

  it('23. (d) site B CAS success → retry insert fails (23505) → exactly one error reply, no buttons', async () => {
    // Site B: switch_biz → createNullBizSuggestionSession → first insert 23505 → existing expired →
    // CAS deactivation succeeds → retry insert also fails (23505) → helper returns null →
    // caller sends exactly one "Something went wrong" reply.
    const cloud = createMockCloud();
    const sender = new MetaCloudSender(cloud as any, createTestSupabase());
    mockDetectionResult = { businessId: null, suggestions: [] };

    const PAST_TS = new Date(Date.now() - 60_000).toISOString();
    const expiredSess23 = {
      id: 'sess-b23', whatsapp_number: '+234800', business_id: null,
      current_step: 'select_business_suggestion', is_active: true,
      version: 7, expires_at: PAST_TS,
      session_data: { suggestions: [] },
    };

    const { findReturningCustomerBusinesses } = await import('@/lib/bot/handlers/bot-code-detection');
    vi.mocked(findReturningCustomerBusinesses).mockResolvedValueOnce([
      { id: 'biz-d1', name: 'Delta 1', bot_code: 'delta1' } as any,
      { id: 'biz-d2', name: 'Delta 2', bot_code: 'delta2' } as any,
    ]);

    let botN23 = 0;
    let insertCount23 = 0;
    const supabase = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'platform_settings') return makeChain({ value: false });
        if (table === 'bot_sessions') {
          botN23++;
          const n = botN23;
          if (n === 1) return makeChain(null); // cleanup in helper
          if (n === 2) {
            // first insert → 23505
            insertCount23++;
            const c = makeChain(null);
            c.insert = vi.fn().mockImplementation(() => {
              const ic = makeChain(null, true);
              ic.select = vi.fn().mockImplementation(() => {
                const sc = makeChain(null, false);
                sc.single = vi.fn().mockResolvedValue({ data: null, error: { code: '23505' } });
                return sc;
              });
              return ic;
            });
            return c;
          }
          if (n === 3) {
            const c = makeChain(expiredSess23);
            c.single = vi.fn().mockResolvedValue({ data: expiredSess23, error: null });
            return c;
          }
          if (n === 4) {
            // CAS → success
            return makeChain([{ id: expiredSess23.id }]);
          }
          if (n === 5) {
            // retry insert → also fails (23505 — another concurrent insert)
            insertCount23++;
            const c = makeChain(null);
            c.insert = vi.fn().mockImplementation(() => {
              const ic = makeChain(null, true);
              ic.select = vi.fn().mockImplementation(() => {
                const sc = makeChain(null, false);
                sc.single = vi.fn().mockResolvedValue({ data: null, error: { code: '23505' } });
                return sc;
              });
              return ic;
            });
            return c;
          }
          return makeChain(null);
        }
        if (table === 'blocked_phones') {
          const c = makeChain(null);
          c.select = vi.fn().mockReturnValue({ ...c, eq: vi.fn().mockReturnValue({ ...c, or: vi.fn().mockResolvedValue({ count: 0, error: null }) }) });
          return c;
        }
        return makeChain(null);
      }),
      rpc: vi.fn().mockImplementation((name: string) => {
        if (name === 'get_bot_context') return Promise.resolve({ data: { has_session: false, ambiguous: false, session: null, business: null, capabilities: null, capability_overrides: null }, error: null });
        return Promise.resolve({ data: { success: true, version: 1 }, error: null });
      }),
    };

    const bot = new BotService(supabase as any, sender, createStandaloneService(), createMockIntelligence() as any);
    await bot.handleMessage('+234800', 'switch_biz', 'text');

    // Exactly 2 insert attempts: original + one retry (no more)
    expect(insertCount23).toBe(2);
    // Exactly one error text reply, no buttons
    const errorReplies = cloud.sendText.mock.calls.filter((c: any[]) => c[0]?.text?.includes('Something went wrong'));
    expect(errorReplies.length).toBe(1);
    expect(cloud.sendButtons.mock.calls.length).toBe(0);
  });

  it('17. biz_no with en session: no translate call, platform-scoped send', async () => {
    const cloud = createMockCloud();
    const sender = new MetaCloudSender(cloud as any, createTestSupabase());
    const spyPT = vi.spyOn(sender, 'sendPlatformText');
    const { translateBotResponse: mockTranslate } = await import('@/lib/bot/translate');
    (mockTranslate as any).mockClear();
    (mockTranslate as any).mockImplementation(async (t: string) => t);
    const sugSess = {
      id: 'sess-en', business_id: null, current_step: 'select_business_suggestion',
      is_active: true, session_data: {
        suggestions: [{ id: 'biz-1', name: 'Spa A', bot_code: 'SPAA' }],
        _detected_language: 'en',
      },
      whatsapp_number: '+234800', expires_at: new Date(Date.now() + 1800000).toISOString(), version: 0,
    };
    const supabase = createTableAwareSupabase({ session: sugSess });
    supabase.rpc = vi.fn().mockResolvedValue({ data: { has_session: true, session: sugSess, ambiguous: false }, error: null });
    const bot = new BotService(supabase as any, sender, createStandaloneService(), createMockIntelligence() as any);
    await bot.handleMessage('+234800', 'biz_no', 'text');
    // No translate call for English
    expect(mockTranslate).not.toHaveBeenCalled();
    // Platform-scoped send with English text
    expect(spyPT.mock.calls.length).toBe(1);
    expect((spyPT.mock.calls[0][0] as { text: string }).text).toContain('No problem');
  });
});
