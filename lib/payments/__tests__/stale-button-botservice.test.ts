/**
 * #197: BotService.handleMessage() stale i_paid execution test.
 *
 * Strategy: Instantiate the REAL BotService with mocked dependencies
 * (same pattern as cas-004-botservice-wiring.test.ts). Call the real
 * handleMessage() with button postbacks and verify the stale-payment
 * recovery path is reached.
 *
 * The session is set to `select_capability` (the payment capability menu).
 * When a stale `i_paid` / `i_paid_online` button arrives at this step,
 * BotService should dispatch to the recovery module.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Module-level mocks (same as cas-004-botservice-wiring) ──
vi.mock('@/lib/rate-limit', () => ({ checkRateLimitAsync: vi.fn().mockResolvedValue({ allowed: true, remaining: 10 }) }));
vi.mock('@/lib/platformSettings', () => ({ loadPlatformSettings: vi.fn().mockResolvedValue({ bot_rate_limit_per_minute: 30 }) }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('@/lib/bot/translate', () => ({
  translateBotResponse: vi.fn(async (t: string) => t),
  detectLanguage: vi.fn(async () => 'en'),
  getLanguageName: vi.fn(() => 'English'),
  setTranslationContext: vi.fn(),
}));
vi.mock('@/lib/bot/handlers/global-queries', () => ({
  handleGlobalQuery: vi.fn(async (opts: { session: unknown }) => ({ handled: false, session: opts.session })),
  isOrdersQuery: vi.fn(() => false),
}));
vi.mock('@/lib/bot/handlers/escape-hatches', () => ({
  HOME_PATTERN: /^home$/i,
  handleEscapeHatch: vi.fn().mockResolvedValue({ handled: false }),
}));
vi.mock('@/lib/bot/keyword-service', () => ({
  loadBotCustomConfig: vi.fn().mockResolvedValue({ welcome_buttons: [], quick_replies: [], default_reply: null }),
  matchQuickReply: vi.fn(() => null),
  loadUnifiedKeywords: vi.fn().mockResolvedValue([]),
  matchUnifiedKeyword: vi.fn(() => null),
}));
vi.mock('@/lib/bot/confidence-policy', () => ({
  loadConversationConfig: vi.fn().mockResolvedValue({
    aiEnabled: false, autoRouteThreshold: 0.85, clarificationThreshold: 0.60,
    fallbackBehavior: 'menu', faqEnabled: true, knowledgeEnabled: true,
    assistantName: 'Assistant', tone: 'friendly',
  }),
}));
vi.mock('@/lib/bot/automation/rules-engine', () => ({ evaluateRules: vi.fn().mockResolvedValue(undefined) }));

// ── Mock stale-payment-recovery to capture dispatch calls ──
const recoverGenericCalls: unknown[] = [];
const recoverByRefCalls: Array<{ ref: string }> = [];

vi.mock('@/lib/payments/stale-payment-recovery', () => ({
  recoverByOrderReference: vi.fn().mockImplementation(async (_ctx: unknown, ref: string) => {
    recoverByRefCalls.push({ ref });
    return { type: 'confirmed', message: '✅ Payment Confirmed!', referenceCode: ref, amount: 121000, countryCode: 'NG' };
  }),
  recoverGeneric: vi.fn().mockImplementation(async () => {
    recoverGenericCalls.push({});
    return { type: 'confirmed', message: '✅ Payment Confirmed!', referenceCode: 'WA-OR-0001', amount: 121000, countryCode: 'NG' };
  }),
}));

import { BotService } from '@/lib/bot/bot.service';
import { createCaptureSender } from '@/lib/bot/__tests__/bot-harness';
import type { StandaloneService } from '@/lib/bot/standalone.service';
import type { BotIntelligenceService } from '@/lib/bot/bot-intelligence';

// ── Reusable mock factories (from cas-004 pattern) ──

function createTableMock(config: {
  activeSession?: Record<string, unknown> | null;
  business?: Record<string, unknown> | null;
  capabilities?: Array<{ capability: string; is_enabled: boolean; sort_order: number }>;
  overrides?: string[];
  enabledLanguages?: string[];
}) {
  function makeChain(resolveData: unknown = null) {
    const chain: Record<string, any> = {};
    for (const m of ['select','insert','update','upsert','delete','eq','neq','or','in','is','not','ilike','like','gte','lte','gt','lt','order','limit','range','filter','match','contains','containedBy'])
      chain[m] = vi.fn().mockReturnValue(chain);
    chain.single = vi.fn().mockResolvedValue({ data: resolveData, error: resolveData ? null : { message: 'not found' } });
    chain.maybeSingle = vi.fn().mockResolvedValue({ data: resolveData, error: null });
    return chain;
  }

  return {
    from: vi.fn((table: string) => {
      if (table === 'bot_sessions') {
        const chain = makeChain(config.activeSession);
        chain.update = vi.fn().mockReturnValue(chain);
        chain.delete = vi.fn().mockReturnValue(chain);
        return chain;
      }
      if (table === 'businesses') return makeChain(config.business);
      if (table === 'business_capabilities') {
        const d = Promise.resolve({ data: config.capabilities ?? [], error: null });
        const c: Record<string, any> = {};
        for (const m of ['select','eq','order']) c[m] = () => c;
        c.then = d.then.bind(d); c.catch = d.catch.bind(d);
        return c;
      }
      if (table === 'capability_overrides') {
        const d = Promise.resolve({ data: (config.overrides || []).map(c => ({ capability: c })), error: null });
        const c: Record<string, any> = {};
        for (const m of ['select','eq']) c[m] = () => c;
        c.then = d.then.bind(d); c.catch = d.catch.bind(d);
        return c;
      }
      if (table === 'ai_conversation_config') {
        return makeChain(config.enabledLanguages ? { enabled_languages: config.enabledLanguages } : null);
      }
      if (table === 'platform_settings') return makeChain({ value: false });
      if (table === 'profiles') return makeChain({ id: 'profile-1' });
      return makeChain();
    }),
    // Mock RPC: update_session_cas returns success so capability refresh doesn't bail
    rpc: vi.fn().mockResolvedValue({
      data: { success: true, version: 1, current_step: 'select_capability' },
      error: null,
    }),
    storage: { from: vi.fn(() => ({ upload: vi.fn(), createSignedUrl: vi.fn(), getPublicUrl: vi.fn() })) },
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null }, error: null }) },
  } as any;
}

function createMockStandalone(): StandaloneService {
  return {
    loadWhatsAppConfigBundle: vi.fn().mockResolvedValue({ templates: { greeting: 'Welcome!' }, welcome_buttons: [], auto_reply_enabled: false, business_hours: null, alias: null }),
    checkTierLimitsFromBusiness: vi.fn().mockResolvedValue({ allowed: true, isWhitelabel: false }),
    fillTemplate: vi.fn((t: string) => t),
    getBotAlias: vi.fn().mockResolvedValue(null),
  } as any;
}

function createMockIntelligence(): BotIntelligenceService {
  return {
    isTimedOut: vi.fn(() => ({ timedOut: false, remaining: 0 })),
    containsProfanity: vi.fn(() => false),
    recordProfanity: vi.fn(() => ({ timeout: false, warn: false })),
    resetAbuse: vi.fn(),
    getHelpText: vi.fn(() => 'Help'),
    getPersonaGreeting: vi.fn((_a: string, n: string) => `Hi from ${n}`),
    getContextualHelp: vi.fn(() => 'Help'),
  } as any;
}

const PHONE = '+2341234567890';
const BIZ_ID = 'biz-test-197';

// Session at select_capability — the payment menu step
function makeSelectCapabilitySession() {
  return {
    id: 'sess-197-stale',
    whatsapp_number: PHONE,
    user_id: 'u-197',
    business_id: BIZ_ID,
    current_step: 'select_capability',
    session_data: {
      capabilities: ['ordering', 'payment'],
      active_capability: null,
      business_id: BIZ_ID,
      business_name: 'Test Store 197',
      business_category: 'restaurant',
    },
    is_active: true,
    expires_at: new Date(Date.now() + 86400000).toISOString(),
    version: 1,
  };
}

function makeBusiness() {
  return {
    id: BIZ_ID, status: 'active', subscription_tier: 'growth',
    trial_ends_at: null, category: 'restaurant', name: 'Test Store 197',
    slug: 'test-store-197', flow_type: 'ordering', metadata: {},
    country_code: 'NG', is_whitelabel: false, payment_gateway: 'paystack',
  };
}

// ═══════════════════════════════════════════════════════
// REAL BotService.handleMessage() EXECUTION TESTS
// ═══════════════════════════════════════════════════════

describe('BotService.handleMessage stale i_paid execution (#197)', () => {

  beforeEach(() => {
    recoverGenericCalls.length = 0;
    recoverByRefCalls.length = 0;
  });

  it('i_paid button at select_capability → dispatches recoverGeneric via real handleMessage', async () => {
    const sender = createCaptureSender();
    const supabase = createTableMock({
      activeSession: makeSelectCapabilitySession(),
      business: makeBusiness(),
      capabilities: [
        { capability: 'ordering', is_enabled: true, sort_order: 0 },
        { capability: 'payment', is_enabled: true, sort_order: 1 },
      ],
      enabledLanguages: ['en'],
    });

    const bot = new BotService(supabase, sender, createMockStandalone(), createMockIntelligence());
    // messageType='button' is critical — parser only fires on button postbacks
    await bot.handleMessage(PHONE, 'i_paid', 'button');

    expect(recoverGenericCalls.length).toBe(1);
    expect(recoverByRefCalls.length).toBe(0);
    expect(sender.hasMessageContaining('Payment Confirmed')).toBe(true);
  });

  it('i_paid_online button at select_capability → dispatches recoverGeneric', async () => {
    const sender = createCaptureSender();
    const supabase = createTableMock({
      activeSession: makeSelectCapabilitySession(),
      business: makeBusiness(),
      capabilities: [
        { capability: 'ordering', is_enabled: true, sort_order: 0 },
        { capability: 'payment', is_enabled: true, sort_order: 1 },
      ],
      enabledLanguages: ['en'],
    });

    const bot = new BotService(supabase, sender, createMockStandalone(), createMockIntelligence());
    await bot.handleMessage(PHONE, 'i_paid_online', 'button');

    expect(recoverGenericCalls.length).toBe(1);
    expect(sender.hasMessageContaining('Payment Confirmed')).toBe(true);
  });

  it('i_paid:WA-OR-0981 button → dispatches recoverByOrderReference with exact ref', async () => {
    const sender = createCaptureSender();
    const supabase = createTableMock({
      activeSession: makeSelectCapabilitySession(),
      business: makeBusiness(),
      capabilities: [
        { capability: 'ordering', is_enabled: true, sort_order: 0 },
        { capability: 'payment', is_enabled: true, sort_order: 1 },
      ],
      enabledLanguages: ['en'],
    });

    const bot = new BotService(supabase, sender, createMockStandalone(), createMockIntelligence());
    await bot.handleMessage(PHONE, 'i_paid:WA-OR-0981', 'button');

    expect(recoverByRefCalls.length).toBe(1);
    expect(recoverByRefCalls[0].ref).toBe('WA-OR-0981');
    expect(recoverGenericCalls.length).toBe(0);
    expect(sender.hasMessageContaining('Payment Confirmed')).toBe(true);
  });

  it('i_paid_online:WA-OR-0456 button → dispatches recoverByOrderReference', async () => {
    const sender = createCaptureSender();
    const supabase = createTableMock({
      activeSession: makeSelectCapabilitySession(),
      business: makeBusiness(),
      capabilities: [
        { capability: 'ordering', is_enabled: true, sort_order: 0 },
        { capability: 'payment', is_enabled: true, sort_order: 1 },
      ],
      enabledLanguages: ['en'],
    });

    const bot = new BotService(supabase, sender, createMockStandalone(), createMockIntelligence());
    await bot.handleMessage(PHONE, 'i_paid_online:WA-OR-0456', 'button');

    expect(recoverByRefCalls.length).toBe(1);
    expect(recoverByRefCalls[0].ref).toBe('WA-OR-0456');
    expect(sender.hasMessageContaining('Payment Confirmed')).toBe(true);
  });

  it('free text "paid" (messageType=text) → does NOT trigger recovery', async () => {
    const sender = createCaptureSender();
    const supabase = createTableMock({
      activeSession: makeSelectCapabilitySession(),
      business: makeBusiness(),
      capabilities: [
        { capability: 'ordering', is_enabled: true, sort_order: 0 },
        { capability: 'payment', is_enabled: true, sort_order: 1 },
      ],
      enabledLanguages: ['en'],
    });

    const bot = new BotService(supabase, sender, createMockStandalone(), createMockIntelligence());
    await bot.handleMessage(PHONE, 'paid', 'text');

    expect(recoverGenericCalls.length).toBe(0);
    expect(recoverByRefCalls.length).toBe(0);
  });

  it('free text "done" (messageType=text) → does NOT trigger recovery', async () => {
    const sender = createCaptureSender();
    const supabase = createTableMock({
      activeSession: makeSelectCapabilitySession(),
      business: makeBusiness(),
      capabilities: [
        { capability: 'ordering', is_enabled: true, sort_order: 0 },
        { capability: 'payment', is_enabled: true, sort_order: 1 },
      ],
      enabledLanguages: ['en'],
    });

    const bot = new BotService(supabase, sender, createMockStandalone(), createMockIntelligence());
    await bot.handleMessage(PHONE, 'done', 'text');

    expect(recoverGenericCalls.length).toBe(0);
    expect(recoverByRefCalls.length).toBe(0);
  });

  it('malformed i_paid: (empty ref, button) → fails closed, no recovery', async () => {
    const sender = createCaptureSender();
    const supabase = createTableMock({
      activeSession: makeSelectCapabilitySession(),
      business: makeBusiness(),
      capabilities: [
        { capability: 'ordering', is_enabled: true, sort_order: 0 },
        { capability: 'payment', is_enabled: true, sort_order: 1 },
      ],
      enabledLanguages: ['en'],
    });

    const bot = new BotService(supabase, sender, createMockStandalone(), createMockIntelligence());
    await bot.handleMessage(PHONE, 'i_paid:', 'button');

    expect(recoverGenericCalls.length).toBe(0);
    expect(recoverByRefCalls.length).toBe(0);
  });

  it('i_paid button at await_order_payment → NOT stale (legitimate step), no recovery', async () => {
    const sender = createCaptureSender();
    const session = makeSelectCapabilitySession();
    session.current_step = 'await_order_payment';
    session.session_data.active_capability = 'ordering';

    const supabase = createTableMock({
      activeSession: session,
      business: makeBusiness(),
      capabilities: [
        { capability: 'ordering', is_enabled: true, sort_order: 0 },
      ],
      enabledLanguages: ['en'],
    });

    const bot = new BotService(supabase, sender, createMockStandalone(), createMockIntelligence());
    await bot.handleMessage(PHONE, 'i_paid', 'button');

    // At a legitimate payment-waiting step, i_paid goes to normal flow — NOT recovery
    expect(recoverGenericCalls.length).toBe(0);
    expect(recoverByRefCalls.length).toBe(0);
  });
});
