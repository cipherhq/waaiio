/** Real BotService dispatch with mocked provider/database boundaries. */
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


// Exercise the real BotService dispatch; provider sends and database boundaries are mocked.
const channelId = 'shared-channel';
const pickerSession = {
  id: 'picker', whatsapp_number: '+234800', business_id: null,
  current_step: 'select_business_suggestion', version: 4, is_active: true,
  expires_at: new Date(Date.now() + 3600000).toISOString(),
  session_data: { _inbound_channel_id: channelId, _conversation_version: 8,
    suggestions: [{id:'ayo',name:'Ayo',bot_code:'AYO'},{id:'other',name:'Other',bot_code:'OTHER'}] },
};
function setup(selected: unknown, error: unknown = null, insertedSession: Record<string, unknown> | null = null) {
  const supabase = createTableAwareSupabase({session: null, insertedSession, business: { id:'ayo',name:'Ayo',status:'active',category:'salon',subscription_tier:'business',metadata:{} }});
  const fallbackFrom = supabase.from.getMockImplementation()!;
  supabase.from.mockImplementation((table: string) => {
    if (table === 'whatsapp_channels') return makeChain({id:channelId,channel_type:'shared'});
    const chain = fallbackFrom(table);
    if (table === 'businesses') chain.eq.mockImplementation((column: string) =>
      column === 'whatsapp_phone_number_id' ? makeChain(null) : chain);
    return chain;
  });
  supabase.rpc.mockImplementation(async (name: string) => name === 'get_shared_conversation'
    ? {data:{version:8,session:selected},error} as any
    : name === 'select_shared_conversation' ? {data:true,error:null} as any : name === 'update_session_cas' ? {data:{success:true,version:5},error:null} as any : {data:{ambiguous:true},error:null} as any);
  const cloud = createMockCloud();
  const sender = new MetaCloudSender(cloud as any, createTestSupabase());
  const bot = new BotService(supabase as any, sender, createStandaloneService(), createMockIntelligence() as any);
  return {supabase,cloud,bot};
}
describe('shared-channel dispatch continuity', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const {handleGlobalQuery} = await import('@/lib/bot/handlers/global-queries');
    vi.mocked(handleGlobalQuery).mockImplementation(async (opts:any)=>({handled:false,session:opts.session}));
  });
  it('routes numeric picker response to the selected stored code instead of redisplaying suggestions', async () => {
    const {bot,supabase} = setup(pickerSession);
    const original = bot.handleMessage.bind(bot);
    const spy = vi.spyOn(bot,'handleMessage');
    spy.mockImplementationOnce(original).mockResolvedValue(undefined);
    await bot.handleMessage('+234800','1','text','provider-id');
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[1]).toEqual(['+234800','AYO','text','provider-id',undefined,undefined,undefined,'fuzzy',
      {id:'picker',version:4,conversationVersion:8,businessId:'ayo'}]);
    expect(supabase.rpc.mock.calls.some(([name])=>name==='get_bot_context')).toBe(false);
  });
  it('keeps the selected session for a plain-text booking reply despite phone-wide ambiguity', async () => {
    const session = {...pickerSession,id:'ayo-session',business_id:'ayo',current_step:'my_bookings',session_data:{_inbound_channel_id:channelId}};
    const {bot,supabase} = setup(session);
    const {handleGlobalQuery} = await import('@/lib/bot/handlers/global-queries');
    vi.mocked(handleGlobalQuery).mockImplementation(async (opts:any)=>({handled:true,session:opts.session}));
    await bot.handleMessage('+234800','next Friday','text','provider-id');
    expect(handleGlobalQuery).toHaveBeenCalledWith(expect.objectContaining({session:expect.objectContaining({id:'ayo-session'}),text:'next Friday'}));
    expect(supabase.rpc.mock.calls.some(([name])=>name==='get_bot_context')).toBe(false);
  });
  it('persists an exact business-code selection before presenting the new session', async () => {
    const created = {...pickerSession,id:'ayo-session',business_id:'ayo',current_step:'select_capability',session_data:{_inbound_channel_id:channelId}};
    const {bot,supabase} = setup(null,null,created);
    const {detectBotCodeWithSuggestions} = await import('@/lib/bot/handlers/bot-code-detection');
    vi.mocked(detectBotCodeWithSuggestions).mockResolvedValueOnce({businessId:'ayo',authority:'exact'});
    await bot.handleMessage('+234800','AYO','text','provider-id');
    expect(supabase.rpc).toHaveBeenCalledWith('select_shared_conversation', {
      p_phone:'+234800',p_channel_id:channelId,p_session_id:'ayo-session',p_expected_version:8,p_picker_id:null,p_picker_version:null,
    });
  });
  it('does not fall back to phone-wide sessions when channel binding storage fails', async () => {
    const {bot,supabase,cloud} = setup(null,{message:'unavailable'});
    await bot.handleMessage('+234800','1','text','provider-id');
    expect(supabase.rpc.mock.calls.some(([name])=>name==='get_bot_context')).toBe(false);
    expect(cloud.sendText).toHaveBeenCalled();
  });
});
