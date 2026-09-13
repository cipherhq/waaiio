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
  | { route: 'unknown'; reason: string };

/**
 * Decide how to route a charge.completed webhook event.
 * Production routing authority — called by the actual POST handler.
 *
 * Fail-closed rules:
 * - waaiiosub + no local intent → unknown (orphaned platform event, reconcile)
 * - Provider subscription match + no local subscription → unknown (orphaned)
 * - Missing/invalid provider txId when subscription can't be classified → unknown
 * - Only positively proven zero-subscription match may route to business_payment
 * - Ambiguous/unavailable → unknown
 */
export function decideChargeRouting(
  txRef: string,
  webhookTxId: number,
  hasIntentMatch: boolean,
  renewalLookupResult: 'matched' | 'not_subscription' | 'unavailable' | 'ambiguous' | 'not_checked',
  localSubId?: string,
): ChargeRoutingDecision {
  // waaiiosub prefix → platform subscription domain
  if (txRef.startsWith('waaiiosub')) {
    if (hasIntentMatch) return { route: 'platform_initial', txRef };
    // waaiiosub without local intent → unknown/reconcile (never business_payment)
    return { route: 'unknown', reason: 'waaiiosub_without_intent' };
  }

  // Non-waaiiosub → need provider subscription evidence to classify
  if (!webhookTxId) {
    return { route: 'unknown', reason: 'missing_provider_tx_id' };
  }

  if (renewalLookupResult === 'not_checked') {
    return { route: 'unknown', reason: 'subscription_lookup_not_performed' };
  }

  if (renewalLookupResult === 'matched') {
    if (!localSubId) {
      // Provider says it's a subscription, but no local match → orphaned
      return { route: 'unknown', reason: 'provider_match_without_local_subscription' };
    }
    return { route: 'platform_renewal', txId: webhookTxId };
  }

  if (renewalLookupResult === 'unavailable' || renewalLookupResult === 'ambiguous') {
    return { route: 'unknown', reason: `subscription_lookup_${renewalLookupResult}` };
  }

  // renewalLookupResult === 'not_subscription' — positively proven zero matches
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

/**
 * Evidence-aware provider initialization response classifier.
 *
 * Only a documented response that proves NO provider transaction/session was created
 * may transition the intent terminal (mark_failed). Specifically:
 * - 400 Bad Request, 401/403 Auth, 404 Not Found, 422 Validation → definitive rejection
 * - 429 Too Many Requests → retryable, retain key
 * - 409 Conflict / requery → ambiguous, retain key
 * - Unknown/other 4xx → ambiguous, retain key (fail closed)
 * - 5xx, network, timeout → ambiguous, retain key
 */
export function decideInitResponse(httpStatus: number, providerSuccess: boolean): InitDecision {
  if (providerSuccess) return { action: 'success' };
  if (httpStatus >= 500) return { action: 'retain_key' }; // ambiguous 5xx
  // Evidence-aware 4xx classification (Blocker B)
  if (httpStatus >= 400 && httpStatus < 500) {
    // Definitive rejections — provider provably did NOT create a transaction
    const definitiveRejections = [400, 401, 403, 404, 422];
    if (definitiveRejections.includes(httpStatus)) return { action: 'mark_failed' };
    // 429 (rate limit), 409 (conflict/requery), other ambiguous 4xx → retain key
    return { action: 'retain_key' };
  }
  return { action: 'retain_key' }; // network/timeout/other non-ok
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
