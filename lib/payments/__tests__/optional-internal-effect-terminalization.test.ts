import { describe, expect, it, vi } from 'vitest';
import { driveInternalEffect } from '@/lib/payments/terminal-effects';

function makeSupabase(opts?: { skipOk?: boolean; completeOk?: boolean }) {
  const rpc = vi.fn(async (name: string) => {
    if (name === 'reserve_terminal_effect') {
      return { data: { reserved: true, effect_token: 'effect-token-1' }, error: null };
    }
    if (name === 'complete_internal_effect') {
      return { data: { completed: opts?.completeOk !== false }, error: null };
    }
    if (name === 'skip_optional_effect') {
      return { data: { skipped: opts?.skipOk !== false }, error: null };
    }
    throw new Error(`unexpected RPC: ${name}`);
  });
  return { supabase: { rpc } as any, rpc };
}

describe('driveInternalEffect optional failure terminalization', () => {
  it('skips a failed optional internal effect instead of leaving it claimed', async () => {
    const { supabase, rpc } = makeSupabase();
    const execute = vi.fn().mockRejectedValue(new Error('referral_lookup_failed'));

    const result = await driveInternalEffect(
      supabase,
      'payment-1',
      'referral_generation',
      'master-claim-1',
      execute,
    );

    expect(result).toEqual({ ok: true });
    expect(rpc).toHaveBeenCalledWith('reserve_terminal_effect', {
      p_payment_id: 'payment-1',
      p_effect_key: 'referral_generation',
      p_master_claim_token: 'master-claim-1',
    });
    expect(rpc).toHaveBeenCalledWith('skip_optional_effect', {
      p_payment_id: 'payment-1',
      p_effect_key: 'referral_generation',
      p_effect_token: 'effect-token-1',
      p_suppression_reason: 'optional_internal_effect_failed',
    });
    expect(rpc).not.toHaveBeenCalledWith(
      'complete_internal_effect',
      expect.anything(),
    );
  });

  it('keeps required internal failures fail-closed and does not skip them', async () => {
    const { supabase, rpc } = makeSupabase();
    const execute = vi.fn().mockRejectedValue(new Error('ticket finalization failed'));

    const result = await driveInternalEffect(
      supabase,
      'payment-2',
      'ticket_inventory_finalization',
      'master-claim-2',
      execute,
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain('ticket finalization failed');
    expect(rpc.mock.calls.some(([name]) => name === 'skip_optional_effect')).toBe(false);
  });

  it('fails closed if the optional skip transition itself cannot be persisted', async () => {
    const { supabase } = makeSupabase({ skipOk: false });
    const execute = vi.fn().mockRejectedValue(new Error('optional work failed'));

    const result = await driveInternalEffect(
      supabase,
      'payment-3',
      'referral_generation',
      'master-claim-3',
      execute,
    );

    expect(result).toEqual({ ok: false, error: 'skip_optional_failed' });
  });

  it('still completes a successful optional internal effect normally', async () => {
    const { supabase, rpc } = makeSupabase();
    const execute = vi.fn().mockResolvedValue(undefined);

    const result = await driveInternalEffect(
      supabase,
      'payment-4',
      'referral_generation',
      'master-claim-4',
      execute,
    );

    expect(result).toEqual({ ok: true });
    expect(rpc).toHaveBeenCalledWith('complete_internal_effect', {
      p_payment_id: 'payment-4',
      p_effect_key: 'referral_generation',
      p_effect_token: 'effect-token-1',
    });
    expect(rpc.mock.calls.some(([name]) => name === 'skip_optional_effect')).toBe(false);
  });
});
