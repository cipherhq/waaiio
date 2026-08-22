/**
 * Bot "I've Paid" recovery adapter.
 *
 * Provides a rich lifecycle result for bot flows while routing
 * through the canonical Payment Authority via reconcilePayment.
 *
 * This replaces direct verifyPayment calls in bot "I've Paid" paths.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '@/lib/logger';
import { reconcilePayment } from './reconcile';

export type RecoveryOutcome =
  | 'completed'       // Full lifecycle done (Stage 2+3)
  | 'processing'      // Provider verified, lifecycle in progress
  | 'retryable'       // Provider verified, lifecycle retryable
  | 'not_paid'        // Provider definitively confirms unpaid — safe to retry/new-link
  | 'provider_error'  // Indeterminate verification (timeout/network) — do NOT encourage new checkout
  | 'not_verified'    // Config/lookup/rejected/payment-not-found — neutral, do NOT imply unpaid
  | 'not_deliverable'; // Payment processed but customer not reachable

export interface RecoveryResult {
  outcome: RecoveryOutcome;
  paymentId?: string;
}

/**
 * Verify and reconcile a payment through the canonical authority.
 * Returns a rich result distinguishing completed, processing, retryable,
 * and not-verified outcomes so bot flows can provide accurate UX.
 */
export async function verifyAndReconcilePayment(
  supabase: SupabaseClient,
  paymentReference: string,
): Promise<RecoveryResult> {
  // Find the payment by gateway reference
  const { data: payment, error } = await supabase
    .from('payments')
    .select('id')
    .eq('gateway_reference', paymentReference)
    .maybeSingle();

  if (error || !payment) {
    logger.warn('[BOT-RECOVERY] Payment not found for reference:', paymentReference);
    return { outcome: 'not_verified' };
  }

  // Reconcile through canonical authority
  const result = await reconcilePayment(supabase, payment.id, 'ive_paid');

  if (!result.lifecycle) {
    // Preserve provider-verification fidelity so callers can distinguish
    // definitively-unpaid (safe to retry) from indeterminate (unsafe).
    switch (result.providerOutcome) {
      case 'not_paid':
        return { outcome: 'not_paid', paymentId: payment.id };
      case 'retryable_error':
        return { outcome: 'provider_error', paymentId: payment.id };
      case 'config_error':
      default:
        return { outcome: 'not_verified', paymentId: payment.id };
    }
  }

  switch (result.lifecycle.status) {
    case 'completed':
    case 'already_completed':
      return { outcome: 'completed', paymentId: payment.id };
    case 'not_deliverable':
      return { outcome: 'not_deliverable', paymentId: payment.id };
    case 'processing':
      return { outcome: 'processing', paymentId: payment.id };
    case 'retryable_failed':
      return { outcome: 'retryable', paymentId: payment.id };
    case 'rejected':
    default:
      return { outcome: 'not_verified', paymentId: payment.id };
  }
}
