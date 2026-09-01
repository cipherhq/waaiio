/**
 * Slice A — Localization Safety Boundary behavioral tests.
 *
 * Part 1: Tests the real translateBotResponse + TranslationContext entitlement gate.
 * Part 2: Tests the real FlowExecutor.execute() path for language-switch behavior.
 * Part 3: Tests truly concurrent tenant attribution.
 *
 * Anthropic SDK and AI-usage tracking are mocked at the boundary;
 * the entitlement logic, fail-closed behavior, and context isolation
 * are exercised for real.
 *
 * Ref: Issue #274 / #271 Slice A proof obligations.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock external boundaries only ──

const { mockCreate, mockIncrementAIUsage, mockLoggerWarn } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
  mockIncrementAIUsage: vi.fn().mockResolvedValue(undefined),
  mockLoggerWarn: vi.fn(),
}));

// Mock Anthropic SDK — the only external AI call
vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    messages = { create: mockCreate };
  }
  return { default: MockAnthropic };
});

// Mock PostHog feature flag — always enabled
vi.mock('@/lib/posthog/flags', () => ({
  isFeatureEnabledServer: vi.fn().mockResolvedValue(true),
  FLAGS: { BOT_TRANSLATION_ENABLED: 'bot-translation-enabled' },
}));

// Mock rate limiter — always allowed
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn().mockReturnValue({ allowed: true, remaining: 49 }),
  checkRateLimitAsync: vi.fn().mockResolvedValue({ allowed: true, remaining: 10 }),
}));

// Mock logger — capture warn/error for debugging
const { mockLoggerError } = vi.hoisted(() => ({ mockLoggerError: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: mockLoggerWarn, error: mockLoggerError, debug: vi.fn() },
}));

// Mock AI usage tracker — capture calls for attribution verification
vi.mock('@/lib/bot/ai-tier-guard', () => ({
  incrementAIUsage: mockIncrementAIUsage,
  checkAIFeature: vi.fn().mockResolvedValue(true),
  isLanguageAllowed: vi.fn().mockReturnValue(true),
}));

// ── FlowExecutor-specific mocks ──

vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

vi.mock('@/lib/bot/conversation-guard', () => ({
  checkConversationLimit: vi.fn().mockResolvedValue({ allowed: true }),
  trackOutboundMessage: vi.fn().mockResolvedValue(undefined),
  getConversationLimitMessage: vi.fn(() => 'Limit reached'),
}));

vi.mock('@/lib/bot/step-overrides', () => ({
  loadOverrides: vi.fn().mockResolvedValue(new Map()),
  evaluateBranchConditions: vi.fn(),
}));

vi.mock('@/lib/bot/flow-analytics', () => ({ logDropoff: vi.fn() }));

// ── BotService-specific mocks (for lang_yes stale-policy test) ──
vi.mock('@/lib/platformSettings', () => ({
  loadPlatformSettings: vi.fn().mockResolvedValue({ bot_rate_limit_per_minute: 30 }),
}));
vi.mock('@/lib/bot/keyword-service', () => ({
  loadBotCustomConfig: vi.fn().mockResolvedValue({ welcome_buttons: [], quick_replies: [], default_reply: null }),
  matchQuickReply: vi.fn(() => null),
  loadUnifiedKeywords: vi.fn().mockResolvedValue([]),
  matchUnifiedKeyword: vi.fn(() => null),
}));
vi.mock('@/lib/bot/handlers/escape-hatches', () => ({
  HOME_PATTERN: /^home$/i,
  handleEscapeHatch: vi.fn().mockResolvedValue({ handled: false }),
}));
vi.mock('@/lib/bot/handlers/global-queries', () => ({
  handleGlobalQuery: vi.fn(async (opts: { session: unknown }) => ({ handled: false, session: opts.session })),
  isOrdersQuery: vi.fn(() => false),
}));
vi.mock('@/lib/bot/confidence-policy', () => ({
  loadConversationConfig: vi.fn().mockResolvedValue({
    aiEnabled: false, autoRouteThreshold: 0.85, clarificationThreshold: 0.60,
    fallbackBehavior: 'menu', faqEnabled: true, knowledgeEnabled: true,
    assistantName: 'Assistant', tone: 'friendly',
  }),
}));
vi.mock('@/lib/bot/automation/rules-engine', () => ({ evaluateRules: vi.fn().mockResolvedValue(undefined) }));

// Mock bot-helpers — control getActiveSession return per-test
const { mockGetActiveSession } = vi.hoisted(() => ({
  mockGetActiveSession: vi.fn().mockResolvedValue(null),
}));
vi.mock('@/lib/bot/bot-helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../bot-helpers')>();
  return {
    ...actual,
    getActiveSession: mockGetActiveSession,
  };
});

// Mock language-policy — Free tier by default (tests can override)
const { mockGetEffectiveLanguages, mockLoadBusinessLanguages, mockCertifiedLanguages } = vi.hoisted(() => ({
  mockGetEffectiveLanguages: vi.fn().mockReturnValue({
    allowedLanguages: ['en'],
    llmAllowed: false,
    translationAllowed: false,
  }),
  mockLoadBusinessLanguages: vi.fn().mockResolvedValue(null),
  // Default: English only. Tests can override via mockCertifiedLanguages.length = 0; mockCertifiedLanguages.push('en', 'fr');
  mockCertifiedLanguages: ['en'] as string[],
}));

vi.mock('@/lib/bot/language-policy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../language-policy')>();
  return {
    ...actual,
    getEffectiveLanguages: mockGetEffectiveLanguages,
    loadBusinessLanguages: mockLoadBusinessLanguages,
    get CERTIFIED_LANGUAGES() { return mockCertifiedLanguages; },
  };
});

// Mock flow registry — returns a controllable test step
const { mockGetFlowStep } = vi.hoisted(() => ({
  mockGetFlowStep: vi.fn(),
}));

vi.mock('../flows/registry', () => ({
  getFlowStep: mockGetFlowStep,
  getFlowStepAcrossFlows: vi.fn().mockReturnValue(null),
  getExtendedFlowDefinition: vi.fn().mockReturnValue(null),
  getFlowDefinition: vi.fn().mockReturnValue(null),
}));

import { translateBotResponse, type TranslationContext } from '../translate';
import type { LanguageEntitlement } from '../language-policy';
import { FlowExecutor } from '../flows/executor';
import { BotService } from '../bot.service';
import { createCaptureSender } from './bot-harness';

// ── Helpers ──

function makeCtx(overrides: {
  translationAllowed?: boolean;
  allowedLanguages?: string[];
  businessId?: string;
}): TranslationContext {
  const entitlement: LanguageEntitlement = {
    allowedLanguages: overrides.allowedLanguages ?? ['en'],
    llmAllowed: false,
    translationAllowed: overrides.translationAllowed ?? false,
  };
  return {
    entitlement,
    businessId: overrides.businessId ?? 'biz-test',
    supabase: {}, // stub — only used for incrementAIUsage passthrough
  };
}

function setupAnthropicResponse(translated: string) {
  mockCreate.mockResolvedValueOnce({
    content: [{ type: 'text', text: translated }],
    usage: { input_tokens: 10, output_tokens: 5 },
  });
}

/** Create a minimal mock Supabase client for FlowExecutor */
function createMockSupabase() {
  const mockRpc = vi.fn().mockResolvedValue({
    data: { success: true, version: 2, current_step: 'test_step' },
    error: null,
  });

  const mockFrom = vi.fn(() => ({
    select: vi.fn(() => ({
      eq: vi.fn(() => ({
        single: vi.fn().mockResolvedValue({ data: null, error: null }),
        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
      })),
    })),
    update: vi.fn(() => ({ eq: vi.fn().mockResolvedValue({ error: null }) })),
    insert: vi.fn().mockResolvedValue({ error: null }),
  }));

  return { rpc: mockRpc, from: mockFrom } as any;
}

/** Create a test flow step */
function createTestStep() {
  return {
    prompt: vi.fn(async () => [{ type: 'text' as const, text: 'Pick a date:' }]),
    validate: vi.fn(async () => ({ valid: true })),
    next: vi.fn(async () => null),
    skipIf: undefined,
  };
}

/** Standard test session */
function createTestSession(overrides?: Partial<{
  _detected_language: string;
}>) {
  return {
    id: 'sess-1',
    user_id: null,
    business_id: 'biz-1',
    current_step: 'test_step',
    session_data: {
      active_capability: 'scheduling',
      capabilities: ['scheduling'],
      ...(overrides?._detected_language ? { _detected_language: overrides._detected_language } : {}),
    } as Record<string, unknown>,
    conversation_log: [] as Array<{ role: 'bot' | 'user'; content: string; timestamp: string }>,
    version: 1,
  };
}

const TEST_BUSINESS = {
  id: 'biz-1', name: 'Test Biz', slug: 'test', category: 'salon' as any,
  flow_type: 'scheduling' as any, subscription_tier: 'free',
  trial_ends_at: '2025-01-01', metadata: {}, country_code: 'NG' as any,
  payment_gateway: null,
};

// ══════════════════════════════════════════════════════════════
// Part 1: Direct translateBotResponse boundary tests
// ══════════════════════════════════════════════════════════════

describe('Slice A — translateBotResponse entitlement boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIncrementAIUsage.mockResolvedValue(undefined);
  });

  it('returns original text when translationAllowed is false', async () => {
    const ctx = makeCtx({ translationAllowed: false, allowedLanguages: ['en'] });
    const result = await translateBotResponse('Hello, welcome!', 'fr', ctx);
    expect(result).toBe('Hello, welcome!');
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockIncrementAIUsage).not.toHaveBeenCalled();
  });

  it('returns original text when language is not in allowedLanguages', async () => {
    const ctx = makeCtx({ translationAllowed: true, allowedLanguages: ['en', 'pcm'] });
    const result = await translateBotResponse('Book a haircut', 'fr', ctx);
    expect(result).toBe('Book a haircut');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('translates and attributes AI usage to the correct business when entitled', async () => {
    const ctx = makeCtx({
      translationAllowed: true, allowedLanguages: ['en', 'fr'], businessId: 'biz-acme-123',
    });
    setupAnthropicResponse('Bonjour, bienvenue!');
    const result = await translateBotResponse('Hello, welcome!', 'fr', ctx);
    expect(result).toBe('Bonjour, bienvenue!');
    expect(mockCreate).toHaveBeenCalledOnce();
    expect(mockIncrementAIUsage).toHaveBeenCalledWith(ctx.supabase, 'biz-acme-123', 'translation');
  });

  it('returns original text on Anthropic API failure', async () => {
    const ctx = makeCtx({ translationAllowed: true, allowedLanguages: ['en', 'fr'], businessId: 'biz-fail' });
    mockCreate.mockRejectedValueOnce(new Error('API timeout'));
    const result = await translateBotResponse('Your appointment is ready to confirm.', 'fr', ctx);
    expect(result).toBe('Your appointment is ready to confirm.');
    expect(mockIncrementAIUsage).not.toHaveBeenCalled();
  });

  it('returns original text for English', async () => {
    const ctx = makeCtx({ translationAllowed: true, allowedLanguages: ['en', 'fr'] });
    expect(await translateBotResponse('Hello', 'en', ctx)).toBe('Hello');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('returns original text for empty language', async () => {
    const ctx = makeCtx({ translationAllowed: true, allowedLanguages: ['en'] });
    expect(await translateBotResponse('Hello', '', ctx)).toBe('Hello');
  });

  it('Free tier context blocks all non-English translation', async () => {
    const freeCtx = makeCtx({ translationAllowed: false, allowedLanguages: ['en'] });
    expect(await translateBotResponse('Hello', 'fr', freeCtx)).toBe('Hello');
    expect(await translateBotResponse('Hello', 'pcm', freeCtx)).toBe('Hello');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('blocks translation for persisted but non-entitled _detected_language', async () => {
    const freeCtx = makeCtx({ translationAllowed: false, allowedLanguages: ['en'] });
    const result = await translateBotResponse('Your booking is confirmed.', 'fr', freeCtx);
    expect(result).toBe('Your booking is confirmed.');
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════
// Part 2: Real FlowExecutor path tests
// ══════════════════════════════════════════════════════════════

describe('Slice A — real FlowExecutor language-switch + outbound behavior', () => {
  let sender: ReturnType<typeof createCaptureSender>;
  let supabase: ReturnType<typeof createMockSupabase>;
  let executor: FlowExecutor;
  let testStep: ReturnType<typeof createTestStep>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockIncrementAIUsage.mockResolvedValue(undefined);

    sender = createCaptureSender();
    supabase = createMockSupabase();
    executor = new FlowExecutor(supabase, sender, {} as any, {} as any);
    testStep = createTestStep();
    mockGetFlowStep.mockReturnValue(testStep);

    // Default: Free tier
    mockGetEffectiveLanguages.mockReturnValue({
      allowedLanguages: ['en'],
      llmAllowed: false,
      translationAllowed: false,
    });
  });

  it('Free + "switch to french" => no persistence, no success claim, safe rejection, zero Anthropic call', async () => {
    const session = createTestSession();

    await executor.execute('+2348001234567', 'switch to french', session, TEST_BUSINESS);

    // Session must NOT have _detected_language='fr'
    expect(session.session_data._detected_language).toBeUndefined();

    // Must send a safe "not available" message
    expect(sender.hasMessageContaining('not available')).toBe(true);

    // Must re-prompt the current step after rejection
    expect(testStep.prompt).toHaveBeenCalled();

    // Zero Anthropic translation calls
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('persisted non-entitled _detected_language=fr => executor outbound untranslated, zero Anthropic call', async () => {
    // Session has _detected_language='fr' but business is Free (not entitled)
    const session = createTestSession({ _detected_language: 'fr' });

    // Execute with empty input → should send the step prompt untranslated
    await executor.execute('+2348001234567', '', session, TEST_BUSINESS);

    // Prompt should have been sent
    expect(testStep.prompt).toHaveBeenCalled();

    // The outbound message should be the original English text (not translated)
    const msgs = sender.getMessages();
    const textMsgs = msgs.filter(m => m.type === 'text');
    // 'Pick a date:' is the test step prompt — must remain English
    expect(textMsgs.some(m => m.text === 'Pick a date:')).toBe(true);

    // Zero Anthropic calls — translation blocked by entitlement
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('successful "switch to french" when entitled+certified => persists _detected_language, translated confirmation, re-prompt via ctx.t uses new language', async () => {
    // Configure: French is certified and entitled for this test
    mockCertifiedLanguages.length = 0;
    mockCertifiedLanguages.push('en', 'fr');
    mockGetEffectiveLanguages.mockReturnValue({
      allowedLanguages: ['en', 'fr'],
      llmAllowed: true,
      translationAllowed: true,
    });

    // Replace the default test step with one whose prompt calls ctx.t()
    // This proves ctx.t observes the post-switch language, not the stale pre-switch value
    const ctxTStep = {
      prompt: vi.fn(async (ctx: { t: (s: string) => Promise<string> }) => {
        const translated = await ctx.t('Pick a date:');
        return [{ type: 'text' as const, text: translated }];
      }),
      validate: vi.fn(async () => ({ valid: true })),
      next: vi.fn(async () => null),
      skipIf: undefined,
    };
    mockGetFlowStep.mockReturnValue(ctxTStep);

    const session = createTestSession();
    // Mock Anthropic responses:
    // (1) "Switched to French. ✅" confirmation text
    // (2) "Pick a date:" → "Choisissez une date :" via ctx.t in the re-prompt
    // (3) sendMessages re-translates the already-French prompt (by-design double-pass;
    //     in production the cache would absorb this, but in tests each mock is consumed once)
    setupAnthropicResponse('Passage au français. ✅');
    setupAnthropicResponse('Choisissez une date :');
    setupAnthropicResponse('Choisissez une date :');

    await executor.execute('+2348001234567', 'switch to french', session, {
      ...TEST_BUSINESS,
      subscription_tier: 'growth',
    });

    // _detected_language must be persisted as 'fr'
    expect(session.session_data._detected_language).toBe('fr');

    // CAS update must have been called to persist the language change
    expect(supabase.rpc).toHaveBeenCalledWith(
      'update_session_cas',
      expect.objectContaining({
        p_session_id: 'sess-1',
      }),
    );

    // Must send translated confirmation
    const msgs = sender.getMessages();
    expect(msgs.some(m => m.type === 'text' && m.text?.includes('Passage au français'))).toBe(true);

    // The re-prompt must have been called via ctx.t and the French translation consumed
    expect(ctxTStep.prompt).toHaveBeenCalled();

    // Anthropic must have been called at least twice:
    // (1) confirmation "Switched to French. ✅"
    // (2) ctx.t('Pick a date:') inside step.prompt
    // (3) sendMessages also translates the prompt output (by-design double-pass)
    expect(mockCreate.mock.calls.length).toBeGreaterThanOrEqual(2);

    // The re-prompt message must be the French translation, not the English original
    // This proves ctx.t read _detected_language='fr' (not the stale pre-switch '')
    expect(msgs.some(m => m.type === 'text' && m.text === 'Choisissez une date :')).toBe(true);
    // The English original must NOT appear in any sent text message
    expect(msgs.some(m => m.type === 'text' && m.text === 'Pick a date:')).toBe(false);

    // Restore defaults for subsequent tests
    mockCertifiedLanguages.length = 0;
    mockCertifiedLanguages.push('en');
  });

  it('"switch to english" => clears persisted non-English preference through CAS, English re-prompt', async () => {
    // Session starts with _detected_language='fr'
    const session = createTestSession({ _detected_language: 'fr' });

    await executor.execute('+2348001234567', 'switch to english', session, TEST_BUSINESS);

    // _detected_language must be cleared (set to undefined)
    expect(session.session_data._detected_language).toBeUndefined();

    // CAS update must have been called
    expect(supabase.rpc).toHaveBeenCalledWith(
      'update_session_cas',
      expect.objectContaining({
        p_session_id: 'sess-1',
      }),
    );

    // Must send "Switched to English" confirmation
    expect(sender.hasMessageContaining('Switched to English')).toBe(true);

    // Must re-prompt the current step
    expect(testStep.prompt).toHaveBeenCalled();

    // Zero Anthropic calls — no translation needed for English
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════
// Part 3: Truly concurrent tenant-attribution test
// ══════════════════════════════════════════════════════════════

describe('Slice A — concurrent tenant attribution (truly overlapping)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIncrementAIUsage.mockResolvedValue(undefined);
  });

  it('two in-flight translations attribute usage to correct businesses without cross-contamination', async () => {
    // Each business gets its own distinct supabase stub so we can verify object identity
    const supabaseA = { _id: 'supabase-A' };
    const supabaseB = { _id: 'supabase-B' };
    const ctxA: TranslationContext = {
      entitlement: { allowedLanguages: ['en', 'fr'], llmAllowed: false, translationAllowed: true },
      businessId: 'biz-concurrent-A',
      supabase: supabaseA,
    };
    const ctxB: TranslationContext = {
      entitlement: { allowedLanguages: ['en', 'fr'], llmAllowed: false, translationAllowed: true },
      businessId: 'biz-concurrent-B',
      supabase: supabaseB,
    };

    // Deferred promises so both requests are genuinely in flight simultaneously
    let resolveA!: (v: any) => void;
    let resolveB!: (v: any) => void;
    const deferredA = new Promise(r => { resolveA = r; });
    const deferredB = new Promise(r => { resolveB = r; });

    mockCreate
      .mockImplementationOnce(() => deferredA)
      .mockImplementationOnce(() => deferredB);

    // Start both translations — both are now awaiting their deferred Anthropic responses
    const promiseA = translateBotResponse('Concurrent overlap message A', 'fr', ctxA);
    const promiseB = translateBotResponse('Concurrent overlap message B', 'fr', ctxB);

    // Resolve B first, then A — interleaved completion order
    resolveB({ content: [{ type: 'text', text: 'Traduction B' }], usage: { input_tokens: 10, output_tokens: 5 } });
    // Let B's microtasks drain before resolving A
    await new Promise(r => setTimeout(r, 0));
    resolveA({ content: [{ type: 'text', text: 'Traduction A' }], usage: { input_tokens: 10, output_tokens: 5 } });

    const resultA = await promiseA;
    const resultB = await promiseB;

    expect(resultA).toBe('Traduction A');
    expect(resultB).toBe('Traduction B');

    // Let all fire-and-forget increment calls settle
    await new Promise(r => setTimeout(r, 50));

    expect(mockIncrementAIUsage).toHaveBeenCalledTimes(2);

    // Verify each increment is bound to its own (supabase, businessId) pair
    const calls = mockIncrementAIUsage.mock.calls;
    const callA = calls.find((c: unknown[]) => c[1] === 'biz-concurrent-A');
    const callB = calls.find((c: unknown[]) => c[1] === 'biz-concurrent-B');
    expect(callA).toBeDefined();
    expect(callB).toBeDefined();
    // Object identity — not just string match. Each business's supabase is distinct.
    expect(callA![0]).toBe(supabaseA);
    expect(callB![0]).toBe(supabaseB);
  });
});

// ══════════════════════════════════════════════════════════════
// Part 4: BotService lang_yes stale-policy revalidation
// ══════════════════════════════════════════════════════════════

describe('Slice A — BotService lang_yes stale-policy revalidation', () => {
  /** Create a Supabase mock where the resumed session has _pending_language set */
  function createBotServiceSupabase(pendingLang: string) {
    const updateTracker: Array<{ table: string; data: unknown }> = [];

    function makeChain(resolveData: unknown = null) {
      const chain: Record<string, any> = {};
      for (const m of ['select','insert','update','upsert','delete','eq','neq','or','in','is','not','ilike','like','gte','lte','gt','lt','order','limit','range','filter','match','contains','containedBy'])
        chain[m] = vi.fn().mockReturnValue(chain);
      chain.single = vi.fn().mockResolvedValue({ data: resolveData, error: resolveData ? null : { message: 'not found' } });
      chain.maybeSingle = vi.fn().mockResolvedValue({ data: resolveData, error: null });
      return chain;
    }

    const activeSession = {
      id: 'sess-lang-1',
      user_id: null,
      business_id: 'biz-lang-1',
      current_step: 'select_date',
      is_active: true,
      whatsapp_number: '+2348001234567',
      session_data: {
        active_capability: 'scheduling',
        capabilities: ['scheduling'],
        _pending_language: pendingLang,
        business_name: 'Test Salon',
      },
      conversation_log: [],
      version: 1,
      expires_at: new Date(Date.now() + 86400000).toISOString(),
      last_active_at: new Date().toISOString(),
    };

    const business = {
      id: 'biz-lang-1', name: 'Test Salon', slug: 'test-salon',
      category: 'salon', flow_type: 'scheduling', subscription_tier: 'free',
      trial_ends_at: '2025-01-01', metadata: {}, country_code: 'NG',
      owner_id: 'owner-1', payment_gateway: null, status: 'active',
      is_whitelabel: false, operating_hours: null,
    };

    return {
      supabase: {
        from: vi.fn((table: string) => {
          if (table === 'bot_sessions') {
            const chain = makeChain(activeSession);
            const origUpdate = chain.update;
            chain.update = vi.fn((data: unknown) => {
              updateTracker.push({ table: 'bot_sessions', data });
              return origUpdate(data);
            });
            chain.delete = vi.fn().mockReturnValue(chain);
            return chain;
          }
          if (table === 'businesses') return makeChain(business);
          if (table === 'business_capabilities') {
            const d = Promise.resolve({ data: [{ capability: 'scheduling', is_enabled: true, sort_order: 0 }], error: null });
            const c: Record<string, any> = {};
            for (const m of ['select','eq','order']) c[m] = () => c;
            c.then = d.then.bind(d); c.catch = d.catch.bind(d);
            return c;
          }
          if (table === 'ai_conversation_config') return makeChain(null);
          if (table === 'platform_settings') return makeChain({ value: false });
          if (table === 'profiles') return makeChain({ id: 'profile-1' });
          return makeChain();
        }),
        rpc: vi.fn().mockResolvedValue({ data: { success: true, version: 2, current_step: 'select_date' }, error: null }),
        storage: { from: vi.fn(() => ({ upload: vi.fn(), createSignedUrl: vi.fn(), getPublicUrl: vi.fn() })) },
      } as any,
      updateTracker,
      activeSession,
    };
  }

  function createMockStandalone() {
    return {
      loadWhatsAppConfigBundle: vi.fn().mockResolvedValue({ templates: { greeting: 'Welcome!' }, welcome_buttons: [], auto_reply_enabled: false, business_hours: null, alias: null }),
      checkTierLimitsFromBusiness: vi.fn().mockResolvedValue({ allowed: true, isWhitelabel: false }),
      fillTemplate: vi.fn((t: string) => t), getBotAlias: vi.fn().mockResolvedValue(null),
    } as any;
  }

  function createMockIntelligence() {
    return {
      isTimedOut: vi.fn(() => ({ timedOut: false, remaining: 0 })),
      containsProfanity: vi.fn(() => false),
      recordProfanity: vi.fn(() => ({ timeout: false, warn: false })),
      resetAbuse: vi.fn(),
      getHelpText: vi.fn(() => 'Help'), getPersonaGreeting: vi.fn((_a: string, n: string) => `Hi from ${n}`),
      getContextualHelp: vi.fn(() => 'Help'),
    } as any;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockIncrementAIUsage.mockResolvedValue(undefined);
    // Default: Free tier (no translation, English only)
    mockGetEffectiveLanguages.mockReturnValue({
      allowedLanguages: ['en'],
      llmAllowed: false,
      translationAllowed: false,
    });
    mockCertifiedLanguages.length = 0;
    mockCertifiedLanguages.push('en');
  });

  it('lang_yes with stale pending language (no longer entitled) => rejects, does not persist _detected_language', async () => {
    // Scenario: French was offered as _pending_language when the business was Growth,
    // but the business has since downgraded to Free tier.
    // mockGetEffectiveLanguages already returns Free (translationAllowed=false).
    const { supabase, updateTracker, activeSession } = createBotServiceSupabase('fr');

    // Return this session when getActiveSession is called
    mockGetActiveSession.mockResolvedValue(activeSession);

    const sender = createCaptureSender();
    const botService = new BotService(supabase, sender, createMockStandalone(), createMockIntelligence());

    await botService.handleMessage('+2348001234567', 'lang_yes', 'text');

    // _detected_language must NOT be set to 'fr' in the session update
    const sessionUpdates = updateTracker.filter(u => u.table === 'bot_sessions');
    const hasUnauthorizedLang = sessionUpdates.some(u => {
      const sd = (u.data as any)?.session_data;
      return sd && sd._detected_language === 'fr';
    });
    expect(hasUnauthorizedLang).toBe(false);

    // Must send a "no longer available" message
    expect(sender.hasMessageContaining('no longer available')).toBe(true);

    // Must NOT send the success confirmation "I'll respond in French"
    expect(sender.hasMessageContaining("I'll respond in")).toBe(false);

    // Zero Anthropic translation calls
    expect(mockCreate).not.toHaveBeenCalled();

    // _pending_language must be cleared (cleaned up regardless of acceptance/rejection)
    const lastUpdate = sessionUpdates[sessionUpdates.length - 1];
    if (lastUpdate) {
      const sd = (lastUpdate.data as any)?.session_data;
      expect(sd?._pending_language).toBeUndefined();
    }
  });
});
