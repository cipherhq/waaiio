/**
 * Flutterwave webhook/route decision functions (M378 Phase 1).
 *
 * Production decision logic extracted from POST handlers for testability.
 * The actual POST handlers call these exact functions.
 */

import type { VerifyResult } from './flutterwave-verify';
import type { CorrelationResult } from './flutterwave-subscription';

// ═══ Webhook charge.completed routing decision ═══

export type ChargeRoutingDecision =
  | { route: 'platform_initial'; txRef: string }
  | { route: 'platform_renewal'; txId: number }
  | { route: 'business_payment'; txRef: string }
  | { route: 'unknown' };

/**
 * Decide how to route a charge.completed webhook event.
 * This is the production routing logic called by the POST handler.
 *
 * - tx_ref starting with 'waaiiosub' → platform subscription initial charge
 * - Otherwise, if provider subscription lookup finds a match → platform renewal
 * - Otherwise → ordinary business payment (existing path)
 */
export function decideChargeRouting(
  txRef: string,
  webhookTxId: number,
  hasIntentMatch: boolean,
  renewalLookupResult: 'matched' | 'not_subscription' | 'unavailable' | 'ambiguous',
  localSubId?: string,
): ChargeRoutingDecision {
  if (txRef.startsWith('waaiiosub') && hasIntentMatch) {
    return { route: 'platform_initial', txRef };
  }
  if (!txRef.startsWith('waaiiosub')) {
    if (renewalLookupResult === 'matched' && localSubId) {
      return { route: 'platform_renewal', txId: webhookTxId };
    }
    if (renewalLookupResult === 'unavailable' || renewalLookupResult === 'ambiguous') {
      return { route: 'unknown' }; // fail closed
    }
  }
  return { route: 'business_payment', txRef };
}

// ═══ Timeout recovery decision ═══

export type TimeoutDecision =
  | { action: 'finalize'; tx: { id: number; amount: number; currency: string; created_at: string } }
  | { action: 'replace' }
  | { action: 'retain' }
  | { action: 'fail_closed'; reason: string };

export function decideTimeoutRecovery(verifyResult: VerifyResult): TimeoutDecision {
  if (!verifyResult.ok) {
    return { action: 'fail_closed', reason: verifyResult.reason };
  }
  const { tx } = verifyResult;
  if (tx.status === 'successful') {
    return { action: 'finalize', tx: { id: tx.id, amount: tx.amount, currency: tx.currency, created_at: tx.created_at } };
  }
  if (tx.status === 'failed' || tx.status === 'cancelled') {
    return { action: 'replace' };
  }
  // pending/unknown → retain original intent/key
  return { action: 'retain' };
}

// ═══ Provider initialization response decision ═══

export type InitDecision =
  | { action: 'success' }
  | { action: 'mark_failed' }
  | { action: 'retain_key' };

export function decideInitResponse(httpStatus: number, providerSuccess: boolean): InitDecision {
  if (providerSuccess) return { action: 'success' };
  if (httpStatus >= 500) return { action: 'retain_key' }; // ambiguous 5xx
  if (httpStatus >= 400 && httpStatus < 500) return { action: 'mark_failed' }; // definitive 4xx
  return { action: 'retain_key' }; // other non-ok
}

// ═══ Cancellation decision ═══

export type CancelDecision =
  | { action: 'cancel' }
  | { action: 'already_cancelled' }
  | { action: 'stale_duplicate' }
  | { action: 'fail_closed'; reason: string };

export function decideCancellation(
  localStatus: string,
  hasSubscriptionId: boolean,
  providerState: { ok: true; status: string } | { ok: false; reason: string } | null,
): CancelDecision {
  // Already cancelled locally → idempotent
  if (localStatus === 'cancelled') {
    return { action: 'already_cancelled' };
  }
  // Missing subscription ID → fail closed, never bypass verification
  if (!hasSubscriptionId) {
    return { action: 'fail_closed', reason: 'missing_subscription_id' };
  }
  // Provider verification required
  if (!providerState) {
    return { action: 'fail_closed', reason: 'verification_not_performed' };
  }
  if (!providerState.ok) {
    return { action: 'fail_closed', reason: `provider_${providerState.reason}` };
  }
  // Only cancel if provider confirms cancelled/deactivated
  if (providerState.status === 'cancelled' || providerState.status === 'deactivated') {
    return { action: 'cancel' };
  }
  // Provider says active/other → stale duplicate
  return { action: 'stale_duplicate' };
}

// ═══ Subscription correlation decision ═══

export type CorrelationDecision =
  | { action: 'proceed'; subscriptionId: string; planId: number }
  | { action: 'fail_closed'; reason: string };

export function decideSubscriptionCorrelation(result: CorrelationResult): CorrelationDecision {
  if (!result.ok) {
    return { action: 'fail_closed', reason: result.reason };
  }
  return { action: 'proceed', subscriptionId: result.sub.subscriptionId, planId: result.sub.planId };
}

// ═══ Finalizer result decision ═══

export type FinalizerDecision =
  | { action: 'success' }
  | { action: 'quarantined' }
  | { action: 'failed'; reason: string };

export function decideFinalizerResult(result: Record<string, unknown> | null, error: unknown): FinalizerDecision {
  if (error) return { action: 'failed', reason: String(error) };
  if (!result || result.finalized !== true) {
    if (result?.quarantine) return { action: 'quarantined' };
    return { action: 'failed', reason: JSON.stringify(result) };
  }
  return { action: 'success' };
}
