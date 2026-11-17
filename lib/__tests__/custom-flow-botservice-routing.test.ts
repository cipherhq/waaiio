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
 *  6. waitlist acceptance leaves usage counting unchanged — the customer's
 *     "yes" is still counted as an inbound message / new conversation
 *     ('Hi' fix rework: the re-entry carries a separate restart flag, not
 *     provenance, so the no-provenance usage path runs exactly as on main).
 *
 * Follows the real-BotService harness of s1-botservice-real-handleMessage.test.ts:
 * real BotService + real custom-flow engine, mocked external boundaries, an
 * in-memory filter-aware Supabase mock seeded with an active custom session.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTestSupabase } from './helpers/mock-supabase';
import type { CustomFlowDefinition } from '@/lib/bot/custom-flow/types';

vi.mock('@/lib/countries', () => ({ loadCountries: vi.fn().mockResolvedValue([]), getCountry: vi.fn(), getCountryList: vi.fn().mockReturnValue([]), isValidCountryCode: vi.fn().mockReturnValue(true), getDialingCodeMap: vi.fn().mockReturnValue({}) }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimitAsync: vi.fn().mockResolvedValue({ allowed: true, remaining: 10 }) }));
vi.mock('@/lib/platformSettings', () => ({ loadPlatformSettings: vi.fn().mockResolvedValue({ bot_rate_limit_per_minute: 30, abuse_cooldown_soft_minutes: 5, abuse_cooldown_hard_minutes: 30, conversation_limits: { free: 200, growth: 1000, business: 5000 } }) }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('@/lib/bot/translate', () => ({ translateBotResponse: vi.fn(async (t: string) => t), detectLanguage: vi.fn(async () => 'en'), getLanguageName: vi.fn(() => 'English') }));
vi.mock('@/lib/bot/handlers/global-queries', () => ({ handleGlobalQuery: vi.fn(async (opts: { session: unknown }) => ({ handled: false, session: opts.session })), isOrdersQuery: vi.fn(() => false) }));
vi.mock('@/lib/bot/handlers/escape-hatches', () => ({ HOME_PATTERN: /^(home|directory|search)$/i, handleEscapeHatch: vi.fn().mockResolvedValue({ handled: false }) }));
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
          // #1086 handoff tests turn on extra capabilities for biz-A only.
          ...extraCapsA.map((capability, i) => ({ capability, is_enabled: true, sort_order: 2 + i })),
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
let extraCapsA: string[] = [];
vi.mock('@/lib/channels/send-guard', () => ({
  assertMessagingAllowed: vi.fn().mockImplementation(async (bizId: string) => {
    if (!bizId) throw Object.assign(new Error('Messaging suspended for business unknown: missing_business_id'), { name: 'MessagingSuspendedError' });
    if (suspendedBizIds.has(bizId)) throw Object.assign(new Error(`Messaging suspended for business ${bizId}: suspended`), { name: 'MessagingSuspendedError' });
  }),
}));

let mockDetectionResult: { businessId: string | null; suggestions: Array<{ id: string; name: string; bot_code: string }>; authority?: 'exact' | 'suggestion'; deepLinkCapability?: string } = { businessId: null, suggestions: [] };
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

  private execute(): { data: Row | Row[] | null; error: null; count?: number } {
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
    return { data: rows.map((r) => ({ ...r })), error: null, count: rows.length };
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
    // …and reached the normal bot: as on main (no provenance), a
    // first-time customer at a multi-language business gets the language
    // picker first — not the capability menu, and no custom menu.
    const listBodies = cloud.sendList.mock.calls.map((c: any[]) => String(c[0]?.bodyText ?? ''));
    expect(listBodies.some((b) => b.includes('Please choose your preferred language'))).toBe(true);
    expect(listBodies.some((b) => b.includes('AfroPlus Fest'))).toBe(false);
    // The custom engine never answered: no fallback text went out.
    expect(sentTexts(cloud).some((t) => t.includes("Sorry, I didn't catch that"))).toBe(false);

    // …then the next typed answer reaches the normal flow's handler: "1"
    // selects the scheduling capability and its date step runs.
    await bot.handleMessage(PHONE, '1', 'text', 'pnid-1');
    const buttonBodies2 = cloud.sendButtons.mock.calls.map((c: any[]) => String(c[0]?.bodyText ?? ''));
    expect(buttonBodies2.some((b) => b.includes('When would you like to book?'))).toBe(true);
    expect(buttonBodies2.some((b) => b.includes('AfroPlus Fest'))).toBe(false);
  });

  it('6. waitlist acceptance: usage counting is unchanged (the "yes" is still counted as an inbound message / new conversation)', async () => {
    const cloud = createMockCloud();
    const sender = new MetaCloudSender(cloud as any, createTestSupabase());
    const { supabase } = createRoutingSupabase('select_capability');
    const bot = new BotService(supabase, sender, createStandaloneService(), createMockIntelligence() as any);

    // The customer accepts a waitlist spot ("yes") while a custom session
    // is active. The 'Hi' re-entry carries a separate restart flag, not
    // provenance — so the no-provenance usage path must run exactly as on
    // main: the "yes" counts as one inbound message / new conversation.
    await bot.handleMessage(PHONE, 'yes', 'text', 'pnid-1');
    // trackInboundMessage is fire-and-forget: let its rpc resolve.
    await new Promise((r) => setTimeout(r, 0));

    const usageCalls = (supabase.rpc.mock.calls as any[]).filter(
      (c) => c[0] === 'increment_message_usage' && c[1]?.p_direction === 'inbound',
    );
    expect(usageCalls).toHaveLength(1);
    expect(usageCalls[0][1]).toEqual({
      p_business_id: 'biz-A',
      p_direction: 'inbound',
      p_is_new_conversation: true,
    });
  });
});

describe('custom-flow business menu: actual BotService and executor', () => {
  const flowId = '11111111-1111-4111-8111-111111111111';
  async function menuFixture(provenance?: string) {
    const f = createRoutingSupabase('select_capability');
    f.db.custom_flow_sessions = [];
    f.db.custom_flow_logs = [];
    f.db.custom_flows[0].id = flowId;
    f.db.custom_flows[0].entry_keyword = null;
    f.db.custom_flows[0].published_definition = { ...FESTIVAL_DEF, id: flowId, entry_keyword: null };
    if (provenance) f.botSession.session_data.biz_resolution = provenance;
    const { rememberFlowMenu } = await import('@/lib/bot/custom-flow/menu');
    rememberFlowMenu(f.botSession as any, 'biz-A', ['cap_scheduling', `cf-start:${flowId}`]);
    f.supabase.rpc.mockImplementation(async (name: string, args: any) => {
      if (name === 'get_shared_conversation') return { data: { version: 0, business_id: 'biz-A', session: structuredClone(f.botSession) }, error: null };
      if (name === 'update_session_cas') {
        if (args.p_expected_version !== f.botSession.version) return { data: { success: false, reason: 'version_conflict' }, error: null };
        Object.assign(f.botSession, { version: f.botSession.version + 1, current_step: args.p_current_step, session_data: structuredClone(args.p_session_data) });
        return { data: { success: true, version: f.botSession.version }, error: null };
      }
      if (name === 'deactivate_session_atomic') f.botSession.is_active = false;
      return { data: null, error: null };
    });
    const cloud = createMockCloud();
    const sender = new MetaCloudSender(cloud as any, createTestSupabase());
    const bot = new BotService(f.supabase, sender, createStandaloneService(), createMockIntelligence() as any);
    return { ...f, cloud, sender, bot };
  }
  beforeEach(() => { suspendedBizIds = new Set(); mockDetectionResult = { businessId: null, suggestions: [] }; vi.clearAllMocks(); });
  it.each(['button', 'text'])('starts a displayed blank-keyword flow by %s without completing the normal executor', async type => {
    const f = await menuFixture();
    await f.bot.handleMessage(PHONE, type === 'button' ? `cf-start:${flowId}` : '2', type, 'pnid-1');
    expect(f.db.custom_flow_sessions).toHaveLength(1);
    expect(f.db.custom_flow_sessions[0].flow_id).toBe(flowId);
    expect(f.botSession.current_step).toBe('select_capability');
    expect(f.botSession.session_data._custom_flow_menu).toBeUndefined();
    expect(f.cloud.sendButtons.mock.calls.some((c: any) => c[0].bodyText.includes('AfroPlus Fest'))).toBe(true);
    expect(f.supabase.rpc.mock.calls.filter((c: any) => c[0] === 'increment_message_usage' && c[1]?.p_direction === 'inbound')).toHaveLength(1);
  });
  it.each([undefined, 'shared_session'])( 'ordinary numeric selection with provenance %s is counted once without inventing provenance', async provenance => {
    const f = await menuFixture(provenance);
    const spy = vi.spyOn(f.bot, 'handleMessage');
    await f.bot.handleMessage(PHONE, '1', 'text', 'pnid-1', undefined, undefined, 'inbound-1');
    expect(spy.mock.calls).toHaveLength(1);
    expect(f.botSession.session_data.biz_resolution).toBe(provenance);
    expect(f.supabase.rpc.mock.calls.filter((c: any) => c[0] === 'increment_message_usage' && c[1]?.p_direction === 'inbound')).toHaveLength(1);
    expect(f.cloud.sendButtons.mock.calls.some((c: any) => c[0].bodyText.includes('When would you like to book?'))).toBe(true);
    expect(f.db.custom_flow_sessions).toHaveLength(0);
  });
  it.each([undefined, 'shared_session'])('numeric directory entry with provenance %s reaches existing directory handler', async provenance => {
    const f = await menuFixture(provenance);
    (f.botSession.session_data._custom_flow_menu as any).postbacks[0] = 'nav_directory';
    const spy = vi.spyOn(f.bot, 'handleMessage');
    await f.bot.handleMessage(PHONE, '1', 'text', 'pnid-1');
    expect(spy.mock.calls).toHaveLength(2);
    expect(spy.mock.calls[1][2]).toBe('text');
    expect(spy.mock.calls[1][7]).toBe(provenance);
    expect(spy.mock.calls[1][9]).toBeUndefined();
    expect(f.recorder.inserts.some(i => i.table === 'bot_sessions' && i.row.current_step === 'directory_search' && i.row.business_id === null)).toBe(true);
    expect(f.db.custom_flow_sessions).toHaveLength(0);
    expect(f.supabase.rpc.mock.calls.filter((c: any) => c[0] === 'increment_message_usage' && c[1]?.p_direction === 'inbound')).toHaveLength(1);
  });
  it.each([undefined, 'shared_session'])('numeric opt-in with provenance %s cannot become consent', async provenance => {
    const f = await menuFixture(provenance);
    (f.botSession.session_data._custom_flow_menu as any).postbacks[0] = 'updates_yes:welcome:11111111-1111-4111-8111-111111111111';
    await f.bot.handleMessage(PHONE, '1', 'text', 'pnid-1');
    expect(f.recorder.inserts.some(i => i.table === 'customer_consents' || i.table === 'launch_subscribers')).toBe(false);
    expect(sentTexts(f.cloud).some(t => t.includes('That option is not available right now.'))).toBe(true);
    expect(f.db.custom_flow_sessions).toHaveLength(0);
    expect(f.supabase.rpc.mock.calls.filter((c: any) => c[0] === 'increment_message_usage' && c[1]?.p_direction === 'inbound')).toHaveLength(1);
  });
  it('persists the displayed snapshot through the real executor before sending', async () => {
    const f = await menuFixture();
    delete f.botSession.session_data._custom_flow_menu;
    f.sender.bindBusiness('biz-A');
    await (f.bot as any).flowExecutor.execute(PHONE, '', f.botSession, f.db.businesses[0]);
    const snapshot = f.botSession.session_data._custom_flow_menu;
    expect(snapshot).toMatchObject({ sessionId: f.botSession.id, businessId: 'biz-A' });
    expect(snapshot.postbacks).toContain(`cf-start:${flowId}`);
    const saved = f.supabase.rpc.mock.calls.findIndex((c: any) => c[0] === 'update_session_cas' && c[1].p_session_data._custom_flow_menu);
    expect(saved).toBeGreaterThanOrEqual(0);
    const sends = [...f.cloud.sendButtons.mock.invocationCallOrder, ...f.cloud.sendList.mock.invocationCallOrder, ...f.cloud.sendText.mock.invocationCallOrder];
    expect(sends.length).toBeGreaterThan(0);
    expect(f.supabase.rpc.mock.invocationCallOrder[saved]).toBeLessThan(Math.min(...sends));
  });
  it('does not send the prompt if executor snapshot persistence loses CAS', async () => {
    const f = await menuFixture();
    f.supabase.rpc.mockResolvedValue({ data: { success: false, reason: 'version_conflict' }, error: null });
    await (f.bot as any).flowExecutor.execute(PHONE, '', f.botSession, f.db.businesses[0]);
    expect(f.cloud.sendButtons).not.toHaveBeenCalled();
    expect(f.cloud.sendList).not.toHaveBeenCalled();
  });
  it('keeps the next numeric reply in the active custom engine, not the normal menu', async () => {
    const f = await menuFixture();
    await f.bot.handleMessage(PHONE, `cf-start:${flowId}`, 'button', 'pnid-1');
    await f.bot.handleMessage(PHONE, '1', 'text', 'pnid-1');
    expect(sentTexts(f.cloud)).toContain('Day 1: Tems at 8pm on the Main Stage.');
    expect(f.cloud.sendButtons.mock.calls.some((c: any) => c[0].bodyText.includes('When would you like to book?'))).toBe(false);
  });
  it('a failed prompt send does not start a custom flow or bypass snapshot persistence', async () => {
    const f = await menuFixture();
    f.sender.bindBusiness('biz-A');
    f.cloud.sendButtons.mockRejectedValueOnce(new Error('Cloud API error: 400 (simulated rejection)'));
    await (f.bot as any).flowExecutor.execute(PHONE, '', f.botSession, f.db.businesses[0]);
    expect(f.botSession.session_data._custom_flow_menu).toBeDefined();
    expect(f.cloud.sendButtons).toHaveBeenCalledOnce();
    expect(f.db.custom_flow_sessions).toHaveLength(0);
  });

  it('an ordinary numeric choice cannot become a custom keyword, while direct keyword entry still works', async () => {
    const f = await menuFixture();
    f.db.custom_flows[0].entry_keyword = 'CAP_SCHEDULING';
    await f.bot.handleMessage(PHONE, '1', 'text', 'pnid-1');
    expect(f.db.custom_flow_sessions).toHaveLength(0);
    expect(f.cloud.sendButtons.mock.calls.some((c: any) => c[0].bodyText.includes('When would you like to book?'))).toBe(true);
    const direct = await menuFixture();
    direct.db.custom_flows[0].entry_keyword = 'CAP_SCHEDULING';
    await direct.bot.handleMessage(PHONE, 'CAP_SCHEDULING', 'text', 'pnid-1');
    expect(direct.db.custom_flow_sessions).toHaveLength(1);
  });

});


describe('first contact: published custom-flow menu entry', () => {
  const flowId = '11111111-1111-4111-8111-111111111111';
  let restoreCapabilities: (() => void) | undefined;
  let restoreCanonical: (() => void) | undefined;
  beforeEach(() => { suspendedBizIds = new Set(); mockDetectionResult = { businessId: null, suggestions: [] }; vi.clearAllMocks(); });
  afterEach(() => { restoreCapabilities?.(); restoreCanonical?.(); });

  async function firstContact(capabilities = ['custom_flow', 'scheduling']) {
    const f = createRoutingSupabase('select_capability');
    f.db.bot_sessions = [];
    f.db.profiles = [];
    f.db.customer_profiles = [];
    f.db.custom_flow_sessions = [];
    f.db.custom_flow_logs = [];
    f.db.whatsapp_channels[0] = { ...f.db.whatsapp_channels[0], channel_type: 'dedicated', business_id: 'biz-A' };
    f.db.ai_conversation_config = [{ business_id: 'biz-A', enabled_languages: ['en'] }];
    f.db.business_capabilities = capabilities.map((capability, sort_order) => ({ business_id: 'biz-A', capability, is_enabled: true, sort_order }));
    f.db.services = ['A', 'B'].map(id => ({ id: `service-${id}`, business_id: 'biz-A', name: `Service ${id}`, is_active: true, service_type: 'booking', deleted_at: null, price: 1000, duration_minutes: 60 }));
    f.db.custom_flows[0] = { ...f.db.custom_flows[0], id: flowId, entry_keyword: null, published_definition: { ...FESTIVAL_DEF, id: flowId, entry_keyword: null } };
    const { getConfiguredCapabilities } = await import('@/lib/capabilities/service');
    const original = vi.mocked(getConfiguredCapabilities).getMockImplementation()!;
    vi.mocked(getConfiguredCapabilities).mockImplementation(async (_db, businessId) => ({ ok: true, rows: f.db.business_capabilities.filter(row => row.business_id === businessId).map(({ capability, is_enabled, sort_order }) => ({ capability, is_enabled, sort_order })) }));
    restoreCapabilities = () => vi.mocked(getConfiguredCapabilities).mockImplementation(original);
    f.supabase.rpc.mockImplementation(async (name: string, args: any) => {
      if (name === 'get_bot_context') {
        const session = f.db.bot_sessions.find(row => row.is_active && row.business_id === args.p_business_id);
        return { data: { has_session: !!session, session: session ? structuredClone(session) : null }, error: null };
      }
      if (name === 'deactivate_session_atomic') {
        const session = f.db.bot_sessions.find(row => row.id === args.p_session_id);
        if (session) session.is_active = false;
      }
      if (name === 'update_session_cas') {
        const session = f.db.bot_sessions.find(row => row.id === args.p_session_id);
        if (!session || (session.version ?? 0) !== (args.p_expected_version ?? 0)) return { data: { success: false, reason: 'version_conflict' }, error: null };
        Object.assign(session, { version: (session.version ?? 0) + 1, current_step: args.p_current_step, session_data: structuredClone(args.p_session_data) });
        return { data: { success: true, version: session.version }, error: null };
      }
      return { data: null, error: null };
    });
    const cloud = createMockCloud();
    const sender = new MetaCloudSender(cloud as any, createTestSupabase());
    const bot = new BotService(f.supabase, sender, createStandaloneService(), createMockIntelligence() as any);
    return { ...f, cloud, bot };
  }
  function postbacks(cloud: ReturnType<typeof createMockCloud>): string[] {
    return [
      ...cloud.sendButtons.mock.calls.flatMap((call: any) => call[0].buttons.map((button: any) => button.id)),
      ...cloud.sendList.mock.calls.flatMap((call: any) => call[0].sections.flatMap((section: any) => section.rows.map((row: any) => row.id))),
    ];
  }

  it.each([['custom only', ['custom_flow']], ['ordinary plus custom', ['scheduling', 'custom_flow']]])('Hi on a dedicated number exposes %s before any session/profile exists', async (_label, capabilities) => {
    const f = await firstContact(capabilities as string[]);
    expect(f.db.bot_sessions).toHaveLength(0);
    expect(f.db.profiles).toHaveLength(0);
    expect(f.db.customer_profiles).toHaveLength(0);
    await f.bot.handleMessage(PHONE, 'Hi', 'text', 'pnid-1', 'biz-A');
    const created = f.recorder.inserts.find(item => item.table === 'bot_sessions')!.row;
    expect(created.current_step).toBe('select_capability');
    // Premium businesses keep the first-contact language choice before the menu.
    expect(postbacks(f.cloud)).toContain('lang_pick_en');
    await f.bot.handleMessage(PHONE, 'lang_pick_en', 'button', 'pnid-1', 'biz-A');
    const session = f.db.bot_sessions.find(row => row.is_active)!;
    expect(session.current_step).toBe('select_capability');
    expect(session.session_data._custom_flow_menu).toMatchObject({ sessionId: session.id, businessId: 'biz-A' });
    expect(session.session_data._custom_flow_menu.postbacks).toContain(`cf-start:${flowId}`);
    expect(postbacks(f.cloud)).toContain(`cf-start:${flowId}`);
    if (capabilities.includes('scheduling')) expect(postbacks(f.cloud)).toContain('cap_scheduling');
    expect(f.db.custom_flow_sessions).toHaveLength(0);
  });

  it.each(['missing', 'draft', 'disabled', 'denied', 'invalid'])('keeps the ordinary initial route when custom flow is %s', async state => {
    const f = await firstContact();
    if (state === 'missing') f.db.custom_flows = [];
    if (state === 'draft') f.db.custom_flows[0].status = 'draft';
    if (state === 'disabled') f.db.business_capabilities[0].is_enabled = false;
    if (state === 'denied') f.db.businesses[0].subscription_tier = 'free';
    if (state === 'invalid') f.db.custom_flows[0].published_definition = {};
    await f.bot.handleMessage(PHONE, 'Hi', 'text', 'pnid-1', 'biz-A');
    expect(f.recorder.inserts.find(item => item.table === 'bot_sessions')!.row.current_step).toBe('select_service');
    expect(f.db.bot_sessions[0].session_data._custom_flow_menu).toBeUndefined();
    expect(postbacks(f.cloud)).not.toContain(`cf-start:${flowId}`);
  });

  it('preserves explicit canonical scheduling on a dedicated number with published custom choices', async () => {
    const f = await firstContact();
    const canonical = await import('@/lib/bot/canonical-understanding');
    const spy = vi.spyOn(canonical, 'understandCanonicalMessage').mockResolvedValue({ broadIntent: 'booking', semanticFamily: 'service_time_booking', requestedAction: 'create_new', confidence: 1, language: 'en', entities: { serviceKeywords: [], date: null, specificTime: null, timePreference: null, quantity: null, amount: null, variantKeywords: [] }, source: 'regex', languageEntitlement: { allowedLanguages: ['en'], llmAllowed: false, translationAllowed: false }, languageBlocked: false });
    restoreCanonical = () => spy.mockRestore();
    await f.bot.handleMessage(PHONE, 'book', 'text', 'pnid-1', 'biz-A');
    expect(spy).toHaveBeenCalledOnce();
    expect(f.recorder.inserts.find(item => item.table === 'bot_sessions')!.row.current_step).toBe('select_service');
    expect(f.db.bot_sessions[0].session_data.active_capability).toBe('scheduling');
    expect(postbacks(f.cloud)).not.toContain(`cf-start:${flowId}`);
  });

  it('preserves an explicit scheduling deep link with published custom choices', async () => {
    const f = await firstContact();
    const canonical = await import('@/lib/bot/canonical-understanding');
    const spy = vi.spyOn(canonical, 'understandCanonicalMessage').mockResolvedValue({ broadIntent: null, semanticFamily: null, requestedAction: null, confidence: 0, language: 'en', entities: { serviceKeywords: [], date: null, specificTime: null, timePreference: null, quantity: null, amount: null, variantKeywords: [] }, source: 'regex', languageEntitlement: { allowedLanguages: ['en'], llmAllowed: false, translationAllowed: false }, languageBlocked: false });
    restoreCanonical = () => spy.mockRestore();
    mockDetectionResult = { businessId: 'biz-A', suggestions: [], authority: 'exact', deepLinkCapability: 'scheduling' };
    await f.bot.handleMessage(PHONE, 'AFRO-scheduling', 'text');
    expect(f.recorder.inserts.find(item => item.table === 'bot_sessions')!.row.current_step).toBe('select_service');
    expect(f.db.bot_sessions[0].session_data._deep_link_capability).toBe('scheduling');
    expect(postbacks(f.cloud)).not.toContain(`cf-start:${flowId}`);
  });
});

describe('Default Reply yields to deterministic menu routing', () => {
  const fallback = 'Fictional unknown-message fallback';
  beforeEach(async () => {
    suspendedBizIds = new Set(); mockDetectionResult = { businessId: null, suggestions: [] }; vi.clearAllMocks();
    const keywords = await import('@/lib/bot/keyword-service');
    vi.mocked(keywords.loadBotCustomConfig).mockResolvedValue({ welcome_buttons: [], quick_replies: [], default_reply: fallback });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    const keywords = await import('@/lib/bot/keyword-service');
    vi.mocked(keywords.loadBotCustomConfig).mockResolvedValue({ welcome_buttons: [], quick_replies: [], default_reply: null });
  });
  function fixture() {
    const f = createRoutingSupabase('select_capability');
    f.db.custom_flow_sessions = []; f.db.custom_flows = []; f.db.waitlist_entries = [];
    f.botSession.session_data = { capabilities: ['scheduling'], _force_capability_menu: true };
    f.db.services = [{ id: 'service-1', business_id: 'biz-A', name: 'Fictional appointment', is_active: true, status: 'active', duration_minutes: 30, price: 0, available_days: [], metadata: {}, deleted_at: null }];
    f.supabase.rpc.mockImplementation(async (name: string, args: any) => {
      if (name === 'get_shared_conversation') return { data: { version: 0, business_id: 'biz-A', session: structuredClone(f.botSession) }, error: null };
      if (name === 'update_session_cas') {
        if (args.p_expected_version !== f.botSession.version) return { data: { success: false, reason: 'version_conflict' }, error: null };
        Object.assign(f.botSession, { version: f.botSession.version + 1, current_step: args.p_current_step, session_data: structuredClone(args.p_session_data) });
        return { data: { success: true, version: f.botSession.version }, error: null };
      }
      return { data: null, error: null };
    });
    const cloud = createMockCloud();
    const sender = new MetaCloudSender(cloud as any, createTestSupabase());
    const bot = new BotService(f.supabase, sender, createStandaloneService(), createMockIntelligence() as any);
    return { ...f, cloud, bot };
  }
  it.each([['cap_scheduling', 'button'], ['cap_scheduling', 'list'], ['cap_scheduling', 'text'], ['1', 'text']])('routes %s/%s through the real executor exactly once', async (input, type) => {
    const f = fixture();
    const execute = vi.spyOn((f.bot as any).flowExecutor, 'execute');
    const { capabilitySelectionFlow } = await import('@/lib/bot/flows/capability-selection.flow');
    const validate = vi.spyOn(capabilitySelectionFlow.steps.find(step => step.id === 'select_capability')!, 'validate');
    await f.bot.handleMessage(PHONE, input, type, 'pnid-1');
    expect(execute).toHaveBeenCalledTimes(1); expect(validate).toHaveBeenCalledTimes(1);
    expect(sentTexts(f.cloud)).not.toContain(fallback);
    expect(f.botSession.current_step).not.toBe('select_capability');
    expect(f.botSession.session_data.active_capability).toBe('scheduling');
  });
  it.each(['99', 'cap_unavailable', 'cap_appointment'])('leaves invalid or unavailable %s to existing validation, not fallback', async input => {
    const f = fixture();
    const execute = vi.spyOn((f.bot as any).flowExecutor, 'execute');
    const { capabilitySelectionFlow } = await import('@/lib/bot/flows/capability-selection.flow');
    const validate = vi.spyOn(capabilitySelectionFlow.steps.find(step => step.id === 'select_capability')!, 'validate');
    await f.bot.handleMessage(PHONE, input, 'text', 'pnid-1');
    expect(execute).toHaveBeenCalledTimes(1); expect(validate).toHaveBeenCalledTimes(1);
    expect(sentTexts(f.cloud)).not.toContain(fallback);
    expect(f.botSession.current_step).toBe('select_capability');
    expect(f.botSession.session_data.active_capability).toBeUndefined();
  });
  it.each(['button', 'list', 'text'])('routes the reported cap_appointment case with current entitlement (%s)', async type => {
    const capabilities = await import('@/lib/capabilities/service');
    const configured = vi.mocked(capabilities.getConfiguredCapabilities);
    const original = configured.getMockImplementation()!;
    configured.mockResolvedValue({ ok: true, rows: [{ capability: 'appointment', is_enabled: true, sort_order: 0 }] } as any);
    try {
      const f = fixture();
      f.botSession.session_data.capabilities = ['appointment'];
      f.db.business_capabilities = [{ business_id: 'biz-A', capability: 'appointment', is_enabled: true, sort_order: 0 }];
      f.db.appointments = [{ id: 'appointment-1', business_id: 'biz-A', name: 'Fictional session', duration_minutes: 30, is_active: true, price: 0, available_days: [], metadata: {} }];
      const execute = vi.spyOn((f.bot as any).flowExecutor, 'execute');
      await f.bot.handleMessage(PHONE, 'cap_appointment', type, 'pnid-1');
      expect(execute).toHaveBeenCalledTimes(1);
      expect(sentTexts(f.cloud)).not.toContain(fallback);
      expect(f.botSession.session_data.active_capability).toBe('appointment');
      expect(f.botSession.current_step).not.toBe('select_capability');
    } finally { configured.mockImplementation(original); }
  });
  it('does not bypass current capability denial when skipping fallback', async () => {
    const capabilities = await import('@/lib/capabilities/service');
    const configured = vi.mocked(capabilities.getConfiguredCapabilities);
    const original = configured.getMockImplementation()!;
    configured.mockResolvedValue({ ok: true, rows: [{ capability: 'scheduling', is_enabled: false, sort_order: 0 }] } as any);
    try {
      const f = fixture();
      f.db.business_capabilities = [{ business_id: 'biz-A', capability: 'scheduling', is_enabled: false, sort_order: 0 }];
      await f.bot.handleMessage(PHONE, 'cap_scheduling', 'button', 'pnid-1');
      expect(sentTexts(f.cloud)).not.toContain(fallback);
      expect(f.botSession.session_data.active_capability).toBeUndefined();
      expect(f.botSession.current_step).toBe('select_capability');
    } finally { configured.mockImplementation(original); }
  });
  it('preserves configured fallback for unknown free text without invoking the executor', async () => {
    const f = fixture(); const execute = vi.spyOn((f.bot as any).flowExecutor, 'execute');
    await f.bot.handleMessage(PHONE, 'unrecognised fictional phrase', 'text', 'pnid-1');
    expect(sentTexts(f.cloud)).toContain(fallback); expect(execute).not.toHaveBeenCalled();
  });
  it('preserves executor routing when no fallback is configured', async () => {
    const keywords = await import('@/lib/bot/keyword-service');
    vi.mocked(keywords.loadBotCustomConfig).mockResolvedValue({ welcome_buttons: [], quick_replies: [], default_reply: null });
    const f = fixture(); const execute = vi.spyOn((f.bot as any).flowExecutor, 'execute');
    await f.bot.handleMessage(PHONE, 'cap_scheduling', 'button', 'pnid-1');
    expect(execute).toHaveBeenCalledTimes(1); expect(f.botSession.session_data.active_capability).toBe('scheduling');
  });
});

// ── #1086: "Use what you already have" handoff through the real BotService ──

describe('Custom Flow handoff — the existing flow takes over through BotService (#1086)', () => {
  const EVENT_ID = 'e0000000-0000-4000-8000-000000000001';
  const HANDOFF_DEF: CustomFlowDefinition = {
    ...FESTIVAL_DEF,
    nodes: [
      { id: 'main_menu', type: 'menu', text: 'Welcome to AfroPlus Fest! What do you need?', options: [{ label: 'Tickets', next: 'tix' }, { label: 'Talk to us', next: 'talk' }] },
      { id: 'tix', type: 'handoff', capability: 'ticketing', record_id: EVENT_ID },
      { id: 'talk', type: 'handoff', capability: 'chat' },
    ],
  };
  function handoffFixture(caps: string[]) {
    extraCapsA = caps;
    const cloud = createMockCloud();
    const sender = new MetaCloudSender(cloud as any, createTestSupabase());
    const routing = createRoutingSupabase('select_capability');
    routing.db.custom_flows[0].published_definition = HANDOFF_DEF;
    routing.db.business_capabilities.push(...caps.map((capability, i) => ({ business_id: 'biz-A', capability, is_enabled: true, sort_order: 2 + i })));
    routing.db.events = [{ id: EVENT_ID, business_id: 'biz-A', name: 'AfroPlus Fest Day 1', status: 'published', date: new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0], time: null, venue: 'Main Stage', price: 5000, total_tickets: 100, tickets_sold: 0, max_per_order: 10, image_url: null }];
    routing.db.event_ticket_types = [];
    const bot = new BotService(routing.supabase, sender, createStandaloneService(), createMockIntelligence() as any);
    // The existing CAP-001 capability refresh also writes the session first; only writes that start a capability count here.
    const casCalls = () => routing.supabase.rpc.mock.calls.filter((c: any[]) => c[0] === 'update_session_cas' && c[1].p_session_data?.active_capability).map((c: any[]) => c[1]);
    return { ...routing, cloud, bot, casCalls };
  }
  beforeEach(() => { suspendedBizIds = new Set(); mockDetectionResult = { businessId: null, suggestions: [] }; vi.clearAllMocks(); });
  afterEach(() => { extraCapsA = []; });

  it('Event tickets with a chosen event: the custom session closes and the ticketing validator accepts that event', async () => {
    const f = handoffFixture(['ticketing']);
    await f.bot.handleMessage(PHONE, 'cf:main_menu:0', 'button', 'pnid-1');
    expect(f.db.custom_flow_sessions[0].is_active).toBe(false);
    const cas = f.casCalls();
    // 1) BotService positions the existing bot session on ticketing's first step…
    expect(cas[0]).toMatchObject({ p_session_id: 'sess-1', p_current_step: 'select_event' });
    expect(cas[0].p_session_data).toMatchObject({ business_id: 'biz-A', active_capability: 'ticketing', _inbound_channel_id: 'chan-1' });
    // The mock keeps the object by reference; the executor then appends its own steps.
    expect(cas[0].p_session_data._step_history.slice(0, 2)).toEqual(['select_capability', 'select_event']);
    // 2) …then the unchanged ticketing step validates the event id and moves on.
    const moved = cas.find((c: any) => c.p_current_step !== 'select_event');
    expect(moved?.p_current_step).toBe('select_ticket_type'); // ticketing's own next step after select_event
    expect(moved?.p_session_data).toMatchObject({ event_id: EVENT_ID, event_name: 'AfroPlus Fest Day 1' });
    expect(sentTexts(f.cloud)).not.toContain('Sorry, tickets for this aren’t available right now.');
  });

  it('Talk to a person: the existing chat start message is sent', async () => {
    const f = handoffFixture(['chat']);
    await f.bot.handleMessage(PHONE, 'cf:main_menu:1', 'button', 'pnid-1');
    expect(f.db.custom_flow_sessions[0].is_active).toBe(false);
    expect(f.casCalls()[0]).toMatchObject({ p_current_step: 'chat_start' });
    expect(sentTexts(f.cloud).some(t => t.includes("You're now chatting with *Biz A*"))).toBe(true);
  });

  it('feature turned off: plain message, back to the custom menu, the bot session is not touched', async () => {
    const f = handoffFixture([]);
    await f.bot.handleMessage(PHONE, 'cf:main_menu:0', 'button', 'pnid-1');
    expect(sentTexts(f.cloud)).toContain('Sorry, tickets for this aren’t available right now.');
    expect(f.db.custom_flow_sessions[0]).toMatchObject({ is_active: true, current_node_id: 'main_menu' });
    expect(f.casCalls()).toEqual([]);
  });

  it('another business\'s event: plain message and no handoff', async () => {
    const f = handoffFixture(['ticketing']);
    f.db.events[0].business_id = 'biz-B';
    await f.bot.handleMessage(PHONE, 'cf:main_menu:0', 'button', 'pnid-1');
    expect(sentTexts(f.cloud)).toContain('Sorry, tickets for this aren’t available right now.');
    expect(f.db.custom_flow_sessions[0].is_active).toBe(true);
    expect(f.casCalls()).toEqual([]);
  });
});

