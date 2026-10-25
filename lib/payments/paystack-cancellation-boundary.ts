/**
 * #605: Executable Paystack dispatch / reconciliation boundaries.
 *
 * This module does not create new billing claims. It is deliberately independent
 * of customer_subscriptions.status: a completed cancellation must not prevent
 * reconciliation of a previously-dispatched provider attempt.
 *
 * All callers must supply the authoritative, persisted attempt reference.
 * Never derive a new Paystack charge reference during reconciliation.
 */
import type { PaystackChargeOutcome, PaystackVerifyOutcome } from './paystack-recurring';

export type DbResult = { error: unknown | null };
export type ProviderChargeDecision =
  | { action: 'blocked'; reason: string }
  | { action: 'charged'; transactionId?: string }
  | { action: 'definitive_failure'; reason: string }
  | { action: 'unresolved'; reason: string };

export interface DispatchChargeDependencies {
  /** Read committed subscription state after dispatch and before HTTP request. */
  rereadSubscription: () => Promise<{ data: { status: string; cancellation_requested_at: string | null } | null; error: unknown | null }>;
  /** Charge the already-dispatched attempt with its persisted provider reference. */
  charge: () => Promise<PaystackChargeOutcome>;
  recordCharged: (transactionId?: string) => Promise<DbResult>;
  recordDefinitiveFailure: (reason: string) => Promise<DbResult>;
}

/**
 * Dispatch has ALREADY committed before this function is called.
 * If the state read fails, the provider is never called and the attempt stays
 * dispatched for reconciliation. This check narrows, but cannot make atomic,
 * the distributed DB-to-provider network boundary.
 */
export async function executePaystackDispatchedCharge(deps: DispatchChargeDependencies): Promise<ProviderChargeDecision> {
  let subscription: Awaited<ReturnType<DispatchChargeDependencies['rereadSubscription']>>;
  try {
    subscription = await deps.rereadSubscription();
  } catch {
    return { action: 'blocked', reason: 'precharge_subscription_lookup_exception' };
  }
  if (subscription.error || !subscription.data) {
    return { action: 'blocked', reason: 'precharge_subscription_lookup_failed' };
  }
  if (subscription.data.cancellation_requested_at ||
      !['active', 'past_due'].includes(subscription.data.status)) {
    return { action: 'blocked', reason: 'precharge_cancelled_or_inactive' };
  }

  let outcome: PaystackChargeOutcome;
  try {
    outcome = await deps.charge();
  } catch {
    // Network request may already have reached Paystack. Never reauthorize.
    return { action: 'unresolved', reason: 'charge_boundary_exception' };
  }

  if (outcome.status === 'success') {
    try {
      const result = await deps.recordCharged(outcome.transactionId);
      if (result.error) return { action: 'unresolved', reason: 'record_charged_failed' };
    } catch {
      return { action: 'unresolved', reason: 'record_charged_exception' };
    }
    return { action: 'charged', transactionId: outcome.transactionId };
  }

  if (outcome.status === 'terminal_failure') {
    try {
      const result = await deps.recordDefinitiveFailure(outcome.reason);
      if (result.error) return { action: 'unresolved', reason: 'record_failure_failed' };
    } catch {
      return { action: 'unresolved', reason: 'record_failure_exception' };
    }
    return { action: 'definitive_failure', reason: outcome.reason };
  }

  // pending / indeterminate: leave 'dispatched' until provider verification.
  return { action: 'unresolved', reason: outcome.status };
}

export interface DispatchedPaystackAttempt {
  id: string;
  provider_reference: string;
  status: 'dispatched' | 'charged';
}

export type ReconciliationDecision =
  | { action: 'finalized'; paymentId?: string }
  | { action: 'definitive_failure' }
  | { action: 'unresolved'; reason: string };

export interface ReconcileDependencies {
  verify: (reference: string) => Promise<PaystackVerifyOutcome>;
  /** M337 finalizer performs idempotent accounting against the exact attempt. */
  finalize: (attemptId: string, evidence: Extract<PaystackVerifyOutcome, { status: 'success' }>) => Promise<{ data: { success?: boolean; payment_id?: string } | null; error: unknown | null }>;
  markDefinitiveFailure: (attemptId: string, reason: string) => Promise<DbResult>;
}

/**
 * Reconcile an existing attempt EVEN IF its subscription is now cancelled.
 * Failure/404/timeout cannot justify a replacement provider charge.
 */
export async function reconcilePaystackDispatchedAttempt(
  deps: ReconcileDependencies,
  attempt: DispatchedPaystackAttempt,
): Promise<ReconciliationDecision> {
  let verification: PaystackVerifyOutcome;
  try {
    verification = await deps.verify(attempt.provider_reference);
  } catch {
    return { action: 'unresolved', reason: 'verification_exception' };
  }
  if (verification.status === 'success') {
    try {
      const fin = await deps.finalize(attempt.id, verification);
      if (fin.error || fin.data?.success !== true) {
        return { action: 'unresolved', reason: 'finalizer_did_not_confirm' };
      }
      return { action: 'finalized', paymentId: fin.data.payment_id };
    } catch {
      return { action: 'unresolved', reason: 'finalizer_exception' };
    }
  }
  if (verification.status === 'terminal_failure') {
    // Charged attempts already have strong positive provider evidence: if a
    // later verification disputes it, escalate rather than mutating to failed.
    if (attempt.status === 'charged') return { action: 'unresolved', reason: 'charged_attempt_provider_conflict' };
    try {
      const result = await deps.markDefinitiveFailure(attempt.id, verification.reason);
      if (result.error) return { action: 'unresolved', reason: 'mark_failed_error' };
      return { action: 'definitive_failure' };
    } catch {
      return { action: 'unresolved', reason: 'mark_failed_exception' };
    }
  }
  // Crucially, `not_found` is NOT a definitive negative when a dispatch was
  // committed before the external call. Preserve for operator reconciliation.
  return { action: 'unresolved', reason: verification.status };
}
