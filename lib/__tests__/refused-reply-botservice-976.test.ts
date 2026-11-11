/**
 * #976 end to end: real BotService.handleMessage → real FlowExecutor → real MetaCloudSender.
 * Only the financial RPC (check_or_authorize_send) is faked, answering insufficient_allowance_balance,
 * as on TestBiz staging (2026-11-10/11). Before #976 the customer got silence; now they get the
 * existing #682 notice, at most once per 5 minutes, and no business-scoped message reaches Meta.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { rateLimit, authorizeRpc, customConfig, keywordMatch } = vi.hoisted(() => ({
  customConfig: vi.fn(async () => ({ welcome_buttons: [] as unknown[], quick_replies: [], default_reply: null })),
  keywordMatch: vi.fn((): unknown => null),
  rateLimit: vi.fn(async () => ({ allowed: true, remaining: 1 })),
  authorizeRpc: vi.fn(async () => ({ data: { authorized: false, reason: 'insufficient_allowance_balance' }, error: null })),
}));

vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => ({ rpc: authorizeRpc }) }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimitAsync: rateLimit }));
vi.mock('@/lib/countries', () => ({ loadCountries: vi.fn().mockResolvedValue([]), getCountry: vi.fn(), getCountryList: vi.fn().mockReturnValue([]), isValidCountryCode: vi.fn().mockReturnValue(true), getDialingCodeMap: vi.fn().mockReturnValue({}) }));
vi.mock('@/lib/platformSettings', () => ({ loadPlatformSettings: vi.fn().mockResolvedValue({ bot_rate_limit_per_minute: 30, abuse_cooldown_soft_minutes: 5, abuse_cooldown_hard_minutes: 30, conversation_limits: { free: 200, growth: 1000, business: 5000 } }) }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('@/lib/bot/translate', () => ({ translateBotResponse: vi.fn(async (t: string) => t), detectLanguage: vi.fn(async () => 'en'), getLanguageName: vi.fn(() => 'English') }));
vi.mock('@/lib/bot/handlers/global-queries', () => ({ handleGlobalQuery: vi.fn(async (opts: { session: unknown }) => ({ handled: false, session: opts.session })), isOrdersQuery: vi.fn(() => false) }));
vi.mock('@/lib/bot/handlers/escape-hatches', () => ({ HOME_PATTERN: /^home$/i, handleEscapeHatch: vi.fn().mockResolvedValue({ handled: false }), safeFlowCleanup: vi.fn() }));
vi.mock('@/lib/bot/keyword-service', async (orig) => ({
  ...(await orig<typeof import('@/lib/bot/keyword-service')>()),
  loadBotCustomConfig: customConfig, matchQuickReply: vi.fn(() => null),
  loadUnifiedKeywords: vi.fn().mockResolvedValue([]), matchUnifiedKeyword: keywordMatch,
}));
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
vi.mock('@/lib/channels/send-guard', () => ({ assertMessagingAllowed: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/bot/handlers/bot-code-detection', () => ({
  detectBotCode: vi.fn().mockResolvedValue(null),
  detectBotCodeWithSuggestions: vi.fn().mockResolvedValue({ businessId: null, suggestions: [] }),
  rankSuggestions: vi.fn().mockReturnValue([]),
  findReturningCustomerBusiness: vi.fn().mockResolvedValue(null),
  findReturningCustomerBusinesses: vi.fn().mockResolvedValue([]),
}));

const { BotService } = await import('@/lib/bot/bot.service');
const { MetaCloudSender } = await import('@/lib/channels/message-sender');

const NOTICE = 'This business is temporarily unable to send messages. Please try again later or contact the business directly.';

function chain(data: unknown): any {
  const c: any = {};
  for (const m of ['eq', 'neq', 'or', 'is', 'in', 'not', 'lt', 'gt', 'gte', 'lte', 'ilike', 'like', 'limit', 'order', 'head', 'update', 'delete', 'upsert', 'filter', 'contains', 'range', 'match', 'select']) c[m] = vi.fn(() => c);
  c.single = vi.fn(async () => ({ data, error: null }));
  c.maybeSingle = vi.fn(async () => ({ data, error: null }));
  c.insert = vi.fn(() => chain(data));
  c.then = (f: any, r: any) => Promise.resolve({ data, error: null, count: 0 }).then(f, r);
  return c;
}

/** Sender-side DB: attempt rows get real ids, so the financial RPC is consulted. */
function senderDb() {
  let n = 0;
  return {
    from: () => ({
      insert: () => ({ select: () => ({ single: async () => ({ data: { id: `attempt-${++n}` }, error: null }) }) }),
      update: () => ({ eq: async () => ({ error: null }) }),
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
    }),
    rpc: async () => ({ data: null, error: null }),
  };
}

function botDb() {
  const session = {
    id: 'sess-976', business_id: 'biz-T', current_step: 'select_capability', is_active: true, version: 0,
    session_data: { capabilities: ['scheduling', 'ordering'] }, whatsapp_number: '+2348000000001',
    expires_at: new Date(Date.now() + 3600000).toISOString(), conversation_log: [],
  };
  const business = { id: 'biz-T', name: 'TestBiz', status: 'active', category: 'restaurant', subscription_tier: 'free', country_code: 'NG', metadata: {}, is_whitelabel: false };
  return {
    from: vi.fn((table: string) => {
      if (table === 'platform_settings') return chain({ value: false });
      if (table === 'bot_sessions') return chain(session);
      if (table === 'businesses') return chain(business);
      if (table === 'blocked_phones') {
        const c = chain(null);
        c.select = vi.fn(() => ({ ...c, eq: vi.fn(() => ({ ...c, or: vi.fn(async () => ({ count: 0, error: null })) })) }));
        return c;
      }
      return chain(null);
    }),
    // The bot loads an existing session through get_bot_context (tenant-scoped when the business is pre-resolved).
    rpc: vi.fn(async (fn: string) => fn === 'get_bot_context'
      ? ({ data: {
          has_session: true, session,
          business: { ...business, flow_type: 'scheduling', slug: 'testbiz' },
          capabilities: [
            { capability: 'scheduling', is_enabled: true, sort_order: 0 },
            { capability: 'ordering', is_enabled: true, sort_order: 1 },
          ],
          capability_overrides: [],
        }, error: null })
      : ({ data: { success: true, version: 1 }, error: null })),
  };
}

function cloud() {
  return {
    sendText: vi.fn(async () => ({ messages: [{ id: 'wamid-1' }] })),
    sendButtons: vi.fn(async () => ({ messages: [{ id: 'wamid-2' }] })),
    sendList: vi.fn(async () => ({ messages: [{ id: 'wamid-3' }] })),
    sendTemplate: vi.fn(), sendImage: vi.fn(), sendDocument: vi.fn(), sendAudio: vi.fn(),
    sendFlow: vi.fn(), sendReaction: vi.fn(), sendLocation: vi.fn(), sendProduct: vi.fn(), sendProductList: vi.fn(),
  };
}

const intelligence = {
  isTimedOut: vi.fn(() => ({ timedOut: false })), containsProfanity: vi.fn(() => false),
  recordProfanity: vi.fn(() => ({ timeout: false, warn: false })), recordGibberish: vi.fn(() => ({ timeout: false, warn: false })),
  detectBookingIntent: vi.fn(() => null), getPersonaGreeting: vi.fn(() => null),
};
const standalone = {
  parseNaturalBooking: vi.fn(async () => null), detectLanguage: vi.fn(async () => null),
  loadWhatsAppConfigBundle: vi.fn(async () => ({ templates: { greeting: 'Welcome to {business_name}!' }, alias: null, welcome_buttons: [], quick_replies: [], default_reply: null, auto_reply_enabled: false, business_hours: null, away_message: null, instant_reply_enabled: false, instant_reply_message: null })),
  checkTierLimitsFromBusiness: vi.fn(async () => ({ allowed: true, plan: 'free', monthlyBookings: 0, monthlyLimit: 999, isWhitelabel: false })),
  fillTemplate: vi.fn((t: string) => t),
  checkTierLimits: vi.fn(async () => ({ allowed: true, plan: 'free', monthlyBookings: 0, monthlyLimit: 999, isWhitelabel: false })),
};

function setup() {
  const c = cloud();
  const sender = new MetaCloudSender(c as never, senderDb() as never);
  const bot = new BotService(botDb() as never, sender, standalone as never, intelligence as never);
  const execute = vi.spyOn((bot as unknown as { flowExecutor: { execute: (...a: unknown[]) => Promise<void> } }).flowExecutor, 'execute');
  return { c, bot, execute };
}

describe('#976 refused reply → customer gets the #682 notice (real BotService, executor, sender)', () => {
  beforeEach(() => {
    rateLimit.mockClear();
    rateLimit.mockImplementation(async () => ({ allowed: true, remaining: 1 }));
    authorizeRpc.mockClear();
    customConfig.mockImplementation(async () => ({ welcome_buttons: [], quick_replies: [], default_reply: null }));
    keywordMatch.mockImplementation(() => null);
  });

  it('flow reply refused for insufficient balance: one platform notice, nothing business-scoped reaches Meta', async () => {
    const { c, bot, execute } = setup();
    await bot.handleMessage('+2348000000001', 'menu', 'text', 'pnid-1');

    expect(execute).toHaveBeenCalled(); // the refusal came from a flow reply
    expect(authorizeRpc).toHaveBeenCalledTimes(1); // stopped after the first refusal
    expect(rateLimit).toHaveBeenCalledWith('bot_exhaustion:+2348000000001', 1, 5 * 60 * 1000);
    const allCloud = [...c.sendText.mock.calls, ...c.sendButtons.mock.calls, ...c.sendList.mock.calls];
    expect(allCloud).toHaveLength(1);
    expect(c.sendText).toHaveBeenCalledWith({ to: '+2348000000001', text: NOTICE });
  });

  it('within 5 minutes of a notice: still no business message, and no second notice', async () => {
    rateLimit.mockImplementation(async () => ({ allowed: false, remaining: 0 }));
    const { c, bot } = setup();
    await bot.handleMessage('+2348000000001', 'menu', 'text', 'pnid-1');

    expect([...c.sendText.mock.calls, ...c.sendButtons.mock.calls, ...c.sendList.mock.calls]).toHaveLength(0);
  });

  // Reviewer finding on 4772109: these two paths caught the refusal as "non-fatal" and routed the
  // same message again (a second execute with the tap/keyword as input, an extra refused attempt).
  it('welcome button "start flow" refused: one execute, one authorization, then the notice', async () => {
    customConfig.mockImplementation(async () => ({ welcome_buttons: [{ label: 'Book', action: 'start_flow' }], quick_replies: [], default_reply: null }));
    const { c, bot, execute } = setup();
    await bot.handleMessage('+2348000000001', 'wb_0', 'button', 'pnid-1', 'biz-T');

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][1]).toBe(''); // the prompt only; the tap/keyword is not routed again as input
    expect(authorizeRpc).toHaveBeenCalledTimes(1);
    expect(c.sendText).toHaveBeenCalledTimes(1);
    expect(c.sendText).toHaveBeenCalledWith({ to: '+2348000000001', text: NOTICE });
  });

  it('keyword "start capability" refused: one execute, one authorization, then the notice', async () => {
    keywordMatch.mockImplementation(() => ({ keyword: 'see specials', action_type: 'start_capability', payload: JSON.stringify({ capability: 'scheduling' }) }));
    const { c, bot, execute } = setup();
    await bot.handleMessage('+2348000000001', 'see specials', 'text', 'pnid-1', 'biz-T');

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][1]).toBe(''); // the prompt only; the tap/keyword is not routed again as input
    expect(authorizeRpc).toHaveBeenCalledTimes(1);
    expect(c.sendText).toHaveBeenCalledTimes(1);
    expect(c.sendText).toHaveBeenCalledWith({ to: '+2348000000001', text: NOTICE });
  });
});
