/**
 * Payment Success Helpers — production orchestration used by payment-success page.
 *
 * These helpers own the boundary between the payment-success page and the
 * canonical Payment Authority (reconcilePayment). Tests import these same
 * helpers to prove the production orchestration behavior.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ReconciliationResult } from './reconcile';

export interface ReconcileConfirmationResult {
  confirmed: boolean;
}

/**
 * Reconcile a resolved payment through the canonical Payment Authority and
 * map the lifecycle result to a confirmed/not-confirmed state.
 *
 * This is the single production boundary between the payment-success page
 * and reconcilePayment. It:
 * - calls reconcilePayment exactly once with 'payment_success' source
 * - maps completed/already_completed/not_deliverable → confirmed
 * - never treats payment.status='success' as sufficient authority
 * - all other lifecycle statuses → not confirmed
 */
export async function reconcileAndConfirm(
  supabase: SupabaseClient,
  paymentId: string,
  reconcilePayment: (supabase: SupabaseClient, paymentId: string, source: string) => Promise<ReconciliationResult>,
): Promise<ReconcileConfirmationResult> {
  const result = await reconcilePayment(supabase, paymentId, 'payment_success');

  let confirmed = false;
  if (result.lifecycle?.status === 'completed' || result.lifecycle?.status === 'already_completed') {
    confirmed = true;
  } else if (result.lifecycle?.status === 'not_deliverable') {
    // Business state is finalized but no delivery channel
    confirmed = true;
  }
  // Do NOT fall back to payment.status='success' as "confirmed"
  // Stage 1 (provider-paid) is not Stage 2/3 (business-finalized + customer-confirmed)

  return { confirmed };
}

/**
 * Determine the confirmation message for the payment-success page.
 * Entity-neutral: does not mention "booking" for non-booking payments.
 */
export function getConfirmationMessage(confirmed: boolean, isWebChannel: boolean): string {
  if (!confirmed) {
    return isWebChannel
      ? 'Thank you! Your confirmation will arrive in your email shortly.'
      : 'Thank you! Your confirmation will arrive on WhatsApp shortly.';
  } else if (isWebChannel) {
    return 'Your payment is confirmed. Confirmation sent to your email.';
  } else {
    return 'Your payment is confirmed. Check WhatsApp for your confirmation details.';
  }
}
