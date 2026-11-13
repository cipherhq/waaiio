/**
 * Shared-number business search: results first, past businesses labelled as past
 * (Owner decision 2026-11-13).
 *
 * Real BotService.handleMessage with mocked Supabase, bot-code detection and
 * marketplace search. Verifies, for a customer with no open chat:
 * 1. Results found → results list first, then "You've used these businesses before…".
 * 2. No results → "No businesses found for 'X'…", then past businesses.
 * 3. Close name match → "No exact match for 'X'. This name is close:", then past businesses
 *    as a separate message; stored list keeps matches first.
 * 4. New customer → results only, no past-business message.
 * 5. Tapping a past business after a search enters exactly that business.
 * 6. A category/area search the close-name check also matched ("salon in Lekki")
 *    still gets labelled search results, not the close-name picker.
 * No message says "Did you mean".
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
const OLD_GYM = { id: 'biz-past-2', name: 'Old Gym', bot_code: 'OLDGYM' };

describe('Business search: results first, past businesses labelled as past', () => {
  beforeEach(async () => {
    mockDetectionResult = { businessId: null, suggestions: [] };
    mockReturningBusinesses = [];
    mockSearchResults = [];
    vi.clearAllMocks();
    const { findReturningCustomerBusinesses, detectBotCodeWithSuggestions } = await import('@/lib/bot/handlers/bot-code-detection');
    vi.mocked(findReturningCustomerBusinesses).mockImplementation(async () => mockReturningBusinesses);
    vi.mocked(detectBotCodeWithSuggestions).mockImplementation(async () => mockDetectionResult as any);
  });

  it('1. results found: results list first, then past businesses labelled as past (results not repeated)', async () => {
    mockReturningBusinesses = [OLD_SPA, OLD_GYM];
    mockSearchResults = [
      { businessId: 'biz-new-1', name: 'Lekki Glow', botCode: 'LEKKIGLOW', category: 'salon', city: 'Lagos' },
      { businessId: 'biz-past-2', name: 'Old Gym', botCode: 'OLDGYM', category: 'gym', city: 'Lagos' },
    ];
    const supabase = createSupabase();
    const { bot, cloud } = makeBot(supabase);

    await bot.handleMessage(PHONE, 'salon in Lekki', 'text');

    const sent = sentBodies(cloud);
    expect(sent.map(s => s.kind)).toEqual(['list', 'buttons']);
    expect(sent[0].body).toContain("Search results for 'salon in Lekki': I found 2 businesses. Tap below to choose one.");
    expect(sent[1].body).toBe(PAST_HEADER);
    // Old Gym was already a search result, so only Old Spa is offered as past
    expect(sent[1].ids).toEqual(['biz_0']);
    expect(sent.some(s => s.body.includes('Did you mean'))).toBe(false);

    const dirSession = supabase._inserted.find(r => r.current_step === 'directory_results');
    expect(dirSession?.session_data.suggestions).toEqual([OLD_SPA]);
    expect(dirSession?.session_data._directory_results).toHaveLength(2);
  });

  it('2. no results: plain "No businesses found" first, then past businesses', async () => {
    mockReturningBusinesses = [OLD_SPA];
    const supabase = createSupabase();
    const { bot, cloud } = makeBot(supabase);

    await bot.handleMessage(PHONE, 'barbers in Ikoyi', 'text');

    const sent = sentBodies(cloud);
    expect(sent.map(s => s.kind)).toEqual(['text', 'buttons']);
    expect(sent[0].body).toBe("No businesses found for 'barbers in Ikoyi'. Try a different name, area or category, or browse waaiio.com/directory.");
    expect(sent[1].body).toBe(PAST_HEADER);
    expect(sent[1].ids).toEqual(['biz_0']);
  });

  it('3. close name match: labelled close match first, past businesses in a separate message', async () => {
    const close = { id: 'biz-close', name: 'Glow Studio', bot_code: 'GLOW' };
    mockDetectionResult = { businessId: null, suggestions: [close], authority: 'suggestion' };
    mockReturningBusinesses = [OLD_SPA, close];
    const supabase = createSupabase();
    const { bot, cloud } = makeBot(supabase);

    await bot.handleMessage(PHONE, 'Glo Studo', 'text');

    const sent = sentBodies(cloud);
    expect(sent.map(s => s.kind)).toEqual(['buttons', 'buttons']);
    expect(sent[0].body).toBe("No exact match for 'Glo Studo'. This name is close:");
    expect(sent[0].ids).toEqual(['biz_0']);
    expect(sent[1].body).toBe(PAST_HEADER);
    // Glow Studio is not repeated; Old Spa follows the match in the stored list
    expect(sent[1].ids).toEqual(['biz_1']);
    expect(sent.some(s => s.body.includes('Did you mean'))).toBe(false);

    const picker = supabase._inserted.find(r => r.current_step === 'select_business_suggestion');
    expect(picker?.session_data.suggestions).toEqual([close, OLD_SPA]);
    expect(picker?.session_data._search_match_count).toBe(1);
  });

  it('4. new customer: results only, no past-business message', async () => {
    mockSearchResults = [{ businessId: 'biz-new-1', name: 'Lekki Glow', botCode: 'LEKKIGLOW', category: 'salon', city: 'Lagos' }];
    const supabase = createSupabase();
    const { bot, cloud } = makeBot(supabase);

    await bot.handleMessage(PHONE, 'salon in Lekki', 'text');

    const sent = sentBodies(cloud);
    expect(sent.map(s => s.kind)).toEqual(['list']);
    expect(sent[0].body).toContain("Search results for 'salon in Lekki': I found 1 business. Tap below to choose one.");
    expect(sent.some(s => s.body.includes(PAST_HEADER))).toBe(false);
  });

  it('5. tapping the second past business after a search enters exactly that business', async () => {
    const dirSession = {
      id: 'sess-dir', business_id: null, current_step: 'directory_results', is_active: true, version: 0,
      whatsapp_number: PHONE, expires_at: new Date(Date.now() + 1800000).toISOString(),
      session_data: { _directory_mode: true, _directory_results: [], _directory_suggestions: [], suggestions: [OLD_SPA, OLD_GYM] },
    };
    const oldGym = { id: 'biz-past-2', name: 'Old Gym', status: 'active', category: 'gym', subscription_tier: 'free', country_code: 'NG', metadata: {}, bot_code: 'OLDGYM', is_whitelabel: false };
    // Detection never binds here: the business must come from the tapped button.
    mockDetectionResult = { businessId: null, suggestions: [], authority: 'suggestion' };
    const supabase = createSupabase(dirSession, oldGym);
    const { bot, cloud, sender } = makeBot(supabase);

    await bot.handleMessage(PHONE, 'biz_1', 'text');

    expect((sender as any).boundBusinessId).toBe('biz-past-2');
    // The tap was resolved from the stored session, not searched as text
    expect(sentBodies(cloud).some(s => s.body.includes('biz_1'))).toBe(false);
    const fallback = cloud.sendText.mock.calls.filter((c: any[]) => c[0]?.text?.includes('Something went wrong'));
    expect(fallback).toHaveLength(0);
  });

  it.each([
    ['category match', { businessId: null, suggestions: [{ id: 'biz-abuja', name: 'Abuja Hair Palace', bot_code: 'AHP' }], isCategory: true, authority: 'suggestion' }],
    ['name-pool match', { businessId: null, suggestions: [{ id: 'biz-abuja', name: 'Abuja Hair Palace', bot_code: 'AHP' }], authority: 'suggestion' }],
  ])('6. "salon in Lekki" with a %s from the close-name check still gets labelled search results', async (_label, detection) => {
    mockDetectionResult = detection as typeof mockDetectionResult;
    mockReturningBusinesses = [OLD_SPA];
    mockSearchResults = [{ businessId: 'biz-new-1', name: 'Lekki Glow', botCode: 'LEKKIGLOW', category: 'salon', city: 'Lagos' }];
    const supabase = createSupabase();
    const { bot, cloud } = makeBot(supabase);

    await bot.handleMessage(PHONE, 'salon in Lekki', 'text');

    const sent = sentBodies(cloud);
    expect(sent.map(s => s.kind)).toEqual(['list', 'buttons']);
    expect(sent[0].body).toContain("Search results for 'salon in Lekki': I found 1 business. Tap below to choose one.");
    expect(sent[1].body).toBe(PAST_HEADER);
    expect(sent.some(s => s.body.includes('No exact match') || s.body.includes('might help'))).toBe(false);
    expect(supabase._inserted.some(r => r.current_step === 'select_business_suggestion')).toBe(false);
  });
});
