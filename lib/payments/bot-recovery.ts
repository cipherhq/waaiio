/**
 * Bot "I've Paid" recovery adapter.
 *
 * Provides a boolean-compatible interface for bot flows while routing
 * through the canonical Payment Authority via reconcilePayment.
 *
 * This replaces direct verifyPayment calls in bot "I've Paid" paths.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '@/lib/logger';
import { reconcilePayment } from './reconcile';

/**
 * Verify and reconcile a payment through the canonical authority.
 * Returns true if the payment is now confirmed (completed/already_completed).
 *
 * The bot flow can use this as a drop-in replacement for verifyPayment
 * while ensuring all business mutation goes through the authority.
 */
export async function verifyAndReconcilePayment(
  supabase: SupabaseClient,
  paymentReference: string,
): Promise<boolean> {
  // Find the payment by gateway reference
  const { data: payment, error } = await supabase
    .from('payments')
    .select('id')
    .eq('gateway_reference', paymentReference)
    .maybeSingle();

  if (error || !payment) {
    logger.warn('[BOT-RECOVERY] Payment not found for reference:', paymentReference);
    return false;
  }

  // Reconcile through canonical authority
  const result = await reconcilePayment(supabase, payment.id, 'ive_paid');

  // Return true only if payment is now confirmed
  if (result.lifecycle) {
    return result.lifecycle.status === 'completed'
      || result.lifecycle.status === 'already_completed'
      || result.lifecycle.status === 'not_deliverable';
  }

  // Provider not verified or other non-success outcome
  return false;
}
