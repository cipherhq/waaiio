/**
 * Canonical Stripe subscription renewal finalization helper.
 *
 * Shared between the Stripe webhook (real-time) and the renewal recovery
 * cron (reconciliation). Handles: evidence insert + duplicate recovery +
 * atomic activation via RPC.
 *
 * Callers are responsible for:
 * - Period extraction and validation
 * - Config version resolution
 * - Amount/currency validation
 * - Any webhook-specific error responses
 */

import { logger } from '@/lib/logger';

export interface StripeRenewalParams {
  subscriptionId: string;
  businessId: string;
  plan: string;
  providerInvoiceId: string;
  providerReference: string;
  amountMinor: number;
  currency: string;
  periodStart: string;
  periodEnd: string;
  providerPaidAt: string;
  configVersionId: string;
}

export async function finalizeStripeRenewal(
  service: { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>; from: (table: string) => any },
  params: StripeRenewalParams,
): Promise<{ finalized: boolean; paymentId?: string; reason?: string }> {
  // 1. Insert subscription_payments evidence
  const { data: evidence, error: evidenceErr } = await service.from('subscription_payments').insert({
    business_id: params.businessId,
    subscription_id: params.subscriptionId,
    amount: params.amountMinor,
    currency: params.currency.toUpperCase(),
    gateway: 'stripe',
    gateway_reference: params.providerReference,
    provider_reference: params.providerReference,
    plan: params.plan,
    action: 'renewal',
    status: 'success',
    config_version_id: params.configVersionId,
    billing_interval: 'month',
    period_start: params.periodStart,
    period_end: params.periodEnd,
  }).select('id').single();

  let paymentId: string | null = null;

  if (evidenceErr) {
    // Duplicate recovery
    const errObj = evidenceErr as { code?: string; message?: string };
    const isDuplicate = errObj.code === '23505' || errObj.message?.includes('duplicate') || errObj.message?.includes('unique');
    if (isDuplicate) {
      const { data: existing } = await service.from('subscription_payments')
        .select('id')
        .eq('subscription_id', params.subscriptionId)
        .eq('provider_reference', params.providerReference)
        .eq('gateway', 'stripe')
        .eq('status', 'success')
        .single();
      if (existing) {
        paymentId = existing.id;
      } else {
        logger.error('[STRIPE-RENEWAL] Duplicate evidence but exact lookup failed', { err: errObj });
        return { finalized: false, reason: 'duplicate_evidence_lookup_failed' };
      }
    } else {
      logger.error('[STRIPE-RENEWAL] Evidence insert failed', { err: errObj });
      return { finalized: false, reason: `evidence_insert_failed: ${errObj.message}` };
    }
  } else {
    paymentId = evidence?.id;
  }

  if (!paymentId) {
    logger.error('[STRIPE-RENEWAL] No payment ID after evidence insert');
    return { finalized: false, reason: 'no_payment_id' };
  }

  // 2. Activate via canonical RPC
  const { data: activation, error: activateErr } = await service.rpc('activate_paid_subscription', { p_payment_id: paymentId });
  if (activateErr) {
    const errObj = activateErr as { message?: string };
    logger.error('[STRIPE-RENEWAL] Activation RPC failed', { err: errObj });
    return { finalized: false, reason: `activation_failed: ${errObj.message}` };
  }

  const result = activation as Record<string, unknown> | null;
  if (!result || result.activated !== true) {
    logger.error('[STRIPE-RENEWAL] Activation rejected', { result });
    return { finalized: false, reason: `activation_rejected: ${(result as Record<string, unknown>)?.reason || 'unknown'}` };
  }

  return { finalized: true, paymentId };
}
