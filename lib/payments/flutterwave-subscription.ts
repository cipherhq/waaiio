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
 * Query Flutterwave subscriptions with explicit status filter.
 * Returns matching subscriptions or error.
 */
async function querySubscriptions(
  email: string,
  statusFilter: 'cancelled' | 'active',
  flutterwaveKey: string,
): Promise<{ ok: true; data: { id: number; status: string }[] } | { ok: false; reason: string }> {
  try {
    const url = `https://api.flutterwave.com/v3/subscriptions?email=${encodeURIComponent(email)}&status=${statusFilter}`;
    const response = await fetch(url, {
      headers: { 'Authorization': `Bearer ${flutterwaveKey}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) return { ok: false, reason: 'unavailable' };
    const data = await response.json() as { status?: string; data?: { id: number; status: string }[] };
    if (data.status !== 'success' || !data.data) return { ok: false, reason: 'unavailable' };
    return { ok: true, data: data.data };
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
export async function verifySubscriptionStatus(
  subscriptionId: string,
  subscriberEmail: string,
  flutterwaveKey: string,
): Promise<{ ok: true; status: string } | { ok: false; reason: string }> {
  // Step 1: Check cancelled subscriptions first (explicit status=cancelled)
  const cancelledResult = await querySubscriptions(subscriberEmail, 'cancelled', flutterwaveKey);
  if (!cancelledResult.ok) return cancelledResult;

  const cancelledMatch = cancelledResult.data.filter(s => String(s.id) === subscriptionId);
  if (cancelledMatch.length === 1) return { ok: true, status: 'cancelled' };
  if (cancelledMatch.length > 1) {
    logger.error('[FLW-SUB] Ambiguous cancelled subscription', { subscriptionId, count: cancelledMatch.length });
    return { ok: false, reason: 'ambiguous' };
  }

  // Step 2: Not found as cancelled — check active (explicit status=active)
  const activeResult = await querySubscriptions(subscriberEmail, 'active', flutterwaveKey);
  if (!activeResult.ok) return activeResult;

  const activeMatch = activeResult.data.filter(s => String(s.id) === subscriptionId);
  if (activeMatch.length === 1) return { ok: true, status: 'active' };
  if (activeMatch.length > 1) {
    logger.error('[FLW-SUB] Ambiguous active subscription', { subscriptionId, count: activeMatch.length });
    return { ok: false, reason: 'ambiguous' };
  }

  // Not found in either status
  return { ok: false, reason: 'not_found' };
}
