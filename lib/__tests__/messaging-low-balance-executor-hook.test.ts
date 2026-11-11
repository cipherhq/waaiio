/**
 * The bot's send path runs the low-balance check after its messages, also when a send was
 * refused for lack of balance (TestBiz staging, 10 Nov 2026). Real FlowExecutor.sendMessages.
 */
import { describe, expect, it, vi } from 'vitest';

const checkLowBalanceAlerts = vi.fn(async () => undefined);
vi.mock('@/lib/messaging/low-balance-alerts', () => ({ checkLowBalanceAlerts: (...a: unknown[]) => checkLowBalanceAlerts(...(a as [])) }));
vi.mock('@/lib/bot/conversation-guard', async (orig) => ({
  ...(await orig<typeof import('@/lib/bot/conversation-guard')>()),
  trackOutboundMessage: vi.fn(async () => undefined),
  checkSpendThresholds: vi.fn(async () => undefined),
}));
vi.mock('@sentry/nextjs', () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));

async function executorWith(sendText: (m: unknown) => Promise<unknown>) {
  const { FlowExecutor } = await import('@/lib/bot/flows/executor');
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
    await ex.sendMessages('+12404844862', [{ type: 'text', text: 'hi' }], undefined, {});
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
});
