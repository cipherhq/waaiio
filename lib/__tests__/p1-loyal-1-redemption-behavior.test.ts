/**
 * #598 M434 real bot step tests: a durable atomic receipt is the only proof
 * a reward may be issued. No source-text copies of production logic.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { loyaltyFlow } from '@/lib/bot/flows/loyalty.flow';
import { createMockContext, getStep } from '@/lib/bot/flows/__tests__/helpers';

vi.mock('@/lib/logger', () => ({ logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn() } }));
const step = getStep(loyaltyFlow, 'loyalty_redeem');
function ctxForRedemption() {
  const ctx = createMockContext();
  ctx.session.id = '22222222-2222-4222-8222-222222222222';
  ctx.session.session_data = { loyalty_id: 'loy-1', loyalty_balance: 600, _redeem_action: 'confirm' };
  ctx.business!.metadata = { loyalty_reward_threshold: 500, loyalty_reward_description: 'a free haircut' };
  return ctx;
}
function textCalls(ctx: ReturnType<typeof ctxForRedemption>) {
  return vi.mocked(ctx.sender.sendText).mock.calls.map(([args]) => args.text).join(' ');
}

describe('#598 atomic loyalty redemption bot gate', () => {
  beforeEach(() => vi.clearAllMocks());
  it.each([
    { data: { success: false, reason: 'insufficient_points' }, error: null },
    { data: null, error: null },
    { data: { success: true, code: null }, error: null },
    { data: null, error: { message: 'permission denied' } },
  ])('denies issuance without a valid durable receipt: %j', async result => {
    const ctx = ctxForRedemption();
    vi.mocked(ctx.supabase.rpc).mockResolvedValue(result as any);
    await step.next!(ctx);
    expect(textCalls(ctx)).not.toContain('Reward Redeemed!');
    expect(textCalls(ctx)).toContain('Something went wrong');
    expect(vi.mocked(ctx.supabase.from).mock.calls.some(([table]) => table === 'loyalty_transactions')).toBe(false);
  });

  it('issues only the RPC-provided code and authoritative balance, not a locally proposed code', async () => {
    const ctx = ctxForRedemption();
    vi.mocked(ctx.supabase.rpc).mockResolvedValue({
      data: { success: true, code: 'RW-ABC234', points_balance: 100, replayed: false }, error: null,
    } as any);
    vi.mocked(ctx.supabase.from).mockImplementation(((table: string) => {
      if (table === 'alerts') return { insert: vi.fn().mockResolvedValue({ error: null }) };
      return { update: () => ({ eq: async () => ({ error: null }) }) };
    }) as any);
    await step.next!(ctx);
    expect(vi.mocked(ctx.supabase.rpc)).toHaveBeenCalledWith('redeem_loyalty_reward_once', expect.objectContaining({
      p_business_id: ctx.business!.id, p_redemption_key: `bot:${ctx.session.id}`, p_points: 500,
    }));
    expect(textCalls(ctx)).toContain('RW-ABC234');
    expect(textCalls(ctx)).toContain('New balance: *100* points');
    expect(vi.mocked(ctx.supabase.from).mock.calls.some(([table]) => table === 'loyalty_transactions')).toBe(false);
  });

  it('replays the same code, not new points, when the RPC returns a durable repeat receipt', async () => {
    const ctx = ctxForRedemption();
    vi.mocked(ctx.supabase.rpc).mockResolvedValue({
      data: { success: true, code: 'RW-ABC234', points_balance: 100, replayed: true }, error: null,
    } as any);
    vi.mocked(ctx.supabase.from).mockImplementation(((table: string) => {
      if (table === 'alerts') return { insert: vi.fn().mockResolvedValue({ error: null }) };
      return { update: () => ({ eq: async () => ({ error: null }) }) };
    }) as any);
    await step.next!(ctx);
    expect(textCalls(ctx)).toContain('RW-ABC234');
    expect(textCalls(ctx)).not.toContain('Something went wrong');
  });

  it('does not debit or create a reward on Skip', async () => {
    const ctx = ctxForRedemption();
    ctx.session.session_data._redeem_action = 'skip';
    expect(await step.next!(ctx)).toBe('loyalty_menu');
    expect(ctx.supabase.rpc).not.toHaveBeenCalled();
  });
});
