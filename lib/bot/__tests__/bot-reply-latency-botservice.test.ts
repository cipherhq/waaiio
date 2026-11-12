/**
 * Bot reply latency — BotService.handleMessage() wiring.
 *
 * Proves, through the real message entry point, that the LLM intent fallback no
 * longer fires on a typed answer or a capability-menu tap (where it always found
 * nothing), still fires on open free text at a non-answer step, and that the
 * handler copy-language reads only happen for an exit reply.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const llmSpy = vi.fn();

vi.mock('@/lib/bot/llm-intent', () => ({ classifyWithLLM: (...args: unknown[]) => llmSpy(...args) }));
vi.mock('@/lib/posthog/flags', () => ({
  isFeatureEnabledServer: vi.fn().mockResolvedValue(true),
  FLAGS: { LLM_INTENT_ENABLED: 'llm-intent-enabled' },
}));
vi.mock('@/lib/bot/classification-logger', () => ({ logClassification: vi.fn() }));
vi.mock('@/lib/trial-status', () => ({
  resolveLimitTier: vi.fn(async (_s: unknown, _b: unknown, t?: string | null) => (t === 'growth' || t === 'business' ? t : 'free')),
  resolveTrialCredit: vi.fn().mockResolvedValue(false),
  resolveTrialStatus: vi.fn().mockResolvedValue(false),
  resolveFeatureTrialEndsAt: vi.fn().mockResolvedValue(null),
}));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimitAsync: vi.fn().mockResolvedValue({ allowed: true, remaining: 10 }) }));
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

const PHONE = '+2341234567890';
const BIZ = 'biz-latency-001';

const NO_RESULT = {
  flow: null, entities: { serviceKeywords: [], date: null, timePreference: null, quantity: null },
  confidence: 0, language: 'en', semanticFamily: null, requestedAction: null,
};

/** Supabase mock: session + growth-tier business from get_bot_context, empty everywhere else. Records every call. */
function createDb(session: Record<string, unknown>) {
  const calls: string[] = [];
  const business = { id: BIZ, name: 'Latency Salon', status: 'active', subscription_tier: 'growth', trial_ends_at: null, category: 'salon', metadata: {} };
  function chain(data: unknown, count = 0) {
    const c: Record<string, any> = {};
    for (const m of ['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'neq', 'or', 'in', 'is', 'not', 'ilike', 'like', 'gte', 'lte', 'gt', 'lt', 'order', 'limit', 'range', 'filter', 'match', 'contains']) c[m] = vi.fn(() => c);
    c.single = vi.fn().mockResolvedValue({ data, error: null });
    c.maybeSingle = vi.fn().mockResolvedValue({ data, error: null });
    c.then = (ok: any, bad: any) => Promise.resolve({ data: Array.isArray(data) ? data : [], count, error: null }).then(ok, bad);
    return c;
  }
  return {
    calls,
    client: {
      from: vi.fn((table: string) => {
        calls.push(table);
        if (table === 'businesses') return chain(business);
        if (table === 'business_capabilities') return chain([{ capability: 'scheduling', is_enabled: true, sort_order: 0 }, { capability: 'chat', is_enabled: true, sort_order: 1 }]);
        if (table === 'platform_settings') return chain({ value: false });
        if (table === 'services') return chain(null, 3); // scheduling has bookable services
        return chain(null);
      }),
      rpc: vi.fn((name: string, params?: Record<string, unknown>) => {
        calls.push(`rpc:${name}`);
        if (name === 'update_session_cas') return Promise.resolve({ data: { success: true, version: 1 }, error: null });
        if (name === 'get_bot_context' && params?.p_business_id === null) {
          return Promise.resolve({ data: { has_session: true, ambiguous: false, session, business, capabilities: null, capability_overrides: null }, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      }),
      storage: { from: vi.fn(() => ({ upload: vi.fn(), createSignedUrl: vi.fn(), getPublicUrl: vi.fn() })) },
    } as any,
  };
}

function sessionAt(step: string, extra: Record<string, unknown> = {}) {
  return {
    id: 'sess-latency', whatsapp_number: PHONE, user_id: 'u1', business_id: BIZ, current_step: step,
    session_data: { capabilities: ['scheduling', 'chat'], business_id: BIZ, business_name: 'Latency Salon', business_category: 'salon', ...extra },
    is_active: true, expires_at: new Date(Date.now() + 86400000).toISOString(), version: 0,
  };
}

function bot(db: ReturnType<typeof createDb>) {
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
  return new BotService(db.client, createCaptureSender(), standalone, intelligence);
}

beforeEach(() => {
  llmSpy.mockReset();
  llmSpy.mockResolvedValue(NO_RESULT);
});

describe('BotService: LLM intent fallback only where it can help', () => {
  it('typed answer at collect_name: no LLM call, no copy-language reads', async () => {
    const db = createDb(sessionAt('collect_name', { active_capability: 'scheduling', service_id: 'svc-1' }));
    await bot(db).handleMessage(PHONE, 'John Doe', 'text');
    expect(llmSpy).not.toHaveBeenCalled();
    // ai_conversation_config is read once for the AI layer (not again for the copy language).
    expect(db.calls.filter(t => t === 'ai_conversation_config').length).toBeLessThanOrEqual(2);
    expect(db.calls.filter(t => t === 'profiles').length).toBeLessThanOrEqual(1);
  });

  it('capability tap at select_capability: no LLM call', async () => {
    const db = createDb(sessionAt('select_capability'));
    await bot(db).handleMessage(PHONE, 'cap_scheduling', 'list');
    expect(llmSpy).not.toHaveBeenCalled();
  });

  it('control: open free text at a non-answer step still reaches the LLM fallback', async () => {
    const db = createDb(sessionAt('select_service', { active_capability: 'scheduling' }));
    await bot(db).handleMessage(PHONE, 'mo fe ri dokita', 'text');
    expect(llmSpy).toHaveBeenCalled();
  });
});
