/**
 * Owner bug 2026-11-18 (staging): a next-steps button tapped after the chat expired
 * ran a directory search on its own label ("No businesses found for 'menu'").
 *
 * Real BotService.handleMessage with mocked Supabase, bot-code detection and
 * marketplace search. No chat is open (expired sessions are not returned). Verifies:
 * 1. "View Options" that names its business goes back to that business's options.
 * 2. The same tap naming a business this customer never used is not trusted: picker.
 * 3. An old menu message (bare "menu" / pc_* ids, sent before this fix): picker.
 * 4. "Payment history" opens the payment history; "Search directory" opens the directory.
 * 5. With a chat still open, "pc_options:<id>" behaves exactly like "pc_options".
 * 6. With a directory search open (e.g. after the picker), the same taps are navigation too.
 * 7. On the shared number the re-entry binds the conversation to the named business.
 * No reply ever says "No businesses found".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTestSupabase } from './helpers/mock-supabase';

vi.mock('@/lib/countries', () => ({ loadCountries: vi.fn().mockResolvedValue([]), getCountry: vi.fn(), getCountryList: vi.fn().mockReturnValue([]), isValidCountryCode: vi.fn().mockReturnValue(true), getDialingCodeMap: vi.fn().mockReturnValue({}) }));
let searchRateLimited = false;
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimitAsync: vi.fn().mockImplementation(async (key: string) => (
    key.startsWith('dir-search:') && searchRateLimited ? { allowed: false, remaining: 0 } : { allowed: true, remaining: 10 })),
}));
vi.mock('@/lib/platformSettings', () => ({ loadPlatformSettings: vi.fn().mockResolvedValue({ bot_rate_limit_per_minute: 30, abuse_cooldown_soft_minutes: 5, abuse_cooldown_hard_minutes: 30, conversation_limits: { free: 200, growth: 1000, business: 5000 } }) }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('@/lib/bot/translate', () => ({ translateBotResponse: vi.fn(async (t: string) => t), detectLanguage: vi.fn(async () => 'en'), getLanguageName: vi.fn(() => 'English') }));
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
vi.mock('@/lib/channels/send-guard', () => ({
  assertMessagingAllowed: vi.fn().mockImplementation(async (bizId: string) => {
    if (!bizId) throw Object.assign(new Error('Messaging suspended for business unknown: missing_business_id'), { name: 'MessagingSuspendedError' });
  }),
}));

type Biz = { id: string; name: string; bot_code: string };
let mockDetectionResult: { businessId: string | null; suggestions?: Biz[]; authority?: string } = { businessId: null, suggestions: [] };
let mockReturningBusinesses: Biz[] = [];
vi.mock('@/lib/bot/handlers/bot-code-detection', () => ({
  detectBotCode: vi.fn().mockResolvedValue(null),
  detectBotCodeWithSuggestions: vi.fn().mockImplementation(async () => mockDetectionResult),
  rankSuggestions: vi.fn().mockReturnValue([]),
  findReturningCustomerBusinesses: vi.fn().mockImplementation(async () => mockReturningBusinesses),
}));

let mockSearchResults: Array<Record<string, unknown>> = [];
vi.mock('@/lib/marketplace/search', () => ({
  searchMarketplace: vi.fn().mockImplementation(async () => ({ ok: true, results: mockSearchResults, hasMore: false, suggestions: [] })),
  searchFuzzy: vi.fn().mockResolvedValue([]),
  loadDirectoryHiddenIds: vi.fn().mockResolvedValue([]),
  isBusinessDirectoryEligible: vi.fn().mockResolvedValue(true),
  formatMarketplaceResults: vi.fn().mockReturnValue(''),
}));

const { BotService } = await import('@/lib/bot/bot.service');
const { MetaCloudSender } = await import('@/lib/channels/message-sender');

const PHONE = '+234800';

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

/** Supabase mock with no open chat; captures inserted bot_sessions rows. */
function createSupabase(existingSession: Record<string, unknown> | null = null, business: Record<string, unknown> | null = null) {
  const inserted: Array<Record<string, any>> = [];
  let contextReads = 0;
  const supabase = {
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
    // The stored session answers the first context read; the re-entry for the picked business finds none.
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
  return supabase;
}

function makeBot(supabase: unknown) {
  const cloud = createMockCloud();
  const sender = new MetaCloudSender(cloud as any, createTestSupabase());
  const bot = new BotService(supabase as any, sender, createStandaloneService(), createMockIntelligence() as any);
  return { bot, cloud, sender };
}

/** Every outbound customer-visible body, in send order. */
function sentBodies(cloud: ReturnType<typeof createMockCloud>): Array<{ order: number; kind: string; body: string; ids: string[] }> {
  const out: Array<{ order: number; kind: string; body: string; ids: string[] }> = [];
  cloud.sendText.mock.calls.forEach((c: any[], i: number) => out.push({ order: cloud.sendText.mock.invocationCallOrder[i], kind: 'text', body: c[0]?.text || '', ids: [] }));
  cloud.sendButtons.mock.calls.forEach((c: any[], i: number) => out.push({ order: cloud.sendButtons.mock.invocationCallOrder[i], kind: 'buttons', body: c[0]?.bodyText || '', ids: (c[0]?.buttons || []).map((b: any) => b.id) }));
  cloud.sendList.mock.calls.forEach((c: any[], i: number) => out.push({ order: cloud.sendList.mock.invocationCallOrder[i], kind: 'list', body: c[0]?.bodyText || c[0]?.body || '', ids: [] }));
  return out.sort((a, b) => a.order - b.order);
}

const PAST_HEADER = "You've used these businesses before. Would you like to continue with one of them?";
const OLD_SPA = { id: 'biz-past-1', name: 'Old Spa', bot_code: 'OLDSPA' };

const handleTransactionDocument = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/bot/handlers/transaction-docs', () => ({ handleTransactionDocument: (...args: unknown[]) => handleTransactionDocument(...args) }));

const TESTBIZ_ID = '10000000-0000-4000-8000-000000000001';
const STRANGER_ID = '20000000-0000-4000-8000-000000000002';
const TESTBIZ = { id: TESTBIZ_ID, name: 'TestBiz', bot_code: 'TESTBIZ' };
const BALASHOP = { id: '30000000-0000-4000-8000-000000000003', name: 'BalaShop', bot_code: 'BALASHOP' };
const testBizRecord = { ...TESTBIZ, status: 'active', category: 'salon', subscription_tier: 'free', country_code: 'NG', metadata: {}, is_whitelabel: false };

function neverSearched(cloud: ReturnType<typeof createMockCloud>) {
  expect(sentBodies(cloud).some(s => s.body.includes('No businesses found'))).toBe(false);
  expect(sentBodies(cloud).some(s => s.body.includes('Something went wrong'))).toBe(false);
}

describe('Next-steps button tapped after the chat expired', () => {
  beforeEach(async () => {
    mockDetectionResult = { businessId: null, suggestions: [] };
    mockReturningBusinesses = [TESTBIZ, BALASHOP];
    mockSearchResults = [];
    searchRateLimited = false;
    vi.clearAllMocks();
    const { findReturningCustomerBusinesses, detectBotCodeWithSuggestions } = await import('@/lib/bot/handlers/bot-code-detection');
    vi.mocked(findReturningCustomerBusinesses).mockImplementation(async () => mockReturningBusinesses);
    vi.mocked(detectBotCodeWithSuggestions).mockImplementation(async () => mockDetectionResult as any);
  });

  it.each(['menu', 'pc_options'])('1. "View Options" (%s:<business>) goes back to that business, as a returning customer', async (id) => {
    const supabase = createSupabase(null, testBizRecord);
    const { bot, cloud, sender } = makeBot(supabase);
    const spy = vi.spyOn(bot, 'handleMessage');

    await bot.handleMessage(PHONE, `${id}:${TESTBIZ_ID}`, 'button');

    neverSearched(cloud);
    expect((sender as any).boundBusinessId).toBe(TESTBIZ_ID);
    // Re-entered through the business code with the past-business provenance (ACC-204).
    const reentry = spy.mock.calls.find(c => c[1] === 'TESTBIZ');
    expect(reentry?.[4]).toBe(TESTBIZ_ID);
    expect(reentry?.[7]).toBe('returning_customer');
    // The directory was never searched.
    const { searchMarketplace } = await import('@/lib/marketplace/search');
    expect(vi.mocked(searchMarketplace)).not.toHaveBeenCalled();
  });

  it('2. a button naming a business this customer never used is not trusted: past-business picker', async () => {
    const supabase = createSupabase(null, testBizRecord);
    const { bot, cloud, sender } = makeBot(supabase);

    await bot.handleMessage(PHONE, `menu:${STRANGER_ID}`, 'button');

    neverSearched(cloud);
    expect((sender as any).boundBusinessId).not.toBe(STRANGER_ID);
    const sent = sentBodies(cloud);
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toContain("You've used these businesses before");
    expect(sent[0].ids).toEqual([`dir_biz_${TESTBIZ_ID}`, `dir_biz_${BALASHOP.id}`, 'dir_find']);
  });

  it.each(['menu', 'pc_options', 'pc_done', 'pc_again', 'pc_history'])(
    '3. an old menu message (bare "%s", the Owner\'s 2:40pm message) goes straight to the past-business picker',
    async (id) => {
      const supabase = createSupabase();
      const { bot, cloud } = makeBot(supabase);

      await bot.handleMessage(PHONE, id, 'button');

      neverSearched(cloud);
      const sent = sentBodies(cloud);
      expect(sent).toHaveLength(1);
      expect(sent[0].body).toContain("You've used these businesses before");
      expect(sent[0].ids).toEqual([`dir_biz_${TESTBIZ_ID}`, `dir_biz_${BALASHOP.id}`, 'dir_find']);
      // The picker is saved so a tap on TestBiz / BalaShop enters it.
      const saved = supabase._inserted.find(r => r.current_step === 'directory_search');
      expect(saved?.session_data.suggestions).toEqual([TESTBIZ, BALASHOP]);
    },
  );

  it('3b. a new customer with an old "menu" button gets the directory welcome, not a search', async () => {
    mockReturningBusinesses = [];
    const supabase = createSupabase();
    const { bot, cloud } = makeBot(supabase);

    await bot.handleMessage(PHONE, 'menu', 'button');

    neverSearched(cloud);
    const sent = sentBodies(cloud);
    expect(sent).toHaveLength(1);
    expect(sent.some(s => s.body.includes("You've used these businesses before"))).toBe(false);
  });

  it('4a. "Payment history" opens the payment history, not a search', async () => {
    const supabase = createSupabase();
    const profileChain = supabase.from;
    supabase.from = vi.fn().mockImplementation((table: string) => {
      if (table === 'profiles') {
        const c: any = profileChain('other');
        c.maybeSingle = vi.fn().mockResolvedValue({ data: { id: 'profile-1' }, error: null });
        return c;
      }
      return profileChain(table);
    });
    const { bot, cloud } = makeBot(supabase);

    await bot.handleMessage(PHONE, 'history', 'button');

    neverSearched(cloud);
    expect(handleTransactionDocument).toHaveBeenCalledTimes(1);
    expect(handleTransactionDocument.mock.calls[0][4]).toBe('profile-1');
    expect(handleTransactionDocument.mock.calls[0][5]).toBe('history');
  });

  it('4b. "Search directory" opens the directory with the past businesses, not a search for "directory"', async () => {
    const supabase = createSupabase();
    const { bot, cloud } = makeBot(supabase);

    await bot.handleMessage(PHONE, 'directory', 'button');

    neverSearched(cloud);
    const sent = sentBodies(cloud);
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toContain("You've used these businesses before");
    expect(sent[0].ids).toContain('dir_find');
  });

  it('5. with the chat still open, "pc_options:<business>" shows the menu exactly like "pc_options"', async () => {
    const postCompletion = {
      id: 'sess-pc', business_id: TESTBIZ_ID, current_step: 'post_completion', is_active: true, version: 2,
      whatsapp_number: PHONE, expires_at: new Date(Date.now() + 3600000).toISOString(),
      session_data: { _post_completion_cap: 'payment' },
    };
    for (const id of ['pc_options', `pc_options:${TESTBIZ_ID}`]) {
      const supabase = createSupabase(postCompletion, testBizRecord);
      const { bot, cloud } = makeBot(supabase);

      await bot.handleMessage(PHONE, id, 'button');

      neverSearched(cloud);
      const cas = supabase.rpc.mock.calls.filter((c: any[]) => c[0] === 'update_session_cas');
      expect(cas.some((c: any[]) => c[1]?.p_session_id === 'sess-pc' && c[1]?.p_current_step === 'select_capability')).toBe(true);
    }
  });

  const dirSession = {
    id: 'sess-dir', business_id: null, current_step: 'directory_results', is_active: true, version: 5,
    whatsapp_number: PHONE, expires_at: new Date(Date.now() + 1800000).toISOString(),
    session_data: { _directory_mode: true, _directory_results: [], _directory_suggestions: [], suggestions: [TESTBIZ, BALASHOP] },
  };

  it.each(['pc_options', 'pc_again', 'pc_history', 'pc_done', 'menu', `pc_options:${STRANGER_ID}`])(
    '6a. directory search open: "%s" goes to the past-business picker, never a search',
    async (id) => {
      const supabase = createSupabase(dirSession);
      const { bot, cloud } = makeBot(supabase);

      await bot.handleMessage(PHONE, id, 'list');

      neverSearched(cloud);
      const { searchMarketplace } = await import('@/lib/marketplace/search');
      expect(vi.mocked(searchMarketplace)).not.toHaveBeenCalled();
      const sent = sentBodies(cloud);
      expect(sent).toHaveLength(1);
      expect(sent[0].body).toContain("You've used these businesses before");
    },
  );

  it('6b. directory search open: "pc_options:<business>" goes back to that business', async () => {
    const supabase = createSupabase(dirSession, testBizRecord);
    const { bot, cloud, sender } = makeBot(supabase);
    const spy = vi.spyOn(bot, 'handleMessage');

    await bot.handleMessage(PHONE, `pc_options:${TESTBIZ_ID}`, 'list');

    neverSearched(cloud);
    expect((sender as any).boundBusinessId).toBe(TESTBIZ_ID);
    const reentry = spy.mock.calls.find(c => c[1] === 'TESTBIZ');
    expect(reentry?.[7]).toBe('returning_customer');
  });

  it('7. shared number, no chat: the re-entry selects the named business for this conversation', async () => {
    const supabase = createSupabase(null, testBizRecord);
    const baseFrom = supabase.from;
    supabase.from = vi.fn().mockImplementation((table: string) => {
      if (table === 'whatsapp_channels') return makeChain({ id: 'ch-shared', channel_type: 'shared', country_code: 'NG' });
      const c: any = baseFrom(table);
      if (table === 'businesses') {
        // The shared number is no business's own number.
        const eq = c.eq;
        c.eq = vi.fn().mockImplementation((col: string, ...rest: unknown[]) => {
          if (col === 'whatsapp_phone_number_id') { c.single = vi.fn().mockResolvedValue({ data: null, error: null }); }
          return eq(col, ...rest);
        });
      }
      return c;
    });
    const baseRpc = supabase.rpc;
    supabase.rpc = vi.fn().mockImplementation((fn: string, args: unknown) => {
      if (fn === 'get_shared_conversation') return Promise.resolve({ data: { version: 4, business_id: null, session: null }, error: null });
      return baseRpc(fn, args);
    });
    // The real detector resolves the business code exactly, as for a typed code.
    const { detectBotCodeWithSuggestions } = await import('@/lib/bot/handlers/bot-code-detection');
    vi.mocked(detectBotCodeWithSuggestions).mockImplementation(async (_db: unknown, code: string) => (code === 'TESTBIZ'
      ? { businessId: TESTBIZ_ID, suggestions: [], authority: 'exact' } : mockDetectionResult) as any);
    const { bot, cloud } = makeBot(supabase);
    const spy = vi.spyOn(bot, 'handleMessage');

    await bot.handleMessage(PHONE, `menu:${TESTBIZ_ID}`, 'button', 'pnid-shared');

    neverSearched(cloud);
    const reentry = spy.mock.calls.find(c => c[1] === 'TESTBIZ');
    expect(reentry?.[4]).toBeUndefined(); // no business authority passed past the shared binding
    expect(reentry?.[7]).toBe('returning_customer');
    expect(reentry?.[8]).toEqual({ conversationVersion: 4, businessId: TESTBIZ_ID });
    const select = (supabase.rpc as any).mock.calls.find((c: any[]) => c[0] === 'select_shared_conversation');
    expect(select?.[1]).toMatchObject({ p_channel_id: 'ch-shared', p_expected_version: 4 });
  });
});
