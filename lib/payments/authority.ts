/**
 * Waaiio Payment Authority — Phase 1 Core Lifecycle
 *
 * GATEWAYS AUTHENTICATE MONEY. WAAIIO AUTHORIZES BUSINESS STATE.
 *
 * Three-stage state machine:
 *   Stage 1 — Provider-paid:        payment.status = 'success'
 *   Stage 2 — Business-finalized:   payment.finalization_completed_at IS NOT NULL
 *   Stage 3 — Customer-confirmed:   ConfirmationResult.status = 'completed'
 *
 * The authority resumes from the first incomplete stage.
 * Every entry point must call the SAME engine.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import * as Sentry from '@sentry/nextjs';
import { logger } from '@/lib/logger';
import { safeLogErrorContext } from '@/lib/errors';
import type { ConfirmationResult } from './send-confirmation';

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

export type PaymentProviderName = 'paystack' | 'stripe' | 'flutterwave' | 'square' | 'paypal';
const SUPPORTED_PROVIDERS = new Set<string>(['paystack', 'stripe', 'flutterwave', 'square', 'paypal']);

/** Provider-agnostic verification result. Amount/currency from PROVIDER truth. */
export interface VerifiedPaymentResult {
  provider: PaymentProviderName;
  waaiioReference: string;
  providerTransactionId?: string;
  amount: number;
  currency: string;
  paymentMethod?: string;
  cardLast4?: string;
  cardBrand?: string;
  gatewayFee?: number;
  verifiedAt: string;
  providerStatus?: string;
}

/** Result from processSuccessfulPayment indicating critical effect outcome. */
export interface FinalizationResult {
  criticalSuccess: boolean;
  errors?: string[];
}

/** Lifecycle result exposing stage completion state. */
export interface PaymentLifecycleResult {
  status: 'completed' | 'already_completed' | 'processing' | 'retryable_failed' | 'rejected' | 'not_deliverable';
  retryable: boolean;
  reason?: string;
  stages: {
    providerPaid: boolean;
    businessFinalized: boolean;
    customerConfirmed: boolean;
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Input validation
// ────────────────────────────────────────────────────────────────────────────

function validateInput(v: VerifiedPaymentResult): PaymentLifecycleResult | null {
  if (!v.waaiioReference?.trim()) return reject('Missing waaiioReference', 'invalid_input');
  if (!v.provider || !SUPPORTED_PROVIDERS.has(v.provider)) return reject(`Unsupported provider: '${v.provider}'`, 'invalid_input');
  if (typeof v.amount !== 'number' || !Number.isFinite(v.amount)) return reject(`Non-finite amount: ${v.amount}`, 'invalid_input');
  if (!v.currency?.trim()) return reject('Missing currency', 'invalid_input');
  return null;
}

function reject(reason: string, code?: string): PaymentLifecycleResult {
  return {
    status: 'rejected', retryable: false, reason: code ? `${code}: ${reason}` : reason,
    stages: { providerPaid: false, businessFinalized: false, customerConfirmed: false },
  };
}

function retryable(reason: string, stages: PaymentLifecycleResult['stages']): PaymentLifecycleResult {
  return { status: 'retryable_failed', retryable: true, reason, stages };
}

function processing(reason: string, stages: PaymentLifecycleResult['stages']): PaymentLifecycleResult {
  return { status: 'processing', retryable: true, reason, stages };
}

// ────────────────────────────────────────────────────────────────────────────
// Core Authority: authorizeAndFinalize
// ────────────────────────────────────────────────────────────────────────────

/**
 * The single canonical payment completion engine.
 *
 * @param supabase - Service-role client
 * @param verified - Provider-verified payment result (read-only from provider)
 * @param processPayment - The canonical business-effect function (processSuccessfulPayment wrapper)
 * @param sendConfirmation - The canonical customer confirmation function
 */
export async function authorizeAndFinalize(
  supabase: SupabaseClient,
  verified: VerifiedPaymentResult,
  processPayment: (supabase: SupabaseClient, payment: {
    id: string; amount: number;
    booking_id: string | null; invoice_id: string | null; campaign_id: string | null;
    reservation_id: string | null; order_id: string | null;
    metadata: Record<string, unknown> | null; gateway_fee: number;
  }) => Promise<FinalizationResult>,
  sendConfirmation: (supabase: SupabaseClient, payment: {
    id: string; amount: number;
    booking_id: string | null; invoice_id: string | null; campaign_id: string | null;
    reservation_id?: string | null; order_id?: string | null;
  }) => Promise<ConfirmationResult>,
): Promise<PaymentLifecycleResult> {
  const logPrefix = `[PAY-AUTHORITY ${verified.provider}]`;

  // ── Input validation ──
  const inputError = validateInput(verified);
  if (inputError) return inputError;

  // ── Stage 1: Load and authorize payment ──
  const { data: payment, error: paymentError } = await supabase
    .from('payments')
    .select('id, amount, currency, gateway, status, booking_id, invoice_id, campaign_id, reservation_id, order_id, metadata, gateway_fee, finalization_completed_at, payment_authority_version')
    .eq('gateway_reference', verified.waaiioReference)
    .maybeSingle();

  if (paymentError) {
    logger.withContext({ op: 'authority.payment-lookup', ...safeLogErrorContext(paymentError) })
      .error(`${logPrefix} Payment lookup failed`);
    return retryable('payment_lookup_error', { providerPaid: false, businessFinalized: false, customerConfirmed: false });
  }
  if (!payment) {
    return reject('Payment not found for reference: ' + verified.waaiioReference, 'payment_not_found');
  }

  // Legacy fence: reject pre-authority ALREADY-SUCCESSFUL payments (unknown finalization state)
  if (payment.payment_authority_version == null && payment.status === 'success') {
    logger.info(`${logPrefix} Legacy pre-authority payment ${payment.id} — skipping`);
    return reject('Legacy pre-authority payment — finalization state unknown', 'legacy_finalization_unverified');
  }

  // Cutover adoption: pre-authority pending payment being paid now → adopt as version 0
  if (payment.payment_authority_version == null && payment.status !== 'success') {
    const { error: adoptErr } = await supabase.from('payments')
      .update({ payment_authority_version: 0 })
      .eq('id', payment.id)
      .is('payment_authority_version', null);
    if (adoptErr) {
      logger.withContext({ op: 'authority.cutover-adopt', ...safeLogErrorContext(adoptErr) })
        .error(`${logPrefix} Version-0 adoption failed — cannot proceed without durable version`);
      return retryable('cutover_adoption_failed', { providerPaid: false, businessFinalized: false, customerConfirmed: false });
    }
    payment.payment_authority_version = 0;
  }

  // Provider truth validation
  if (payment.gateway !== verified.provider) {
    return reject(`Provider mismatch: expected ${payment.gateway}, got ${verified.provider}`, 'provider_mismatch');
  }
  if (payment.amount !== verified.amount) {
    return reject(`Amount mismatch: expected ${payment.amount}, got ${verified.amount}`, 'amount_mismatch');
  }
  if (payment.currency !== verified.currency) {
    return reject(`Currency mismatch: expected ${payment.currency}, got ${verified.currency}`, 'currency_mismatch');
  }

  // Mark provider-paid if not already
  if (payment.status !== 'success') {
    const { error: updateError } = await supabase
      .from('payments')
      .update({ status: 'success', paid_at: new Date().toISOString(), gateway_status: verified.providerStatus || 'success' })
      .eq('id', payment.id)
      .neq('status', 'success');
    if (updateError) {
      logger.withContext({ op: 'authority.mark-paid', ...safeLogErrorContext(updateError) })
        .error(`${logPrefix} Failed to mark payment as provider-paid`);
      return retryable('mark_paid_error', { providerPaid: false, businessFinalized: false, customerConfirmed: false });
    }
  }
  const stagesPaid = { providerPaid: true, businessFinalized: false, customerConfirmed: false };

  // ── Stage 2: Business finalization ──
  // Check if already finalized
  if (payment.finalization_completed_at) {
    // Skip to Stage 3
    const confirmResult = await sendConfirmation(supabase, {
      id: payment.id, amount: payment.amount,
      booking_id: payment.booking_id, invoice_id: payment.invoice_id,
      campaign_id: payment.campaign_id, reservation_id: payment.reservation_id,
      order_id: payment.order_id,
    });
    return mapConfirmationResult(supabase, payment.id, confirmResult, { ...stagesPaid, businessFinalized: true });
  }

  // Claim finalization
  const { data: claim, error: claimError } = await supabase.rpc('claim_payment_finalization', {
    p_payment_id: payment.id,
  });

  if (claimError) {
    logger.withContext({ op: 'authority.finalization-claim', ...safeLogErrorContext(claimError) })
      .error(`${logPrefix} Finalization claim RPC error`);
    return retryable('finalization_claim_error', stagesPaid);
  }
  if (!claim?.claimed) {
    if (claim?.already_completed) {
      // Another worker completed finalization — skip to Stage 3
      const confirmResult = await sendConfirmation(supabase, {
        id: payment.id, amount: payment.amount,
        booking_id: payment.booking_id, invoice_id: payment.invoice_id,
        campaign_id: payment.campaign_id, reservation_id: payment.reservation_id,
        order_id: payment.order_id,
      });
      return mapConfirmationResult(supabase, payment.id, confirmResult, { ...stagesPaid, businessFinalized: true });
    }
    return processing(claim?.reason || 'finalization_claim_not_granted', stagesPaid);
  }

  const claimToken = claim.claim_token as string;

  // Execute critical business effects
  let finalizationResult: FinalizationResult;
  try {
    finalizationResult = await processPayment(supabase, {
      id: payment.id,
      amount: payment.amount,
      booking_id: claim.booking_id || null,
      invoice_id: claim.invoice_id || null,
      campaign_id: claim.campaign_id || null,
      reservation_id: claim.reservation_id || null,
      order_id: claim.order_id || null,
      metadata: (payment.metadata || null) as Record<string, unknown> | null,
      gateway_fee: claim.gateway_fee || 0,
    });
  } catch (err) {
    logger.withContext({ op: 'authority.process-payment', ...safeLogErrorContext(err) })
      .error(`${logPrefix} processSuccessfulPayment threw`);
    Sentry.captureException(err, { tags: { component: 'payment-authority', operation: 'process-payment' } });
    // Release claim for retry
    try { await supabase.rpc('release_payment_finalization', { p_payment_id: payment.id, p_claim_token: claimToken }); } catch { /* release is best-effort */ }
    return retryable('process_payment_threw', stagesPaid);
  }

  if (!finalizationResult.criticalSuccess) {
    logger.error(`${logPrefix} Critical business effects failed: ${finalizationResult.errors?.join(', ')}`);
    // Release claim for retry — critical effects are idempotent
    try { await supabase.rpc('release_payment_finalization', { p_payment_id: payment.id, p_claim_token: claimToken }); } catch { /* release is best-effort */ }
    return retryable('critical_effects_failed', stagesPaid);
  }

  // Mark Stage 2 complete — MUST succeed before proceeding
  const { data: completeResult, error: completeError } = await supabase.rpc('complete_payment_finalization', {
    p_payment_id: payment.id, p_claim_token: claimToken,
  });

  if (completeError) {
    logger.withContext({ op: 'authority.complete-finalization', ...safeLogErrorContext(completeError) })
      .error(`${logPrefix} complete_payment_finalization RPC error`);
    return retryable('finalization_complete_rpc_error', stagesPaid);
  }
  if (!completeResult?.completed && !completeResult?.already_completed) {
    logger.warn(`${logPrefix} Finalization complete returned false: ${completeResult?.reason}`);
    return processing(completeResult?.reason || 'finalization_not_completed', stagesPaid);
  }

  const stagesFinalized = { ...stagesPaid, businessFinalized: true };

  // ── Stage 3: Customer confirmation ──
  const confirmResult = await sendConfirmation(supabase, {
    id: payment.id, amount: payment.amount,
    booking_id: payment.booking_id, invoice_id: payment.invoice_id,
    campaign_id: payment.campaign_id, reservation_id: payment.reservation_id,
    order_id: payment.order_id,
  });

  return mapConfirmationResult(supabase, payment.id, confirmResult, stagesFinalized);
}

async function mapConfirmationResult(
  supabase: SupabaseClient,
  paymentId: string,
  result: ConfirmationResult,
  stages: PaymentLifecycleResult['stages'],
): Promise<PaymentLifecycleResult> {
  // Persist terminal confirmation state for ALL paths into Stage 3
  if (result.status === 'not_deliverable') {
    const { error: termErr } = await supabase.from('payments')
      .update({ confirmation_terminal_reason: 'not_deliverable' })
      .eq('id', paymentId);
    if (termErr) {
      logger.withContext({ op: 'authority.terminal-persist', ...safeLogErrorContext(termErr) })
        .error('[PAY-AUTHORITY] Failed to persist confirmation_terminal_reason');
      return retryable('confirmation_terminal_persist_failed', stages);
    }
  }
  switch (result.status) {
    case 'completed':
      return { status: 'completed', retryable: false, stages: { ...stages, customerConfirmed: true } };
    case 'already_completed':
      return { status: 'already_completed', retryable: false, stages: { ...stages, customerConfirmed: true } };
    case 'processing':
      return processing('confirmation_processing', stages);
    case 'retryable_failed':
      return retryable(`confirmation_failed: ${result.reason}`, stages);
    case 'not_deliverable':
      // Customer has no contact info — Stage 3 cannot complete but business state IS safe.
      // Not retryable (no contact info to retry with). Not completed (customer not confirmed).
      return { status: 'not_deliverable', retryable: false, reason: result.reason, stages: { ...stages, customerConfirmed: false } };
    default:
      return retryable('confirmation_unknown_status', stages);
  }
}
