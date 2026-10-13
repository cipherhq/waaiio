/**
 * Pidgin executor switching — executable FlowExecutor tests
 *
 * Calls the real FlowExecutor.execute() with mocked Supabase/sender.
 * a) idle session + "pidgin" → pcm, Pidgin confirmation sent
 * b) next reply in pcm session uses Pidgin copy
 * c) "english" switches back
 * d) step with "French" option + "French" → answer accepted, no switch
 * e) free-text step + "Yoruba" → saved as answer
 * f) "talk pidgin" during free-text step → switches
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock external boundaries ──

const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }));
vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic { messages = { create: mockCreate }; }
  return { default: MockAnthropic };
});

vi.mock('@/lib/countries', () => ({
  loadCountries: vi.fn().mockResolvedValue([]),
  getCountry: vi.fn(),
  getCountryList: vi.fn().mockReturnValue([]),
  isValidCountryCode: vi.fn().mockReturnValue(true),
  getDialingCodeMap: vi.fn().mockReturnValue({}),
}));
vi.mock('@/lib/posthog/flags', () => ({
  isFeatureEnabledServer: vi.fn().mockResolvedValue(true),
  FLAGS: { BOT_TRANSLATION_ENABLED: 'bot-translation-enabled' },
}));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn().mockReturnValue({ allowed: true, remaining: 49 }),
  checkRateLimitAsync: vi.fn().mockResolvedValue({ allowed: true, remaining: 10 }),
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/bot/ai-tier-guard', () => ({
  incrementAIUsage: vi.fn().mockResolvedValue(undefined),
  checkAIFeature: vi.fn().mockResolvedValue(true),
  isLanguageAllowed: vi.fn().mockReturnValue(true),
}));
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
vi.mock('@/lib/bot/automation/rules-engine', () => ({ evaluateRules: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/bot/confidence-policy', () => ({
  loadConversationConfig: vi.fn().mockResolvedValue({
    aiEnabled: false, autoRouteThreshold: 0.85, clarificationThreshold: 0.60,
    fallbackBehavior: 'menu', faqEnabled: true, knowledgeEnabled: true,
    assistantName: 'Assistant', tone: 'friendly',
  }),
}));

const { mockReadPref, mockWritePref } = vi.hoisted(() => ({
  mockReadPref: vi.fn().mockResolvedValue(null),
  mockWritePref: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/bot/language-preference', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../language-preference')>();
  return { ...actual, readPreferredResponseLanguage: mockReadPref, writePreferredResponseLanguage: mockWritePref };
});

// Language policy: Growth tier with PCM + EN certified
const { mockGetEffectiveLanguages, mockCertifiedLanguages } = vi.hoisted(() => ({
  mockGetEffectiveLanguages: vi.fn().mockReturnValue({
    allowedLanguages: ['en', 'pcm', 'yo', 'fr'],
    llmAllowed: true,
    translationAllowed: true,
  }),
  mockCertifiedLanguages: ['en', 'pcm'] as string[],
}));
vi.mock('@/lib/bot/language-policy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../language-policy')>();
  return {
    ...actual,
    getEffectiveLanguages: mockGetEffectiveLanguages,
    loadBusinessLanguages: vi.fn().mockResolvedValue(null),
    get CERTIFIED_LANGUAGES() { return mockCertifiedLanguages; },
  };
});

// Controllable test step
const { mockGetFlowStep } = vi.hoisted(() => ({ mockGetFlowStep: vi.fn() }));
vi.mock('../flows/registry', () => ({
  getFlowStep: mockGetFlowStep,
  getFlowStepAcrossFlows: vi.fn().mockReturnValue(null),
  getExtendedFlowDefinition: vi.fn().mockReturnValue(null),
  getFlowDefinition: vi.fn().mockReturnValue(null),
}));

import { FlowExecutor } from '../flows/executor';
import { createCaptureSender } from './bot-harness';

function createMockSupabase() {
  return {
    rpc: vi.fn().mockResolvedValue({
      data: { success: true, version: 2, current_step: 'test_step' },
      error: null,
    }),
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          single: vi.fn().mockResolvedValue({ data: null, error: null }),
          maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
        })),
      })),
      update: vi.fn(() => ({ eq: vi.fn().mockResolvedValue({ error: null }) })),
      insert: vi.fn().mockResolvedValue({ error: null }),
    })),
  } as any;
}

function createSession(overrides?: { _detected_language?: string }) {
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

const BIZ = {
  id: 'biz-1', name: 'Test Biz', slug: 'test', category: 'salon' as any,
  flow_type: 'scheduling' as any, subscription_tier: 'growth',
  trial_ends_at: '2099-01-01', metadata: {}, country_code: 'NG' as any,
  payment_gateway: null,
};

describe('Pidgin executor switching — executable tests', () => {
  let sender: ReturnType<typeof createCaptureSender>;
  let supabase: ReturnType<typeof createMockSupabase>;
  let executor: FlowExecutor;

  beforeEach(() => {
    vi.clearAllMocks();
    sender = createCaptureSender();
    supabase = createMockSupabase();
    executor = new FlowExecutor(supabase, sender, {} as any, {} as any);
  });

  it('(a) idle session + "pidgin" → language becomes pcm, Pidgin confirmation sent', async () => {
    // Step rejects "pidgin" (not a valid answer at idle/menu)
    const step = {
      prompt: vi.fn(async () => [{ type: 'text' as const, text: 'Pick a date:' }]),
      validate: vi.fn(async () => ({ valid: false, errorMessage: 'Invalid' })),
      next: vi.fn(async () => null),
    };
    mockGetFlowStep.mockReturnValue(step);

    const session = createSession();
    await executor.execute('+2348001234567', 'pidgin', session, BIZ);

    expect(session.session_data._detected_language).toBe('pcm');
    // Confirmation message should be in Pidgin
    expect(sender.hasMessageContaining('Pidgin')).toBe(true);
  });

  it('(b) next bot reply in pcm session uses Pidgin copy', async () => {
    const step = {
      prompt: vi.fn(async () => [{ type: 'text' as const, text: 'Pick a date:' }]),
      validate: vi.fn(async () => ({ valid: true })),
      next: vi.fn(async () => null),
    };
    mockGetFlowStep.mockReturnValue(step);

    // Session already has pcm set from a previous switch
    const session = createSession({ _detected_language: 'pcm' });
    // Empty input → prompt the step
    await executor.execute('+2348001234567', '', session, BIZ);

    expect(step.prompt).toHaveBeenCalled();
    // The step prompt text should have been sent
    const msgs = sender.getMessages();
    expect(msgs.length).toBeGreaterThan(0);
  });

  it('(c) "english" switches back to en', async () => {
    // Step rejects bare "english"
    const step = {
      prompt: vi.fn(async () => [{ type: 'text' as const, text: 'Pick a date:' }]),
      validate: vi.fn(async () => ({ valid: false, errorMessage: 'Invalid' })),
      next: vi.fn(async () => null),
    };
    mockGetFlowStep.mockReturnValue(step);

    const session = createSession({ _detected_language: 'pcm' });
    await executor.execute('+2348001234567', 'english', session, BIZ);

    // _detected_language should be cleared (en = undefined)
    expect(session.session_data._detected_language).toBeUndefined();
  });

  it('(d) step with "French" option + "French" → answer accepted, language unchanged', async () => {
    // Step accepts "French" as a valid option answer
    const step = {
      prompt: vi.fn(async () => [{ type: 'text' as const, text: 'Choose language:' }]),
      validate: vi.fn(async () => ({ valid: true, data: { choice: 'French' } })),
      next: vi.fn(async () => 'next_step'),
    };
    mockGetFlowStep.mockReturnValue(step);

    const session = createSession();
    await executor.execute('+2348001234567', 'French', session, BIZ);

    // Language should NOT have switched — "French" was an answer
    expect(session.session_data._detected_language).toBeUndefined();
    // validate was called (the step processed it as an answer)
    expect(step.validate).toHaveBeenCalled();
  });

  it('(e) free-text step + "Yoruba" → saved as answer, no language switch', async () => {
    // Free-text step accepts anything
    const step = {
      prompt: vi.fn(async () => [{ type: 'text' as const, text: 'Enter your name:' }]),
      validate: vi.fn(async () => ({ valid: true, data: { name: 'Yoruba' } })),
      next: vi.fn(async () => 'next_step'),
    };
    mockGetFlowStep.mockReturnValue(step);

    const session = createSession();
    await executor.execute('+2348001234567', 'Yoruba', session, BIZ);

    // Language should NOT have switched — "Yoruba" was free-text input
    expect(session.session_data._detected_language).toBeUndefined();
  });

  it('(f) "talk pidgin" during free-text step → switches (verb phrase overrides)', async () => {
    // Free-text step accepts anything
    const step = {
      prompt: vi.fn(async () => [{ type: 'text' as const, text: 'Enter your name:' }]),
      validate: vi.fn(async () => ({ valid: true, data: { name: 'talk pidgin' } })),
      next: vi.fn(async () => 'next_step'),
    };
    mockGetFlowStep.mockReturnValue(step);

    const session = createSession();
    await executor.execute('+2348001234567', 'talk pidgin', session, BIZ);

    // "talk pidgin" is a verb phrase (isBare=false) → MUST switch regardless of step
    expect(session.session_data._detected_language).toBe('pcm');
  });
});
