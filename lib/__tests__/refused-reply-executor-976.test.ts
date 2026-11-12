/**
 * #976: a flow reply refused by the financial gate (insufficient_allowance_balance).
 * Real FlowExecutor.execute()/sendMessages(); the flow registry, guard counters and Supabase are mocked.
 *  - the refusal is passed up (so BotService can send the #682 notice), and the rest of the batch is not tried
 *  - other send errors keep today's log-and-continue behaviour
 *  - refused replies are removed from conversation_log (one extra session save); delivered ones stay
 *  - outbound usage is counted only when something was sent; post-send work is kept alive with after()
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

const DENIAL = 'Financial authorization denied: insufficient_allowance_balance';

let FlowExecutor: typeof import('@/lib/bot/flows/executor').FlowExecutor;
let RefusedSendError: typeof import('@/lib/bot/financial-denial').RefusedSendError;
let isFinancialDenial: typeof import('@/lib/bot/financial-denial').isFinancialDenial;
beforeAll(async () => {
  ({ FlowExecutor } = await import('@/lib/bot/flows/executor'));
  ({ RefusedSendError, isFinancialDenial } = await import('@/lib/bot/financial-denial'));
}, 60_000);

type Cas = { p_expected_version: number; p_conversation_log: Array<{ role: string; content: string }> };

/** Supabase whose update_session_cas succeeds (or reports stale from call `staleFrom` on). */
function supabaseWithCas(casCalls: Cas[], staleFrom = Infinity) {
  return {
    rpc: vi.fn((_fn: string, args: Cas) => {
      casCalls.push(args);
      const stale = casCalls.length >= staleFrom;
      return Promise.resolve({ data: { success: !stale, version: args.p_expected_version + 1 }, error: null });
    }),
    from: vi.fn(() => ({ update: vi.fn(() => ({ eq: vi.fn(() => Promise.resolve({ data: null, error: null })) })) })),
  };
}

/** Sender whose Nth sendText call (1-based) behaves as given; others succeed. */
function senderWith(outcomes: Record<number, 'deny' | 'meta400'>) {
  let n = 0;
  const sendText = vi.fn(async () => {
    n++;
    if (outcomes[n] === 'deny') throw new Error(DENIAL);
    if (outcomes[n] === 'meta400') throw new Error('Cloud API error: 400');
    return { success: true };
  });
  return { sendText, sendButtons: vi.fn(), sendList: vi.fn(), sendImage: vi.fn(), sendDocument: vi.fn() };
}

function session() {
  return {
    id: 'sess-976', user_id: null, business_id: 'biz-1', current_step: 'welcome', version: 3,
    session_data: { active_capability: 'scheduling', capabilities: ['scheduling'] } as Record<string, unknown>,
    conversation_log: [{ role: 'user' as const, content: 'Hi', timestamp: '2026-11-11T00:54:50.000Z' }],
  };
}

const business = {
  id: 'biz-1', name: 'TestBiz', slug: 'testbiz', category: 'general' as never, flow_type: 'scheduling' as never,
  subscription_tier: 'starter', trial_ends_at: null, metadata: {}, country_code: 'NG' as never,
};

function promptStep(texts: string[]) {
  mockGetFlowStep.mockImplementation((_f: string, id: string) => id === 'welcome' ? {
    id: 'welcome',
    async prompt() { return texts.map(text => ({ type: 'text', text })); },
    async validate() { return { valid: true }; },
    async next() { return null; },
  } : null);
}

function botLines(c: Cas) { return c.p_conversation_log.filter(e => e.role === 'bot').map(e => e.content); }

beforeEach(() => {
  vi.clearAllMocks();
  loadOverrides.mockImplementation(async () => new Map());
  after.mockImplementation(() => { throw new Error('`after` was called outside a request scope'); });
});

describe('#976 refused flow reply — FlowExecutor.execute (prompt path)', () => {
  it('passes the refusal up with its original message and does not try the rest of the batch', async () => {
    promptStep(['Welcome to TestBiz!', 'Pick a service']);
    const cas: Cas[] = [];
    const sender = senderWith({ 1: 'deny' });
    const ex = new FlowExecutor(supabaseWithCas(cas) as never, sender as never, {} as never, {} as never);

    const err = await ex.execute('+2348000000001', '', session(), business).catch(e => e);

    expect(err).toBeInstanceOf(RefusedSendError);
    expect((err as Error).message).toBe(DENIAL); // BotService's #682 check matches on this
    expect(isFinancialDenial(err)).toBe(true);
    expect(sender.sendText).toHaveBeenCalledTimes(1); // message 2 is not tried
  });

  it('saves the prompt before sending (unchanged), then removes the refused replies from the log', async () => {
    promptStep(['Welcome to TestBiz!', 'Pick a service']);
    const cas: Cas[] = [];
    const s = session();
    const ex = new FlowExecutor(supabaseWithCas(cas) as never, senderWith({ 1: 'deny' }) as never, {} as never, {} as never);

    await ex.execute('+2348000000001', '', s, business).catch(() => undefined);

    expect(cas).toHaveLength(2);
    expect(botLines(cas[0])).toEqual(['Welcome to TestBiz!', 'Pick a service']); // save-before-send kept
    expect(botLines(cas[1])).toEqual([]); // cleanup: neither reply reached the customer
    expect(cas[1].p_expected_version).toBe(cas[0].p_expected_version + 1);
    expect(cas[1].p_conversation_log.map(e => e.content)).toEqual(['Hi']); // customer's message kept
    expect(s.conversation_log.map(e => e.content)).toEqual(['Hi']);
  });

  it('keeps replies that were delivered before the refusal', async () => {
    promptStep(['Welcome to TestBiz!', 'Pick a service']);
    const cas: Cas[] = [];
    const ex = new FlowExecutor(supabaseWithCas(cas) as never, senderWith({ 2: 'deny' }) as never, {} as never, {} as never);

    await ex.execute('+2348000000001', '', session(), business).catch(() => undefined);

    expect(botLines(cas[1])).toEqual(['Welcome to TestBiz!']);
  });

  it('a stale cleanup save writes nothing more and the refusal still reaches the caller', async () => {
    promptStep(['Welcome to TestBiz!']);
    const cas: Cas[] = [];
    const ex = new FlowExecutor(supabaseWithCas(cas, 2) as never, senderWith({ 1: 'deny' }) as never, {} as never, {} as never);

    const err = await ex.execute('+2348000000001', '', session(), business).catch(e => e);

    expect(err).toBeInstanceOf(RefusedSendError);
    expect(cas).toHaveLength(2); // the stale attempt only; no retry
  });

  it('a Meta error is not a refusal: logged, the next message is still sent, nothing removed', async () => {
    promptStep(['Welcome to TestBiz!', 'Pick a service']);
    const cas: Cas[] = [];
    const sender = senderWith({ 1: 'meta400' });
    const ex = new FlowExecutor(supabaseWithCas(cas) as never, sender as never, {} as never, {} as never);

    await expect(ex.execute('+2348000000001', '', session(), business)).resolves.toBeUndefined();

    expect(sender.sendText).toHaveBeenCalledTimes(2);
    expect(cas).toHaveLength(1);
  });

  it('a refused custom prompt (step override) is removed from the log too', async () => {
    promptStep(['unused']);
    loadOverrides.mockImplementation(async () => new Map([['welcome', { action: 'custom', customPrompt: 'Our custom hello' }]]) as never);
    const cas: Cas[] = [];
    const ex = new FlowExecutor(supabaseWithCas(cas) as never, senderWith({ 1: 'deny' }) as never, {} as never, {} as never);

    const err = await ex.execute('+2348000000001', '', session(), business).catch(e => e);

    expect(err).toBeInstanceOf(RefusedSendError);
    expect(botLines(cas[0])).toEqual(['Our custom hello']);
    expect(botLines(cas[1])).toEqual([]);
  });
});

describe('#976 refused flow reply — FlowExecutor.execute (input path, plain text sends)', () => {
  function validatingStep() {
    mockGetFlowStep.mockImplementation((_f: string, id: string) => id === 'welcome' ? {
      id: 'welcome',
      async prompt() { return [{ type: 'buttons', body: 'Pick a service', buttons: [{ id: 'a', title: 'A' }] }]; },
      async validate() { return { valid: false, errorMessage: 'Please pick one of the options.' }; },
      async next() { return null; },
    } : null);
  }

  it('a refused validation-error reply and the re-shown prompt after it are removed; the customer line stays', async () => {
    validatingStep();
    const cas: Cas[] = [];
    const ex = new FlowExecutor(supabaseWithCas(cas) as never, senderWith({ 1: 'deny' }) as never, {} as never, {} as never);

    const err = await ex.execute('+2348000000001', 'xyz', session(), business).catch(e => e);

    expect(err).toBeInstanceOf(RefusedSendError);
    expect(botLines(cas[0])).toEqual([expect.stringContaining('Please pick one of the options.'), 'Pick a service']);
    const last = cas[cas.length - 1];
    expect(botLines(last)).toEqual([]);
    expect(last.p_conversation_log.map(e => e.content)).toEqual(['Hi', 'xyz']);
  });

  it('an identical bot line delivered in an earlier message is never removed', async () => {
    validatingStep();
    const cas: Cas[] = [];
    const s = session();
    const earlier = { role: 'bot' as const, content: 'Pick a service', timestamp: '2026-11-11T00:50:00.000Z' };
    s.conversation_log.push(earlier as never);
    const ex = new FlowExecutor(supabaseWithCas(cas) as never, senderWith({ 1: 'deny' }) as never, {} as never, {} as never);

    await ex.execute('+2348000000001', 'xyz', s, business).catch(() => undefined);

    expect(botLines(cas[cas.length - 1])).toEqual(['Pick a service']); // the earlier, delivered one
    expect(s.conversation_log).toContain(earlier);
  });

  it('error text delivered, re-shown prompt refused: only the prompt line is removed', async () => {
    validatingStep();
    const cas: Cas[] = [];
    const sender = senderWith({});
    sender.sendButtons = vi.fn(async () => { throw new Error(DENIAL); }) as never;
    const ex = new FlowExecutor(supabaseWithCas(cas) as never, sender as never, {} as never, {} as never);

    await ex.execute('+2348000000001', 'xyz', session(), business).catch(() => undefined);

    expect(botLines(cas[cas.length - 1])).toEqual([expect.stringContaining('Please pick one of the options.')]);
  });
});

describe('#976 FlowExecutor.sendMessages — usage tracking and after()', () => {
  function bare(sender: unknown) {
    const ex = new FlowExecutor({} as never, sender as never, {} as never, {} as never);
    (ex as unknown as { currentBusinessId: string }).currentBusinessId = 'biz-1';
    return ex as unknown as { sendMessages: (to: string, m: unknown[], s: undefined, t: unknown) => Promise<void> };
  }

  it('all refused: no outbound usage counted; spend and low-balance checks still run', async () => {
    await bare(senderWith({ 1: 'deny' })).sendMessages('+1', [{ type: 'text', text: 'a' }], undefined, {}).catch(() => undefined);
    expect(trackOutboundMessage).not.toHaveBeenCalled();
    expect(checkSpendThresholds).toHaveBeenCalledTimes(1);
    expect(checkLowBalanceAlerts).toHaveBeenCalledTimes(1);
  });

  it('partly sent: outbound usage counted once', async () => {
    await bare(senderWith({ 2: 'deny' })).sendMessages('+1', [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }], undefined, {}).catch(() => undefined);
    expect(trackOutboundMessage).toHaveBeenCalledTimes(1);
  });

  it('a refused message that was never logged carries its text but no log entry', async () => {
    const err = await bare(senderWith({ 1: 'deny' })).sendMessages('+1', [{ type: 'text', text: 'a' }], undefined, {}).catch(e => e);
    expect(err).toBeInstanceOf(RefusedSendError);
    expect((err as InstanceType<typeof RefusedSendError>).refusedText).toBe('a');
    expect((err as InstanceType<typeof RefusedSendError>).refusedEntry).toBeUndefined();
  });

  it('inside a request, tracking and both checks are kept alive with after()', async () => {
    after.mockImplementation(() => undefined);
    await bare(senderWith({})).sendMessages('+1', [{ type: 'text', text: 'a' }], undefined, {});
    expect(after).toHaveBeenCalledTimes(3);
    for (const call of after.mock.calls) expect(call[0]).toBeInstanceOf(Promise);
  });
});
