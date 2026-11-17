/**
 * #1065 Owner Option A — real BotService.handleMessage routing for the Stripe
 * PIN-activation "Not now" button. Harness copied from stale-button-botservice.
 *  - During the customer's own Stripe PIN step the tap reaches the PIN handler
 *    and runs the existing typed-cancel RPC.
 *  - After the PIN step has ended (duplicate / stale tap) it is a silent no-op:
 *    no message, no session or card mutation.
 */
import { describe, it, expect, vi } from 'vitest';

const finish = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('@/lib/payments/transaction-followup', () => ({ finishTransactionCardStep: finish, resumePaidTransactionFollowup: vi.fn() }));
// ── Module-level mocks (same as cas-004-botservice-wiring) ──
vi.mock('@/lib/rate-limit', () => ({ checkRateLimitAsync: vi.fn().mockResolvedValue({ allowed: true, remaining: 10 }) }));
vi.mock('@/lib/countries', () => ({ loadCountries: vi.fn().mockResolvedValue([]), getCountry: vi.fn(), getCountryList: vi.fn().mockReturnValue([]), isValidCountryCode: vi.fn().mockReturnValue(true), getDialingCodeMap: vi.fn().mockReturnValue({}) }));
vi.mock('@/lib/platformSettings', () => ({ loadPlatformSettings: vi.fn().mockResolvedValue({ bot_rate_limit_per_minute: 30 }) }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('@/lib/bot/translate', () => ({
  translateBotResponse: vi.fn(async (t: string) => t),
  detectLanguage: vi.fn(async () => 'en'),
  getLanguageName: vi.fn(() => 'English'),
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
    // Mock RPC: handles get_bot_context (#266) and update_session_cas
    rpc: vi.fn().mockImplementation((name: string, params?: Record<string, unknown>) => {
      // #266: bot service calls get_bot_context(phone, NULL) for unresolved sessions
      if (name === 'get_bot_context') {
        if (config.activeSession && params?.p_business_id === null) {
          return Promise.resolve({
            data: {
              has_session: true,
              ambiguous: false,
              session: config.activeSession,
              business: config.business ?? null,
              capabilities: config.capabilities ?? [],
              capability_overrides: (config.overrides || []).map(c => ({ capability: c })),
            },
            error: null,
          });
        }
        return Promise.resolve({ data: { has_session: false, session: null, business: null, capabilities: [], capability_overrides: [] }, error: null });
      }
      // update_session_cas returns success so capability refresh doesn't bail
      return Promise.resolve({
        data: { success: true, version: 1, current_step: 'select_capability' },
        error: null,
      });
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
const BIZ_ID = 'biz-stripe-1065';
const PAY_ID = 'pay-stripe-1065';

function session(step: string, data: Record<string, unknown> = {}) {
  return {
    id: 'sess-1065', whatsapp_number: PHONE.slice(1), user_id: 'u-1065', business_id: BIZ_ID,
    current_step: step, is_active: true, version: 3,
    expires_at: new Date(Date.now() + 86400000).toISOString(),
    session_data: { business_id: BIZ_ID, business_name: 'Stripe Store', business_category: 'restaurant',
      capabilities: ['ordering', 'payment'], active_capability: null, ...data },
  };
}
const stripePinData = {
  _save_card_pending: true, _save_card_business_id: BIZ_ID, _save_card_gateway: 'stripe',
  _save_card_payment_id: PAY_ID, _save_card_offer_id: 'offer-1065', _inbound_channel_id: 'ch-1',
};
const business = {
  id: BIZ_ID, status: 'active', subscription_tier: 'growth', trial_ends_at: null, category: 'restaurant',
  name: 'Stripe Store', slug: 'stripe-store', flow_type: 'ordering', metadata: {}, country_code: 'US',
  is_whitelabel: false, payment_gateway: 'stripe',
};
const capabilities = [
  { capability: 'ordering', is_enabled: true, sort_order: 0 },
  { capability: 'payment', is_enabled: true, sort_order: 1 },
];

async function tap(activeSession: Record<string, unknown>, text: string) {
  finish.mockClear();
  const sender = createCaptureSender();
  const supabase = createTableMock({ activeSession, business, capabilities, enabledLanguages: ['en'] });
  const bot = new BotService(supabase, sender, createMockStandalone(), createMockIntelligence());
  await bot.handleMessage(PHONE, text, 'button');
  const rpcNames = supabase.rpc.mock.calls.map((c: unknown[]) => c[0]);
  return { sender, supabase, rpcNames };
}

describe('BotService routes the Stripe PIN "Not now" button (#1065)', () => {
  it('on the customer\'s own Stripe PIN step it runs the existing typed-cancel RPC and resumes the follow-up', async () => {
    const { sender, supabase, rpcNames } = await tap(session('save_card_pin', stripePinData), `stripe_pin_not_now:${PAY_ID}`);
    expect(rpcNames).toContain('cancel_transaction_card_setup');
    expect(supabase.rpc).toHaveBeenCalledWith('cancel_transaction_card_setup', expect.objectContaining({
      p_payment_id: PAY_ID, p_business_id: BIZ_ID, p_customer_phone: PHONE,
    }));
    expect(sender.hasMessageContaining('Card save cancelled.')).toBe(true);
    expect(finish).toHaveBeenCalledWith(supabase, PAY_ID, PHONE, BIZ_ID);
  });

  it('a tap for another payment on the PIN step does nothing', async () => {
    const { sender, rpcNames } = await tap(session('save_card_pin', stripePinData), 'stripe_pin_not_now:pay-other');
    expect(rpcNames).not.toContain('cancel_transaction_card_setup');
    expect(sender.getMessages()).toEqual([]);
    expect(finish).not.toHaveBeenCalled();
  });

  it.each(['select_capability', 'ordering_menu'])('a stale/duplicate tap after the PIN step ended (%s) is a silent no-op', async step => {
    const { sender, rpcNames } = await tap(session(step), `stripe_pin_not_now:${PAY_ID}`);
    expect(rpcNames).not.toContain('cancel_transaction_card_setup');
    expect(sender.getMessages()).toEqual([]);
    expect(finish).not.toHaveBeenCalled();
  });

  it('a stale tap with no active session is a silent no-op', async () => {
    const { sender, rpcNames } = await tap(null as any, `stripe_pin_not_now:${PAY_ID}`);
    expect(rpcNames).not.toContain('cancel_transaction_card_setup');
    expect(sender.getMessages()).toEqual([]);
  });
});
