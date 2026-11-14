/**
 * Custom Flow BotService wiring tests (Issue #1013, Phase 1 re-review).
 *
 * The routing tests in lib/bot/custom-flow/__tests__/engine.test.ts prove
 * tryHandleCustomFlow itself yields on PIN steps, business codes and foreign
 * postbacks. This file proves the WIRING in BotService.handleMessage
 * (lib/bot/bot.service.ts, custom-flow branch ~1249): with an ACTIVE
 * custom session, each input still reaches its EXISTING handler — and the
 * test asserts the handler actually ran, not merely that the engine
 * returned "not handled":
 *
 *  1. a save_card_pin step reaches the card-PIN handler (it sends the
 *     "enter exactly 4 digits" prompt);
 *  2. a business code reaches the business-code path (the business actually
 *     switches to biz-B: new session + sender bound to biz-B);
 *  3. a foreign button postback ("I've Paid" / i_paid) reaches its existing
 *     handler (it sends the stale-payment "No recent payment found" reply).
 *  4. a "restart" closes the custom session and the next typed answer ("1")
 *     reaches the normal flow's handler (the scheduling date step runs) —
 *     reviewer B P1: without the close, the engine swallows the "1" and
 *     answers its own fallback instead.
 *  5. waitlist acceptance ("yes" to a spot opening up) reaches the booking
 *     flow while a custom session is active — the platform's internal 'Hi'
 *     re-entry closes the custom session instead of being swallowed by
 *     the engine ('Hi' fix: without the guard, the engine shows its own
 *     menu and the booking flow never starts).
 *
 * Follows the real-BotService harness of s1-botservice-real-handleMessage.test.ts:
 * real BotService + real custom-flow engine, mocked external boundaries, an
 * in-memory filter-aware Supabase mock seeded with an active custom session.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTestSupabase } from './helpers/mock-supabase';
import type { CustomFlowDefinition } from '@/lib/bot/custom-flow/types';

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
// Entitlement for the custom-flow engine goes through this mock: biz-A is
// Premium ('business' tier) with custom_flow enabled, so the engine reaches
// the business-code check for the right reason instead of yielding on
// entitlement. biz-B is a plain free business.
vi.mock('@/lib/capabilities/service', () => ({
  getConfiguredCapabilities: vi.fn().mockImplementation(async (_supabase: unknown, businessId: string) => ({
    ok: true,
    rows: businessId === 'biz-B'
      ? [{ capability: 'scheduling', is_enabled: true, sort_order: 0 }]
      : [
          { capability: 'custom_flow', is_enabled: true, sort_order: 0 },
          { capability: 'scheduling', is_enabled: true, sort_order: 1 },
        ],
  })),
  getCapabilityCustomLabels: vi.fn().mockResolvedValue({}),
  getEnabledCapabilities: vi.fn().mockResolvedValue([]),
  hasCapability: vi.fn().mockResolvedValue(false),
  setCapabilities: vi.fn().mockResolvedValue(undefined),
  getCapabilityConfig: vi.fn().mockResolvedValue(null),
  initCapabilities: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/bot/smart-intent', () => ({
  parseSmartIntent: vi.fn().mockResolvedValue(null),
  // Test 4 ("restart" then "1") reaches the capability-selection pre-fill,
  // which reads parsed.understood — production never returns null here, so
  // the mock returns the minimal "not understood" object instead.
  parseSmartIntentHybrid: vi.fn().mockResolvedValue({ understood: false, broadIntent: null, serviceKeywords: [], date: null, specificTime: null, timePreference: null, quantity: null, amount: null, variantKeywords: [] }),
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

let mockDetectionResult: { businessId: string | null; suggestions: Array<{ id: string; name: string; bot_code: string }>; authority?: 'exact' | 'suggestion' } = { businessId: null, suggestions: [] };
vi.mock('@/lib/bot/handlers/bot-code-detection', () => ({
  detectBotCode: vi.fn().mockResolvedValue(null),
  detectBotCodeWithSuggestions: vi.fn().mockImplementation(async () => mockDetectionResult),
  rankSuggestions: vi.fn().mockReturnValue([]),
  findReturningCustomerBusiness: vi.fn().mockResolvedValue(null),
  findReturningCustomerBusinesses: vi.fn().mockResolvedValue([]),
}));

const { BotService } = await import('@/lib/bot/bot.service');
const { MetaCloudSender } = await import('@/lib/channels/message-sender');

// ── Mocks ────────────────────────────────────────────────────────────

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

// ── Filter-aware in-memory Supabase ──────────────────────────────────

type Row = Record<string, any>;

class RoutingQuery {
  private filters: Array<(row: Row) => boolean> = [];
  private orderBy: { col: string; asc: boolean } | null = null;
  private limitN: number | null = null;
  private mode: 'single' | 'maybeSingle' | null = null;
  private selectCalled = false;

  constructor(
    private readonly db: Record<string, Row[]>,
    private readonly table: string,
    private readonly op: 'select' | 'insert' | 'update' | 'delete',
    private readonly insertRows: Row[] = [],
    private readonly patch: Row = {},
    private readonly recorder: { inserts: Array<{ table: string; row: Row }>; updates: Array<{ table: string; patch: Row }> },
  ) {}

  select(): this { this.selectCalled = true; return this; }
  eq(col: string, value: unknown): this { this.filters.push((r) => r[col] === value); return this; }
  neq(col: string, value: unknown): this { this.filters.push((r) => r[col] !== value); return this; }
  ilike(col: string, value: unknown): this {
    const v = String(value).toLowerCase();
    this.filters.push((r) => String(r[col] ?? '').toLowerCase() === v);
    return this;
  }
  like(col: string, value: unknown): this {
    const v = String(value).replace(/%/g, '');
    this.filters.push((r) => String(r[col] ?? '').includes(v));
    return this;
  }
  is(col: string, value: unknown): this { this.filters.push((r) => (value === null ? r[col] == null : r[col] === value)); return this; }
  in(col: string, values: unknown[]): this { this.filters.push((r) => (values as unknown[]).includes(r[col])); return this; }
  gte(col: string, value: unknown): this { this.filters.push((r) => r[col] >= (value as never)); return this; }
  lte(col: string, value: unknown): this { this.filters.push((r) => r[col] <= (value as never)); return this; }
  gt(col: string, value: unknown): this { this.filters.push((r) => r[col] > (value as never)); return this; }
  lt(col: string, value: unknown): this { this.filters.push((r) => r[col] < (value as never)); return this; }
  // .or() filter strings are not parsed: tables that need them are unseeded,
  // so returning all rows (none) is the same as applying the filter.
  or(): this { return this; }
  not(): this { return this; }
  contains(): this { return this; }
  containedBy(): this { return this; }
  textSearch(): this { return this; }
  filter(): this { return this; }
  match(): this { return this; }
  csv(): this { return this; }
  returns(): this { return this; }
  head(): this { return this; }
  range(): this { return this; }
  // Real supabase-js defaults ascending to true when opts is omitted
  // (scheduling.flow.ts calls .order(col) with one argument).
  order(col: string, opts?: { ascending: boolean }): this { this.orderBy = { col, asc: opts?.ascending ?? true }; return this; }
  limit(n: number): this { this.limitN = n; return this; }

  single(): Promise<{ data: Row | null; error: null }> { this.mode = 'single'; return Promise.resolve(this.execute() as { data: Row | null; error: null }); }
  maybeSingle(): Promise<{ data: Row | null; error: null }> { this.mode = 'maybeSingle'; return Promise.resolve(this.execute() as { data: Row | null; error: null }); }

  then(resolve: (v: { data: Row | Row[] | null; error: null }) => void, reject?: (e: unknown) => void): void {
    try { resolve(this.execute()); } catch (e) { if (reject) reject(e); }
  }
  catch(reject: (e: unknown) => void): void { try { this.execute(); } catch (e) { reject(e); } }

  private execute(): { data: Row | Row[] | null; error: null } {
    const table = this.db[this.table] ?? [];
    if (this.op === 'insert') {
      const inserted = this.insertRows.map((row, i) => ({
        id: row.id ?? `fake-${this.table}-${table.length + i + 1}`,
        ...row,
      }));
      table.push(...inserted);
      for (const row of inserted) this.recorder.inserts.push({ table: this.table, row: { ...row } });
      if (this.mode === 'single') return { data: inserted[0] ? { ...inserted[0] } : null, error: null };
      return { data: inserted.map((r) => ({ ...r })), error: null };
    }
    const matched = table.filter((row) => this.filters.every((f) => f(row)));
    if (this.op === 'update') {
      for (const row of matched) Object.assign(row, this.patch);
      this.recorder.updates.push({ table: this.table, patch: { ...this.patch } });
      return { data: this.selectCalled ? matched.map((r) => ({ id: r.id })) : null, error: null };
    }
    if (this.op === 'delete') {
      const remaining = table.filter((row) => !this.filters.every((f) => f(row)));
      this.db[this.table] = remaining;
      return { data: null, error: null };
    }
    let rows = [...matched];
    if (this.orderBy) {
      const { col, asc } = this.orderBy;
      rows.sort((a, b) => {
        if (a[col] < b[col]) return asc ? -1 : 1;
        if (a[col] > b[col]) return asc ? 1 : -1;
        return 0;
      });
    }
    if (this.limitN !== null) rows = rows.slice(0, this.limitN);
    if (this.mode === 'single' || this.mode === 'maybeSingle') {
      return { data: rows[0] ? { ...rows[0] } : null, error: null };
    }
    return { data: rows.map((r) => ({ ...r })), error: null };
  }
}

// ── Fixtures ─────────────────────────────────────────────────────────

const PHONE = '2348012345678';
const FUTURE = new Date(Date.now() + 3600000).toISOString();

const FESTIVAL_DEF: CustomFlowDefinition = {
  id: 'flow-1',
  name: 'AfroPlus Fest',
  status: 'published',
  greeting: 'Welcome to AfroPlus Fest! What do you need?',
  fallback_message: "Sorry, I didn't catch that. Please choose an option below.",
  entry_keyword: 'AFROFEST',
  start_node: 'main_menu',
  nodes: [
    {
      id: 'main_menu',
      type: 'menu',
      text: 'Welcome to AfroPlus Fest! What do you need?',
      options: [
        { label: 'Schedule', next: 'schedule_msg' },
        { label: 'Vendors', next: 'vendor_lookup' },
        { label: 'Latest News', next: 'news_msg' },
      ],
    },
    { id: 'schedule_msg', type: 'message', text: 'Day 1: Tems at 8pm on the Main Stage.', next: null },
    {
      id: 'vendor_lookup',
      type: 'lookup',
      table: 'vendors',
      search_fields: ['name', 'category'],
      prompt: 'Type a food or vendor name.',
      reply: '{{name}} — {{category}}. Find them at {{location}}.',
      no_match: 'No vendor matches "{{query}}". Try another name.',
      next: 'main_menu',
    },
    { id: 'news_msg', type: 'message', text: 'Gates open at 2pm. See you there!', next: 'main_menu' },
  ],
};

function seedDb(currentStep: string): { db: Record<string, Row[]>; botSession: Row } {
  const botSession: Row = {
    id: 'sess-1',
    business_id: 'biz-A',
    whatsapp_number: PHONE,
    user_id: null,
    current_step: currentStep,
    session_data: { capabilities: ['scheduling', 'custom_flow'] },
    is_active: true,
    expires_at: FUTURE,
    version: 0,
  };
  return {
    db: {
    businesses: [
      { id: 'biz-A', name: 'Biz A', slug: 'biz-a', category: 'other', flow_type: 'scheduling', subscription_tier: 'business', trial_ends_at: null, feature_trial_ends_at: null, bot_code: 'AFRO', status: 'active', country_code: 'NG', metadata: {}, is_whitelabel: false, payment_gateway: null, operating_hours: null },
      { id: 'biz-B', name: 'Spa B', slug: 'spa-b', category: 'spa', flow_type: 'scheduling', subscription_tier: 'free', trial_ends_at: null, feature_trial_ends_at: null, bot_code: 'SPAB', status: 'active', country_code: 'NG', metadata: {}, is_whitelabel: false, payment_gateway: null, operating_hours: null },
    ],
    bot_sessions: [botSession],
    whatsapp_channels: [
      { id: 'chan-1', phone_number_id: 'pnid-1', channel_type: 'shared', country_code: 'NG', business_id: null, is_active: true },
    ],
    custom_flows: [
      { id: 'flow-1', business_id: 'biz-A', name: 'AfroPlus Fest', greeting: 'Welcome to AfroPlus Fest! What do you need?', fallback_message: "Sorry, I didn't catch that. Please choose an option below.", entry_keyword: 'AFROFEST', status: 'published', published_version: 1, published_definition: FESTIVAL_DEF },
    ],
    custom_flow_sessions: [
      { id: 'cf-sess-1', business_id: 'biz-A', whatsapp_number: PHONE, flow_id: 'flow-1', flow_version: 1, current_node_id: 'main_menu', fields: {}, version: 0, is_active: true, expires_at: FUTURE },
    ],
    business_capabilities: [
      { business_id: 'biz-A', capability: 'custom_flow', is_enabled: true, sort_order: 0 },
      { business_id: 'biz-A', capability: 'scheduling', is_enabled: true, sort_order: 1 },
    ],
    waitlist_entries: [
      { id: 'wl-1', business_id: 'biz-A', customer_name: 'Test Customer', customer_phone: PHONE, service_id: 'svc-1', status: 'notified', notified_at: new Date(Date.now() - 60000).toISOString() },
    ],
    },
    botSession,
  };
}

function createRoutingSupabase(currentStep: string) {
  const { db: seed, botSession } = seedDb(currentStep);
  const db: Record<string, Row[]> = { ...seed };
  const recorder = { inserts: [] as Array<{ table: string; row: Row }>, updates: [] as Array<{ table: string; patch: Row }> };
  const supabase = {
    from: (table: string) => ({
      select: () => new RoutingQuery(db, table, 'select', [], {}, recorder),
      insert: (rows: Row | Row[]) => new RoutingQuery(db, table, 'insert', Array.isArray(rows) ? rows : [rows], {}, recorder),
      update: (patch: Row) => new RoutingQuery(db, table, 'update', [], patch, recorder),
      delete: () => new RoutingQuery(db, table, 'delete', [], {}, recorder),
      upsert: (rows: Row | Row[]) => new RoutingQuery(db, table, 'insert', Array.isArray(rows) ? rows : [rows], {}, recorder),
    }),
    rpc: vi.fn(async (fn: string) => {
      if (fn === 'get_shared_conversation') {
        return { data: { version: 0, business_id: 'biz-A', session: { ...botSession } }, error: null };
      }
      if (fn === 'update_session_cas') {
        return { data: { success: true, version: 1 }, error: null };
      }
      // Test 4 ("restart") reaches the shared-conversation selection after
      // the restart creates a fresh session; a truthy selection lets the
      // restart path continue to the capability menu.
      if (fn === 'select_shared_conversation') {
        return { data: { ok: true }, error: null };
      }
      return { data: null, error: null };
    }),
  };
  return { supabase: supabase as any, db, recorder, botSession };
}

function sentTexts(cloud: ReturnType<typeof createMockCloud>): string[] {
  return cloud.sendText.mock.calls.map((c: any[]) => String(c[0]?.text ?? ''));
}

describe('Custom Flow BotService wiring — active session yields to existing handlers (#1013)', () => {
  beforeEach(() => {
    suspendedBizIds = new Set();
    mockDetectionResult = { businessId: null, suggestions: [] };
    vi.clearAllMocks();
  });

  it('1. save_card_pin step: the PIN handler runs (asks for exactly 4 digits), the engine never consumes the PIN', async () => {
    const cloud = createMockCloud();
    const sender = new MetaCloudSender(cloud as any, createTestSupabase());
    const { supabase } = createRoutingSupabase('save_card_pin');
    const bot = new BotService(supabase, sender, createStandaloneService(), createMockIntelligence() as any);

    await bot.handleMessage(PHONE, '12', 'text', 'pnid-1');

    // The card-PIN handler actually ran: only it sends this prompt.
    expect(sentTexts(cloud).some((t) => t.includes('Please enter exactly *4 digits* for your Waaiio PIN'))).toBe(true);
    // The custom engine never answered: no flow menu went out.
    const bodies = [...cloud.sendButtons.mock.calls.map((c: any[]) => String(c[0]?.body ?? ''))];
    expect(bodies.some((b) => b.includes('AfroPlus Fest'))).toBe(false);
  });

  it('2. business code: the code path runs and the business actually switches to biz-B', async () => {
    mockDetectionResult = { businessId: 'biz-B', suggestions: [], authority: 'exact' };
    const cloud = createMockCloud();
    const sender = new MetaCloudSender(cloud as any, createTestSupabase());
    const { supabase, recorder } = createRoutingSupabase('select_capability');
    const bot = new BotService(supabase, sender, createStandaloneService(), createMockIntelligence() as any);

    await bot.handleMessage(PHONE, 'SPAB', 'text', 'pnid-1');

    // The business-code path actually ran: a new session was created for biz-B…
    const newSessions = recorder.inserts.filter((i) => i.table === 'bot_sessions' && i.row.business_id === 'biz-B');
    expect(newSessions.length).toBeGreaterThan(0);
    // …and the sender is now bound to biz-B, not biz-A.
    expect(sender.boundBusinessId).toBe('biz-B');
    // The custom engine never answered: no flow menu went out.
    const bodies = [...cloud.sendButtons.mock.calls.map((c: any[]) => String(c[0]?.body ?? ''))];
    expect(bodies.some((b) => b.includes('AfroPlus Fest'))).toBe(false);
  });

  it('3. foreign button postback (i_paid): the "I\'ve Paid" handler runs (no recent payment reply)', async () => {
    const cloud = createMockCloud();
    const sender = new MetaCloudSender(cloud as any, createTestSupabase());
    const { supabase } = createRoutingSupabase('select_capability');
    const bot = new BotService(supabase, sender, createStandaloneService(), createMockIntelligence() as any);

    await bot.handleMessage(PHONE, 'i_paid', 'button', 'pnid-1');

    // The stale-payment handler actually ran: only it sends this reply.
    expect(sentTexts(cloud).some((t) => t.includes('No recent payment found for this business.'))).toBe(true);
    // The custom engine never answered: no flow menu went out.
    const bodies = [...cloud.sendButtons.mock.calls.map((c: any[]) => String(c[0]?.body ?? ''))];
    expect(bodies.some((b) => b.includes('AfroPlus Fest'))).toBe(false);
  });

  it('4. restart: the custom session closes and the next typed answer reaches the normal flow handler', async () => {
    const cloud = createMockCloud();
    const sender = new MetaCloudSender(cloud as any, createTestSupabase());
    const { supabase, db } = createRoutingSupabase('select_capability');
    const bot = new BotService(supabase, sender, createStandaloneService(), createMockIntelligence() as any);

    // The customer types "restart" inside the active custom session.
    await bot.handleMessage(PHONE, 'restart', 'text', 'pnid-1');

    // Reviewer B P1: the restart must close the custom session…
    expect(db.custom_flow_sessions[0]?.is_active).toBe(false);
    // …and the restart handler itself ran: a fresh session started and the
    // normal bot asked for a language (no custom menu went out).
    const listBodies = cloud.sendList.mock.calls.map((c: any[]) => String(c[0]?.bodyText ?? ''));
    expect(listBodies.some((b) => b.includes('Please choose your preferred language'))).toBe(true);
    expect(listBodies.some((b) => b.includes('AfroPlus Fest'))).toBe(false);

    // …then the next typed answer reaches the normal flow's handler: "1"
    // selects the scheduling capability and its date step runs.
    await bot.handleMessage(PHONE, '1', 'text', 'pnid-1');
    const buttonBodies = cloud.sendButtons.mock.calls.map((c: any[]) => String(c[0]?.bodyText ?? ''));
    expect(buttonBodies.some((b) => b.includes('When would you like to book?'))).toBe(true);
    // The custom engine never answered the typed reply: no fallback text
    // and no custom menu went out.
    expect(sentTexts(cloud).some((t) => t.includes("Sorry, I didn't catch that"))).toBe(false);
    expect(buttonBodies.some((b) => b.includes('AfroPlus Fest'))).toBe(false);
  });

  it('5. waitlist acceptance: "yes" reaches the booking flow while a custom session is active', async () => {
    const cloud = createMockCloud();
    const sender = new MetaCloudSender(cloud as any, createTestSupabase());
    const { supabase, db } = createRoutingSupabase('select_capability');
    const bot = new BotService(supabase, sender, createStandaloneService(), createMockIntelligence() as any);

    // The customer accepts a waitlist spot ("yes") while a custom session
    // is active. The platform re-enters handleMessage with 'Hi' to start
    // the booking flow — that 'Hi' must reach the normal bot, not the
    // custom engine.
    await bot.handleMessage(PHONE, 'yes', 'text', 'pnid-1');

    // The waitlist handler itself ran: the entry was confirmed…
    expect(db.waitlist_entries[0]?.status).toBe('confirmed');
    // …and the 'Hi' re-entry closed the custom session…
    expect(db.custom_flow_sessions[0]?.is_active).toBe(false);
    // …and reached the normal bot: the capability menu went out (no
    // custom menu), so the customer can pick scheduling and book.
    const buttonBodies = cloud.sendButtons.mock.calls.map((c: any[]) => String(c[0]?.bodyText ?? ''));
    expect(buttonBodies.some((b) => b.includes('What would you like to do?'))).toBe(true);
    expect(buttonBodies.some((b) => b.includes('AfroPlus Fest'))).toBe(false);
    // The custom engine never answered: no fallback text went out.
    expect(sentTexts(cloud).some((t) => t.includes("Sorry, I didn't catch that"))).toBe(false);

    // …then the next typed answer reaches the normal flow's handler: "1"
    // selects the scheduling capability and its date step runs.
    await bot.handleMessage(PHONE, '1', 'text', 'pnid-1');
    const buttonBodies2 = cloud.sendButtons.mock.calls.map((c: any[]) => String(c[0]?.bodyText ?? ''));
    expect(buttonBodies2.some((b) => b.includes('When would you like to book?'))).toBe(true);
    expect(buttonBodies2.some((b) => b.includes('AfroPlus Fest'))).toBe(false);
  });
});
