/**
 * S-1 Real BotService.handleMessage() Behavioral Tests (#256)
 *
 * Instantiates real BotService with mocked external boundaries and calls
 * handleMessage() to prove tenant binding, suspension, switch/discovery,
 * and B selection/resolution through the actual state machine.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/rate-limit', () => ({ checkRateLimitAsync: vi.fn().mockResolvedValue({ allowed: true, remaining: 10 }) }));
vi.mock('@/lib/platformSettings', () => ({ loadPlatformSettings: vi.fn().mockResolvedValue({ bot_rate_limit_per_minute: 30, abuse_cooldown_soft_minutes: 5, abuse_cooldown_hard_minutes: 30 }) }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('@/lib/bot/translate', () => ({ translateBotResponse: vi.fn(async (t: string) => t), detectLanguage: vi.fn(async () => 'en'), getLanguageName: vi.fn(() => 'English') }));
vi.mock('@/lib/bot/handlers/global-queries', () => ({ handleGlobalQuery: vi.fn(async (opts: { session: unknown }) => ({ handled: false, session: opts.session })), isOrdersQuery: vi.fn(() => false) }));
vi.mock('@/lib/bot/handlers/escape-hatches', () => ({ HOME_PATTERN: /^home$/i, handleEscapeHatch: vi.fn().mockResolvedValue({ handled: false }) }));
vi.mock('@/lib/bot/keyword-service', () => ({ loadBotCustomConfig: vi.fn().mockResolvedValue({ welcome_buttons: [], quick_replies: [], default_reply: null }), matchQuickReply: vi.fn(() => null), loadUnifiedKeywords: vi.fn().mockResolvedValue([]), matchUnifiedKeyword: vi.fn(() => null) }));
vi.mock('@/lib/circuit-breaker', () => ({ isCircuitOpen: () => false, recordSuccess: vi.fn(), recordFailure: vi.fn(), CircuitBreakerOpenError: class extends Error {} }));

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
  };
}

function createTableAwareSupabase(config: {
  session?: Record<string, unknown> | null;
  business?: Record<string, unknown> | null;
} = {}) {
  const { session = null, business = null } = config;
  function makeChain(tableData: unknown) {
    const chain: Record<string, any> = {};
    for (const m of ['select', 'eq', 'neq', 'or', 'is', 'in', 'not', 'lt', 'gt', 'gte', 'lte', 'limit', 'order', 'head', 'insert', 'update', 'delete', 'upsert']) chain[m] = vi.fn().mockReturnValue(chain);
    chain.single = vi.fn().mockResolvedValue({ data: tableData, error: null });
    chain.maybeSingle = vi.fn().mockResolvedValue({ data: tableData, error: null });
    chain.select = vi.fn().mockReturnValue(chain);
    return chain;
  }
  return {
    from: vi.fn().mockImplementation((table: string) => {
      if (table === 'platform_settings') return makeChain({ value: false });
      if (table === 'bot_sessions') return makeChain(session);
      if (table === 'businesses') return makeChain(business);
      return makeChain(null);
    }),
    rpc: vi.fn().mockResolvedValue({ data: { success: true, version: 1 }, error: null }),
  };
}

const standalone = () => ({ parseNaturalBooking: vi.fn().mockResolvedValue(null), detectLanguage: vi.fn().mockResolvedValue(null) } as any);

/** Count all business-scoped cloud calls (sendText, sendButtons, sendList, sendTemplate). */
function totalBusinessScopedCalls(cloud: ReturnType<typeof createMockCloud>): number {
  return cloud.sendText.mock.calls.length
    + cloud.sendButtons.mock.calls.length
    + cloud.sendList.mock.calls.length
    + cloud.sendTemplate.mock.calls.length;
}

/**
 * Create a supabase mock where the session response changes after the first query.
 * First bot_sessions query returns `firstSession`; subsequent queries return `null`.
 * This simulates session deactivation between recursive handleMessage calls.
 */
function createStatefulSupabase(config: {
  firstSession: Record<string, unknown> | null;
  business: Record<string, unknown> | null;
}) {
  let sessionQueryCount = 0;
  function makeChain(tableData: unknown) {
    const chain: Record<string, any> = {};
    for (const m of ['select', 'eq', 'neq', 'or', 'is', 'in', 'not', 'lt', 'gt', 'gte', 'lte', 'limit', 'order', 'head', 'insert', 'update', 'delete', 'upsert']) chain[m] = vi.fn().mockReturnValue(chain);
    chain.single = vi.fn().mockResolvedValue({ data: tableData, error: null });
    chain.maybeSingle = vi.fn().mockResolvedValue({ data: tableData, error: null });
    chain.select = vi.fn().mockReturnValue(chain);
    return chain;
  }
  return {
    from: vi.fn().mockImplementation((table: string) => {
      if (table === 'platform_settings') return makeChain({ value: false });
      if (table === 'bot_sessions') {
        sessionQueryCount++;
        // First session query returns the suggestion session; subsequent return null (deactivated)
        return makeChain(sessionQueryCount === 1 ? config.firstSession : null);
      }
      if (table === 'businesses') return makeChain(config.business);
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
      session: { id: 'sess-1', business_id: 'biz-A', current_step: 'idle', is_active: true, session_data: {}, whatsapp_number: '+234800', expires_at: new Date(Date.now() + 3600000).toISOString() },
      business: { id: 'biz-A', name: 'Biz A', status: 'active', category: 'restaurant', subscription_tier: 'free', country_code: 'NG', metadata: {} },
    });
    const bot = new BotService(supabase as any, sender, standalone(), createMockIntelligence() as any);
    await bot.handleMessage('+234800', 'Hi', 'text', 'pnid-1');
    // A is bound
    expect(sender.boundBusinessId).toBe('biz-A');
    // A authorization was evaluated through the actual flow
    const { assertMessagingAllowed } = await import('@/lib/channels/send-guard');
    const aCalls = (assertMessagingAllowed as any).mock.calls.filter((c: string[]) => c[0] === 'biz-A');
    expect(aCalls.length).toBeGreaterThan(0);
    // Active business produces at least one business-scoped provider call
    expect(totalBusinessScopedCalls(cloud)).toBeGreaterThan(0);
  });

  it('2. suspended A via preResolved: exactly zero business-scoped Meta calls', async () => {
    suspendedBizIds.add('biz-A');
    const cloud = createMockCloud();
    const sender = new MetaCloudSender(cloud as any);
    const supabase = createTableAwareSupabase({
      business: { id: 'biz-A', name: 'Biz A', status: 'active', category: 'restaurant', subscription_tier: 'free', country_code: 'NG', metadata: {} },
    });
    const bot = new BotService(supabase as any, sender, standalone(), createMockIntelligence() as any);
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
    const supabase = createTableAwareSupabase();
    const bot = new BotService(supabase as any, sender, standalone(), createMockIntelligence() as any);
    await bot.handleMessage('+234800', 'switch spa', 'text', 'pnid-1');
    // Discovery mode clears business binding
    expect(sender.boundBusinessId).toBe('');
    // Platform-scoped picker send reached Meta (sendText or sendButtons for the suggestion list)
    const pickerCalls = cloud.sendText.mock.calls.length + cloud.sendButtons.mock.calls.length;
    expect(pickerCalls).toBeGreaterThan(0);
  });

  it('4. B selection: picker postback resolves B, evaluates B authorization, produces B provider calls', async () => {
    const cloud = createMockCloud();
    const sender = new MetaCloudSender(cloud as any);

    // Configure detection to resolve biz-B when the recursive call sends bot_code 'SPAB'
    mockDetectionResult = { businessId: 'biz-B', suggestions: [] };

    // Stateful supabase: first session query returns suggestion session, subsequent return null
    // (simulates deactivation before recursive handleMessage)
    const supabase = createStatefulSupabase({
      firstSession: {
        id: 'sess-pick', business_id: null,
        current_step: 'select_business_suggestion',
        is_active: true,
        session_data: { suggestions: [{ id: 'biz-B', name: 'Spa B', bot_code: 'SPAB' }] },
        whatsapp_number: '+234800',
        expires_at: new Date(Date.now() + 3600000).toISOString(),
      },
      business: { id: 'biz-B', name: 'Spa B', status: 'active', category: 'spa', subscription_tier: 'free', country_code: 'NG', metadata: {}, bot_code: 'SPAB' },
    });
    const bot = new BotService(supabase as any, sender, standalone(), createMockIntelligence() as any);

    // User selects biz_0 from picker → BotService resolves B via recursive handleMessage
    await bot.handleMessage('+234800', 'biz_0', 'text', 'pnid-1');

    // B must be bound (not A, not empty — exact match)
    expect(sender.boundBusinessId).toBe('biz-B');
    // B authorization was evaluated through assertMessagingAllowed
    const { assertMessagingAllowed } = await import('@/lib/channels/send-guard');
    const bCalls = (assertMessagingAllowed as any).mock.calls.filter((c: string[]) => c[0] === 'biz-B');
    expect(bCalls.length).toBeGreaterThan(0);
    // B produced at least one business-scoped provider call
    expect(totalBusinessScopedCalls(cloud)).toBeGreaterThan(0);
  });

  it('5. dedicated suspended A: zero business-scoped Meta calls', async () => {
    suspendedBizIds.add('biz-dedicated');
    const cloud = createMockCloud();
    const sender = new MetaCloudSender(cloud as any);
    const supabase = createTableAwareSupabase();
    const bot = new BotService(supabase as any, sender, standalone(), createMockIntelligence() as any);
    await bot.handleMessage('+234800', 'Hi', 'text', 'pnid-1', 'biz-dedicated');
    // Business is bound (preResolved)
    expect(sender.boundBusinessId).toBe('biz-dedicated');
    // ALL business-scoped cloud calls must be exactly zero
    expect(totalBusinessScopedCalls(cloud)).toBe(0);
  });

  it('6. missing tenant: zero business-scoped provider calls', async () => {
    const cloud = createMockCloud();
    const sender = new MetaCloudSender(cloud as any);
    mockDetectionResult = { businessId: null, suggestions: [] };
    const supabase = createTableAwareSupabase();
    const bot = new BotService(supabase as any, sender, standalone(), createMockIntelligence() as any);
    await bot.handleMessage('+234800', 'random text', 'text', 'pnid-1');
    // Sender remains tenantless
    expect(sender.boundBusinessId).toBe('');
    // ALL business-scoped cloud calls must be exactly zero (no business context)
    expect(totalBusinessScopedCalls(cloud)).toBe(0);
  });
});
