/**
 * Flutterwave subscription correlation helpers (M378).
 *
 * Shared fail-closed provider-subscription lookup contract:
 * - HTTP 2xx required
 * - Provider response status must be 'success'
 * - Exactly one valid subscription row
 * - Valid nonzero provider subscription ID and plan ID
 * - Otherwise fail closed
 */

import { logger } from '@/lib/logger';

export interface SubscriptionCorrelation {
  subscriptionId: string;
  planId: number;
}

export type CorrelationResult =
  | { ok: true; sub: SubscriptionCorrelation }
  | { ok: false; reason: 'unavailable' | 'ambiguous' | 'not_found' | 'invalid' };

/**
 * Correlate a Flutterwave transaction to its provider subscription.
 * Uses GET /v3/subscriptions?transaction_id={txId}.
 *
 * Fail-closed: non-2xx, non-success, zero/multiple matches, or invalid IDs → error.
 */
export async function correlateProviderSubscription(
  transactionId: number,
  flutterwaveKey: string,
): Promise<CorrelationResult> {
  try {
    const response = await fetch(
      `https://api.flutterwave.com/v3/subscriptions?transaction_id=${transactionId}`,
      {
        headers: { 'Authorization': `Bearer ${flutterwaveKey}` },
        signal: AbortSignal.timeout(10000),
      },
    );

    if (!response.ok) {
      logger.error('[FLW-SUB] Subscription lookup HTTP error', { status: response.status, txId: transactionId });
      return { ok: false, reason: 'unavailable' };
    }

    const data = await response.json() as { status?: string; data?: { id: number; plan: number }[] };

    if (data.status !== 'success' || !data.data) {
      logger.error('[FLW-SUB] Subscription lookup non-success', { status: data.status, txId: transactionId });
      return { ok: false, reason: 'unavailable' };
    }

    if (data.data.length === 0) {
      return { ok: false, reason: 'not_found' };
    }

    if (data.data.length > 1) {
      logger.error('[FLW-SUB] Ambiguous: multiple subscriptions for transaction', { txId: transactionId, count: data.data.length });
      return { ok: false, reason: 'ambiguous' };
    }

    const sub = data.data[0];
    if (!sub.id || !sub.plan || sub.plan === 0) {
      logger.error('[FLW-SUB] Invalid subscription identity', { txId: transactionId, subId: sub.id, planId: sub.plan });
      return { ok: false, reason: 'invalid' };
    }

    return { ok: true, sub: { subscriptionId: String(sub.id), planId: sub.plan } };
  } catch (error) {
    logger.error('[FLW-SUB] Subscription lookup error', { txId: transactionId, error: String(error) });
    return { ok: false, reason: 'unavailable' };
  }
}

/**
 * Verify a Flutterwave subscription's current status using the documented
 * GET /v3/subscriptions list endpoint, matching by exact stored subscription ID.
 *
 * Does NOT use undocumented GET /v3/subscriptions/{id} endpoint.
 * Requires: HTTP 2xx, status=success, exact match to stored ID, exactly one match.
 */
/**
 * Query Flutterwave subscriptions with explicit status filter, paginating until
 * the target subscription ID is found or results are demonstrably exhausted.
 *
 * Documented GET /v3/subscriptions supports: email, status (cancelled|active), page.
 * Default page=1. Exhaustion: empty data array or fewer results than a reasonable page size.
 */
export async function findSubscriptionByStatus(
  targetSubscriptionId: string,
  email: string,
  statusFilter: 'cancelled' | 'active',
  flutterwaveKey: string,
  opts?: { planId?: number; maxPages?: number },
): Promise<{ ok: true; found: true; status: string } | { ok: true; found: false } | { ok: false; reason: string }> {
  const maxPages = opts?.maxPages ?? 50; // safety cap
  try {
    for (let page = 1; page <= maxPages; page++) {
      let url = `https://api.flutterwave.com/v3/subscriptions?email=${encodeURIComponent(email)}&status=${statusFilter}&page=${page}`;
      if (opts?.planId) url += `&plan=${opts.planId}`;

      const response = await fetch(url, {
        headers: { 'Authorization': `Bearer ${flutterwaveKey}` },
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) return { ok: false, reason: 'unavailable' };

      const data = await response.json() as { status?: string; data?: { id: number; status: string }[] };
      if (data.status !== 'success') return { ok: false, reason: 'unavailable' };

      // Empty page = provider-authoritative exhaustion
      if (!data.data || data.data.length === 0) {
        return { ok: true, found: false };
      }

      const match = data.data.find(s => String(s.id) === targetSubscriptionId);
      if (match) {
        return { ok: true, found: true, status: match.status };
      }

      // Continue to next page — do NOT use undocumented page-size heuristics
    }
    // Safety cap reached — fail closed as unavailable (NOT not_found)
    logger.error('[FLW-SUB] Pagination cap reached without finding subscription', {
      targetSubscriptionId, statusFilter, maxPages,
    });
    return { ok: false, reason: 'unavailable' };
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}

/**
 * Verify a Flutterwave subscription's current status using the documented
 * GET /v3/subscriptions endpoint with explicit status filters.
 *
 * For cancellation verification:
 * 1. Query status=cancelled with email filter, exact-match stored subscription ID
 * 2. If not found as cancelled, query status=active to check if it's still active (stale duplicate)
 * 3. If not found in either → not_found (fail closed)
 */
/**
 * Exhaustively classify whether a Flutterwave transaction belongs to a subscription,
 * checking BOTH active and cancelled provider subscriptions before declaring not_subscription.
 *
 * Required by Phase 1 Blocker A: a delayed charge whose provider subscription is now
 * cancelled must not be misrouted as an ordinary business payment.
 *
 * Returns the same CorrelationResult shape as correlateProviderSubscription but with
 * provider-authoritative dual-status evidence.
 */
export async function correlateProviderSubscriptionExhaustive(
  transactionId: number,
  flutterwaveKey: string,
): Promise<CorrelationResult> {
  // Step 1: Query default (active) subscriptions by transaction_id
  const activeResult = await correlateProviderSubscription(transactionId, flutterwaveKey);
  if (activeResult.ok) return activeResult; // Found as active subscription
  if (activeResult.reason === 'ambiguous' || activeResult.reason === 'invalid') return activeResult;
  if (activeResult.reason === 'unavailable') return activeResult; // Provider error — fail closed

  // activeResult.reason === 'not_found' under default/active filter
  // Step 2: Query cancelled subscriptions explicitly
  try {
    const response = await fetch(
      `https://api.flutterwave.com/v3/subscriptions?transaction_id=${transactionId}&status=cancelled`,
      {
        headers: { 'Authorization': `Bearer ${flutterwaveKey}` },
        signal: AbortSignal.timeout(10000),
      },
    );

    if (!response.ok) {
      logger.error('[FLW-SUB] Cancelled subscription lookup HTTP error', { status: response.status, txId: transactionId });
      return { ok: false, reason: 'unavailable' };
    }

    const data = await response.json() as { status?: string; data?: { id: number; plan: number }[] };

    if (data.status !== 'success' || !data.data) {
      logger.error('[FLW-SUB] Cancelled subscription lookup non-success', { status: data.status, txId: transactionId });
      return { ok: false, reason: 'unavailable' };
    }

    if (data.data.length === 0) {
      // Zero across both active and cancelled — genuinely not a subscription
      return { ok: false, reason: 'not_found' };
    }

    if (data.data.length > 1) {
      logger.error('[FLW-SUB] Ambiguous: multiple cancelled subscriptions for transaction', { txId: transactionId, count: data.data.length });
      return { ok: false, reason: 'ambiguous' };
    }

    const sub = data.data[0];
    if (!sub.id || !sub.plan || sub.plan === 0) {
      logger.error('[FLW-SUB] Invalid cancelled subscription identity', { txId: transactionId, subId: sub.id, planId: sub.plan });
      return { ok: false, reason: 'invalid' };
    }

    return { ok: true, sub: { subscriptionId: String(sub.id), planId: sub.plan } };
  } catch (error) {
    logger.error('[FLW-SUB] Cancelled subscription lookup error', { txId: transactionId, error: String(error) });
    return { ok: false, reason: 'unavailable' };
  }
}

export async function verifySubscriptionStatus(
  subscriptionId: string,
  subscriberEmail: string,
  flutterwaveKey: string,
  planId?: number,
): Promise<{ ok: true; status: string } | { ok: false; reason: string }> {
  // Step 1: Check cancelled subscriptions (explicit status=cancelled, paginated)
  const cancelledResult = await findSubscriptionByStatus(
    subscriptionId, subscriberEmail, 'cancelled', flutterwaveKey, { planId },
  );
  if (!cancelledResult.ok) return { ok: false, reason: cancelledResult.reason };
  if (cancelledResult.found) return { ok: true, status: 'cancelled' };

  // Step 2: Not found as cancelled — check active (explicit status=active, paginated)
  const activeResult = await findSubscriptionByStatus(
    subscriptionId, subscriberEmail, 'active', flutterwaveKey, { planId },
  );
  if (!activeResult.ok) return { ok: false, reason: activeResult.reason };
  if (activeResult.found) return { ok: true, status: 'active' };

  // Not found in either status after exhaustive pagination
  return { ok: false, reason: 'not_found' };
}
