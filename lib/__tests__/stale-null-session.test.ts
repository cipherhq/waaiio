/**
 * Stale null-business session fix tests
 *
 * Tests the fix for expired null-biz sessions that stayed is_active=true,
 * causing 23505 collisions and silent failures (MessagingSuspendedError crash)
 * when no business is bound and sends go through business-scoped sendText.
 *
 * Covers:
 * 1. Stale expired null-biz session → deactivated, retry insert succeeds, platform reply sent
 * 2. Stale expired null-biz session + "Hi" → platform-scoped reply, no MessagingSuspendedError
 * 3. Brand-new phone, "Hi" on shared number, no business → platform reply, no crash
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
vi.mock('@/lib/bot/handlers/bot-code-detection', () => ({
  detectBotCode: vi.fn().mockResolvedValue(null),
  detectBotCodeWithSuggestions: vi.fn().mockImplementation(async () => mockDetectionResult),
  rankSuggestions: vi.fn().mockReturnValue([]),
  findReturningCustomerBusiness: vi.fn().mockResolvedValue(null),
  findReturningCustomerBusinesses: vi.fn().mockResolvedValue([]),
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
      alias: null,
      welcome_buttons: [],
      quick_replies: [],
      default_reply: null,
      auto_reply_enabled: false,
      business_hours: null,
      away_message: null,
      instant_reply_enabled: false,
      instant_reply_message: null,
    }),
    checkTierLimitsFromBusiness: vi.fn().mockResolvedValue({
      allowed: true, plan: 'free', monthlyBookings: 0, monthlyLimit: 999, isWhitelabel: false,
    }),
    fillTemplate: vi.fn().mockImplementation((template: string) => template),
    checkTierLimits: vi.fn().mockResolvedValue({ allowed: true, plan: 'free', monthlyBookings: 0, monthlyLimit: 999, isWhitelabel: false }),
  } as any;
}

/**
 * Faithful mock chain supporting every method used by the exercised production paths.
 */
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
    vi.clearAllMocks();
  });

  it('1. stale expired null-biz session → deactivated, retry insert succeeds, platform reply sent', async () => {
    const cloud = createMockCloud();
    const sender = new MetaCloudSender(cloud as any, createTestSupabase());

    const expiredSession = {
      id: 'sess-stale', business_id: null, current_step: 'select_business_suggestion',
      is_active: true, session_data: { suggestions: [] }, whatsapp_number: '+234800',
      expires_at: new Date(Date.now() - 3600000).toISOString(), // expired 1 hour ago
      version: 0,
    };

    // No business detected — will try null-biz insert which collides with the stale session
    mockDetectionResult = { businessId: null, suggestions: [] };

    const retriedSession = {
      id: 'sess-retry', business_id: null, current_step: 'select_business_suggestion',
      is_active: true, session_data: {}, whatsapp_number: '+234800',
      expires_at: new Date(Date.now() + 1800000).toISOString(), version: 0,
    };

    let insertCallCount = 0;
    let deactivateUpdateCalled = false;
    const supabase = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'platform_settings') return makeChain({ value: false });
        if (table === 'bot_sessions') {
          const chain = makeChain(null); // getActiveSession returns null (expired filtered)
          // .update() for deactivation of stale session
          chain.update = vi.fn().mockImplementation(() => {
            deactivateUpdateCalled = true;
            return makeChain(null);
          });
          chain.insert = vi.fn().mockImplementation(() => {
            insertCallCount++;
            if (insertCallCount === 1) {
              // First insert: 23505 collision with stale null-biz session
              const errChain = makeChain(null, true);
              errChain.select = vi.fn().mockImplementation(() => {
                const sc = makeChain(null, false);
                sc.single = vi.fn().mockResolvedValue({
                  data: null,
                  error: { code: '23505', message: 'duplicate key', details: '' },
                });
                return sc;
              });
              return errChain;
            }
            // Second insert (retry after deactivation): success
            const retryChain = makeChain(retriedSession, true);
            retryChain.select = vi.fn().mockImplementation(() => makeChain(retriedSession, false));
            return retryChain;
          });
          // The 23505 recovery SELECT: .select('*').eq().is().eq().single()
          // returns the expired stale session
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
    await bot.handleMessage('+234800', 'Hi', 'text', 'pnid-1');

    // The stale session was deactivated via update
    expect(deactivateUpdateCalled).toBe(true);
    // Insert was called twice (first 23505, then retry)
    expect(insertCallCount).toBe(2);

    // A platform reply was sent — "Welcome to Waaiio" greeting
    const welcomeCalls = cloud.sendText.mock.calls.filter(
      (c: any[]) => typeof c[0]?.text === 'string' && c[0].text.includes('Welcome to Waaiio')
    );
    expect(welcomeCalls.length).toBe(1);

    // Platform discovery entered — no business bound
    expect(sender.boundBusinessId).toBe('');

    // No crash fallback
    const crashFallbacks = cloud.sendText.mock.calls.filter(
      (c: any[]) => typeof c[0]?.text === 'string' && c[0].text.includes('Something went wrong')
    );
    expect(crashFallbacks.length).toBe(0);
  });

  it('2. stale expired null-biz session + "Hi" → platform-scoped reply, no MessagingSuspendedError', async () => {
    const cloud = createMockCloud();
    const sender = new MetaCloudSender(cloud as any, createTestSupabase());

    // No business found — will end up in the first-time user greeting path
    mockDetectionResult = { businessId: null, suggestions: [] };

    const newSession = {
      id: 'sess-new', business_id: null, current_step: 'select_business_suggestion',
      is_active: true, session_data: {}, whatsapp_number: '+234800',
      expires_at: new Date(Date.now() + 1800000).toISOString(), version: 0,
    };

    const supabase = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'platform_settings') return makeChain({ value: false });
        if (table === 'bot_sessions') {
          const chain = makeChain(null); // getActiveSession returns null
          chain.insert = vi.fn().mockImplementation(() => {
            const ic = makeChain(newSession, true);
            ic.select = vi.fn().mockImplementation(() => makeChain(newSession, false));
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
    await bot.handleMessage('+234800', 'Hi', 'text', 'pnid-1');

    // A "Welcome to Waaiio" platform text was sent
    const welcomeCalls = cloud.sendText.mock.calls.filter(
      (c: any[]) => typeof c[0]?.text === 'string' && c[0].text.includes('Welcome to Waaiio')
    );
    expect(welcomeCalls.length).toBe(1);

    // Platform discovery was entered (no business bound)
    expect(sender.boundBusinessId).toBe('');

    // No crash fallback
    const crashFallbacks = cloud.sendText.mock.calls.filter(
      (c: any[]) => typeof c[0]?.text === 'string' && c[0].text.includes('Something went wrong')
    );
    expect(crashFallbacks.length).toBe(0);
  });

  it('3. brand-new phone, "Hi" on shared number, no business → platform reply, no crash', async () => {
    const cloud = createMockCloud();
    const sender = new MetaCloudSender(cloud as any, createTestSupabase());
    mockDetectionResult = { businessId: null, suggestions: [] };

    const nullSession = {
      id: 'sess-brand-new', business_id: null, current_step: 'select_business_suggestion',
      is_active: true, session_data: {}, whatsapp_number: '+234900',
      expires_at: new Date(Date.now() + 1800000).toISOString(), version: 0,
    };

    const supabase = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'platform_settings') return makeChain({ value: false });
        if (table === 'bot_sessions') {
          const chain = makeChain(null);
          chain.insert = vi.fn().mockImplementation(() => {
            const ic = makeChain(nullSession, true);
            ic.select = vi.fn().mockImplementation(() => makeChain(nullSession, false));
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
    await bot.handleMessage('+234900', 'Hi', 'text', 'pnid-1');

    // Platform-scoped welcome sent
    const welcomeCalls = cloud.sendText.mock.calls.filter(
      (c: any[]) => typeof c[0]?.text === 'string' && c[0].text.includes('Welcome to Waaiio')
    );
    expect(welcomeCalls.length).toBe(1);

    // No crash — no "Something went wrong"
    const crashFallbacks = cloud.sendText.mock.calls.filter(
      (c: any[]) => typeof c[0]?.text === 'string' && c[0].text.includes('Something went wrong')
    );
    expect(crashFallbacks.length).toBe(0);

    // Platform discovery mode — no business bound
    expect(sender.boundBusinessId).toBe('');
  });

  it('4. returning customer with past businesses, "Hi" → picker sent platform-scoped, no crash', async () => {
    const cloud = createMockCloud();
    const sender = new MetaCloudSender(cloud as any, createTestSupabase());
    mockDetectionResult = { businessId: null, suggestions: [] };

    // Mock findReturningCustomerBusinesses to return past businesses
    const { findReturningCustomerBusinesses } = await import('@/lib/bot/handlers/bot-code-detection');
    (findReturningCustomerBusinesses as any).mockResolvedValue([
      { id: 'biz-R1', name: 'Restaurant One', bot_code: 'REST1' },
    ]);

    // The null-biz suggestion session created in the picker path
    const sugSession = {
      id: 'sess-sug', business_id: null, current_step: 'select_business_suggestion',
      is_active: true, session_data: { suggestions: [{ id: 'biz-R1', name: 'Restaurant One', bot_code: 'REST1' }] },
      whatsapp_number: '+234700', expires_at: new Date(Date.now() + 1800000).toISOString(), version: 0,
    };

    // Shared insert mock
    const insertMock = vi.fn().mockImplementation(() => {
      const ic = makeChain(sugSession, true);
      ic.select = vi.fn().mockImplementation(() => makeChain(sugSession, false));
      return ic;
    });

    const supabase = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'platform_settings') return makeChain({ value: false });
        if (table === 'bot_sessions') {
          const chain = makeChain(null); // getActiveSession returns null
          chain.insert = insertMock;
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
    await bot.handleMessage('+234700', 'Hi', 'text', 'pnid-1');

    // Returning customer: "Did you mean *Restaurant One*?" via platform-scoped buttons
    const pickerCalls = cloud.sendButtons.mock.calls.filter(
      (c: any[]) => typeof c[0]?.bodyText === 'string' && c[0].bodyText.includes('Restaurant One')
    );
    expect(pickerCalls.length).toBe(1);

    // Platform discovery entered — no business bound
    expect(sender.boundBusinessId).toBe('');

    // No crash — no "Something went wrong"
    const crashFallbacks = cloud.sendText.mock.calls.filter(
      (c: any[]) => typeof c[0]?.text === 'string' && c[0].text.includes('Something went wrong')
    );
    expect(crashFallbacks.length).toBe(0);
  });
});
