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
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: mockLoggerWarn, error: vi.fn(), debug: vi.fn() },
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

// Mock language-policy — Free tier by default (tests can override)
const { mockGetEffectiveLanguages, mockLoadBusinessLanguages } = vi.hoisted(() => ({
  mockGetEffectiveLanguages: vi.fn().mockReturnValue({
    allowedLanguages: ['en'],
    llmAllowed: false,
    translationAllowed: false,
  }),
  mockLoadBusinessLanguages: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/lib/bot/language-policy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../language-policy')>();
  return {
    ...actual,
    getEffectiveLanguages: mockGetEffectiveLanguages,
    loadBusinessLanguages: mockLoadBusinessLanguages,
    // Keep real CERTIFIED_LANGUAGES for switch gate tests
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
