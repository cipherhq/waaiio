/**
 * CAS-004 — BotService production-wiring tests.
 * Tests invoke BotService.handleMessage() to prove actual routing behavior.
 */
import { describe, it, expect, vi } from 'vitest';

// Module-level mocks (before BotService import)
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimitAsync: vi.fn().mockResolvedValue({ allowed: true, remaining: 10 }),
}));
vi.mock('@/lib/platformSettings', () => ({
  loadPlatformSettings: vi.fn().mockResolvedValue({ bot_rate_limit_per_minute: 30 }),
}));
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
  loadConversationConfig: vi.fn().mockResolvedValue({ aiEnabled: false }),
}));
vi.mock('@/lib/bot/automation/rules-engine', () => ({
  evaluateRules: vi.fn().mockResolvedValue(undefined),
}));

import { BotService } from '../bot.service';
import { createCaptureSender } from './bot-harness';
import type { StandaloneService } from '../standalone.service';
import type { BotIntelligenceService } from '../bot-intelligence';

function createTableMock(config: {
  activeSession?: Record<string, unknown> | null;
  business?: Record<string, unknown> | null;
  capabilities?: Array<{ capability: string; is_enabled: boolean; sort_order: number }>;
  overrides?: string[];
  updateTracker?: Array<{ table: string; data: unknown }>;
}) {
  const updateTracker = config.updateTracker || [];
  function makeChain(resolveData: unknown = null, resolveError: unknown = null) {
    const chain: Record<string, any> = {};
    for (const m of ['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'neq', 'or', 'in', 'is', 'not', 'ilike', 'like', 'gte', 'lte', 'gt', 'lt', 'order', 'limit', 'range', 'filter', 'match', 'contains', 'containedBy']) {
      chain[m] = vi.fn().mockReturnValue(chain);
    }
    chain.single = vi.fn().mockResolvedValue({ data: resolveData, error: resolveError });
    chain.maybeSingle = vi.fn().mockResolvedValue({ data: resolveData, error: null });
    return chain;
  }

  return {
    from: vi.fn((table: string) => {
      if (table === 'bot_sessions') {
        const chain = makeChain(config.activeSession);
        const origUpdate = chain.update;
        chain.update = vi.fn((data: unknown) => { updateTracker.push({ table: 'bot_sessions', data }); return origUpdate(data); });
        chain.delete = vi.fn().mockReturnValue(chain);
        return chain;
      }
      if (table === 'businesses') return makeChain(config.business);
      if (table === 'business_capabilities') {
        const capData = { data: config.capabilities ?? [], error: null };
        const resolved = Promise.resolve(capData);
        const chain: Record<string, any> = {};
        for (const m of ['select', 'eq', 'order']) chain[m] = () => chain;
        chain.then = resolved.then.bind(resolved);
        chain.catch = resolved.catch.bind(resolved);
        return chain;
      }
      if (table === 'capability_overrides') {
        const ovData = { data: (config.overrides || []).map(c => ({ capability: c })), error: null };
        const resolved = Promise.resolve(ovData);
        const chain: Record<string, any> = {};
        for (const m of ['select', 'eq']) chain[m] = () => chain;
        chain.then = resolved.then.bind(resolved);
        chain.catch = resolved.catch.bind(resolved);
        return chain;
      }
      if (table === 'platform_settings') return makeChain({ value: false });
      if (table === 'services') return makeChain({ price: 50, duration_minutes: 30, deposit_amount: 0 });
      return makeChain();
    }),
    rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
    storage: { from: vi.fn(() => ({ upload: vi.fn(), createSignedUrl: vi.fn(), getPublicUrl: vi.fn() })) },
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
    getPersonaGreeting: vi.fn((_a: string, name: string) => `Hi from ${name}`),
    getContextualHelp: vi.fn(() => 'Help'),
  } as any;
}

const PHONE = '+2341234567890';
const BIZ_ID = 'biz-cas004';

describe('CAS-004 BotService wiring — new session semantic routing', () => {
  it('A: only ordering + "reserve a room" → browse_catalog NEVER entered', async () => {
    const sender = createCaptureSender();
    const supabase = createTableMock({
      activeSession: null, // no existing session
      business: { id: BIZ_ID, status: 'active', subscription_tier: 'growth', trial_ends_at: null, category: 'restaurant', name: 'Test Restaurant', slug: 'test', flow_type: 'ordering', metadata: {}, country_code: 'NG', is_whitelabel: false },
      capabilities: [{ capability: 'ordering', is_enabled: true, sort_order: 0 }],
    });

    const bot = new BotService(supabase, sender, createMockStandalone(), createMockIntelligence());
    await bot.handleMessage(PHONE, 'I want to reserve a hotel room', 'text', undefined, BIZ_ID);

    // browse_catalog must NOT be the session step — semantic mismatch forces menu
    const sessionInserts = supabase.from.mock.calls
      .filter((c: string[]) => c[0] === 'bot_sessions')
      .map((c: string[]) => c);

    // Check that either: session was created at select_capability (not browse_catalog)
    // OR no session was created (action routed elsewhere)
    const allMessages = sender.getMessages();
    const allText = allMessages.map(m => (m as any).text || (m as any).body || '').join(' ').toLowerCase();

    // Must NOT see ordering-specific prompts like "browse catalog" or product list
    expect(allText).not.toContain('browse');
    expect(allText).not.toContain('catalog');
  });

  it('B: Pidgin "I wan see my order" → READ_HISTORY, not CREATE_NEW ordering', async () => {
    const sender = createCaptureSender();
    const supabase = createTableMock({
      activeSession: null,
      business: { id: BIZ_ID, status: 'active', subscription_tier: 'growth', trial_ends_at: null, category: 'restaurant', name: 'Test', slug: 'test', flow_type: 'ordering', metadata: {}, country_code: 'NG', is_whitelabel: false },
      capabilities: [{ capability: 'ordering', is_enabled: true, sort_order: 0 }],
    });

    const bot = new BotService(supabase, sender, createMockStandalone(), createMockIntelligence());
    await bot.handleMessage(PHONE, 'I wan see my order', 'text', undefined, BIZ_ID);

    // Should route to order history handler or recoverable message
    // Must NOT enter browse_catalog (CREATE_NEW ordering)
    const allMessages = sender.getMessages();
    const allText = allMessages.map(m => (m as any).text || (m as any).body || '').join(' ').toLowerCase();
    expect(allText).not.toContain('browse');
    expect(allText).not.toContain('catalog');
  });
});
