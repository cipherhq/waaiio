/**
 * The bot's send path runs the low-balance check after its messages, also when a send was
 * refused for lack of balance (TestBiz staging, 10 Nov 2026). Real FlowExecutor.sendMessages.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';

const checkLowBalanceAlerts = vi.fn(async () => undefined);
vi.mock('@/lib/messaging/low-balance-alerts', () => ({ checkLowBalanceAlerts: (...a: unknown[]) => checkLowBalanceAlerts(...(a as [])) }));
vi.mock('@/lib/bot/conversation-guard', async (orig) => ({
  ...(await orig<typeof import('@/lib/bot/conversation-guard')>()),
  trackOutboundMessage: vi.fn(async () => undefined),
  checkSpendThresholds: vi.fn(async () => undefined),
}));
vi.mock('@sentry/nextjs', () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));
const after = vi.fn((_p: unknown): void => { throw new Error('`after` was called outside a request scope'); });
vi.mock('next/server', async (orig) => ({ ...(await orig<typeof import('next/server')>()), after: (p: unknown) => after(p) }));

// The executor module is large: import it once, before the tests, with a long timeout.
// (Imported cold inside the first test it can pass the 5 s default and leak a late send into the next test.)
let FlowExecutor: typeof import('@/lib/bot/flows/executor').FlowExecutor;
beforeAll(async () => { ({ FlowExecutor } = await import('@/lib/bot/flows/executor')); }, 60_000);

async function executorWith(sendText: (m: unknown) => Promise<unknown>) {
  const ex = new FlowExecutor({} as never, { sendText } as never, {} as never, { resetAbuse: vi.fn() } as never);
  (ex as unknown as { currentBusinessId: string }).currentBusinessId = 'biz-1';
  return ex as unknown as { sendMessages: (to: string, m: unknown[], s: undefined, t: unknown) => Promise<void> };
}

describe('FlowExecutor.sendMessages → low-balance check', () => {
  it('runs after an accepted send', async () => {
    checkLowBalanceAlerts.mockClear();
    const ex = await executorWith(async () => ({ ok: true }));
    await ex.sendMessages('+12404844862', [{ type: 'text', text: 'hi' }], undefined, {});
    expect(checkLowBalanceAlerts).toHaveBeenCalledWith(expect.anything(), 'biz-1');
  });

  it('runs when the send was refused for insufficient balance', async () => {
    checkLowBalanceAlerts.mockClear();
    const ex = await executorWith(async () => { throw new Error('Financial authorization denied: insufficient_allowance_balance'); });
    // #976: the refusal is passed up (BotService sends the #682 notice); the check has already run.
    await expect(ex.sendMessages('+12404844862', [{ type: 'text', text: 'hi' }], undefined, {}))
      .rejects.toThrow('Financial authorization denied: insufficient_allowance_balance');
    expect(checkLowBalanceAlerts).toHaveBeenCalledTimes(1);
  });

  it('a failing check never breaks the reply', async () => {
    checkLowBalanceAlerts.mockClear();
    checkLowBalanceAlerts.mockRejectedValueOnce(new Error('db down') as never);
    const sendText = vi.fn(async () => ({ ok: true }));
    const ex = await executorWith(sendText);
    await expect(ex.sendMessages('+1', [{ type: 'text', text: 'hi' }], undefined, {})).resolves.toBeUndefined();
    expect(sendText).toHaveBeenCalledTimes(1);
  });

  it('inside a request the check is kept alive with after() (the webhook may respond first)', async () => {
    checkLowBalanceAlerts.mockClear();
    after.mockImplementationOnce(() => undefined);
    const ex = await executorWith(async () => ({ ok: true }));
    await ex.sendMessages('+1', [{ type: 'text', text: 'hi' }], undefined, {});
    expect(after).toHaveBeenCalledWith(expect.any(Promise));
  });

  it('outside a request (after() throws) the reply and the check still run', async () => {
    checkLowBalanceAlerts.mockClear();
    const sendText = vi.fn(async () => ({ ok: true }));
    const ex = await executorWith(sendText);
    await expect(ex.sendMessages('+1', [{ type: 'text', text: 'hi' }], undefined, {})).resolves.toBeUndefined();
    expect(checkLowBalanceAlerts).toHaveBeenCalledTimes(1);
  });
});
