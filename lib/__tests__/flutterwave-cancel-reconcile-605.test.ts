import { describe, expect, it, vi } from 'vitest';
import { reconcileCancelledFlutterwaveClaim } from '@/lib/payments/flutterwave-cancellation-reconciliation';

const stable = 'flw-51200000-0000-0000-0000-000000000002-2026-10-18';
const attempt = stable + '-a1';
const record = {
  stable_ref: stable,
  attempt_ref: attempt,
  claim_status: 'claimed',
  subscription_id: '51200000-0000-0000-0000-000000000002',
  amount: 50,
  currency: 'NGN',
};

function mockCase(opts: {
  outcome?: string | null;
  amount?: number;
  currency?: string;
  txRef?: string | null;
  touched?: boolean;
  touchError?: unknown;
  finalResult?: { success: boolean; payment_id?: string };
  finalError?: unknown;
} = {}) {
  const verify = vi.fn().mockResolvedValue(opts.outcome === null ? null : {
    outcome: opts.outcome ?? 'successful',
    amount: opts.amount ?? 50,
    currency: opts.currency ?? 'NGN',
    providerTxRef: opts.txRef === undefined ? attempt : opts.txRef,
  });
  const finalize = vi.fn().mockResolvedValue({
    data: opts.finalResult ?? { success: true, payment_id: 'pay-01' },
    error: opts.finalError ?? null,
  });
  const update = vi.fn();
  const query: any = {};
  query.eq = vi.fn().mockReturnValue(query);
  query.select = vi.fn().mockReturnValue(query);
  query.maybeSingle = vi.fn().mockResolvedValue({
    data: opts.touched === false ? null : { event_id: stable },
    error: opts.touchError ?? null,
  });
  update.mockReturnValue(query);
  const from = vi.fn().mockReturnValue({ update });
  const rpc = vi.fn().mockImplementation((name: string) => {
    if (name === 'finalize_token_recurring_charge') return finalize();
    throw new Error(`Unexpected RPC ${name}`);
  });
  return { deps: { supabase: { from, rpc } as any, verifyTransactionFn: verify as any }, verify, rpc, update };
}

describe('#605 Flutterwave post-cancellation existing-claim reconciliation', () => {
  it('finalizes a proven prior charge using exact identities and no charging call', async () => {
    const { deps, verify, rpc, update } = mockCase();
    expect(await reconcileCancelledFlutterwaveClaim(deps, record)).toEqual({
      action: 'finalized', paymentId: 'pay-01',
    });
    expect(verify).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledWith(attempt);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('finalize_token_recurring_charge', {
      p_stable_ref: stable, p_subscription_id: record.subscription_id,
      p_verified_amount: 50, p_verified_currency: 'NGN',
      p_gateway: 'flutterwave', p_provider_attempt_ref: attempt,
    });
    expect(update).toHaveBeenCalledOnce();
  });

  it('reconciles an already provider_success claim without charging again', async () => {
    const { deps, rpc } = mockCase();
    const result = await reconcileCancelledFlutterwaveClaim(deps, { ...record, claim_status: 'provider_success' });
    expect(result.action).toBe('finalized');
    expect(rpc).toHaveBeenCalledOnce();
  });

  it.each(['pending', 'unknown', 'failed', null])('does not finalize unresolved outcome %s', async outcome => {
    const { deps, rpc } = mockCase({ outcome });
    const result = await reconcileCancelledFlutterwaveClaim(deps, record);
    expect(result.action).toBe('skipped');
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    { txRef: 'other-ref' },
    { txRef: null },
    { amount: 60 },
    { currency: 'USD' },
  ])('rejects wrong provider identity, amount or currency: %o', async mismatch => {
    const { deps, rpc } = mockCase(mismatch);
    expect((await reconcileCancelledFlutterwaveClaim(deps, record)).action).toBe('error');
    expect(rpc).not.toHaveBeenCalled();
  });

  it('refuses malformed claim identity without provider verification', async () => {
    const { deps, verify } = mockCase();
    const result = await reconcileCancelledFlutterwaveClaim(deps, { ...record, attempt_ref: 'some-other-transaction' });
    expect(result).toEqual({ action: 'skipped', reason: 'invalid_existing_claim' });
    expect(verify).not.toHaveBeenCalled();
  });

  it('refuses a claim altered before the queue rotation', async () => {
    const { deps, verify } = mockCase({ touched: false });
    expect((await reconcileCancelledFlutterwaveClaim(deps, record)).reason).toBe('claim_changed');
    expect(verify).not.toHaveBeenCalled();
  });

  it('fails closed if claim update errors', async () => {
    const { deps, verify } = mockCase({ touchError: { message: 'DB down' } });
    expect((await reconcileCancelledFlutterwaveClaim(deps, record)).reason).toBe('claim_rotation_failed');
    expect(verify).not.toHaveBeenCalled();
  });

  it('treats finalizer database error as unresolved', async () => {
    const { deps } = mockCase({ finalError: { message: 'DB unavailable' } });
    expect((await reconcileCancelledFlutterwaveClaim(deps, record)).reason).toBe('finalization_failed');
  });

  it('treats finalizer refusal as unresolved', async () => {
    const { deps } = mockCase({ finalResult: { success: false } });
    expect((await reconcileCancelledFlutterwaveClaim(deps, record)).reason).toBe('finalization_failed');
  });
});
