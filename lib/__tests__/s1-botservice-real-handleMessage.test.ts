/**
 * S-1 Real BotService.handleMessage() Behavioral Tests (#256)
 *
 * Instantiates real BotService with mocked external boundaries and calls
 * handleMessage() to prove tenant binding, suspension, switch/discovery,
 * and B selection/resolution through the actual state machine.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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

/**
 * Faithful mock chain supporting every method used by the exercised production paths.
 * `thenable` controls whether the chain supports await (for fire-and-forget patterns).
 * Non-thenable chains are used for intermediates so `await chain.insert().select().single()`
 * correctly waits for `.single()` instead of resolving at `.insert()`.
 */
function makeChain(tableData: unknown, thenable = true) {
  const chain: Record<string, any> = {};
  for (const m of ['eq', 'neq', 'or', 'is', 'in', 'not', 'lt', 'gt', 'gte', 'lte', 'ilike', 'like', 'limit', 'order', 'head', 'update', 'delete', 'upsert', 'filter', 'contains', 'containedBy', 'range', 'overlaps', 'textSearch', 'match', 'csv', 'returns']) chain[m] = vi.fn().mockReturnValue(chain);
  chain.single = vi.fn().mockResolvedValue({ data: tableData, error: null });
  chain.maybeSingle = vi.fn().mockResolvedValue({ data: tableData, error: null });
  chain.select = vi.fn().mockReturnValue(chain);
  // insert returns a thenable chain (for fire-and-forget .then() patterns like logDropoff)
  // BUT its .select() returns a non-thenable chain so await .insert().select().single()
  // correctly waits for .single() instead of resolving at .insert().
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
        // .insert().select().single() must return a realistic session for new-session path
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

/**
 * Faithful StandaloneService stub implementing all methods reached by the exercised paths.
 * Crashes if a method is called that wasn't anticipated (no silent swallow).
 */
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

/** Count all business-scoped cloud calls (sendText, sendButtons, sendList, sendTemplate). */
function totalBusinessScopedCalls(cloud: ReturnType<typeof createMockCloud>): number {
  return cloud.sendText.mock.calls.length
    + cloud.sendButtons.mock.calls.length
    + cloud.sendList.mock.calls.length
    + cloud.sendTemplate.mock.calls.length;
}

/**
 * Stateful supabase mock: first bot_sessions read returns `firstSession`,
 * subsequent reads return `null` (simulates deactivation). Session insert
 * returns `insertedSession` for the recursive new-session path.
 */
function createStatefulSupabase(config: {
  firstSession: Record<string, unknown> | null;
  business: Record<string, unknown> | null;
  insertedSession?: Record<string, unknown> | null;
}) {
  let sessionQueryCount = 0;
  return {
    from: vi.fn().mockImplementation((table: string) => {
      if (table === 'platform_settings') return makeChain({ value: false });
      if (table === 'bot_sessions') {
        sessionQueryCount++;
        const sessionData = sessionQueryCount === 1 ? config.firstSession : null;
        const chain = makeChain(sessionData);
        // insert().select().single() for new-session creation in recursive call
        if (config.insertedSession) {
          const insertChain = makeChain(config.insertedSession);
          chain.insert = vi.fn().mockReturnValue(insertChain);
        }
        return chain;
      }
      if (table === 'businesses') return makeChain(config.business);
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

describe('S-1 Real BotService.handleMessage() (#256)', () => {
  beforeEach(() => {
    suspendedBizIds = new Set();
    mockDetectionResult = { businessId: null, suggestions: [] };
    vi.clearAllMocks();
  });

  it('1. resumed A session: BotService binds A and produces business-scoped provider calls', async () => {
    const cloud = createMockCloud();
    const sender = new MetaCloudSender(cloud as any);
    const supabase = createTableAwareSupabase({
      session: {
        id: 'sess-1', business_id: 'biz-A', current_step: 'select_capability', is_active: true,
        session_data: { capabilities: ['scheduling', 'ordering'] },
        whatsapp_number: '+234800', expires_at: new Date(Date.now() + 3600000).toISOString(), version: 0,
      },
      business: { id: 'biz-A', name: 'Biz A', status: 'active', category: 'restaurant', subscription_tier: 'free', country_code: 'NG', metadata: {}, is_whitelabel: false },
    });
    const bot = new BotService(supabase as any, sender, createStandaloneService(), createMockIntelligence() as any);
    // Send 'menu' — not a greeting, not a restart trigger, flows into capability selection handler
    await bot.handleMessage('+234800', 'menu', 'text', 'pnid-1');
    // A is bound
    expect(sender.boundBusinessId).toBe('biz-A');
    // A authorization was evaluated through the actual flow (not generic fallback)
    const { assertMessagingAllowed } = await import('@/lib/channels/send-guard');
    const aCalls = (assertMessagingAllowed as any).mock.calls.filter((c: string[]) => c[0] === 'biz-A');
    expect(aCalls.length).toBeGreaterThan(0);
    // Active business produces at least one business-scoped provider call
    expect(totalBusinessScopedCalls(cloud)).toBeGreaterThan(0);
    // Guard: the generic fallback "Something went wrong" must NOT be the source of cloud calls
    const fallbackCalls = cloud.sendText.mock.calls.filter(
      (c: any[]) => typeof c[0]?.text === 'string' && c[0].text.includes('Something went wrong')
    );
    expect(fallbackCalls.length).toBe(0);
  });

  it('2. suspended A via preResolved: exactly zero business-scoped Meta calls', async () => {
    suspendedBizIds.add('biz-A');
    const cloud = createMockCloud();
    const sender = new MetaCloudSender(cloud as any);
    const bizA = { id: 'biz-A', name: 'Biz A', status: 'active', category: 'restaurant', subscription_tier: 'free', country_code: 'NG', metadata: {}, is_whitelabel: false };
    const newSession = { id: 'sess-new', business_id: 'biz-A', current_step: 'select_capability', is_active: true, session_data: { capabilities: ['scheduling'] }, whatsapp_number: '+234800', expires_at: new Date(Date.now() + 3600000).toISOString(), version: 0 };
    const supabase = createTableAwareSupabase({
      business: bizA,
      insertedSession: newSession,
    });
    const bot = new BotService(supabase as any, sender, createStandaloneService(), createMockIntelligence() as any);
    await bot.handleMessage('+234800', 'Hi', 'text', 'pnid-1', 'biz-A');
    // A is bound via preResolvedBusinessId
    expect(sender.boundBusinessId).toBe('biz-A');
    // ALL business-scoped cloud calls must be exactly zero (suspension blocks every send)
    expect(totalBusinessScopedCalls(cloud)).toBe(0);
  });

  it('3. switch <keyword>: BotService fuzzy picker reaches Meta via platform-scoped send', async () => {
    suspendedBizIds.add('biz-A');
    const cloud = createMockCloud();
    const sender = new MetaCloudSender(cloud as any);
    sender.bindBusiness('biz-A');
    mockDetectionResult = { businessId: null, suggestions: [{ id: 'biz-B', name: 'Spa B', bot_code: 'SPAB' }, { id: 'biz-C', name: 'Spa C', bot_code: 'SPAC' }] };
    const supabase = createTableAwareSupabase({
      insertedSession: { id: 'sess-sug', business_id: null, current_step: 'select_business_suggestion', is_active: true, session_data: {}, whatsapp_number: '+234800', expires_at: new Date(Date.now() + 3600000).toISOString(), version: 0 },
    });
    const bot = new BotService(supabase as any, sender, createStandaloneService(), createMockIntelligence() as any);
    await bot.handleMessage('+234800', 'switch spa', 'text', 'pnid-1');
    // Discovery mode clears business binding
    expect(sender.boundBusinessId).toBe('');
    // Platform-scoped picker send reached Meta (sendText or sendButtons for the suggestion list)
    const pickerCalls = cloud.sendText.mock.calls.length + cloud.sendButtons.mock.calls.length;
    expect(pickerCalls).toBeGreaterThan(0);
    // Guard: no generic fallback
    const fallbackCalls = cloud.sendText.mock.calls.filter(
      (c: any[]) => typeof c[0]?.text === 'string' && c[0].text.includes('Something went wrong')
    );
    expect(fallbackCalls.length).toBe(0);
  });

  it('4. B selection: picker postback resolves B, evaluates B authorization, produces B provider calls', async () => {
    const cloud = createMockCloud();
    const sender = new MetaCloudSender(cloud as any);

    // Configure detection to resolve biz-B when the recursive call sends bot_code 'SPAB'
    mockDetectionResult = { businessId: 'biz-B', suggestions: [] };

    const bizB = { id: 'biz-B', name: 'Spa B', status: 'active', category: 'spa', subscription_tier: 'free', country_code: 'NG', metadata: {}, bot_code: 'SPAB', is_whitelabel: false };
    const newBSession = { id: 'sess-B', business_id: 'biz-B', current_step: 'select_capability', is_active: true, session_data: { capabilities: ['scheduling'] }, whatsapp_number: '+234800', expires_at: new Date(Date.now() + 3600000).toISOString(), version: 0 };

    const supabase = createStatefulSupabase({
      firstSession: {
        id: 'sess-pick', business_id: null,
        current_step: 'select_business_suggestion',
        is_active: true,
        session_data: { suggestions: [{ id: 'biz-B', name: 'Spa B', bot_code: 'SPAB' }] },
        whatsapp_number: '+234800',
        expires_at: new Date(Date.now() + 3600000).toISOString(),
        version: 0,
      },
      business: bizB,
      insertedSession: newBSession,
    });
    const bot = new BotService(supabase as any, sender, createStandaloneService(), createMockIntelligence() as any);

    // User selects biz_0 from picker → BotService resolves B via recursive handleMessage
    await bot.handleMessage('+234800', 'biz_0', 'text', 'pnid-1');

    // B must be bound (exact match)
    expect(sender.boundBusinessId).toBe('biz-B');
    // B authorization was evaluated through assertMessagingAllowed
    const { assertMessagingAllowed } = await import('@/lib/channels/send-guard');
    const bCalls = (assertMessagingAllowed as any).mock.calls.filter((c: string[]) => c[0] === 'biz-B');
    expect(bCalls.length).toBeGreaterThan(0);
    // B produced at least one business-scoped provider call
    expect(totalBusinessScopedCalls(cloud)).toBeGreaterThan(0);
    // Guard: no generic fallback — assertions come from the real B business flow
    const fallbackCalls = cloud.sendText.mock.calls.filter(
      (c: any[]) => typeof c[0]?.text === 'string' && c[0].text.includes('Something went wrong')
    );
    expect(fallbackCalls.length).toBe(0);
  });

  it('5. dedicated suspended A: zero business-scoped Meta calls', async () => {
    suspendedBizIds.add('biz-dedicated');
    const cloud = createMockCloud();
    const sender = new MetaCloudSender(cloud as any);
    const bizDedicated = { id: 'biz-dedicated', name: 'Ded Biz', status: 'active', category: 'restaurant', subscription_tier: 'free', country_code: 'NG', metadata: {}, is_whitelabel: false };
    const newSession = { id: 'sess-ded', business_id: 'biz-dedicated', current_step: 'select_capability', is_active: true, session_data: { capabilities: ['scheduling'] }, whatsapp_number: '+234800', expires_at: new Date(Date.now() + 3600000).toISOString(), version: 0 };
    const supabase = createTableAwareSupabase({
      business: bizDedicated,
      insertedSession: newSession,
    });
    const bot = new BotService(supabase as any, sender, createStandaloneService(), createMockIntelligence() as any);
    await bot.handleMessage('+234800', 'Hi', 'text', 'pnid-1', 'biz-dedicated');
    // Business is bound (preResolved)
    expect(sender.boundBusinessId).toBe('biz-dedicated');
    // ALL business-scoped cloud calls must be exactly zero
    expect(totalBusinessScopedCalls(cloud)).toBe(0);
  });

  it('6. missing tenant: guard evaluates missing identity, zero business-scoped provider calls', async () => {
    const cloud = createMockCloud();
    const sender = new MetaCloudSender(cloud as any);
    mockDetectionResult = { businessId: null, suggestions: [] };
    // Provide a realistic tenantless session so the flow proceeds past session insert
    const tenantlessSession = {
      id: 'sess-notenent', business_id: null, current_step: 'select_capability',
      is_active: true, session_data: { capabilities: [] },
      whatsapp_number: '+234800', expires_at: new Date(Date.now() + 3600000).toISOString(), version: 0,
    };
    const supabase = createTableAwareSupabase({ insertedSession: tenantlessSession });
    const bot = new BotService(supabase as any, sender, createStandaloneService(), createMockIntelligence() as any);
    await bot.handleMessage('+234800', 'random text', 'text', 'pnid-1');
    // Sender remains tenantless
    expect(sender.boundBusinessId).toBe('');
    // The missing-identity guard was called (assertMessagingAllowed with empty/falsy businessId)
    const { assertMessagingAllowed } = await import('@/lib/channels/send-guard');
    const guardCalls = (assertMessagingAllowed as any).mock.calls.filter(
      (c: string[]) => !c[0] || c[0] === ''
    );
    expect(guardCalls.length).toBeGreaterThan(0);
    // ALL business-scoped cloud calls must be exactly zero (guard blocked them)
    expect(totalBusinessScopedCalls(cloud)).toBe(0);
    // Guard: no generic fallback — the zero calls come from the guard, not a crash
    const fallbackCalls = cloud.sendText.mock.calls.filter(
      (c: any[]) => typeof c[0]?.text === 'string' && c[0].text.includes('Something went wrong')
    );
    expect(fallbackCalls.length).toBe(0);
  });
});
