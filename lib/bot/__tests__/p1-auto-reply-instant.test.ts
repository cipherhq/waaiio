/**
 * P1-AUTO-1 — Instant reply runtime tests.
 * Verifies that instant_reply_message is sent on first contact during business hours,
 * and that all dedup/capability/config guards work correctly.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Module-level mocks ──
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

// Mock business-hours so we can control isOpen
const mockIsWithinBusinessHours = vi.fn().mockReturnValue(true);
vi.mock('@/lib/bot/business-hours', () => ({
  isWithinBusinessHours: (...args: unknown[]) => mockIsWithinBusinessHours(...args),
  // Re-export the type (not runtime but needed for type imports)
}));

import { BotService } from '../bot.service';
import { createCaptureSender } from './bot-harness';
import type { StandaloneService } from '../standalone.service';
import type { BotIntelligenceService } from '../bot-intelligence';

// ── Mock factories ──

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
      if (table === 'bot_sessions') return makeChain(config.activeSession);
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
    rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
    storage: { from: vi.fn(() => ({ upload: vi.fn(), createSignedUrl: vi.fn(), getPublicUrl: vi.fn() })) },
  } as any;
}

function createMockStandalone(overrides?: Partial<{
  auto_reply_enabled: boolean;
  business_hours: Record<string, unknown> | null;
  away_message: string | null;
  instant_reply_enabled: boolean;
  instant_reply_message: string | null;
}>): StandaloneService {
  const o = overrides || {};
  const has = (k: string) => k in o;
  return {
    loadWhatsAppConfigBundle: vi.fn().mockResolvedValue({
      templates: { greeting: 'Welcome!' },
      welcome_buttons: [],
      quick_replies: [],
      default_reply: null,
      alias: null,
      auto_reply_enabled: has('auto_reply_enabled') ? o.auto_reply_enabled : true,
      business_hours: has('business_hours') ? o.business_hours : { timezone: 'UTC', monday: { open: '09:00', close: '17:00', enabled: true } },
      away_message: has('away_message') ? o.away_message : 'We are closed.',
      instant_reply_enabled: has('instant_reply_enabled') ? o.instant_reply_enabled : true,
      instant_reply_message: has('instant_reply_message') ? o.instant_reply_message : 'Thanks for reaching out! We\'ll be with you shortly.',
    }),
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
const BIZ_ID = 'biz-auto-reply';

const BIZ_GROWTH = {
  id: BIZ_ID, status: 'active', subscription_tier: 'growth',
  trial_ends_at: null, category: 'salon', name: 'Test Salon',
  slug: 'test-salon', flow_type: 'scheduling', metadata: {},
  country_code: 'NG', is_whitelabel: false,
};

const BIZ_FREE = {
  ...BIZ_GROWTH, subscription_tier: 'free',
};

const CAPS_WITH_AUTO_REPLY = [
  { capability: 'scheduling', is_enabled: true, sort_order: 0 },
  { capability: 'auto_reply', is_enabled: true, sort_order: 1 },
];

const CAPS_WITHOUT_AUTO_REPLY = [
  { capability: 'scheduling', is_enabled: true, sort_order: 0 },
];

// ═══════════════════════════════════════════════════════
// P1-AUTO-1: AUTO-REPLY ENTITLEMENT + INSTANT REPLY TESTS
// ═══════════════════════════════════════════════════════

describe('P1-AUTO-1: Auto-reply entitlement and instant reply runtime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsWithinBusinessHours.mockReturnValue(true); // default: during business hours
  });

  // ── Entitlement gate (both away + instant) ──

  it('1. effective auto_reply + outside hours → away message fires', async () => {
    mockIsWithinBusinessHours.mockReturnValue(false);
    const sender = createCaptureSender();
    const supabase = createTableMock({
      activeSession: null,
      business: BIZ_GROWTH,
      capabilities: CAPS_WITH_AUTO_REPLY,
      enabledLanguages: ['en'],
    });
    const standalone = createMockStandalone();
    const bot = new BotService(supabase, sender, standalone, createMockIntelligence());
    await bot.handleMessage(PHONE, 'hello', 'text', undefined, BIZ_ID);

    const texts = sender.getTextMessages();
    expect(texts).toContain('We are closed.');
    expect(texts).not.toContain('Thanks for reaching out! We\'ll be with you shortly.');
  });

  it('2. NO effective auto_reply + outside hours → away message does NOT fire', async () => {
    mockIsWithinBusinessHours.mockReturnValue(false);
    const sender = createCaptureSender();
    const supabase = createTableMock({
      activeSession: null,
      business: BIZ_FREE,
      capabilities: CAPS_WITHOUT_AUTO_REPLY,
      enabledLanguages: ['en'],
    });
    const standalone = createMockStandalone();
    const bot = new BotService(supabase, sender, standalone, createMockIntelligence());
    await bot.handleMessage(PHONE, 'hello', 'text', undefined, BIZ_ID);

    const texts = sender.getTextMessages();
    expect(texts).not.toContain('We are closed.');
  });

  it('3. effective auto_reply + inside hours + instant enabled → instant reply fires', async () => {
    const sender = createCaptureSender();
    const supabase = createTableMock({
      activeSession: null,
      business: BIZ_GROWTH,
      capabilities: CAPS_WITH_AUTO_REPLY,
      enabledLanguages: ['en'],
    });
    const standalone = createMockStandalone();
    const bot = new BotService(supabase, sender, standalone, createMockIntelligence());
    await bot.handleMessage(PHONE, 'hello', 'text', undefined, BIZ_ID);

    const texts = sender.getTextMessages();
    expect(texts).toContain('Thanks for reaching out! We\'ll be with you shortly.');
  });

  it('4. NO effective auto_reply + inside hours → instant reply does NOT fire', async () => {
    const sender = createCaptureSender();
    const supabase = createTableMock({
      activeSession: null,
      business: BIZ_FREE,
      capabilities: CAPS_WITHOUT_AUTO_REPLY,
      enabledLanguages: ['en'],
    });
    const standalone = createMockStandalone();
    const bot = new BotService(supabase, sender, standalone, createMockIntelligence());
    await bot.handleMessage(PHONE, 'hello', 'text', undefined, BIZ_ID);

    const texts = sender.getTextMessages();
    expect(texts).not.toContain('Thanks for reaching out! We\'ll be with you shortly.');
  });

  it('5. auto_reply_enabled=false → neither away nor instant fires', async () => {
    mockIsWithinBusinessHours.mockReturnValue(false);
    const sender = createCaptureSender();
    const supabase = createTableMock({
      activeSession: null,
      business: BIZ_GROWTH,
      capabilities: CAPS_WITH_AUTO_REPLY,
      enabledLanguages: ['en'],
    });
    const standalone = createMockStandalone({ auto_reply_enabled: false });
    const bot = new BotService(supabase, sender, standalone, createMockIntelligence());
    await bot.handleMessage(PHONE, 'hello', 'text', undefined, BIZ_ID);

    const texts = sender.getTextMessages();
    expect(texts).not.toContain('We are closed.');
    expect(texts).not.toContain('Thanks for reaching out! We\'ll be with you shortly.');
  });

  it('6. active session → neither away nor instant fires (first-contact dedup)', async () => {
    // Test outside hours with session
    mockIsWithinBusinessHours.mockReturnValue(false);
    const sender = createCaptureSender();
    const supabase = createTableMock({
      activeSession: {
        id: 'session-1', phone_number: PHONE, business_id: BIZ_ID,
        flow: 'capability_selection', current_step: 'choose', session_data: {},
        step_history: [], created_at: new Date().toISOString(),
      },
      business: BIZ_GROWTH,
      capabilities: CAPS_WITH_AUTO_REPLY,
      enabledLanguages: ['en'],
    });
    const standalone = createMockStandalone();
    const bot = new BotService(supabase, sender, standalone, createMockIntelligence());
    await bot.handleMessage(PHONE, 'hello', 'text', undefined, BIZ_ID);

    const texts = sender.getTextMessages();
    expect(texts).not.toContain('We are closed.');
    expect(texts).not.toContain('Thanks for reaching out! We\'ll be with you shortly.');
  });

  it('7. normal bot routing continues when no auto_reply entitlement', async () => {
    const sender = createCaptureSender();
    const supabase = createTableMock({
      activeSession: null,
      business: BIZ_FREE,
      capabilities: CAPS_WITHOUT_AUTO_REPLY,
      enabledLanguages: ['en'],
    });
    const standalone = createMockStandalone();
    const bot = new BotService(supabase, sender, standalone, createMockIntelligence());
    await bot.handleMessage(PHONE, 'hello', 'text', undefined, BIZ_ID);

    const msgs = sender.getMessages();
    // Bot still sends greeting/menu — not blocked by missing auto_reply
    expect(msgs.length).toBeGreaterThanOrEqual(1);
    // No auto-reply messages leaked
    const texts = sender.getTextMessages();
    expect(texts).not.toContain('We are closed.');
    expect(texts).not.toContain('Thanks for reaching out! We\'ll be with you shortly.');
  });

  it('8. entitlement comes from canonical resolver, not manual tier check', async () => {
    // Business on free tier BUT with auto_reply override (e.g. admin-granted)
    // The canonical resolver sees the override and includes auto_reply in effective caps
    // → auto-reply should fire because the resolver grants it, not because of manual tier check
    const sender = createCaptureSender();
    const supabase = createTableMock({
      activeSession: null,
      business: BIZ_FREE, // free tier
      capabilities: CAPS_WITH_AUTO_REPLY,
      overrides: ['auto_reply'], // admin override grants auto_reply despite free tier
      enabledLanguages: ['en'],
    });
    const standalone = createMockStandalone();
    const bot = new BotService(supabase, sender, standalone, createMockIntelligence());
    await bot.handleMessage(PHONE, 'hello', 'text', undefined, BIZ_ID);

    const texts = sender.getTextMessages();
    // Should fire because canonical resolver includes auto_reply via override
    expect(texts).toContain('Thanks for reaching out! We\'ll be with you shortly.');
  });

  // ── Instant reply config guards ──

  it('9. does NOT send instant reply when instant_reply_message is empty', async () => {
    const sender = createCaptureSender();
    const supabase = createTableMock({
      activeSession: null,
      business: BIZ_GROWTH,
      capabilities: CAPS_WITH_AUTO_REPLY,
      enabledLanguages: ['en'],
    });
    const standalone = createMockStandalone({ instant_reply_message: null });
    const bot = new BotService(supabase, sender, standalone, createMockIntelligence());
    await bot.handleMessage(PHONE, 'hello', 'text', undefined, BIZ_ID);

    const texts = sender.getTextMessages();
    expect(texts).not.toContain('Thanks for reaching out! We\'ll be with you shortly.');
  });

  it('10. does NOT send instant reply when instant_reply_enabled is false', async () => {
    const sender = createCaptureSender();
    const supabase = createTableMock({
      activeSession: null,
      business: BIZ_GROWTH,
      capabilities: CAPS_WITH_AUTO_REPLY,
      enabledLanguages: ['en'],
    });
    const standalone = createMockStandalone({ instant_reply_enabled: false });
    const bot = new BotService(supabase, sender, standalone, createMockIntelligence());
    await bot.handleMessage(PHONE, 'hello', 'text', undefined, BIZ_ID);

    const texts = sender.getTextMessages();
    expect(texts).not.toContain('Thanks for reaching out! We\'ll be with you shortly.');
  });

  it('11. does NOT send instant reply when business_hours is null', async () => {
    const sender = createCaptureSender();
    const supabase = createTableMock({
      activeSession: null,
      business: BIZ_GROWTH,
      capabilities: CAPS_WITH_AUTO_REPLY,
      enabledLanguages: ['en'],
    });
    const standalone = createMockStandalone({ business_hours: null });
    const bot = new BotService(supabase, sender, standalone, createMockIntelligence());
    await bot.handleMessage(PHONE, 'hello', 'text', undefined, BIZ_ID);

    const texts = sender.getTextMessages();
    expect(texts).not.toContain('Thanks for reaching out! We\'ll be with you shortly.');
  });

  it('12. normal bot flow still runs after instant reply', async () => {
    const sender = createCaptureSender();
    const supabase = createTableMock({
      activeSession: null,
      business: BIZ_GROWTH,
      capabilities: CAPS_WITH_AUTO_REPLY,
      enabledLanguages: ['en'],
    });
    const standalone = createMockStandalone();
    const bot = new BotService(supabase, sender, standalone, createMockIntelligence());
    await bot.handleMessage(PHONE, 'hello', 'text', undefined, BIZ_ID);

    const msgs = sender.getMessages();
    // Instant reply + at least one more message (greeting/menu/etc)
    expect(msgs.length).toBeGreaterThanOrEqual(2);
    // First message should be the instant reply
    expect(msgs[0].text).toBe('Thanks for reaching out! We\'ll be with you shortly.');
  });

  it('13. sends custom instant reply message', async () => {
    const customMsg = 'Welcome to our salon! A team member will assist you soon.';
    const sender = createCaptureSender();
    const supabase = createTableMock({
      activeSession: null,
      business: BIZ_GROWTH,
      capabilities: CAPS_WITH_AUTO_REPLY,
      enabledLanguages: ['en'],
    });
    const standalone = createMockStandalone({ instant_reply_message: customMsg });
    const bot = new BotService(supabase, sender, standalone, createMockIntelligence());
    await bot.handleMessage(PHONE, 'hello', 'text', undefined, BIZ_ID);

    const texts = sender.getTextMessages();
    expect(texts).toContain(customMsg);
  });
});
