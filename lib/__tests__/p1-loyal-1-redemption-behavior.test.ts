/**
 * #598 executable loyalty redemption regression tests.
 * Runs the actual production FlowStep.next, not source-string assertions.
 * This covers the immediate false/no-code failure gate; atomic ledger receipt
 * is a separate prerequisite for full redemption certification.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { loyaltyFlow } from '@/lib/bot/flows/loyalty.flow';
import { createMockContext, getStep } from '@/lib/bot/flows/__tests__/helpers';

vi.mock('@/lib/logger', () => ({ logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn() } }));
const step = getStep(loyaltyFlow, 'loyalty_redeem');

function redemptionContext() {
  const ctx = createMockContext();
  ctx.session.session_data = {
    loyalty_id: 'loyalty-1', loyalty_balance: 600,
    _redeem_action: 'confirm',
  };
  ctx.business!.metadata = {
    loyalty_reward_threshold: 500,
    loyalty_reward_description: 'a free haircut',
  };
  return ctx;
}

describe('P1-LOYAL-1/#598: executable redemption fail-closed behavior', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    { data: false, error: null },
    { data: null, error: null },
    { data: undefined, error: { message: 'DB offline' } },
  ])('denies reward and transaction when redemption is not confirmed: %j', async response => {
    const ctx = redemptionContext();
    vi.mocked(ctx.supabase.rpc).mockResolvedValue(response as any);
    await step.next!(ctx);
    const messages = vi.mocked(ctx.sender.sendText).mock.calls.map(([arg]) => arg.text);
    expect(messages.join(' ')).not.toContain('Reward Redeemed!');
    expect(messages.join(' ')).toContain('Something went wrong');
    expect(vi.mocked(ctx.supabase.from).mock.calls.some(([table]) => table === 'loyalty_transactions')).toBe(false);
  });

  it('generates a reward code only after a confirmed true RPC and persisted receipt', async () => {
    const ctx = redemptionContext();
    vi.mocked(ctx.supabase.rpc).mockResolvedValue({ data: true, error: null } as any);
    const insert = vi.fn().mockResolvedValue({ error: null });
    vi.mocked(ctx.supabase.from).mockImplementation(((table: string) => {
      if (table === 'loyalty_transactions') return { insert };
      return { update: () => ({ eq: async () => ({ error: null }) }), insert: () => Promise.resolve({ error: null }) };
    }) as any);
    await step.next!(ctx);
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ points_change: -500, reference_type: expect.stringMatching(/^code:RW-/) }));
    const messages = vi.mocked(ctx.sender.sendText).mock.calls.map(([arg]) => arg.text).join(' ');
    expect(messages).toContain('Reward Redeemed!');
    expect(messages).toContain('Redemption code:');
  });

  it('never claims the reward was issued when the transaction INSERT fails', async () => {
    const ctx = redemptionContext();
    vi.mocked(ctx.supabase.rpc).mockResolvedValue({ data: true, error: null } as any);
    vi.mocked(ctx.supabase.from).mockImplementation(((table: string) => {
      if (table === 'loyalty_transactions') return { insert: () => Promise.resolve({ error: { message: 'write failed' } }) };
      return { update: () => ({ eq: async () => ({ error: null }) }) };
    }) as any);
    await step.next!(ctx);
    const messages = vi.mocked(ctx.sender.sendText).mock.calls.map(([arg]) => arg.text).join(' ');
    expect(messages).toContain('Something went wrong');
    expect(messages).not.toContain('Reward Redeemed!');
  });
});
