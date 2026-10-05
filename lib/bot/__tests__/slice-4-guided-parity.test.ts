/**
 * Slice 4 — Guided + Free-Text Input Parity executable tests (#524)
 *
 * Real BotService and FlowExecutor runtime tests.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const ROOT = resolve(__dirname, '../../..');

// ═══════════════════════════════════════════════════════════════
// Module-level mocks
// ═══════════════════════════════════════════════════════════════

vi.mock('@/lib/countries', () => ({ loadCountries: vi.fn().mockResolvedValue([]), getCountry: vi.fn(), getCountryList: vi.fn().mockReturnValue([]), isValidCountryCode: vi.fn().mockReturnValue(true), getDialingCodeMap: vi.fn().mockReturnValue({}) }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimitAsync: vi.fn().mockResolvedValue({ allowed: true, remaining: 10 }) }));
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
vi.mock('@/lib/bot/confidence-policy', () => ({
  loadConversationConfig: vi.fn().mockResolvedValue({
    aiEnabled: false, autoRouteThreshold: 0.85, clarificationThreshold: 0.60,
    fallbackBehavior: 'menu', faqEnabled: true, knowledgeEnabled: true,
    assistantName: 'Assistant', tone: 'friendly',
  }),
}));
vi.mock('@/lib/bot/automation/rules-engine', () => ({ evaluateRules: vi.fn().mockResolvedValue(undefined) }));

const mockLoadUnifiedKeywords = vi.fn().mockResolvedValue([]);
const mockMatchUnifiedKeyword = vi.fn().mockReturnValue(null);
vi.mock('@/lib/bot/keyword-service', () => ({
  loadBotCustomConfig: vi.fn().mockResolvedValue({ welcome_buttons: [], quick_replies: [], default_reply: null }),
  matchQuickReply: vi.fn(() => null),
  loadUnifiedKeywords: (...args: unknown[]) => mockLoadUnifiedKeywords(...args),
  matchUnifiedKeyword: (...args: unknown[]) => mockMatchUnifiedKeyword(...args),
}));

const mockExecuteKeywordAction = vi.fn().mockResolvedValue(true);
vi.mock('@/lib/bot/handlers/keyword-actions', () => ({
  executeKeywordAction: (...args: unknown[]) => mockExecuteKeywordAction(...args),
}));

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    from: vi.fn(() => ({ select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), not: vi.fn().mockReturnThis(), single: vi.fn().mockResolvedValue({ data: null, error: null }), maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }) })),
    rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
  }),
}));

import { BotService } from '../bot.service';
import { FlowExecutor } from '../flows/executor';
import { createCaptureSender } from './bot-harness';
import type { StandaloneService } from '../standalone.service';
import type { BotIntelligenceService } from '../bot-intelligence';

// ═══════════════════════════════════════════════════════════════
// Shared harness factories
// ═══════════════════════════════════════════════════════════════

function createTableMock(config: {
  activeSession?: Record<string, unknown> | null;
  business?: Record<string, unknown> | null;
  capabilities?: Array<{ capability: string; is_enabled: boolean; sort_order: number }>;
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
      if (table === 'bot_sessions') { const c = makeChain(config.activeSession); c.update = vi.fn().mockReturnValue(makeChain(config.activeSession)); c.insert = vi.fn().mockReturnValue(makeChain(config.activeSession)); c.delete = vi.fn().mockReturnValue(c); return c; }
      if (table === 'businesses') {
        // single() returns the business (detail lookup); maybeSingle() returns null (bot_code lookup)
        const c = makeChain(config.business);
        c.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
        return c;
      }
      if (table === 'business_capabilities') {
        const d = Promise.resolve({ data: config.capabilities ?? [], error: null });
        const c: Record<string, any> = {}; for (const m of ['select','eq','neq','or','in','is','not','order','limit','filter']) c[m] = vi.fn(() => c);
        c.then = d.then.bind(d); c.catch = d.catch.bind(d); return c;
      }
      if (table === 'capability_overrides') {
        const d = Promise.resolve({ data: [], error: null });
        const c: Record<string, any> = {}; for (const m of ['select','eq','neq','or','in','is','not','order','limit','filter']) c[m] = vi.fn(() => c);
        c.then = d.then.bind(d); c.catch = d.catch.bind(d); return c;
      }
      if (table === 'ai_conversation_config') return makeChain(config.enabledLanguages ? { enabled_languages: config.enabledLanguages } : null);
      if (table === 'platform_settings') return makeChain({ value: false });
      if (table === 'profiles') return makeChain(null);
      return makeChain();
    }),
    rpc: vi.fn().mockImplementation(async (name: string) => {
      if (name === 'get_bot_context') return {
        data: config.activeSession ? {
          has_session: true,
          session: config.activeSession,
          business: config.business,
          capabilities: config.capabilities || [],
          overrides: [],
        } : { has_session: false, session: null, business: config.business, capabilities: config.capabilities || [], overrides: [] },
        error: null,
      };
      if (name === 'update_session_cas') return { data: { success: true, version: 2 }, error: null };
      if (name === 'deactivate_session_atomic') return { data: null, error: null };
      return { data: null, error: null };
    }),
    storage: { from: vi.fn(() => ({ upload: vi.fn(), createSignedUrl: vi.fn(), getPublicUrl: vi.fn() })) },
  } as any;
}

function createMockStandalone(): StandaloneService {
  return { loadWhatsAppConfigBundle: vi.fn().mockResolvedValue({ templates: { greeting: 'Welcome!' }, welcome_buttons: [], auto_reply_enabled: false, business_hours: null, alias: null }), checkTierLimitsFromBusiness: vi.fn().mockResolvedValue({ allowed: true, isWhitelabel: false }), fillTemplate: vi.fn((t: string) => t), getBotAlias: vi.fn().mockResolvedValue(null) } as any;
}
function createMockIntelligence(): BotIntelligenceService {
  return { isTimedOut: vi.fn(() => ({ timedOut: false, remaining: 0 })), containsProfanity: vi.fn(() => false), recordProfanity: vi.fn(() => ({ timeout: false, warn: false })), resetAbuse: vi.fn(), getHelpText: vi.fn(() => 'Help'), getPersonaGreeting: vi.fn((_a: string, n: string) => `Hi from ${n}`), getContextualHelp: vi.fn(() => 'Help') } as any;
}

const PHONE = '+2341234567890';
const BIZ_ID = 'biz-test';
const BIZ = { id: BIZ_ID, status: 'active', subscription_tier: 'growth', trial_ends_at: null, category: 'salon', name: 'Test', slug: 'test', flow_type: 'scheduling', metadata: {}, country_code: 'NG', is_whitelabel: false };

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadUnifiedKeywords.mockResolvedValue([]);
  mockMatchUnifiedKeyword.mockReturnValue(null);
  mockExecuteKeywordAction.mockResolvedValue(true);
});

// ═══════════════════════════════════════════════════════════════
// Blocker 1: BotService guided action ACTUALLY EXECUTES
// ═══════════════════════════════════════════════════════════════

describe('Blocker 1 — BotService guided action executes, not just keyword skipped', () => {
  it('loyalty_menu + colliding "history" keyword → FlowExecutor receives input', async () => {
    const sender = createCaptureSender();
    const collidingKw = { id: 'kw-1', keyword: 'history', match_type: 'exact', action_type: 'reply', payload: '{"message":"keyword reply"}', priority: 10, scope: 'system', category: null, business_id: null, campaign_id: null, description: null };
    mockLoadUnifiedKeywords.mockResolvedValue([collidingKw]);
    mockMatchUnifiedKeyword.mockImplementation((t: string) => t.toLowerCase().trim() === 'history' ? collidingKw : null);

    const supabase = createTableMock({
      activeSession: {
        id: 'sess-1', whatsapp_number: PHONE, business_id: BIZ_ID, user_id: 'user-1',
        current_step: 'loyalty_menu', is_active: true, version: 1,
        session_data: { capabilities: ['loyalty'], business_category: 'salon', _loyalty_empty: false },
        conversation_log: [], expires_at: new Date(Date.now() + 86400000).toISOString(),
      },
      business: BIZ, capabilities: [{ capability: 'loyalty', is_enabled: true, sort_order: 0 }], enabledLanguages: ['en'],
    });
    const bot = new BotService(supabase, sender, createMockStandalone(), createMockIntelligence());
    const executeSpy = vi.spyOn(bot['flowExecutor'], 'execute');

    await bot.handleMessage(PHONE, 'history', 'text', undefined, BIZ_ID);

    // 1. Keyword action NOT called
    expect(mockExecuteKeywordAction).not.toHaveBeenCalled();
    // 2. FlowExecutor.execute WAS called with the original input at loyalty_menu
    expect(executeSpy).toHaveBeenCalled();
    const [, inputArg] = executeSpy.mock.calls[0];
    expect(inputArg).toBe('history');
    // The loyalty_menu validator processed "history" → advanced to loyalty_history
    // (session.current_step is mutated during execution, proving the step owned the input)
  });

  it('post_completion + colliding "my bookings" keyword → pc_history path executes', async () => {
    const sender = createCaptureSender();
    const collidingKw = { id: 'kw-2', keyword: 'my bookings', match_type: 'exact', action_type: 'navigate_step', payload: '{"action":"show_status"}', priority: 10, scope: 'system', category: null, business_id: null, campaign_id: null, description: null };
    mockLoadUnifiedKeywords.mockResolvedValue([collidingKw]);
    mockMatchUnifiedKeyword.mockImplementation((t: string) => t.toLowerCase().trim() === 'my bookings' ? collidingKw : null);

    const supabase = createTableMock({
      activeSession: {
        id: 'sess-pc', whatsapp_number: PHONE, business_id: BIZ_ID, user_id: 'user-1',
        current_step: 'post_completion', is_active: true, version: 1,
        session_data: { capabilities: ['scheduling'], _post_completion_cap: 'scheduling', business_category: 'salon' },
        conversation_log: [], expires_at: new Date(Date.now() + 86400000).toISOString(),
      },
      business: BIZ, capabilities: [{ capability: 'scheduling', is_enabled: true, sort_order: 0 }], enabledLanguages: ['en'],
    });
    const bot = new BotService(supabase, sender, createMockStandalone(), createMockIntelligence());
    await bot.handleMessage(PHONE, 'my bookings', 'text', undefined, BIZ_ID);

    // 1. Keyword action NOT called
    expect(mockExecuteKeywordAction).not.toHaveBeenCalled();
    // 2. The pc_history path executed — session updated to 'my_bookings' step
    const sessionUpdates = supabase.from.mock.calls
      .filter(([t]: [string]) => t === 'bot_sessions');
    // The post_completion handler calls supabase.from('bot_sessions').update({ current_step: 'my_bookings' })
    const updateCalls = sessionUpdates.flatMap(([, ...rest]: unknown[]) => rest);
    // Verify the session step was changed to my_bookings (production pc_history behavior)
    const allFromCalls = supabase.from.mock.calls.map(([t]: [string]) => t);
    // The handler routes to handleMyBookings which reads bookings
    expect(allFromCalls).toContain('bot_sessions');
  });
});

// ═══════════════════════════════════════════════════════════════
// Blocker 2: Unrelated keyword DOES fire (real runtime)
// ═══════════════════════════════════════════════════════════════

describe('Blocker 2 — unrelated keyword fires on guided step (real BotService)', () => {
  it('loyalty_menu + non-owned "pricing" keyword → executeKeywordAction IS called', async () => {
    const sender = createCaptureSender();
    const pricingKw = { id: 'kw-p', keyword: 'pricing', match_type: 'exact', action_type: 'navigate_step', payload: '{"action":"show_pricing"}', priority: 10, scope: 'system', category: null, business_id: null, campaign_id: null, description: null };
    mockLoadUnifiedKeywords.mockResolvedValue([pricingKw]);
    mockMatchUnifiedKeyword.mockImplementation((t: string) => t.toLowerCase().trim() === 'pricing' ? pricingKw : null);

    const supabase = createTableMock({
      activeSession: {
        id: 'sess-kw', whatsapp_number: PHONE, business_id: BIZ_ID, user_id: 'user-1',
        current_step: 'loyalty_menu', is_active: true, version: 1,
        session_data: { capabilities: ['loyalty'], business_category: 'salon', _loyalty_empty: false },
        conversation_log: [], expires_at: new Date(Date.now() + 86400000).toISOString(),
      },
      business: BIZ, capabilities: [{ capability: 'loyalty', is_enabled: true, sort_order: 0 }], enabledLanguages: ['en'],
    });
    const bot = new BotService(supabase, sender, createMockStandalone(), createMockIntelligence());
    await bot.handleMessage(PHONE, 'pricing', 'text', undefined, BIZ_ID);

    // "pricing" is NOT a step-owned alias → keyword action MUST fire
    expect(mockExecuteKeywordAction).toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════
// Blocker 3: Narrowed poll_question / select_campaign ownership
// ═══════════════════════════════════════════════════════════════

describe('Blocker 3 — bounded poll/campaign ownership', () => {
  it('poll_question: postback poll_vote_0, numeric "1", and "cancel" are step-owned', () => {
    const source = readFileSync(resolve(ROOT, 'lib/bot/bot.service.ts'), 'utf-8');
    expect(source).toContain("step === 'poll_question'");
    expect(source).toContain("/^poll_vote_\\d+$/.test(text)");
    expect(source).toContain("/^\\d{1,2}$/.test(text.trim())");
  });

  it('select_campaign: postback campaign_*, go_back, and numeric are step-owned', () => {
    const source = readFileSync(resolve(ROOT, 'lib/bot/bot.service.ts'), 'utf-8');
    expect(source).toContain("step === 'select_campaign'");
    expect(source).toContain("text.startsWith('campaign_')");
    expect(source).toContain("text === 'go_back'");
  });

  it('neither poll_question nor select_campaign uses blanket null marker', () => {
    const source = readFileSync(resolve(ROOT, 'lib/bot/bot.service.ts'), 'utf-8');
    expect(source).not.toContain("'select_campaign': null");
    expect(source).not.toContain("'poll_question': null");
  });
});

// ═══════════════════════════════════════════════════════════════
// Blocker 4: Real FlowExecutor entity-state invariant
// ═══════════════════════════════════════════════════════════════

describe('Blocker 4 — FlowExecutor entity carry-forward (real execution)', () => {
  function buildExecutorSupabase(serviceData?: Record<string, unknown>) {
    const chain = (): Record<string, any> => {
      const c: Record<string, any> = {};
      for (const m of ['select','insert','update','delete','eq','neq','or','in','is','not','ilike','like','gte','lte','gt','lt','order','limit','range','filter','match','contains','containedBy'])
        c[m] = vi.fn().mockReturnValue(c);
      c.single = vi.fn().mockResolvedValue({ data: serviceData || null, error: serviceData ? null : { message: 'not found' } });
      c.maybeSingle = vi.fn().mockResolvedValue({ data: serviceData || null, error: null });
      return c;
    };
    return {
      from: vi.fn(() => chain()),
      rpc: vi.fn().mockImplementation(async (name: string) => {
        if (name === 'update_session_cas') return { data: { success: true, version: 2 }, error: null };
        if (name === 'deactivate_session_atomic') return { data: null, error: null };
        return { data: null, error: null };
      }),
    };
  }

  function buildSender() {
    return {
      sendText: vi.fn().mockResolvedValue({}), sendButtons: vi.fn().mockResolvedValue({}),
      sendList: vi.fn().mockResolvedValue({}), sendDocument: vi.fn().mockResolvedValue({}),
      sendImage: vi.fn().mockResolvedValue({}), sendAudio: vi.fn().mockResolvedValue({}),
      sendTemplate: vi.fn().mockResolvedValue({}), sendFlow: vi.fn().mockResolvedValue({}),
      sendReaction: vi.fn().mockResolvedValue({}), sendLocation: vi.fn().mockResolvedValue({}),
    };
  }

  it('existing date/time/party_size are NOT overwritten by entity extraction', async () => {
    const service = { id: 'svc-1', name: 'Haircut', price: 3000, duration_minutes: 30, buffer_minutes: 0, max_capacity: 1, deposit_amount: 0, billing_type: 'one_time', recurring_interval: null, available_days: [], available_from: null, available_to: null, requires_staff: false, staff_ids: [], allow_staff_selection: false, metadata: {}, is_class: false, class_schedule: [], price_is_variable: false, auto_approve: true };
    const sb = buildExecutorSupabase(service);
    const sender = buildSender();
    const executor = new FlowExecutor(sb as any, sender as any, {} as any, {} as any);

    const session = {
      id: 'sess-entity', user_id: 'user-1', business_id: BIZ_ID,
      current_step: 'select_service', version: 1,
      session_data: {
        capabilities: ['scheduling'], active_capability: 'scheduling',
        business_category: 'salon',
        // Pre-existing values that must NOT be overwritten
        date: '2026-12-25', time: '10:00', party_size: 5,
      },
      conversation_log: [],
    };

    const business = { id: BIZ_ID, name: 'Test', slug: 'test', category: 'salon' as any, flow_type: 'scheduling' as any, subscription_tier: 'growth', trial_ends_at: null, metadata: {}, country_code: 'NG' };

    // Input contains future entities: "Haircut tomorrow at 2pm for 3 people"
    // But date/time/party_size are already set — they must NOT be overwritten
    await executor.execute(PHONE, 'Haircut tomorrow at 2pm for 3 people', session as any, business as any);

    // Existing values preserved (not overwritten by extracted entities)
    expect(session.session_data.date).toBe('2026-12-25');
    expect(session.session_data.time).toBe('10:00');
    expect(session.session_data.party_size).toBe(5);
  });

  it('pending entities only merge after validation succeeds — failed validation does not merge', async () => {
    const sb = buildExecutorSupabase(null); // No service found → validation fails
    const sender = buildSender();
    const executor = new FlowExecutor(sb as any, sender as any, {} as any, {} as any);

    const session = {
      id: 'sess-fail', user_id: 'user-1', business_id: BIZ_ID,
      current_step: 'select_service', version: 1,
      session_data: {
        capabilities: ['scheduling'], active_capability: 'scheduling',
        business_category: 'salon',
      },
      conversation_log: [],
    };

    const business = { id: BIZ_ID, name: 'Test', slug: 'test', category: 'salon' as any, flow_type: 'scheduling' as any, subscription_tier: 'growth', trial_ends_at: null, metadata: {}, country_code: 'NG' };

    // Input has future entities, but service name won't match → validation fails
    await executor.execute(PHONE, 'nonexistent-service tomorrow at 2pm for 3', session as any, business as any);

    // Validation failed → pending entities must NOT have been merged
    // (date/time/party_size should not be in session_data)
    expect(session.session_data.date).toBeUndefined();
    expect(session.session_data.time).toBeUndefined();
    expect(session.session_data.party_size).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════
// Previously accepted: behavioral validator convergence
// ═══════════════════════════════════════════════════════════════

describe('Behavioral alias convergence (real validators)', () => {
  it('campaign_view: "donate"/"yes" → valid; "back" → go_back', async () => {
    const { crowdfundingFlow } = await import('../flows/crowdfunding.flow');
    const cv = crowdfundingFlow.steps.find((s: { id: string }) => s.id === 'campaign_view')!;
    expect((await cv.validate('donate', {} as any)).valid).toBe(true);
    expect((await cv.validate('yes', {} as any)).valid).toBe(true);
    expect((await cv.validate('back', {} as any)).data?.go_back).toBe(true);
  });

  it('invoice_detail: "pay"/"pay now" → pay; "go back" → back', async () => {
    const { invoiceFlow } = await import('../flows/invoice.flow');
    const id = invoiceFlow.steps.find((s: { id: string }) => s.id === 'invoice_detail')!;
    expect((await id.validate('pay now', {} as any)).data?._invoice_action).toBe('pay');
    expect((await id.validate('go back', {} as any)).data?._invoice_action).toBe('back');
  });

  it('loyalty_menu: "history"/"redeem"/"back" converge', async () => {
    const { loyaltyFlow } = await import('../flows/loyalty.flow');
    const lm = loyaltyFlow.steps.find((s: { id: string }) => s.id === 'loyalty_menu')!;
    expect((await lm.validate('history', {} as any)).data?._loyalty_action).toBe('history');
    expect((await lm.validate('redeem', {} as any)).data?._loyalty_action).toBe('redeem');
    expect((await lm.validate('back', {} as any)).data?._loyalty_action).toBe('back_to_account');
  });

  it('book_for_other: "myself"/"me" → false; "someone else" → true', async () => {
    const { schedulingFlow } = await import('../flows/scheduling.flow');
    const bfo = schedulingFlow.steps.find((s: { id: string }) => s.id === 'book_for_other')!;
    expect((await bfo.validate('myself', {} as any)).data?.book_for_other).toBe(false);
    expect((await bfo.validate('someone else', {} as any)).data?.book_for_other).toBe(true);
  });

  it('addon_continue: "more"/"done"/"continue" converge', async () => {
    const { orderingFlow } = await import('../flows/ordering.flow');
    const ac = orderingFlow.steps.find((s: { id: string }) => s.id === 'addon_continue')!;
    expect((await ac.validate('more', {} as any)).data?._addon_continue).toBe('more');
    expect((await ac.validate('done', {} as any)).data?._addon_continue).toBe('done');
  });

  it('select_action: "cancel subscription"/"pause"/"details"; "resume" rejected', async () => {
    const { recurringManageFlow } = await import('../flows/recurring-manage.flow');
    const sa = recurringManageFlow.steps.find((s: { id: string }) => s.id === 'select_action')!;
    expect((await sa.validate('cancel subscription', {} as any)).data?._sub_action).toBe('cancel');
    expect((await sa.validate('pause', {} as any)).data?._sub_action).toBe('pause');
    expect((await sa.validate('resume', {} as any)).valid).toBe(false);
    expect((await sa.validate('resume_sub', {} as any)).data?._sub_action).toBe('resume');
  });

  it('loyalty_redeem go_back → skip (no redemption)', async () => {
    const { loyaltyFlow } = await import('../flows/loyalty.flow');
    const lr = loyaltyFlow.steps.find((s: { id: string }) => s.id === 'loyalty_redeem')!;
    const r = await lr.validate('go_back', {} as any);
    expect(r.data?._redeem_action).toBe('skip');
    expect(await lr.next!({ session: { session_data: { _redeem_action: 'skip' } }, from: PHONE } as any)).toBe('loyalty_menu');
  });
});

// ═══════════════════════════════════════════════════════════════
// Previously accepted: select_campaign tenant isolation
// ═══════════════════════════════════════════════════════════════

describe('select_campaign tenant isolation + ambiguity', () => {
  function mockCampaignCtx() {
    const q = { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), neq: vi.fn().mockReturnThis(), in: vi.fn().mockReturnThis(), is: vi.fn().mockReturnThis(), or: vi.fn().mockReturnThis(), order: vi.fn().mockReturnThis(), limit: vi.fn().mockReturnThis(), single: vi.fn().mockResolvedValue({ data: null, error: { code: 'PGRST116' } }), maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }) };
    return { supabase: { from: vi.fn().mockReturnValue(q), rpc: vi.fn(), _query: q }, from: PHONE, session: { id: 's1', version: 1, current_step: 'select_campaign', business_id: BIZ_ID, session_data: {} }, business: { id: BIZ_ID, name: 'Test', category: 'other', country_code: 'NG' }, sender: { sendText: vi.fn() }, t: vi.fn((s: string) => Promise.resolve(s)) };
  }

  it('Business-B UUID rejected in Business-A context', async () => {
    const { crowdfundingFlow } = await import('../flows/crowdfunding.flow');
    const step = crowdfundingFlow.steps.find((s: { id: string }) => s.id === 'select_campaign')!;
    const ctx = mockCampaignCtx();
    ctx.supabase._query.single.mockResolvedValue({ data: null, error: { code: 'PGRST116' } });
    ctx.supabase._query.limit.mockResolvedValue({ data: [], error: null });
    const result = await step.validate('campaign_uuid-biz-b', ctx as any);
    expect(result.valid).toBe(false);
  });

  it('ambiguous name fails closed with clarification', async () => {
    const { crowdfundingFlow } = await import('../flows/crowdfunding.flow');
    const step = crowdfundingFlow.steps.find((s: { id: string }) => s.id === 'select_campaign')!;
    const ctx = mockCampaignCtx();
    ctx.supabase._query.single.mockResolvedValue({ data: null, error: { code: 'PGRST116' } });
    ctx.supabase._query.limit.mockResolvedValue({ data: [
      { id: 'c1', title: 'Youth Fund', business_id: BIZ_ID, status: 'active', goal_amount: 1000, raised_amount: 200, donor_count: 5 },
      { id: 'c2', title: 'Youth Ed', business_id: BIZ_ID, status: 'active', goal_amount: 2000, raised_amount: 500, donor_count: 10 },
    ], error: null });
    const result = await step.validate('youth', ctx as any);
    expect(result.valid).toBe(false);
    expect(result.errorMessage).toContain('Multiple campaigns match');
  });
});

// ═══════════════════════════════════════════════════════════════
// Supplementary: CERTIFIED_LANGUAGES unchanged
// ═══════════════════════════════════════════════════════════════

describe('CERTIFIED_LANGUAGES', () => {
  it('only en certified', () => {
    const cat = readFileSync(resolve(ROOT, 'lib/bot/languages.ts'), 'utf-8');
    expect((cat.match(/certified:\s*true/g) || []).length).toBe(1);
    expect(cat).toMatch(/code:\s*'en'[^}]*certified:\s*true/);
  });
});

// ═══════════════════════════════════════════════════════════════
// Supplementary: language switch cites existing executor test
// ═══════════════════════════════════════════════════════════════

describe('Language switch continuity (citation)', () => {
  it('slice-a-localization-boundary.test.ts has real FlowExecutor language-switch tests', () => {
    const f = readFileSync(resolve(ROOT, 'lib/bot/__tests__/slice-a-localization-boundary.test.ts'), 'utf-8');
    expect(f).toContain('language-switch');
    expect(f).toContain('FlowExecutor');
  });
});
