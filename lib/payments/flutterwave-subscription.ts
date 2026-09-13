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
 * Query Flutterwave subscriptions by transaction_id with explicit status filter.
 * Returns the raw parsed subscription rows or a structured failure.
 *
 * This is the atomic building block for exhaustive classification — it always sends
 * an explicit `status` parameter, never relying on provider defaults.
 */
export type TxSubQueryResult =
  | { ok: true; subs: { id: number; plan: number }[] }
  | { ok: false; reason: 'unavailable' };

export async function querySubscriptionsByTxId(
  transactionId: number,
  statusFilter: 'active' | 'cancelled',
  flutterwaveKey: string,
): Promise<TxSubQueryResult> {
  try {
    const response = await fetch(
      `https://api.flutterwave.com/v3/subscriptions?transaction_id=${transactionId}&status=${statusFilter}`,
      {
        headers: { 'Authorization': `Bearer ${flutterwaveKey}` },
        signal: AbortSignal.timeout(10000),
      },
    );

    if (!response.ok) {
      logger.error('[FLW-SUB] Subscription tx lookup HTTP error', { status: response.status, txId: transactionId, statusFilter });
      return { ok: false, reason: 'unavailable' };
    }

    const data = await response.json() as { status?: string; data?: { id: number; plan: number }[] };
    if (data.status !== 'success' || !data.data) {
      logger.error('[FLW-SUB] Subscription tx lookup non-success', { status: data.status, txId: transactionId, statusFilter });
      return { ok: false, reason: 'unavailable' };
    }

    return { ok: true, subs: data.data };
  } catch (error) {
    logger.error('[FLW-SUB] Subscription tx lookup error', { txId: transactionId, statusFilter, error: String(error) });
    return { ok: false, reason: 'unavailable' };
  }
}

/**
 * Exhaustively classify whether a Flutterwave transaction belongs to a subscription
 * by querying BOTH explicit status=active AND explicit status=cancelled for the exact
 * transaction_id, evaluating both results before classification.
 *
 * Required by Phase 1 Blocker A — both queries run before any classification decision.
 *
 * Classification rules (applied AFTER both queries complete):
 * 1. Provider error/malformed/ambiguous in EITHER query → fail closed (unavailable)
 * 2. Combine all valid subscription rows from both queries
 * 3. Zero total across both → not_subscription (only path to business-payment)
 * 4. Dedupe by exact provider subscription identity (id + plan)
 * 5. Exactly one consistent identity → subscription match
 * 6. Multiple different/conflicting identities → fail closed (ambiguous)
 * 7. Invalid identity (zero id/plan) → fail closed (invalid)
 */
export async function correlateProviderSubscriptionExhaustive(
  transactionId: number,
  flutterwaveKey: string,
): Promise<CorrelationResult> {
  // Fire both queries — both must succeed before classification
  const [activeResult, cancelledResult] = await Promise.all([
    querySubscriptionsByTxId(transactionId, 'active', flutterwaveKey),
    querySubscriptionsByTxId(transactionId, 'cancelled', flutterwaveKey),
  ]);

  // Rule 1: provider error in either query → fail closed
  if (!activeResult.ok || !cancelledResult.ok) {
    logger.error('[FLW-SUB] Exhaustive correlation: provider error in at least one query', {
      txId: transactionId, activeOk: activeResult.ok, cancelledOk: cancelledResult.ok,
    });
    return { ok: false, reason: 'unavailable' };
  }

  // Rule 2: combine all rows from both queries
  const allSubs = [...activeResult.subs, ...cancelledResult.subs];

  // Rule 3: zero across both → genuinely not a subscription
  if (allSubs.length === 0) {
    return { ok: false, reason: 'not_found' };
  }

  // Rule 4+7: validate all identities and dedupe by (id, plan)
  const identityMap = new Map<string, { id: number; plan: number }>();
  for (const sub of allSubs) {
    if (!sub.id || !sub.plan || sub.plan === 0) {
      logger.error('[FLW-SUB] Invalid subscription identity in exhaustive correlation', {
        txId: transactionId, subId: sub.id, planId: sub.plan,
      });
      return { ok: false, reason: 'invalid' };
    }
    identityMap.set(`${sub.id}:${sub.plan}`, { id: sub.id, plan: sub.plan });
  }

  // Rule 5: exactly one unique identity → subscription match
  if (identityMap.size === 1) {
    const [, sub] = [...identityMap.entries()][0];
    return { ok: true, sub: { subscriptionId: String(sub.id), planId: sub.plan } };
  }

  // Rule 6: multiple different identities → fail closed
  logger.error('[FLW-SUB] Conflicting subscription identities in exhaustive correlation', {
    txId: transactionId, identityCount: identityMap.size,
    identities: [...identityMap.keys()],
  });
  return { ok: false, reason: 'ambiguous' };
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
