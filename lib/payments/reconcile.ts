/**
 * Shared payment reconciliation orchestrator.
 *
 * ALL payment completion entrypoints converge here:
 *   provider verification → Payment Authority → lifecycle result
 *
 * This layer is provider-neutral. Provider-specific authentication
 * (webhook signatures, event parsing) happens in the caller.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '@/lib/logger';
import { safeLogErrorContext } from '@/lib/errors';
import { verifyWithProvider, type ProviderVerificationOutcome } from './provider-adapters';
import { authorizeAndFinalize, type PaymentLifecycleResult, type FinalizationResult } from './authority';
import { processSuccessfulPayment } from './process-success';
import { sendProactiveConfirmation, type ConfirmationResult } from './send-confirmation';

export type ReconciliationSource = 'webhook' | 'payment_success' | 'ive_paid' | 'saved_card' | 'cron';

export interface ReconciliationResult {
  /** Provider verification outcome */
  providerOutcome: 'verified' | 'not_paid' | 'retryable_error' | 'config_error' | 'skipped';
  /** Payment Authority lifecycle result (null if provider not verified) */
  lifecycle: PaymentLifecycleResult | null;
  /** Whether the caller should acknowledge success to the provider */
  acknowledgeSuccess: boolean;
  /** Provider-specific reason string when not verified (e.g., 'paystack_status: abandoned') */
  providerReason?: string;
}

/**
 * Reconcile a payment through provider verification and the canonical Payment Authority.
 *
 * @param supabase Service-role client
 * @param paymentId The Waaiio payment ID
 * @param source Which entrypoint triggered this reconciliation
 * @param providerOverride Optional pre-verified provider result (for webhook paths that already have provider data)
 */
export async function reconcilePayment(
  supabase: SupabaseClient,
  paymentId: string,
  source: ReconciliationSource,
  providerOverride?: ProviderVerificationOutcome,
): Promise<ReconciliationResult> {
  const logPrefix = `[RECONCILE ${source}]`;

  // 1. Load the canonical payment
  const { data: payment, error: paymentError } = await supabase
    .from('payments')
    .select('id, amount, currency, gateway, gateway_reference, status, business_id, booking_id, invoice_id, campaign_id, reservation_id, order_id, metadata, gateway_fee, payment_authority_version, finalization_completed_at')
    .eq('id', paymentId)
    .single();

  if (paymentError || !payment) {
    logger.withContext({ op: 'reconcile.payment-load', ...safeLogErrorContext(paymentError) })
      .error(`${logPrefix} Payment load failed for ${paymentId}`);
    return { providerOutcome: 'config_error', lifecycle: null, acknowledgeSuccess: false };
  }

  // 2. Provider verification (or use override from webhook)
  let providerResult: ProviderVerificationOutcome;
  if (providerOverride) {
    providerResult = providerOverride;
  } else {
    const meta = (payment.metadata || {}) as Record<string, unknown>;
    providerResult = await verifyWithProvider(supabase, {
      provider: payment.gateway,
      gatewayReference: payment.gateway_reference,
      expectedAmount: payment.amount,
      expectedCurrency: payment.currency,
      paymentMetadata: meta,
      businessId: payment.business_id,
      isNewAuthority: payment.payment_authority_version === 1,
    });
  }

  // 3. Map provider outcome
  if (providerResult.status !== 'verified') {
    const providerReason = 'reason' in providerResult ? providerResult.reason : undefined;
    logger.info(`${logPrefix} Provider outcome: ${providerResult.status} — ${providerReason || ''}`);
    return {
      providerOutcome: providerResult.status,
      lifecycle: null,
      acknowledgeSuccess: providerResult.status !== 'retryable_error',
      providerReason,
    };
  }

  // 4. Provider verified → canonical Payment Authority
  const verified = providerResult.result;

  const processPayment = async (
    sb: SupabaseClient,
    pay: { id: string; amount: number; booking_id: string | null; invoice_id: string | null; campaign_id: string | null; reservation_id: string | null; order_id: string | null; metadata: Record<string, unknown> | null; gateway_fee: number },
  ): Promise<FinalizationResult> => {
    return processSuccessfulPayment(sb, pay);
  };

  const sendConfirm = async (
    sb: SupabaseClient,
    pay: { id: string; amount: number; booking_id: string | null; invoice_id: string | null; campaign_id: string | null; reservation_id?: string | null; order_id?: string | null },
  ): Promise<ConfirmationResult> => {
    return sendProactiveConfirmation(sb, pay, logPrefix);
  };

  const lifecycle = await authorizeAndFinalize(supabase, verified, processPayment, sendConfirm);

  return {
    providerOutcome: 'verified',
    lifecycle,
    acknowledgeSuccess: true, // Provider verified — always ack to prevent retry
  };
}
