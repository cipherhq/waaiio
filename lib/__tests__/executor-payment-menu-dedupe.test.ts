/**
 * One next-steps menu per paid chat transaction (Owner rule 2026-11-05).
 * When the payment confirmation (Stage 3) already sent this payment's menu,
 * the real FlowExecutor.execute() completion branch must not send a second one.
 * Harness copied from p0-executor-cas-regression.test.ts.
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
  checkSpendThresholds: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/bot/step-overrides', () => ({
  loadOverrides: vi.fn(async () => new Map()),
  evaluateBranchConditions: vi.fn(),
}));
vi.mock('@/lib/bot/flow-analytics', () => ({ logDropoff: vi.fn() }));
vi.mock('@/lib/utils/sanitize', () => ({ sanitizeFilterValue: (v: string) => v }));
vi.mock('@/lib/bot/canonical-understanding', () => ({}));

const { mockMenuSent } = vi.hoisted(() => ({ mockMenuSent: vi.fn() }));
vi.mock('@/lib/payments/next-steps-menu', () => ({ paymentNextStepsMenuSent: mockMenuSent }));

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


function completingStep(data: Record<string, unknown>) {
  mockGetFlowStep.mockImplementation((_flowType: string, stepId: string) => {
    if (stepId !== 'await_payment') return null;
    return {
      id: 'await_payment',
      async prompt() { return [{ type: 'text', text: 'Tap I have paid' }]; },
      async validate() { return { valid: true, data }; },
      async next() { return null; },
    };
  });
}

async function runCompletion(sessionData: Record<string, unknown>) {
  const casCalls: CasCall[] = [];
  const sb = buildExecutorSb(casCalls);
  const sender = {
    sendText: vi.fn().mockResolvedValue(undefined),
    sendButtons: vi.fn().mockResolvedValue(undefined),
    sendList: vi.fn().mockResolvedValue(undefined),
    sendImage: vi.fn().mockResolvedValue(undefined),
    sendDocument: vi.fn().mockResolvedValue(undefined),
    sendTemplate: vi.fn().mockResolvedValue(undefined),
  } as any;
  const { FlowExecutor } = await import('@/lib/bot/flows/executor');
  const executor = new FlowExecutor(sb, sender, {} as any, {} as any);
  const session = makeSession({ current_step: 'await_payment', session_data: { active_capability: 'payment', capabilities: ['payment'], ...sessionData } });
  await executor.execute('+2348012345678', 'ive_paid', session, makeBusiness(), undefined, undefined, undefined, true);
  const rpcNames = sb.rpc.mock.calls.map((c: unknown[]) => c[0]);
  return { sender, rpcNames, casCalls };
}

describe('Paid chat completion: one next-steps menu', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('payment confirmation already sent its menu → chat ends the session and sends no second menu', async () => {
    mockMenuSent.mockResolvedValue(true);
    completingStep({ _action: 'payment_confirmed' });
    const { sender, rpcNames, casCalls } = await runCompletion({ payment_reference: 'PAY-1' });
    expect(mockMenuSent).toHaveBeenCalledWith(expect.anything(), 'biz-1', expect.objectContaining({ payment_reference: 'PAY-1', _action: 'payment_confirmed' }));
    expect(sender.sendButtons).not.toHaveBeenCalled();
    expect(sender.sendList).not.toHaveBeenCalled();
    expect(rpcNames).toContain('deactivate_session_atomic');
    expect(casCalls.some(c => c.p_current_step === 'post_completion')).toBe(false);
  });

  it('payment confirmation did not send a menu → chat shows its own menu with the footer', async () => {
    mockMenuSent.mockResolvedValue(false);
    completingStep({ _action: 'payment_confirmed' });
    const { sender, casCalls } = await runCompletion({ payment_reference: 'PAY-1' });
    expect(sender.sendButtons).toHaveBeenCalledTimes(1);
    const menu = sender.sendButtons.mock.calls[0][0];
    expect(menu.buttons.map((b: { id: string }) => b.id)).toContain('pc_options');
    expect(menu.footer).toBe('Powered by Waaiio.com');
    expect(casCalls.some(c => c.p_current_step === 'post_completion')).toBe(true);
  });

  it('free completion (no payment) never asks about the payment menu', async () => {
    mockMenuSent.mockResolvedValue(true);
    completingStep({});
    const { sender } = await runCompletion({});
    expect(mockMenuSent).not.toHaveBeenCalled();
    expect(sender.sendButtons).toHaveBeenCalledTimes(1);
  });
});
