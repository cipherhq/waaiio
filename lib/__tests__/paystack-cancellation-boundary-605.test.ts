/**
 * #605: Executable provider-boundary regression tests, no live provider calls.
 * Uses the exact helper called by retry-failed-charges cron, with fake IO.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  executePaystackDispatchedCharge,
  reconcilePaystackDispatchedAttempt,
  type DispatchChargeDependencies,
  type ReconcileDependencies,
} from '@/lib/payments/paystack-cancellation-boundary';

function chargeDeps(): DispatchChargeDependencies {
  return {
    rereadSubscription: vi.fn().mockResolvedValue({ data: { status: 'active', cancellation_requested_at: null }, error: null }),
    charge: vi.fn().mockResolvedValue({ status: 'success', reference: 'ps-fixed-ref', transactionId: 'tx-1' }),
    recordCharged: vi.fn().mockResolvedValue({ error: null }),
    recordDefinitiveFailure: vi.fn().mockResolvedValue({ error: null }),
  };
}
const dispatched = { id: 'attempt-1', provider_reference: 'ps-fixed-ref', status: 'dispatched' as const };
function reconcileDeps(): ReconcileDependencies {
  return {
    verify: vi.fn().mockResolvedValue({ status: 'success', amountMinor: 5000, currency: 'NGN', transactionId: 'tx-1' }),
    finalize: vi.fn().mockResolvedValue({ data: { success: true, payment_id: 'payment-1' }, error: null }),
    markDefinitiveFailure: vi.fn().mockResolvedValue({ error: null }),
  };
}

describe('#605 Paystack dispatch -> provider initiation (real helper)', () => {
  it('blocks charge when cancellation already recorded', async () => {
    const d = chargeDeps();
    vi.mocked(d.rereadSubscription).mockResolvedValue({ data: { status: 'active', cancellation_requested_at: '2026-10-19T02:00:00Z' }, error: null });
    expect((await executePaystackDispatchedCharge(d)).action).toBe('blocked');
    expect(d.charge).not.toHaveBeenCalled();
    expect(d.recordDefinitiveFailure).not.toHaveBeenCalled();
  });
  it('blocks provider call for missing subscription, cancelled status and DB error', async () => {
    for (const lookup of [
      { data: null, error: null },
      { data: null, error: { message: 'offline' } },
      { data: { status: 'cancelled', cancellation_requested_at: null }, error: null },
    ]) {
      const d = chargeDeps();
      vi.mocked(d.rereadSubscription).mockResolvedValue(lookup);
      expect((await executePaystackDispatchedCharge(d)).action).toBe('blocked');
      expect(d.charge).not.toHaveBeenCalled();
    }
  });
  it('blocks provider call when the preflight throws', async () => {
    const d = chargeDeps();
    vi.mocked(d.rereadSubscription).mockRejectedValue(Error('timeout'));
    expect((await executePaystackDispatchedCharge(d)).action).toBe('blocked');
    expect(d.charge).not.toHaveBeenCalled();
  });
  it('records a verified success only against the persisted attempt', async () => {
    const d = chargeDeps();
    expect(await executePaystackDispatchedCharge(d)).toEqual({ action: 'charged', transactionId: 'tx-1' });
    expect(d.recordCharged).toHaveBeenCalledWith('tx-1');
  });
  it('network exception remains unresolved (never false terminal failure)', async () => {
    const d = chargeDeps();
    vi.mocked(d.charge).mockRejectedValue(Error('timeout after provider accepted'));
    expect((await executePaystackDispatchedCharge(d)).action).toBe('unresolved');
    expect(d.recordDefinitiveFailure).not.toHaveBeenCalled();
  });
  it.each(['pending', 'indeterminate'] as const)('%s provider response stays unresolved', async (status) => {
    const d = chargeDeps();
    vi.mocked(d.charge).mockResolvedValue(status === 'pending'
      ? { status: 'pending', providerStatus: 'processing', reference: 'ps-fixed-ref' }
      : { status: 'indeterminate', reason: 'http_503' });
    expect((await executePaystackDispatchedCharge(d)).action).toBe('unresolved');
    expect(d.recordCharged).not.toHaveBeenCalled();
    expect(d.recordDefinitiveFailure).not.toHaveBeenCalled();
  });
  it('definitive provider rejection may be marked failed', async () => {
    const d = chargeDeps();
    vi.mocked(d.charge).mockResolvedValue({ status: 'terminal_failure', reason: 'card_declined', reference: 'ps-fixed-ref' });
    expect((await executePaystackDispatchedCharge(d)).action).toBe('definitive_failure');
    expect(d.recordDefinitiveFailure).toHaveBeenCalledWith('card_declined');
  });
  it('failed DB write after provider success is unresolved', async () => {
    const d = chargeDeps();
    vi.mocked(d.recordCharged).mockResolvedValue({ error: { message: 'db offline' } });
    expect((await executePaystackDispatchedCharge(d)).action).toBe('unresolved');
  });
  it('failed DB write after provider rejection is unresolved', async () => {
    const d = chargeDeps();
    vi.mocked(d.charge).mockResolvedValue({ status: 'terminal_failure', reason: 'declined', reference: 'ps-fixed-ref' });
    vi.mocked(d.recordDefinitiveFailure).mockResolvedValue({ error: { message: 'offline' } });
    expect((await executePaystackDispatchedCharge(d)).action).toBe('unresolved');
  });
});

describe('#605 Paystack cancelled subscription / in-flight reconciliation', () => {
  it('verified previous charge finalizes without checking subscription status or charging again', async () => {
    const d = reconcileDeps();
    expect(await reconcilePaystackDispatchedAttempt(d, dispatched)).toEqual({ action: 'finalized', paymentId: 'payment-1' });
    expect(d.verify).toHaveBeenCalledWith('ps-fixed-ref');
    expect(d.finalize).toHaveBeenCalledWith('attempt-1', expect.objectContaining({ status: 'success', amountMinor: 5000 }));
    expect(d.markDefinitiveFailure).not.toHaveBeenCalled();
  });
  it.each(['not_found', 'reversed', 'pending', 'indeterminate'] as const)('%s remains unresolved, with no duplicate charge', async (status) => {
    const d = reconcileDeps();
    vi.mocked(d.verify).mockResolvedValue(status === 'pending'
      ? { status: 'pending', txStatus: 'processing' }
      : status === 'indeterminate'
        ? { status: 'indeterminate', reason: 'timeout' }
        : { status });
    expect((await reconcilePaystackDispatchedAttempt(d, dispatched)).action).toBe('unresolved');
    expect(d.finalize).not.toHaveBeenCalled();
    expect(d.markDefinitiveFailure).not.toHaveBeenCalled();
  });
  it('only provider terminal failure can fail an uncharged dispatched attempt', async () => {
    const d = reconcileDeps();
    vi.mocked(d.verify).mockResolvedValue({ status: 'terminal_failure', reason: 'paystack_tx_failed' });
    expect((await reconcilePaystackDispatchedAttempt(d, dispatched)).action).toBe('definitive_failure');
    expect(d.markDefinitiveFailure).toHaveBeenCalledWith('attempt-1', 'paystack_tx_failed');
  });
  it('charged attempt plus conflicting terminal-failure evidence requires review', async () => {
    const d = reconcileDeps();
    vi.mocked(d.verify).mockResolvedValue({ status: 'terminal_failure', reason: 'disputed' });
    expect((await reconcilePaystackDispatchedAttempt(d, { ...dispatched, status: 'charged' })).action).toBe('unresolved');
    expect(d.markDefinitiveFailure).not.toHaveBeenCalled();
  });
  it('finalizer DB error cannot report reconciliation success', async () => {
    const d = reconcileDeps();
    vi.mocked(d.finalize).mockResolvedValue({ data: null, error: { message: 'offline' } });
    expect((await reconcilePaystackDispatchedAttempt(d, dispatched)).action).toBe('unresolved');
  });
  it('verification exception cannot mark a payment failed', async () => {
    const d = reconcileDeps();
    vi.mocked(d.verify).mockRejectedValue(Error('network down'));
    expect((await reconcilePaystackDispatchedAttempt(d, dispatched)).action).toBe('unresolved');
    expect(d.markDefinitiveFailure).not.toHaveBeenCalled();
  });
});
