/**
 * #536 junk pause through the real FlowExecutor.execute() invalid-input path
 * (flow registry, guard counters and Supabase mocked; harness from #976):
 *  - below the threshold the normal error and re-prompt are sent;
 *  - the reply that reaches 5 in a row sends only the pause notice and stores the pause;
 *  - payment steps and payments under way never count;
 *  - a counter error falls back to the normal error reply.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { trackOutboundMessage, checkSpendThresholds, checkLowBalanceAlerts, after, loadOverrides, mockGetFlowStep } = vi.hoisted(() => ({
  trackOutboundMessage: vi.fn(() => Promise.resolve()),
  checkSpendThresholds: vi.fn(() => Promise.resolve()),
  checkLowBalanceAlerts: vi.fn(() => Promise.resolve()),
  after: vi.fn((_p: unknown): void => { throw new Error('`after` was called outside a request scope'); }),
  loadOverrides: vi.fn(async () => new Map()),
  mockGetFlowStep: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), withContext: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) } }));
vi.mock('@sentry/nextjs', () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));
vi.mock('@/lib/bot/flows/analytics-flush', () => ({ flushExecutionAnalytics: vi.fn() }));
vi.mock('@/lib/bot/translate', () => ({ translateBotResponse: vi.fn(async (t: string) => t) }));
vi.mock('@/lib/bot/language-policy', () => ({
  getEffectiveLanguages: vi.fn(() => ({ tier: 'free', allowed: ['en'] })),
  loadBusinessLanguages: vi.fn(async () => null),
}));
vi.mock('@/lib/bot/conversation-guard', () => ({
  checkConversationLimit: vi.fn(async () => ({ allowed: true })),
  trackOutboundMessage,
  getConversationLimitMessage: vi.fn(() => 'Limit reached'),
  checkSpendThresholds,
}));
vi.mock('@/lib/messaging/low-balance-alerts', () => ({ checkLowBalanceAlerts }));
vi.mock('next/server', async (orig) => ({ ...(await orig<typeof import('next/server')>()), after: (p: unknown) => after(p) }));
vi.mock('@/lib/bot/step-overrides', () => ({ loadOverrides, evaluateBranchConditions: vi.fn() }));
vi.mock('@/lib/bot/flow-analytics', () => ({ logDropoff: vi.fn() }));
vi.mock('@/lib/bot/flows/registry', () => ({
  getFlowStep: mockGetFlowStep,
  getFlowStepAcrossFlows: vi.fn(() => null),
  getFlowDefinition: vi.fn(),
  getExtendedFlowDefinition: vi.fn(),
}));


let FlowExecutor: typeof import('@/lib/bot/flows/executor').FlowExecutor;
beforeAll(async () => {
  ({ FlowExecutor } = await import('@/lib/bot/flows/executor'));
}, 60_000);

const PHONE = '+2348000000536';
const business = {
  id: 'biz-1', name: 'TestBiz', slug: 'testbiz', category: 'general' as never, flow_type: 'scheduling' as never,
  subscription_tier: 'starter', trial_ends_at: null, metadata: {}, country_code: 'NG' as never,
};

function session(step: string, extra: Record<string, unknown> = {}) {
  return {
    id: 'sess-536', user_id: null, business_id: 'biz-1', current_step: step, version: 3,
    session_data: { active_capability: 'scheduling', capabilities: ['scheduling'], ...extra } as Record<string, unknown>,
    conversation_log: [{ role: 'user' as const, content: 'Hi', timestamp: '2026-11-12T00:00:00.000Z' }],
  };
}

function invalidStep(id: string) {
  mockGetFlowStep.mockImplementation((_f: string, stepId: string) => stepId === id ? {
    id,
    async prompt() { return [{ type: 'text', text: 'Pick a time' }]; },
    async validate() { return { valid: false, errorMessage: 'Please pick one of the options.' }; },
    async next() { return null; },
  } : null);
}

/** Supabase: CAS always succeeds; the invalid-input counter answers `invalidCount` (or fails). */
function db(invalidCount: number | 'error') {
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === 'record_customer_invalid_input') {
      return invalidCount === 'error' ? { data: null, error: { message: 'down' } } : { data: invalidCount, error: null };
    }
    if (name === 'set_customer_cooldown') return { data: '2026-11-12T00:05:00Z', error: null };
    return { data: { success: true, version: (args.p_expected_version as number ?? 0) + 1 }, error: null };
  });
  return { rpc, from: vi.fn(() => ({ update: vi.fn(() => ({ eq: vi.fn(() => Promise.resolve({ data: null, error: null })) })) })) };
}

function sender() {
  return { sendText: vi.fn(async () => ({ success: true })), sendButtons: vi.fn(), sendList: vi.fn(), sendImage: vi.fn(), sendDocument: vi.fn() };
}

const texts = (s: ReturnType<typeof sender>) => (s.sendText.mock.calls as unknown as Array<[{ text: string }]>).map(c => c[0].text);

beforeEach(() => {
  vi.clearAllMocks();
  loadOverrides.mockImplementation(async () => new Map());
  after.mockImplementation(() => undefined);
});

describe('#536 junk pause in FlowExecutor', () => {
  it('below the threshold sends the normal error reply', async () => {
    invalidStep('pick_time');
    const d = db(4); const s = sender();
    await new FlowExecutor(d as never, s as never, {} as never, {} as never).execute(PHONE, 'asdf', session('pick_time'), business);
    expect(d.rpc).toHaveBeenCalledWith('record_customer_invalid_input', { p_phone: PHONE, p_step_key: 'sess-536:pick_time', p_window_seconds: 600 });
    expect(texts(s)).toEqual([expect.stringContaining('Please pick one of the options.')]);
    expect(d.rpc.mock.calls.map(c => c[0])).not.toContain('set_customer_cooldown');
  });

  it('the 5th invalid reply in a row sends only the pause notice and stores the pause', async () => {
    invalidStep('pick_time');
    const d = db(5); const s = sender();
    await new FlowExecutor(d as never, s as never, {} as never, {} as never).execute(PHONE, 'asdf', session('pick_time'), business);
    expect(texts(s)).toEqual([expect.stringContaining('reply *menu* to see your options')]);
    expect(d.rpc).toHaveBeenCalledWith('set_customer_cooldown', { p_phone: PHONE, p_seconds: 300, p_notice_sent: true });
  });

  it('never counts at a payment step or while a payment is under way', async () => {
    for (const [step, extra] of [['process_order', {}], ['await_payment', {}], ['pick_time', { _awaiting_card_pin: true }]] as const) {
      invalidStep(step);
      const d = db(99); const s = sender();
      await new FlowExecutor(d as never, s as never, {} as never, {} as never).execute(PHONE, '9999', session(step, extra), business);
      expect(d.rpc.mock.calls.map(c => c[0])).not.toContain('record_customer_invalid_input');
      expect(texts(s)).toEqual([expect.stringContaining('Please pick one of the options.')]);
    }
  });

  it('a counter error falls back to the normal error reply', async () => {
    invalidStep('pick_time');
    const d = db('error'); const s = sender();
    await new FlowExecutor(d as never, s as never, {} as never, {} as never).execute(PHONE, 'asdf', session('pick_time'), business);
    expect(texts(s)).toEqual([expect.stringContaining('Please pick one of the options.')]);
  });
});
