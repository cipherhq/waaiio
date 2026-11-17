/**
 * #1083 through the real BotService.handleMessage (mocked Supabase, bot-code
 * detection and marketplace search; real directory handlers):
 * 1. A past customer tapping a hidden business in the recent list enters it, even
 *    though it fails the directory check (which applies to search picks only).
 * 2. A typed bot code for a messaging-suspended business on a shared number gets
 *    the plain "currently unavailable" reply instead of silence.
 * 3. On the suspended business's own number (sender bound) nothing is sent: the
 *    S-1 hard stop is unchanged.
 * 4. An inactive business keeps its existing plain reply.
 * Harness follows search-results-first.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTestSupabase } from './helpers/mock-supabase';

vi.mock('@/lib/countries', () => ({ loadCountries: vi.fn().mockResolvedValue([]), getCountry: vi.fn(), getCountryList: vi.fn().mockReturnValue([]), isValidCountryCode: vi.fn().mockReturnValue(true), getDialingCodeMap: vi.fn().mockReturnValue({}) }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimitAsync: vi.fn().mockResolvedValue({ allowed: true, remaining: 10 }) }));
vi.mock('@/lib/platformSettings', () => ({ loadPlatformSettings: vi.fn().mockResolvedValue({ bot_rate_limit_per_minute: 30, abuse_cooldown_soft_minutes: 5, abuse_cooldown_hard_minutes: 30, conversation_limits: { free: 200, growth: 1000, business: 5000 } }) }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('@/lib/bot/translate', () => ({ translateBotResponse: vi.fn(async (t: string) => t), detectLanguage: vi.fn(async () => 'en'), getLanguageName: vi.fn(() => 'English') }));
vi.mock('@/lib/bot/handlers/global-queries', () => ({ handleGlobalQuery: vi.fn(async (opts: { session: unknown }) => ({ handled: false, session: opts.session })), isOrdersQuery: vi.fn(() => false) }));
vi.mock('@/lib/bot/handlers/escape-hatches', async (importOriginal) => ({ ...await importOriginal<typeof import('@/lib/bot/handlers/escape-hatches')>(), handleEscapeHatch: vi.fn().mockResolvedValue({ handled: false }) }));
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
// The S-1 guard: business-scoped (bound) sends for biz-susp are blocked, as in production.
vi.mock('@/lib/channels/send-guard', () => ({
  assertMessagingAllowed: vi.fn().mockImplementation(async (bizId: string) => {
    if (!bizId || bizId === 'biz-susp') {
      throw Object.assign(new Error(`Messaging suspended for business ${bizId || 'unknown'}`), { name: 'MessagingSuspendedError' });
    }
  }),
}));

let mockDetectionResult: { businessId: string | null; suggestions?: unknown[]; authority?: string } = { businessId: null, suggestions: [] };
vi.mock('@/lib/bot/handlers/bot-code-detection', () => ({
  detectBotCode: vi.fn().mockResolvedValue(null),
  detectBotCodeWithSuggestions: vi.fn().mockImplementation(async () => mockDetectionResult),
  rankSuggestions: vi.fn().mockReturnValue([]),
  findReturningCustomerBusinesses: vi.fn().mockResolvedValue([]),
}));
vi.mock('@/lib/marketplace/search', () => ({
  searchMarketplace: vi.fn().mockResolvedValue({ ok: true, results: [], hasMore: false, suggestions: [] }),
  searchFuzzy: vi.fn().mockResolvedValue([]),
  loadDirectoryHiddenIds: vi.fn().mockResolvedValue([]),
  // Hidden from the directory: a search pick would be refused.
  isBusinessDirectoryEligible: vi.fn().mockResolvedValue(false),
  formatMarketplaceResults: vi.fn().mockReturnValue(''),
}));

const { BotService } = await import('@/lib/bot/bot.service');
const { MetaCloudSender } = await import('@/lib/channels/message-sender');
const { isBusinessDirectoryEligible } = await import('@/lib/marketplace/search');

const PHONE = '+234800';
const UNAVAILABLE = 'This business is currently unavailable. Please try again later.';

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
    checkTierLimitsFromBusiness: vi.fn().mockResolvedValue({ allowed: true, plan: 'free', monthlyBookings: 0, monthlyLimit: 999, isWhitelabel: false }),
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
  if (thenable) {
    const resolvedValue = { data: tableData, error: null, count: 0 };
    chain.then = (onFulfilled?: (v: any) => any, onRejected?: (e: any) => any) => Promise.resolve(resolvedValue).then(onFulfilled, onRejected);
    chain.catch = (onRejected?: (e: any) => any) => Promise.resolve(resolvedValue).catch(onRejected);
  }
  return chain;
}

/** Supabase mock: the stored session answers the first context read only. */
function createSupabase(existingSession: Record<string, unknown> | null, business: Record<string, unknown> | null) {
  const inserted: Array<Record<string, any>> = [];
  let contextReads = 0;
  return {
    _inserted: inserted,
    from: vi.fn().mockImplementation((table: string) => {
      if (table === 'platform_settings') return makeChain({ value: false });
      if (table === 'bot_sessions') {
        const c = makeChain(null);
        c.insert = vi.fn().mockImplementation((row: Record<string, any>) => {
          const saved = { id: `sess-${inserted.length}`, version: 0, ...row };
          inserted.push(saved);
          const ic = makeChain(saved, true);
          ic.select = vi.fn().mockImplementation(() => makeChain(saved, false));
          return ic;
        });
        return c;
      }
      if (table === 'businesses') return makeChain(business);
      if (table === 'blocked_phones') {
        const c = makeChain(null);
        c.select = vi.fn().mockReturnValue({ ...c, eq: vi.fn().mockReturnValue({ ...c, or: vi.fn().mockResolvedValue({ count: 0, error: null }) }) });
        return c;
      }
      return makeChain(null);
    }),
    rpc: vi.fn().mockImplementation((fn: string) => {
      if (fn === 'get_bot_context') {
        contextReads++;
        if (existingSession && contextReads === 1) {
          return Promise.resolve({ data: { has_session: true, session: existingSession, ambiguous: false }, error: null });
        }
        return Promise.resolve({ data: { has_session: false, ambiguous: false }, error: null });
      }
      return Promise.resolve({ data: { success: true, version: 1 }, error: null });
    }),
  };
}

function makeBot(supabase: unknown) {
  const cloud = createMockCloud();
  const sender = new MetaCloudSender(cloud as any, createTestSupabase());
  const bot = new BotService(supabase as any, sender, createStandaloneService(), createMockIntelligence() as any);
  return { bot, cloud, sender };
}

const allSends = (cloud: ReturnType<typeof createMockCloud>) =>
  [cloud.sendText, cloud.sendButtons, cloud.sendList, cloud.sendTemplate].reduce((n, f) => n + f.mock.calls.length, 0);
const texts = (cloud: ReturnType<typeof createMockCloud>) => cloud.sendText.mock.calls.map((c: any[]) => c[0]?.text as string);

const bizRow = (id: string, more: Record<string, unknown> = {}) => ({
  id, name: 'Zubby Adeola', status: 'active', messaging_suspended: false, discovery_enabled: false,
  category: 'salon', subscription_tier: 'free', country_code: 'NG', metadata: {}, bot_code: 'ZUBBY', is_whitelabel: false,
  ...more,
});

describe('#1083 BotService entry', () => {
  beforeEach(async () => {
    mockDetectionResult = { businessId: null, suggestions: [] };
    vi.clearAllMocks();
    const { detectBotCodeWithSuggestions } = await import('@/lib/bot/handlers/bot-code-detection');
    vi.mocked(detectBotCodeWithSuggestions).mockImplementation(async () => mockDetectionResult as any);
    vi.mocked(isBusinessDirectoryEligible).mockResolvedValue(false);
  });

  it('1. a past customer taps a hidden business in the recent list and enters it', async () => {
    const dirSession = {
      id: 'sess-dir', business_id: null, current_step: 'directory_results', is_active: true, version: 0,
      whatsapp_number: PHONE, expires_at: new Date(Date.now() + 1800000).toISOString(),
      session_data: { _directory_mode: true, _directory_postbacks: 'id', _directory_results: [], _directory_suggestions: [],
        suggestions: [{ id: '00000000-0000-4000-8000-000000000009', name: 'Zubby Adeola', bot_code: 'ZUBBY' }] },
    };
    const supabase = createSupabase(dirSession, bizRow('00000000-0000-4000-8000-000000000009'));
    const { bot, cloud, sender } = makeBot(supabase);

    await bot.handleMessage(PHONE, 'dir_biz_00000000-0000-4000-8000-000000000009', 'text');

    expect((sender as any).boundBusinessId).toBe('00000000-0000-4000-8000-000000000009');
    expect(isBusinessDirectoryEligible).not.toHaveBeenCalled();
    expect(texts(cloud).some((t) => /currently unavailable|list has changed|Something went wrong/i.test(t))).toBe(false);
  });

  it('2. a typed bot code for a messaging-suspended business on a shared number gets the plain reply', async () => {
    mockDetectionResult = { businessId: 'biz-susp', authority: 'exact' };
    const supabase = createSupabase(null, bizRow('biz-susp', { messaging_suspended: true, bot_code: 'SUSP' }));
    const { bot, cloud, sender } = makeBot(supabase);

    await bot.handleMessage(PHONE, 'SUSP', 'text');

    expect(texts(cloud)).toEqual([UNAVAILABLE]);
    expect(allSends(cloud)).toBe(1);
    expect((sender as any).boundBusinessId).toBe('');
    expect(supabase._inserted).toHaveLength(0); // no session for the suspended business
  });

  it('3. on the suspended business\'s own number nothing is sent (S-1 hard stop unchanged)', async () => {
    const supabase = createSupabase(null, bizRow('biz-susp', { messaging_suspended: true, bot_code: 'SUSP' }));
    const { bot, cloud, sender } = makeBot(supabase);

    await bot.handleMessage(PHONE, 'hi', 'text', 'pnid-dedicated', 'biz-susp');

    expect((sender as any).boundBusinessId).toBe('biz-susp');
    expect(allSends(cloud)).toBe(0);
    expect(supabase._inserted).toHaveLength(0);
  });

  it('3b. a phone the suspended business blocked still gets no reply', async () => {
    mockDetectionResult = { businessId: 'biz-susp', authority: 'exact' };
    const supabase = createSupabase(null, bizRow('biz-susp', { messaging_suspended: true, bot_code: 'SUSP', metadata: { blocked_phones: [PHONE] } }));
    const { bot, cloud } = makeBot(supabase);

    await bot.handleMessage(PHONE, 'SUSP', 'text');

    expect(allSends(cloud)).toBe(0);
  });

  it('4. an inactive business keeps its existing plain reply', async () => {
    mockDetectionResult = { businessId: 'biz-off', authority: 'exact' };
    const supabase = createSupabase(null, bizRow('biz-off', { status: 'inactive', bot_code: 'OFF' }));
    const { bot, cloud } = makeBot(supabase);

    await bot.handleMessage(PHONE, 'OFF', 'text');

    expect(texts(cloud)).toEqual([UNAVAILABLE]);
    expect(allSends(cloud)).toBe(1);
  });
});
