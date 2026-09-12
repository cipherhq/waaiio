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
 * Verify a Flutterwave subscription's current status by its ID.
 * Used for cancellation verification — confirms the provider subscription is actually cancelled.
 */
export async function verifySubscriptionStatus(
  subscriptionId: string,
  flutterwaveKey: string,
): Promise<{ ok: true; status: string } | { ok: false; reason: string }> {
  try {
    const response = await fetch(
      `https://api.flutterwave.com/v3/subscriptions/${encodeURIComponent(subscriptionId)}`,
      {
        headers: { 'Authorization': `Bearer ${flutterwaveKey}` },
        signal: AbortSignal.timeout(10000),
      },
    );

    if (!response.ok) {
      return { ok: false, reason: 'unavailable' };
    }

    const data = await response.json() as { status?: string; data?: { id: number; status: string } };
    if (data.status !== 'success' || !data.data) {
      return { ok: false, reason: 'unavailable' };
    }

    return { ok: true, status: data.data.status };
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}
