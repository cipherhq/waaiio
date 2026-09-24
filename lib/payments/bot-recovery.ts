/**
 * Bot "I've Paid" recovery adapter.
 *
 * Provides a rich lifecycle result for bot flows while routing
 * through the canonical Payment Authority via reconcilePayment.
 *
 * This replaces direct verifyPayment calls in bot "I've Paid" paths.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ValidationResult } from '@/lib/bot/flows/types';
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

// ── R1-B1: Centralized flow-level saved-card recovery ──

/**
 * Rich result type for flow-level saved-card recovery.
 * Preserves all distinctions so flows can provide accurate UX.
 */
export type FlowRecoveryResult =
  | { type: 'completed'; paymentId: string }
  | { type: 'already_completed'; paymentId: string }
  | { type: 'requires_auth'; paymentId: string; authUrl: string }
  | { type: 'terminal_decline'; paymentId: string; message: string }
  | { type: 'authority_rejected'; paymentId: string; message: string }
  | { type: 'provider_confirmed'; paymentId: string }
  | { type: 'indeterminate'; paymentId: string }
  | { type: 'quarantined'; paymentId: string }
  | { type: 'not_applicable' }  // Not a saved-card dispatched payment — fall back to ordinary
  | { type: 'error'; message: string };

/**
 * Centralized saved-card recovery for ALL bot flows.
 * Routes through the canonical saved-card recovery helper (payment-ID authority).
 */
export async function recoverSavedCardPaymentForFlow(
  supabase: SupabaseClient,
  savedCardPaymentId: string,
): Promise<FlowRecoveryResult> {
  const { recoverDispatchedSavedCardPayment } = await import('./saved-card-recovery');
  const scResult = await recoverDispatchedSavedCardPayment(supabase, savedCardPaymentId);

  switch (scResult.outcome) {
    case 'succeeded':
      return { type: 'completed', paymentId: savedCardPaymentId };
    case 'already_resolved':
      return { type: 'already_completed', paymentId: savedCardPaymentId };
    case 'requires_action':
      if (scResult.authUrl) {
        return { type: 'requires_auth', paymentId: savedCardPaymentId, authUrl: scResult.authUrl };
      }
      return { type: 'indeterminate', paymentId: savedCardPaymentId };
    case 'declined':
      return { type: 'terminal_decline', paymentId: savedCardPaymentId, message: scResult.message || 'Payment declined' };
    case 'authority_rejected':
      return { type: 'authority_rejected', paymentId: savedCardPaymentId, message: scResult.message || 'Payment received but could not be finalized' };
    case 'provider_confirmed':
      return { type: 'provider_confirmed', paymentId: savedCardPaymentId };
    case 'quarantined':
      return { type: 'quarantined', paymentId: savedCardPaymentId };
    case 'indeterminate':
      return { type: 'indeterminate', paymentId: savedCardPaymentId };
    case 'error':
      // "Not a saved-card dispatched payment" → not_applicable so flows fall through
      if (scResult.message === 'Not a saved-card dispatched payment') {
        return { type: 'not_applicable' };
      }
      return { type: 'error', message: scResult.message || 'Unknown error' };
  }
}

/**
 * Map a FlowRecoveryResult to a ValidationResult for flow retry/i_paid handlers.
 * Returns null when the flow should fall through to ordinary recovery (not_applicable).
 */
export function mapSavedCardRecoveryToValidation(
  result: FlowRecoveryResult,
  sessionData: Record<string, unknown>,
): ValidationResult | null {
  switch (result.type) {
    case 'completed':
    case 'already_completed':
      return { valid: true, data: { _action: 'payment_confirmed' } };

    case 'requires_auth':
      // Payment requires 3DS — block retry, keep session active
      sessionData._payment_retry_blocked = true;
      return {
        valid: false,
        persistSessionDataOnFailure: true,
        errorMessage: `🔒 Your bank requires verification.\n\nPlease complete here 👇\n${result.authUrl}\n\nThen return and tap *I've Paid* again.`,
      };

    case 'terminal_decline':
      // Card was declined — allow retry with new payment method
      return {
        valid: true,
        data: {
          _retry_payment: true,
          _payment_retry_blocked: false,
          _saved_card_indeterminate: false,
          _saved_card_requires_auth: false,
          _saved_card_payment_id: null,
          _skip_saved_card: true,
        },
      };

    case 'indeterminate':
      // Uncertain state — block fresh checkout, let customer retry verification.
      sessionData._payment_retry_blocked = true;
      return {
        valid: false,
        persistSessionDataOnFailure: true,
        errorMessage: "We're still verifying your previous payment. Tap *I've Paid* to check again.",
      };

    case 'provider_confirmed':
      sessionData._payment_retry_blocked = true;
      return {
        valid: false,
        persistSessionDataOnFailure: true,
        errorMessage: "Your payment is confirmed by the provider and is still being finalized. Tap *I've Paid* again shortly.",
      };

    case 'authority_rejected':
      // R3-B1: Provider may have charged customer but Waaiio authority rejected finalization.
      // Do NOT enable retry. Do NOT clear payment ID. Do NOT suggest paying again.
      sessionData._payment_retry_blocked = true;
      return {
        valid: false,
        persistSessionDataOnFailure: true,
        errorMessage: 'Your payment was received but we could not safely finalize it. Please do NOT pay again — we are resolving this. Tap *I\'ve Paid* to check status.',
      };

    case 'quarantined':
      return {
        valid: false,
        errorMessage: 'This payment attempt has expired and cannot be replayed safely. Type *Hi* to restart payment.',
      };

    case 'not_applicable':
      // Not a saved-card payment — fall through to ordinary recovery
      return null;

    case 'error':
      sessionData._payment_retry_blocked = true;
      return {
        valid: false,
        persistSessionDataOnFailure: true,
        errorMessage: 'Something went wrong. Please try again.',
      };
  }
}

/**
 * #375: Verify and reconcile a saved-card dispatched payment by payment ID.
 * Uses the canonical saved-card recovery helper (payment-ID authority)
 * instead of gateway_reference lookup.
 *
 * @deprecated Use recoverSavedCardPaymentForFlow + mapSavedCardRecoveryToValidation instead
 */
export async function verifyAndReconcileSavedCardPayment(
  supabase: SupabaseClient,
  paymentId: string,
): Promise<RecoveryResult> {
  const { recoverDispatchedSavedCardPayment } = await import('./saved-card-recovery');
  const scResult = await recoverDispatchedSavedCardPayment(supabase, paymentId);

  switch (scResult.outcome) {
    case 'succeeded':
    case 'already_resolved':
      return { outcome: 'completed', paymentId };
    case 'requires_action':
      return { outcome: 'processing', paymentId };
    case 'provider_confirmed':
      return { outcome: 'processing', paymentId };
    case 'declined':
    case 'quarantined':
      return { outcome: 'not_verified', paymentId };
    case 'authority_rejected':
      return { outcome: 'processing', paymentId }; // Keep fenced — do not allow retry
    case 'indeterminate':
      return { outcome: 'provider_error', paymentId };
    case 'error':
      // Not a saved-card dispatched payment — fall back to ordinary path
      return { outcome: 'not_verified', paymentId };
  }
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
