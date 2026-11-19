/**
 * Bot latency Batch 1 (Owner request 2026-11-19) — same replies through the
 * real message entry point, with fewer database round trips.
 *
 * Each scenario runs BotService.handleMessage() the way the Meta webhook does
 * (pre-resolved business, suspension already gated) against a recording
 * Supabase mock, and checks:
 * - the customer receives exactly the replies recorded from the code before
 *   this change (bot-latency-batch1.golden.json, recorded at 6a94fabc8);
 * - the removed round trips are gone (dead businesses lookup, second
 *   suspension read, second pending-STOP read, repeated ai_conversation_config).
 *
 * Timing evidence: BOT_LATENCY_DELAY_MS=40 adds a fixed delay to every database
 * call (the staging median round trip); BOT_LATENCY_OUT=<file> saves each scenario's duration.
 * BOT_LATENCY_RECORD=1 rewrites the golden file (used once, on the old code).
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const llmSpy = vi.fn();
vi.mock('@/lib/bot/llm-intent', () => ({ classifyWithLLM: (...args: unknown[]) => llmSpy(...args) }));
vi.mock('@/lib/posthog/flags', () => ({
  isFeatureEnabledServer: vi.fn().mockResolvedValue(true),
  FLAGS: { LLM_INTENT_ENABLED: 'llm-intent-enabled', BOT_TRANSLATION_ENABLED: 'bot-translation-enabled' },
}));
vi.mock('@/lib/bot/classification-logger', () => ({ logClassification: vi.fn() }));
vi.mock('@/lib/trial-status', () => ({
  resolveLimitTier: vi.fn(async (_s: unknown, _b: unknown, t?: string | null) => (t === 'growth' || t === 'business' ? t : 'free')),
  resolveTrialCredit: vi.fn().mockResolvedValue(false),
  resolveTrialStatus: vi.fn().mockResolvedValue(false),
  resolveFeatureTrialEndsAt: vi.fn().mockResolvedValue(null),
}));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimitAsync: vi.fn().mockResolvedValue({ allowed: true, remaining: 10 }),
  checkRateLimit: vi.fn(() => ({ allowed: true, remaining: 10 })),
}));
vi.mock('@/lib/countries', () => ({ loadCountries: vi.fn().mockResolvedValue([]), getCountry: vi.fn(), getCountryList: vi.fn().mockReturnValue([]), isValidCountryCode: vi.fn().mockReturnValue(true), getDialingCodeMap: vi.fn().mockReturnValue({}) }));
vi.mock('@/lib/platformSettings', () => ({ loadPlatformSettings: vi.fn().mockResolvedValue({ bot_rate_limit_per_minute: 30 }) }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('@/lib/bot/translate', () => ({
  translateBotResponse: vi.fn(async (text: string) => text),
  detectLanguage: vi.fn(async () => 'en'),
  getLanguageName: vi.fn(() => 'English'),
}));
vi.mock('@/lib/bot/keyword-service', () => ({
  loadBotCustomConfig: vi.fn().mockResolvedValue({ welcome_buttons: [], quick_replies: [], default_reply: null }),
  matchQuickReply: vi.fn(() => null),
  loadUnifiedKeywords: vi.fn().mockResolvedValue([]),
  matchUnifiedKeyword: vi.fn(() => null),
}));
vi.mock('@/lib/bot/automation/rules-engine', () => ({ evaluateRules: vi.fn().mockResolvedValue(undefined) }));

import { BotService } from '../bot.service';
import { createCaptureSender } from './bot-harness';

const PHONE = '2348011112222';
const BIZ = 'biz-latency-b1';
const PNID = 'pnid-dedicated-1';
const DELAY_MS = Number(process.env.BOT_LATENCY_DELAY_MS || 0);
const GOLDEN = path.join(__dirname, 'bot-latency-batch1.golden.json');
const RECORD = process.env.BOT_LATENCY_RECORD === '1';

const NO_RESULT = {
  flow: null, entities: { serviceKeywords: [], date: null, timePreference: null, quantity: null },
  confidence: 0, language: 'en', semanticFamily: null, requestedAction: null,
};

const business = {
  id: BIZ, name: 'Latency Salon', slug: 'latency-salon', status: 'active', subscription_tier: 'growth',
  trial_ends_at: null, category: 'salon', flow_type: 'scheduling', metadata: {}, country_code: 'NG', bot_code: 'LATSALON',
};
const SERVICES = [
  { id: 'svc-1', name: 'Haircut', price: 5000, duration_minutes: 30, max_capacity: 1, is_class: false, class_schedule: null, billing_type: 'one_time', metadata: null },
  { id: 'svc-2', name: 'Braids', price: 15000, duration_minutes: 120, max_capacity: 1, is_class: false, class_schedule: null, billing_type: 'one_time', metadata: null },
];

type Call = { kind: 'from' | 'rpc'; name: string; filters: string[] };

const delay = () => (DELAY_MS > 0 ? new Promise(r => setTimeout(r, DELAY_MS)) : Promise.resolve());

function createDb(session: Record<string, unknown> | null, channelType: 'dedicated' | 'shared' = 'dedicated') {
  const calls: Call[] = [];
  function rowsFor(table: string): unknown {
    if (table === 'businesses') return business;
    if (table === 'business_capabilities') return [{ capability: 'scheduling', is_enabled: true, sort_order: 0 }, { capability: 'chat', is_enabled: true, sort_order: 1 }];
    if (table === 'platform_settings') return { value: false };
    if (table === 'services') return SERVICES;
    if (table === 'whatsapp_channels') {
      return channelType === 'shared'
        ? { id: 'ch-shared', business_id: null, country_code: 'NG', channel_type: 'shared' }
        : { id: 'ch-1', business_id: BIZ, country_code: 'NG', channel_type: 'dedicated' };
    }
    if (table === 'ai_conversation_config') return { enabled_languages: ['en'] };
    return null;
  }
  function chain(table: string) {
    const call: Call = { kind: 'from', name: table, filters: [] };
    calls.push(call);
    const c: Record<string, any> = {};
    for (const m of ['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'neq', 'or', 'in', 'is', 'not', 'ilike', 'like', 'gte', 'lte', 'gt', 'lt', 'order', 'limit', 'range', 'filter', 'match', 'contains']) {
      c[m] = vi.fn((...args: unknown[]) => { call.filters.push(`${m}:${String(args[0])}`); return c; });
    }
    // An insert/upsert returns the row it wrote (new sessions keep their data).
    let written: Record<string, unknown> | null = null;
    for (const m of ['insert', 'upsert']) {
      c[m] = vi.fn((row: Record<string, unknown>) => { call.filters.push(`${m}:`); written = { id: `${table}-new`, version: 0, ...(Array.isArray(row) ? row[0] : row) }; return c; });
    }
    const data = rowsFor(table);
    const first = Array.isArray(data) ? data[0] ?? null : data;
    c.single = vi.fn(async () => {
      await delay();
      // As PostgREST answers in production: businesses has no whatsapp_phone_number_id column.
      if (call.filters.includes('eq:whatsapp_phone_number_id')) return { data: null, error: { code: '42703', message: 'column businesses.whatsapp_phone_number_id does not exist' } };
      return { data: written ?? first, error: null };
    });
    c.maybeSingle = vi.fn(async () => { await delay(); return { data: written ?? first, error: null }; });
    c.then = (ok: any, bad: any) => delay().then(() => ({ data: Array.isArray(data) ? data : (data ? [data] : []), count: Array.isArray(data) ? data.length : 0, error: null })).then(ok, bad);
    return c;
  }
  const client = {
    from: vi.fn((table: string) => chain(table)),
    rpc: vi.fn(async (name: string) => {
      calls.push({ kind: 'rpc', name, filters: [] });
      await delay();
      if (name === 'update_session_cas') return { data: { success: true, version: 1 }, error: null };
      if (name === 'get_bot_context') {
        return { data: session
          ? { has_session: true, ambiguous: false, session, business, capabilities: null, capability_overrides: null }
          : { has_session: false, business, capabilities: null, capability_overrides: null }, error: null };
      }
      if (name === 'record_customer_inbound') return { data: { ignore: false }, error: null };
      return { data: null, error: null };
    }),
    storage: { from: vi.fn(() => ({ upload: vi.fn(), createSignedUrl: vi.fn(), getPublicUrl: vi.fn() })) },
  };
  return { calls, client: client as any };
}

function sessionAt(step: string, extra: Record<string, unknown> = {}) {
  return {
    id: 'sess-b1', whatsapp_number: PHONE, user_id: 'u1', business_id: BIZ, current_step: step,
    session_data: { capabilities: ['scheduling', 'chat'], business_id: BIZ, business_name: 'Latency Salon', business_category: 'salon', ...extra },
    is_active: true, expires_at: new Date(Date.now() + 86400000).toISOString(), version: 0,
  };
}

function makeBot(db: ReturnType<typeof createDb>, sender: ReturnType<typeof createCaptureSender>) {
  const standalone = {
    loadWhatsAppConfigBundle: vi.fn().mockResolvedValue({ templates: { greeting: 'Welcome!' }, welcome_buttons: [], auto_reply_enabled: false, business_hours: null, alias: null }),
    checkTierLimitsFromBusiness: vi.fn().mockResolvedValue({ allowed: true, isWhitelabel: false }),
    fillTemplate: vi.fn((t: string) => t),
    getBotAlias: vi.fn().mockResolvedValue(null),
  } as any;
  const intelligence = {
    isTimedOut: vi.fn(() => ({ timedOut: false, remaining: 0 })), containsProfanity: vi.fn(() => false),
    recordProfanity: vi.fn(() => ({ timeout: false, warn: false })), resetAbuse: vi.fn(),
    getHelpText: vi.fn(() => 'Help'), getPersonaGreeting: vi.fn(() => 'Hi'), getContextualHelp: vi.fn(() => 'Help'),
  } as any;
  const bot = new BotService(db.client, sender, standalone, intelligence);
  // The webhook gates suspension before handleMessage (the old code has no marker).
  (bot as unknown as { markSuspensionGated?: () => void }).markSuspensionGated?.();
  return bot;
}

type Scenario = { name: string; session: Record<string, unknown> | null; text: string; type: string; pre: string | undefined; channel?: 'shared' };

const SCENARIOS: Scenario[] = [
  { name: 'menu tap at select_capability', session: sessionAt('select_capability'), text: 'cap_scheduling', type: 'list', pre: BIZ },
  { name: 'number tap at select_capability', session: sessionAt('select_capability'), text: '1', type: 'text', pre: BIZ },
  { name: 'typed answer at collect_name', session: sessionAt('collect_name', { active_capability: 'scheduling', service_id: 'svc-1' }), text: 'John Doe', type: 'text', pre: BIZ },
  { name: 'free text at select_service', session: sessionAt('select_service', { active_capability: 'scheduling' }), text: 'I want braids please', type: 'text', pre: BIZ },
  // A shared number: the webhook supplies no business and the channel row is shared.
  { name: 'shared number, unknown business', session: null, text: 'hello there', type: 'text', pre: undefined, channel: 'shared' },
];

function replyOf(sender: ReturnType<typeof createCaptureSender>) {
  return sender.getMessages().map(m => JSON.parse(JSON.stringify(m)));
}

const golden: Record<string, unknown> = fs.existsSync(GOLDEN) ? JSON.parse(fs.readFileSync(GOLDEN, 'utf8')) : {};
const recorded: Record<string, unknown> = {};
const timings: Record<string, { ms: number; dbCalls: number }> = {};

beforeEach(() => {
  llmSpy.mockReset();
  llmSpy.mockResolvedValue(NO_RESULT);
  // Date lists depend on today: fix the clock (timers stay real for the delay).
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-18T10:00:00Z'));
});

afterAll(() => {
  vi.useRealTimers();
  if (RECORD) fs.writeFileSync(GOLDEN, JSON.stringify(recorded, null, 2) + '\n');
  if (DELAY_MS > 0 && process.env.BOT_LATENCY_OUT) fs.writeFileSync(process.env.BOT_LATENCY_OUT, JSON.stringify({ delayMs: DELAY_MS, timings }) + '\n');
});

describe('Batch 1: identical replies through BotService.handleMessage', () => {
  it.each(SCENARIOS)('$name', async (sc) => {
    const db = createDb(sc.session, sc.channel);
    const sender = createCaptureSender();
    const t0 = performance.now();
    await makeBot(db, sender).handleMessage(PHONE, sc.text, sc.type, PNID, sc.pre);
    timings[sc.name] = { ms: Math.round(performance.now() - t0), dbCalls: db.calls.length };
    const replies = replyOf(sender);
    recorded[sc.name] = replies;
    expect(replies.length).toBeGreaterThan(0);
    if (!RECORD) expect(replies).toEqual(golden[sc.name]);

    if (RECORD) return;
    // The webhook already gated suspension: no second read.
    expect(db.calls.filter(c => c.name === 'customer_suspensions')).toHaveLength(0);
    // businesses has no whatsapp_phone_number_id column: never queried.
    expect(db.calls.some(c => c.filters.includes('eq:whatsapp_phone_number_id'))).toBe(false);
    // ai_conversation_config: at most one languages read and one config read.
    expect(db.calls.filter(c => c.name === 'ai_conversation_config').length).toBeLessThanOrEqual(2);
  });

  it('number tap: the pending-STOP session read happens once, not twice', async () => {
    if (RECORD) return;
    const db = createDb(sessionAt('select_capability'));
    await makeBot(db, createCaptureSender()).handleMessage(PHONE, '1', 'text', PNID, BIZ);
    const pendingStopReads = db.calls.filter(c => c.name === 'bot_sessions' && c.filters.includes('eq:current_step'));
    expect(pendingStopReads).toHaveLength(1);
  });

  it('without the webhook marker the suspension gate still runs (other entries)', async () => {
    if (RECORD) return;
    const db = createDb(sessionAt('select_capability'));
    const standalone = { loadWhatsAppConfigBundle: vi.fn().mockResolvedValue({ templates: {}, welcome_buttons: [] }), checkTierLimitsFromBusiness: vi.fn().mockResolvedValue({ allowed: true }), fillTemplate: vi.fn((t: string) => t), getBotAlias: vi.fn().mockResolvedValue(null) } as any;
    const intelligence = { isTimedOut: vi.fn(() => ({ timedOut: false, remaining: 0 })), containsProfanity: vi.fn(() => false), recordProfanity: vi.fn(() => ({})), resetAbuse: vi.fn(), getHelpText: vi.fn(() => 'Help'), getPersonaGreeting: vi.fn(() => 'Hi'), getContextualHelp: vi.fn(() => 'Help') } as any;
    await new BotService(db.client, createCaptureSender(), standalone, intelligence).handleMessage(PHONE, 'cap_scheduling', 'list', PNID, BIZ);
    expect(db.calls.filter(c => c.name === 'customer_suspensions')).toHaveLength(1);
  });
});
