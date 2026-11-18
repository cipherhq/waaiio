/**
 * Giving-category link routing in the real BotService (Owner request 2026-11-18).
 *
 * The prefill "{BOT_CODE}:giving:{ref}" from /m/{business}/giving/{category} must:
 *  1. open giving in that category, so the donor only enters the amount;
 *  2. fall back to the business's giving menu for a deleted, inactive or unknown
 *     category;
 *  3. never select another business's category (cross-business safety);
 *  4. reach a hidden business (#1083), work on a dedicated number, and switch
 *     a donor who is mid-way through another giving amount.
 *
 * Real BotService, real bot-code detection, real payment flow and executor;
 * external boundaries mocked; filter-aware in-memory Supabase (pattern of
 * custom-flow-botservice-routing.test.ts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTestSupabase } from './helpers/mock-supabase';

vi.mock('@/lib/countries', () => ({ loadCountries: vi.fn().mockResolvedValue([]), getCountry: vi.fn(), getCountryList: vi.fn().mockReturnValue([]), isValidCountryCode: vi.fn().mockReturnValue(true), getDialingCodeMap: vi.fn().mockReturnValue({}) }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimitAsync: vi.fn().mockResolvedValue({ allowed: true, remaining: 10 }) }));
vi.mock('@/lib/platformSettings', () => ({ getPlatformSettingsSync: vi.fn(() => ({})), loadPlatformSettings: vi.fn().mockResolvedValue({ bot_rate_limit_per_minute: 30, abuse_cooldown_soft_minutes: 5, abuse_cooldown_hard_minutes: 30, conversation_limits: { free: 200, growth: 1000, business: 5000 } }) }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('@/lib/bot/translate', () => ({ translateBotResponse: vi.fn(async (t: string) => t), detectLanguage: vi.fn(async () => 'en'), getLanguageName: vi.fn(() => 'English') }));
vi.mock('@/lib/bot/handlers/global-queries', () => ({ handleGlobalQuery: vi.fn(async (opts: { session: unknown }) => ({ handled: false, session: opts.session })), isOrdersQuery: vi.fn(() => false) }));
vi.mock('@/lib/bot/handlers/escape-hatches', () => ({ HOME_PATTERN: /^(home|directory|search)$/i, handleEscapeHatch: vi.fn().mockResolvedValue({ handled: false }) }));
vi.mock('@/lib/bot/keyword-service', () => ({ loadBotCustomConfig: vi.fn().mockResolvedValue({ welcome_buttons: [], quick_replies: [], default_reply: null }), matchQuickReply: vi.fn(() => null), loadUnifiedKeywords: vi.fn().mockResolvedValue([]), matchUnifiedKeyword: vi.fn(() => null) }));
vi.mock('@/lib/circuit-breaker', () => ({ isCircuitOpen: () => false, recordSuccess: vi.fn(), recordFailure: vi.fn(), CircuitBreakerOpenError: class extends Error {} }));
// A returning donor: without the giving-link guard the "Give again?" rebook prompt would take over.
vi.mock('@/lib/bot/customer-intelligence', () => ({
  getCustomerHistory: vi.fn().mockResolvedValue({ isReturning: true, totalVisits: 3, ltvTier: 'regular', lastServiceId: 'svc-offering', lastServiceName: 'Offering', lastFlowType: 'payment', favoriteServiceId: null, favoriteServiceName: null }),
  buildReturnGreeting: vi.fn().mockReturnValue(null),
}));
vi.mock('@/lib/capabilities/service', () => ({
  getConfiguredCapabilities: vi.fn().mockResolvedValue({ ok: true, rows: [
    { capability: 'giving', is_enabled: true, sort_order: 0 },
    { capability: 'chat', is_enabled: true, sort_order: 1 },
  ] }),
  getCapabilityCustomLabels: vi.fn().mockResolvedValue({}),
  getEnabledCapabilities: vi.fn().mockResolvedValue([]),
  hasCapability: vi.fn().mockResolvedValue(false),
  setCapabilities: vi.fn().mockResolvedValue(undefined),
  getCapabilityConfig: vi.fn().mockResolvedValue(null),
  initCapabilities: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/bot/smart-intent', () => ({
  parseSmartIntent: vi.fn().mockResolvedValue(null),
  parseSmartIntentHybrid: vi.fn().mockResolvedValue({ understood: false, broadIntent: null, serviceKeywords: [], date: null, specificTime: null, timePreference: null, quantity: null, amount: null, variantKeywords: [] }),
  matchServiceFromKeywords: vi.fn().mockResolvedValue(null),
  matchProductsFromKeywords: vi.fn().mockResolvedValue([]),
  buildAcknowledgment: vi.fn().mockReturnValue(null),
  extractEntitiesOnly: vi.fn().mockReturnValue({}),
}));
vi.mock('@/lib/channels/send-guard', () => ({ assertMessagingAllowed: vi.fn().mockResolvedValue(undefined) }));

const { BotService } = await import('@/lib/bot/bot.service');
const { MetaCloudSender } = await import('@/lib/channels/message-sender');

type Row = Record<string, any>;

class Query {
  private filters: Array<(row: Row) => boolean> = [];
  private orderBy: string | null = null;
  private mode: 'single' | null = null;
  constructor(private db: Record<string, Row[]>, private table: string, private op: 'select' | 'insert' | 'update' | 'delete', private rows: Row[] = [], private patch: Row = {}) {}
  select(): this { return this; }
  eq(c: string, v: unknown): this { this.filters.push(r => r[c] === v); return this; }
  neq(c: string, v: unknown): this { this.filters.push(r => r[c] !== v); return this; }
  ilike(c: string, v: unknown): this { this.filters.push(r => String(r[c] ?? '').toLowerCase() === String(v).toLowerCase()); return this; }
  is(c: string, v: unknown): this { this.filters.push(r => (v === null ? r[c] == null : r[c] === v)); return this; }
  in(c: string, v: unknown[]): this { this.filters.push(r => v.includes(r[c])); return this; }
  lt(c: string, v: any): this { this.filters.push(r => r[c] < v); return this; }
  gt(c: string, v: any): this { this.filters.push(r => r[c] > v); return this; }
  gte(c: string, v: any): this { this.filters.push(r => r[c] >= v); return this; }
  lte(c: string, v: any): this { this.filters.push(r => r[c] <= v); return this; }
  // Bot-code detection uses .or('bot_code.ilike.x,...'); other .or() filters are not applied.
  or(expr: string): this {
    const parts = expr.split(',').map(p => p.match(/^bot_code\.ilike\.([a-z0-9-]+)$/i));
    if (parts.every(Boolean)) {
      const codes = parts.map(m => m![1].toLowerCase());
      this.filters.push(r => codes.includes(String(r.bot_code ?? '').toLowerCase()));
    }
    return this;
  }
  not(): this { return this; } contains(): this { return this; } filter(): this { return this; } match(): this { return this; }
  textSearch(): this { return this; } range(): this { return this; } returns(): this { return this; } head(): this { return this; }
  order(c: string): this { this.orderBy = c; return this; }
  limit(): this { return this; }
  single() { this.mode = 'single'; return Promise.resolve(this.run()); }
  maybeSingle() { this.mode = 'single'; return Promise.resolve(this.run()); }
  then(res: (v: any) => void, rej?: (e: unknown) => void) { try { res(this.run()); } catch (e) { rej?.(e); } }
  private run(): { data: any; error: null; count?: number } {
    const table = (this.db[this.table] ??= []);
    if (this.op === 'insert') {
      const ins = this.rows.map((r, i) => ({ id: r.id ?? `${this.table}-${table.length + i + 1}`, version: 0, ...r }));
      table.push(...ins);
      return { data: this.mode === 'single' ? { ...ins[0] } : ins, error: null };
    }
    const hit = table.filter(r => this.filters.every(f => f(r)));
    if (this.op === 'update') { hit.forEach(r => Object.assign(r, this.patch)); return { data: hit.map(r => ({ id: r.id })), error: null }; }
    if (this.op === 'delete') { this.db[this.table] = table.filter(r => !hit.includes(r)); return { data: null, error: null }; }
    const sorted = this.orderBy ? [...hit].sort((a, b) => (a[this.orderBy!] > b[this.orderBy!] ? 1 : -1)) : hit;
    if (this.mode === 'single') return { data: sorted[0] ? { ...sorted[0] } : null, error: null };
    return { data: sorted.map(r => ({ ...r })), error: null, count: sorted.length };
  }
}

const PHONE = '2348012345678';
const FUTURE = new Date(Date.now() + 3600000).toISOString();
const TITHE = '3f2a9c1d-1b2c-4d3e-8f40-000000000001';
const BUILDING = '5c7d1e2f-1b2c-4d3e-8f40-000000000002';
const OLD_FUND = 'aa11bb22-1b2c-4d3e-8f40-000000000003'; // deleted
const PAUSED = 'cc33dd44-1b2c-4d3e-8f40-000000000004'; // inactive
const OTHER_CAT = 'ee55ff66-1b2c-4d3e-8f40-000000000005'; // belongs to biz-other

function biz(id: string, name: string, code: string, extra: Row = {}): Row {
  return { id, name, slug: code.toLowerCase(), category: 'church', flow_type: 'payment', subscription_tier: 'business', trial_ends_at: null,
    feature_trial_ends_at: null, bot_code: code, status: 'active', messaging_suspended: false, country_code: 'NG', metadata: {},
    is_whitelabel: false, payment_gateway: 'paystack', operating_hours: null, discovery_enabled: true, ...extra };
}
function giving(id: string, businessId: string, name: string, extra: Row = {}): Row {
  return { id, business_id: businessId, name, service_type: 'giving', is_active: true, deleted_at: null, price: 0, price_is_variable: true,
    billing_type: 'one_time', recurring_interval: null, sort_order: 0, ...extra };
}

function setup(opts: { session?: Row | null } = {}) {
  const db: Record<string, Row[]> = {
    businesses: [
      biz('biz-grace', 'Grace Chapel', 'GRACE', { discovery_enabled: false }), // hidden from the directory (#1083)
      biz('biz-other', 'Other Mosque', 'OTHER'),
    ],
    services: [
      giving(TITHE, 'biz-grace', 'Tithe'),
      giving(BUILDING, 'biz-grace', 'Building Fund', { sort_order: 1 }),
      giving(OLD_FUND, 'biz-grace', 'Old Fund', { is_active: false, deleted_at: '2026-11-01T00:00:00Z' }),
      giving(PAUSED, 'biz-grace', 'Paused Fund', { is_active: false }),
      giving(OTHER_CAT, 'biz-other', 'Zakat'),
    ],
    whatsapp_channels: [
      { id: 'chan-shared', phone_number_id: 'pnid-shared', channel_type: 'shared', country_code: 'NG', business_id: null, is_active: true },
      { id: 'chan-ded', phone_number_id: 'pnid-ded', channel_type: 'dedicated', country_code: 'NG', business_id: 'biz-grace', is_active: true },
    ],
    // A saved language, so the first-contact language picker does not interrupt.
    customer_profiles: [
      { business_id: 'biz-grace', phone: `+${PHONE}`, preferred_language: 'en' },
      { business_id: 'biz-other', phone: `+${PHONE}`, preferred_language: 'en' },
    ],
    bot_sessions: opts.session ? [opts.session] : [],
  };
  const sessionsById = () => Object.fromEntries(db.bot_sessions.map(s => [s.id, s]));
  const supabase = {
    from: (t: string) => ({
      select: () => new Query(db, t, 'select'),
      insert: (r: Row | Row[]) => new Query(db, t, 'insert', Array.isArray(r) ? r : [r]),
      upsert: (r: Row | Row[]) => new Query(db, t, 'insert', Array.isArray(r) ? r : [r]),
      update: (p: Row) => new Query(db, t, 'update', [], p),
      delete: () => new Query(db, t, 'delete'),
    }),
    rpc: vi.fn(async (fn: string, args: any) => {
      if (fn === 'get_shared_conversation') {
        const s = db.bot_sessions.find(r => r.is_active && r.whatsapp_number === PHONE) ?? null;
        return { data: { version: 0, business_id: s?.business_id ?? null, session: s ? structuredClone(s) : null }, error: null };
      }
      if (fn === 'select_shared_conversation') return { data: { ok: true }, error: null };
      if (fn === 'deactivate_session_atomic') {
        const s = sessionsById()[args.p_session_id];
        if (s) s.is_active = false;
        return { data: null, error: null };
      }
      if (fn === 'update_session_cas') {
        const s = sessionsById()[args.p_session_id];
        if (s) Object.assign(s, { current_step: args.p_current_step, session_data: structuredClone(args.p_session_data), version: (s.version ?? 0) + 1 });
        return { data: { success: true, version: (s?.version ?? 1) }, error: null };
      }
      return { data: null, error: null };
    }),
  };
  const cloud = {
    sendText: vi.fn().mockResolvedValue({ messages: [{ id: 'm1' }] }),
    sendButtons: vi.fn().mockResolvedValue({ messages: [{ id: 'm2' }] }),
    sendList: vi.fn().mockResolvedValue({ messages: [{ id: 'm3' }] }),
    sendTemplate: vi.fn(), sendImage: vi.fn(), sendDocument: vi.fn(), sendAudio: vi.fn(), sendFlow: vi.fn(),
    sendReaction: vi.fn(), sendLocation: vi.fn(), sendProduct: vi.fn(), sendProductList: vi.fn(),
  };
  const sender = new MetaCloudSender(cloud as any, createTestSupabase());
  const standalone = {
    parseNaturalBooking: vi.fn().mockResolvedValue(null), detectLanguage: vi.fn().mockResolvedValue(null),
    loadWhatsAppConfigBundle: vi.fn().mockResolvedValue({ templates: { greeting: 'Welcome! How can I help you today?', confirmation: '', reminder: '', orderConfirmation: '', paymentReceipt: '', orderStatus: '' },
      alias: null, welcome_buttons: [], quick_replies: [], default_reply: null, auto_reply_enabled: false, business_hours: null, away_message: null, instant_reply_enabled: false, instant_reply_message: null }),
    checkTierLimitsFromBusiness: vi.fn().mockResolvedValue({ allowed: true, plan: 'business', monthlyBookings: 0, monthlyLimit: 999, isWhitelabel: false }),
    fillTemplate: vi.fn((t: string) => t),
    checkTierLimits: vi.fn().mockResolvedValue({ allowed: true, plan: 'business', monthlyBookings: 0, monthlyLimit: 999, isWhitelabel: false }),
  };
  const intelligence = {
    isTimedOut: vi.fn().mockReturnValue({ timedOut: false }), containsProfanity: vi.fn().mockReturnValue(false),
    recordProfanity: vi.fn().mockReturnValue({ timeout: false, warn: false }), recordGibberish: vi.fn().mockReturnValue({ timeout: false, warn: false }),
    detectBookingIntent: vi.fn().mockReturnValue(null), getPersonaGreeting: vi.fn().mockReturnValue(null),
  };
  const bot = new BotService(supabase as any, sender, standalone as any, intelligence as any);
  const texts = () => cloud.sendText.mock.calls.map((c: any[]) => String(c[0]?.text ?? ''));
  const lists = () => cloud.sendList.mock.calls.map((c: any[]) => c[0]);
  const buttons = () => cloud.sendButtons.mock.calls.map((c: any[]) => String(c[0]?.body ?? c[0]?.bodyText ?? ''));
  const activeSession = () => db.bot_sessions.find(s => s.is_active && s.whatsapp_number === PHONE);
  return { bot, db, sender, texts, lists, buttons, activeSession };
}

const amountPrompt = (name: string) => `How much would you like to give towards *${name}*?`;
const givingMenuShown = (f: ReturnType<typeof setup>) =>
  f.lists().some(l => JSON.stringify(l).includes('Tithe') && JSON.stringify(l).includes('Building Fund'));

describe('Giving-category link routing (BotService)', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('valid category (shared number, hidden business): opens giving in that category and asks only for the amount', async () => {
    const f = setup();
    await f.bot.handleMessage(PHONE, 'GRACE:giving:3f2a9c1d', 'text', 'pnid-shared');

    expect(f.sender.boundBusinessId).toBe('biz-grace');
    expect(f.texts().some(t => t.includes(amountPrompt('Tithe')))).toBe(true);
    const s = f.activeSession()!;
    expect(s.business_id).toBe('biz-grace');
    expect(s.current_step).toBe('enter_amount');
    expect(s.session_data.active_capability).toBe('giving');
    expect(s.session_data.service_id).toBe(TITHE);
    // Not the giving menu, and not the returning-donor "Give again?" prompt.
    expect(givingMenuShown(f)).toBe(false);
    expect(f.buttons().some(b => b.includes('Give again'))).toBe(false);
  });

  it('upper-case ref and bot code still match', async () => {
    const f = setup();
    await f.bot.handleMessage(PHONE, 'grace:GIVING:5C7D1E2F', 'text', 'pnid-shared');
    expect(f.texts().some(t => t.includes(amountPrompt('Building Fund')))).toBe(true);
  });

  it.each([
    ['deleted', 'aa11bb22', 'Old Fund'],
    ['inactive', 'cc33dd44', 'Paused Fund'],
    ['unknown', 'deadbeef', ''],
  ])('%s category: falls back to the giving menu', async (_label, ref, name) => {
    const f = setup();
    await f.bot.handleMessage(PHONE, `GRACE:giving:${ref}`, 'text', 'pnid-shared');

    expect(f.sender.boundBusinessId).toBe('biz-grace');
    expect(givingMenuShown(f)).toBe(true);
    expect(f.texts().some(t => t.includes('How much would you like to give'))).toBe(false);
    if (name) expect(JSON.stringify(f.lists())).not.toContain(name);
    const s = f.activeSession()!;
    expect(s.current_step).toBe('select_category');
    expect(s.session_data.active_capability).toBe('giving');
    expect(s.session_data.service_id).toBeUndefined();
  });

  it('another business\'s category ref: stays with the code\'s business and never selects the other category', async () => {
    const f = setup();
    // OTHER_CAT belongs to biz-other; the code is GRACE.
    await f.bot.handleMessage(PHONE, 'GRACE:giving:ee55ff66', 'text', 'pnid-shared');

    expect(f.sender.boundBusinessId).toBe('biz-grace');
    expect(givingMenuShown(f)).toBe(true);
    expect(JSON.stringify(f.lists())).not.toContain('Zakat');
    expect(f.texts().some(t => t.includes('Zakat'))).toBe(false);
    expect(f.activeSession()!.session_data.service_id).toBeUndefined();
  });

  it('dedicated number: a code that is not this business\'s own code never preselects a category', async () => {
    const f = setup();
    // Sent to Grace's dedicated number with the other business's code and category.
    await f.bot.handleMessage(PHONE, 'OTHER:giving:ee55ff66', 'text', 'pnid-ded', 'biz-grace');

    expect(f.sender.boundBusinessId).toBe('biz-grace');
    expect(f.texts().some(t => t.includes('Zakat') || t.includes('How much would you like to give'))).toBe(false);
    expect(f.activeSession()!.session_data.service_id).toBeUndefined();
  });

  it('dedicated number: the business\'s own link preselects the category', async () => {
    const f = setup();
    await f.bot.handleMessage(PHONE, 'GRACE:giving:3f2a9c1d', 'text', 'pnid-ded', 'biz-grace');

    expect(f.texts().some(t => t.includes(amountPrompt('Tithe')))).toBe(true);
    expect(f.activeSession()!.session_data.service_id).toBe(TITHE);
  });

  it('mid-way through another amount: the scanned link restarts into the new category', async () => {
    const f = setup({ session: {
      id: 'sess-old', whatsapp_number: PHONE, user_id: null, business_id: 'biz-grace', current_step: 'enter_amount',
      session_data: { business_id: 'biz-grace', active_capability: 'giving', capabilities: ['giving', 'chat'], service_id: TITHE, service_name: 'Tithe' },
      is_active: true, expires_at: FUTURE, version: 0,
    } });
    await f.bot.handleMessage(PHONE, 'GRACE:giving:5c7d1e2f', 'text', 'pnid-shared');

    // The old session is closed (and then cleaned up as inactive).
    expect(f.db.bot_sessions.find(s => s.id === 'sess-old')?.is_active ?? false).toBe(false);
    expect(f.texts().some(t => t.includes(amountPrompt('Building Fund')))).toBe(true);
    expect(f.texts().some(t => t.toLowerCase().includes('valid amount'))).toBe(false);
    expect(f.activeSession()!.session_data.service_id).toBe(BUILDING);
  });
});
