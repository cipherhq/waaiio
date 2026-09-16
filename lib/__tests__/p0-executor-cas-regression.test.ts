/**
 * P0 Executor CAS Regression Tests — ACC-008
 *
 * Instantiates the real FlowExecutor and calls execute() with empty input
 * (prompt path). Captures the update_session_cas RPC call to verify that
 * nextAfterPrompt-based step transitions are persisted atomically via CAS,
 * NOT via direct DB writes from prompt().
 *
 * Isolated from p0-post-payment-lifecycle.test.ts to avoid mock conflicts
 * (this file mocks the registry, that file imports real flow definitions).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks ──

const { mockLogError, mockLogWarn, mockLogInfo } = vi.hoisted(() => ({
  mockLogError: vi.fn(),
  mockLogWarn: vi.fn(),
  mockLogInfo: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    info: mockLogInfo,
    warn: mockLogWarn,
    error: mockLogError,
    withContext: () => ({ error: mockLogError, warn: mockLogWarn, info: mockLogInfo }),
  },
}));

vi.mock('@/lib/errors', () => ({
  safeLogErrorContext: (e: unknown) => ({ err: String(e) }),
  normalizeError: (e: unknown) => e instanceof Error ? e : new Error(String(e)),
}));

// ── Mock the flow registry to return minimal steps ──
// This isolates the CAS mechanism from the real flow complexity.
const mockGetFlowStep = vi.fn();
const mockGetFlowStepAcrossFlows = vi.fn().mockReturnValue(null);
const mockGetFlowDefinition = vi.fn();
const mockGetExtendedFlowDefinition = vi.fn();

vi.mock('@/lib/bot/flows/registry', () => ({
  getFlowStep: mockGetFlowStep,
  getFlowStepAcrossFlows: mockGetFlowStepAcrossFlows,
  getFlowDefinition: mockGetFlowDefinition,
  getExtendedFlowDefinition: mockGetExtendedFlowDefinition,
}));

// ── Mock executor dependencies ──
vi.mock('@sentry/nextjs', () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));
vi.mock('@/lib/bot/flows/analytics-flush', () => ({ flushExecutionAnalytics: vi.fn() }));
vi.mock('@/lib/bot/translate', () => ({
  translateBotResponse: vi.fn(async (text: string) => text),
}));
vi.mock('@/lib/bot/language-policy', () => ({
  getEffectiveLanguages: vi.fn(() => ({ tier: 'free', allowed: ['en'] })),
  loadBusinessLanguages: vi.fn(async () => null),
}));
vi.mock('@/lib/bot/conversation-guard', () => ({
  checkConversationLimit: vi.fn(async () => ({ allowed: true })),
  trackOutboundMessage: vi.fn(() => Promise.resolve()),
  getConversationLimitMessage: vi.fn(() => 'Limit reached'),
}));
vi.mock('@/lib/bot/step-overrides', () => ({
  loadOverrides: vi.fn(async () => new Map()),
  evaluateBranchConditions: vi.fn(),
}));
vi.mock('@/lib/bot/flow-analytics', () => ({ logDropoff: vi.fn() }));
vi.mock('@/lib/utils/sanitize', () => ({ sanitizeFilterValue: (v: string) => v }));
vi.mock('@/lib/bot/canonical-understanding', () => ({}));

// ── Helpers ──

interface CasCall {
  p_session_id: string;
  p_expected_version: number;
  p_current_step: string;
  p_session_data: Record<string, unknown>;
  p_conversation_log: unknown;
  p_step_history: unknown;
}

/** Build a supabase mock that captures update_session_cas RPC args */
function buildExecutorSb(casCalls: CasCall[]) {
  const sb: any = {
    rpc: vi.fn().mockImplementation((_fnName: string, args: CasCall) => {
      casCalls.push(args);
      return Promise.resolve({
        data: { success: true, version: (args.p_expected_version ?? 0) + 1 },
        error: null,
      });
    }),
    from: vi.fn().mockReturnValue({
      update: vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({ data: null, error: null }),
      }),
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({ data: null, error: null }),
          maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
        }),
      }),
    }),
  };
  return sb;
}

function makeSession(overrides?: Partial<{
  id: string;
  user_id: string | null;
  business_id: string | null;
  current_step: string;
  session_data: Record<string, unknown>;
  version: number;
}>) {
  return {
    id: 'sess-cas-1',
    user_id: 'u-1',
    business_id: 'biz-1',
    current_step: 'process_payment',
    session_data: { active_capability: 'payment', capabilities: ['payment', 'scheduling'] },
    version: 0,
    ...overrides,
  };
}

function makeBusiness() {
  return {
    id: 'biz-1',
    name: 'Test Biz',
    slug: 'test-biz',
    category: 'general' as any,
    flow_type: 'payment' as any,
    subscription_tier: 'growth',
    trial_ends_at: '',
    metadata: {},
    country_code: 'NG' as any,
  };
}

// ═══════════════════════════════════════════════════════════════
// ACC-008 CAS Regression: Real FlowExecutor.execute()
// ═══════════════════════════════════════════════════════════════
describe('ACC-008 CAS Regression: Real FlowExecutor.execute()', () => {
  let FlowExecutor: typeof import('@/lib/bot/flows/executor').FlowExecutor;

  beforeEach(async () => {
    vi.clearAllMocks();
    FlowExecutor = (await import('@/lib/bot/flows/executor')).FlowExecutor;
  });

  it('Payment process_payment — CAS persists await_payment after prompt sets payment_reference', async () => {
    // Register a minimal step that simulates what the real payment flow does:
    // prompt() sets payment_reference on session_data, nextAfterPrompt routes to await_payment
    mockGetFlowStep.mockImplementation((flowType: string, stepId: string) => {
      if (stepId === 'process_payment') {
        return {
          id: 'process_payment',
          nextAfterPrompt(ctx: any) {
            const d = ctx.session.session_data;
            if (d.payment_reference || d.bank_transfer_reference) return 'await_payment';
            return undefined;
          },
          async prompt(ctx: any) {
            // Simulate real prompt: set payment_reference on session_data
            ctx.session.session_data.payment_reference = 'PAY-CAS-001';
            return [{ type: 'text', text: 'Pay here: https://pay.test/1' }];
          },
          async validate() { return { valid: true }; },
          async next() { return null; },
        };
      }
      return null;
    });

    const casCalls: CasCall[] = [];
    const sb = buildExecutorSb(casCalls);
    const mockSender = {
      sendText: vi.fn().mockResolvedValue(undefined),
      sendButtons: vi.fn().mockResolvedValue(undefined),
      sendList: vi.fn().mockResolvedValue(undefined),
      sendImage: vi.fn().mockResolvedValue(undefined),
      sendDocument: vi.fn().mockResolvedValue(undefined),
      sendTemplate: vi.fn().mockResolvedValue(undefined),
    } as any;
    const mockStandalone = {} as any;
    const mockIntelligence = {} as any;

    const executor = new FlowExecutor(sb, mockSender, mockStandalone, mockIntelligence);

    const session = makeSession({ current_step: 'process_payment' });
    const business = makeBusiness();

    // Empty input triggers the prompt path
    await executor.execute(
      '+2348012345678',
      '',
      session,
      business,
      undefined,
      undefined,
      undefined,
      true, // _skipInstrumentation
    );

    // Verify CAS RPC was called
    expect(casCalls.length).toBeGreaterThanOrEqual(1);

    // The prompt CAS call should persist current_step = 'await_payment'
    // (the last CAS call in the prompt path)
    const promptCas = casCalls.find(c => c.p_current_step === 'await_payment');
    expect(promptCas).toBeDefined();
    expect(promptCas!.p_current_step).toBe('await_payment');
    expect(promptCas!.p_session_data.payment_reference).toBe('PAY-CAS-001');
  });

  it('Scheduling create_booking — CAS persists payment step after prompt sets payment_reference', async () => {
    mockGetFlowStep.mockImplementation((_flowType: string, stepId: string) => {
      if (stepId === 'create_booking') {
        return {
          id: 'create_booking',
          nextAfterPrompt(ctx: any) {
            const d = ctx.session.session_data;
            if (d._saved_method_id && !d._skip_saved_card) return 'saved_card_prompt';
            if (d.payment_reference || d.bank_transfer_reference) return 'payment';
            return undefined;
          },
          async prompt(ctx: any) {
            // Simulate: booking created, payment initialized
            ctx.session.session_data.payment_reference = 'SCHED-PAY-001';
            ctx.session.session_data.booking_id = 'bk-sched-cas';
            return [{ type: 'text', text: 'Booking created. Pay here.' }];
          },
          async validate() { return { valid: true }; },
          async next() { return null; },
        };
      }
      return null;
    });

    const casCalls: CasCall[] = [];
    const sb = buildExecutorSb(casCalls);
    const mockSender = {
      sendText: vi.fn().mockResolvedValue(undefined),
      sendButtons: vi.fn().mockResolvedValue(undefined),
      sendList: vi.fn().mockResolvedValue(undefined),
      sendImage: vi.fn().mockResolvedValue(undefined),
      sendDocument: vi.fn().mockResolvedValue(undefined),
      sendTemplate: vi.fn().mockResolvedValue(undefined),
    } as any;

    const executor = new FlowExecutor(sb, mockSender, {} as any, {} as any);

    const session = makeSession({
      current_step: 'create_booking',
      session_data: { active_capability: 'scheduling', capabilities: ['scheduling'] },
    });
    const business = makeBusiness();
    business.flow_type = 'scheduling' as any;

    await executor.execute('+2348012345678', '', session, business, undefined, undefined, undefined, true);

    expect(casCalls.length).toBeGreaterThanOrEqual(1);

    const promptCas = casCalls.find(c => c.p_current_step === 'payment');
    expect(promptCas).toBeDefined();
    expect(promptCas!.p_current_step).toBe('payment');
    expect(promptCas!.p_session_data.payment_reference).toBe('SCHED-PAY-001');
  });

  it('No nextAfterPrompt — CAS persists original current_step unchanged', async () => {
    mockGetFlowStep.mockImplementation((_flowType: string, stepId: string) => {
      if (stepId === 'collect_name') {
        return {
          id: 'collect_name',
          // No nextAfterPrompt defined — step stays on collect_name
          async prompt() {
            return [{ type: 'text', text: 'What is your name?' }];
          },
          async validate() { return { valid: true }; },
          async next() { return 'collect_date'; },
        };
      }
      return null;
    });

    const casCalls: CasCall[] = [];
    const sb = buildExecutorSb(casCalls);
    const mockSender = {
      sendText: vi.fn().mockResolvedValue(undefined),
      sendButtons: vi.fn().mockResolvedValue(undefined),
      sendList: vi.fn().mockResolvedValue(undefined),
      sendImage: vi.fn().mockResolvedValue(undefined),
      sendDocument: vi.fn().mockResolvedValue(undefined),
      sendTemplate: vi.fn().mockResolvedValue(undefined),
    } as any;

    const executor = new FlowExecutor(sb, mockSender, {} as any, {} as any);

    const session = makeSession({
      current_step: 'collect_name',
      session_data: { active_capability: 'scheduling', capabilities: ['scheduling'] },
    });

    await executor.execute('+2348012345678', '', session, makeBusiness(), undefined, undefined, undefined, true);

    expect(casCalls.length).toBeGreaterThanOrEqual(1);

    // The CAS call should persist current_step = 'collect_name' (unchanged)
    const promptCas = casCalls[casCalls.length - 1];
    expect(promptCas.p_current_step).toBe('collect_name');
  });

  it('CAS version conflict — executor stops without sending messages', async () => {
    mockGetFlowStep.mockImplementation((_flowType: string, stepId: string) => {
      if (stepId === 'process_payment') {
        return {
          id: 'process_payment',
          nextAfterPrompt() { return 'await_payment'; },
          async prompt(ctx: any) {
            ctx.session.session_data.payment_reference = 'PAY-CONFLICT';
            return [{ type: 'text', text: 'Pay here' }];
          },
          async validate() { return { valid: true }; },
          async next() { return null; },
        };
      }
      return null;
    });

    const sb: any = {
      rpc: vi.fn().mockResolvedValue({
        data: { success: false, reason: 'version_conflict', expected_version: 0, current_version: 2 },
        error: null,
      }),
      from: vi.fn().mockReturnValue({
        update: vi.fn().mockReturnValue({
          eq: vi.fn().mockResolvedValue({ data: null, error: null }),
        }),
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data: null, error: null }),
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
          }),
        }),
      }),
    };

    const mockSender = {
      sendText: vi.fn().mockResolvedValue(undefined),
      sendButtons: vi.fn().mockResolvedValue(undefined),
      sendList: vi.fn().mockResolvedValue(undefined),
      sendImage: vi.fn().mockResolvedValue(undefined),
      sendDocument: vi.fn().mockResolvedValue(undefined),
      sendTemplate: vi.fn().mockResolvedValue(undefined),
    } as any;

    const executor = new FlowExecutor(sb, mockSender, {} as any, {} as any);
    const session = makeSession({ current_step: 'process_payment' });

    await executor.execute('+2348012345678', '', session, makeBusiness(), undefined, undefined, undefined, true);

    // On CAS failure, executor must NOT send messages to avoid duplicate sends
    expect(mockSender.sendText).not.toHaveBeenCalled();
    expect(mockSender.sendButtons).not.toHaveBeenCalled();
  });
});
