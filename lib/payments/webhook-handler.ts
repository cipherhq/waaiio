import type { SupabaseClient } from '@supabase/supabase-js';
import * as Sentry from '@sentry/nextjs';
import { getServerPostHog } from '@/lib/posthog/server';
import { createAlert } from '@/lib/alerts/create-alert';
import { logger } from '@/lib/logger';
import { reconcilePayment } from './reconcile';
import { normalizePaystackCardAuthorization, persistPaystackCardAuthorization } from './paystack-card-authorization';

/**
 * Shared webhook processing logic for both platform and BYO payment webhooks.
 * Handles charge.success and charge.failed events for deposit bookings.
 */

/** P1-A: optional scope binds finalization to a verified payment + business. */
export interface PaymentScope {
  paymentId: string;
  businessId: string;
}

/** P1-C: outcome tells the caller what happened. */
export type SuccessOutcome = 'finalized' | 'already_finalized' | 'amount_mismatch' | 'incomplete';

/** P1-A: typed error for scoped update failures. */
export class ScopedUpdateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScopedUpdateError';
  }
}

export async function processPaystackChargeSuccess(
  data: Record<string, unknown>,
  reference: string,
  supabase: SupabaseClient,
  scope?: PaymentScope,
): Promise<SuccessOutcome> {
  let existingPayment: Record<string, unknown> | null;
  if (scope) {
    const { data: p, error } = await supabase
      .from('payments')
      .select('id, status, amount, booking_id, invoice_id, campaign_id, reservation_id, order_id, metadata, gateway, payment_authority_version, finalization_completed_at')
      .eq('id', scope.paymentId)
      .eq('business_id', scope.businessId)
      .single();
    if (error || !p) throw new ScopedUpdateError(`Payment not found for scope id=${scope.paymentId} business=${scope.businessId}`);
    existingPayment = p;
  } else {
    const { data: p } = await supabase
      .from('payments')
      .select('id, status, amount, booking_id, invoice_id, campaign_id, reservation_id, order_id, metadata, gateway, payment_authority_version, finalization_completed_at')
      .eq('gateway_reference', reference)
      .single();
    if (!p) return 'already_finalized';
    existingPayment = p;
  }

  const authorization = data.authorization as Record<string, unknown> | undefined;
  const customer = data.customer as Record<string, unknown> | undefined;
  const cardAuthorization = normalizePaystackCardAuthorization(authorization, customer);

  if (cardAuthorization) {
    const amount = Number(data.amount) / 100;
    const currency = typeof data.currency === 'string' ? data.currency : '';
    await persistPaystackCardAuthorization(supabase, existingPayment.id as string, amount, currency, cardAuthorization);
  }

  if (existingPayment.status === 'success' && existingPayment.payment_authority_version !== 1) return 'already_finalized';
  if (existingPayment.status === 'success' && existingPayment.finalization_completed_at) return 'already_finalized';

  const paystackFeeKobo = (data.fees as number) || 0;
  const gatewayFee = Math.round(paystackFeeKobo / 100);

  const webhookAmountKobo = data.amount as number;
  const expectedKobo = Math.round((existingPayment.amount as number) * 100);

  if (webhookAmountKobo !== expectedKobo) {
    Sentry.captureMessage('Payment amount mismatch', { level: 'warning', extra: { reference, webhookAmountKobo, expectedKobo } });
    if (scope) {
      // Status guard: never flip a success payment to failed
      const { data: updated, error } = await supabase
        .from('payments')
        .update({ status: 'failed', gateway_status: 'amount_mismatch' })
        .eq('id', scope.paymentId)
        .eq('business_id', scope.businessId)
        .eq('status', 'pending')
        .select('id');
      if (error) throw new ScopedUpdateError('amount_mismatch scoped update error');
      if (!updated?.length) {
        // 0 rows: check if already failed (benign) or success (must not flip)
        const { data: current } = await supabase
          .from('payments')
          .select('status')
          .eq('id', scope.paymentId)
          .eq('business_id', scope.businessId)
          .single();
        if (current?.status === 'failed') return 'amount_mismatch'; // already failed — benign
        throw new ScopedUpdateError('amount_mismatch scoped update: payment not pending');
      }
    } else {
      // Unscoped: also guard with status='pending'
      await supabase
        .from('payments')
        .update({ status: 'failed', gateway_status: 'amount_mismatch' })
        .eq('gateway_reference', reference)
        .eq('status', 'pending');
    }
    return 'amount_mismatch';
  }

  if (scope) {
    const { data: updated, error } = await supabase
      .from('payments')
      .update({
        payment_method: (data.channel as string) || 'card',
        card_last_four: (authorization?.last4 as string) || null,
        card_brand: (authorization?.brand as string) || null,
        gateway_fee: gatewayFee,
      })
      .eq('id', scope.paymentId)
      .eq('business_id', scope.businessId)
      .select('id');
    if (error || !updated?.length) throw new ScopedUpdateError('metadata scoped update failed');
  } else {
    await supabase
      .from('payments')
      .update({
        payment_method: (data.channel as string) || 'card',
        card_last_four: (authorization?.last4 as string) || null,
        card_brand: (authorization?.brand as string) || null,
        gateway_fee: gatewayFee,
      })
      .eq('gateway_reference', reference);
  }

  const posthog = getServerPostHog();
  posthog?.capture({ distinctId: reference, event: 'payment_success', properties: { gateway: 'paystack', amount: existingPayment.amount } });

  import('@/lib/fraud/detect').then(({ checkPaymentFraud }) => {
    const customer = data.customer as Record<string, string> | undefined;
    const ipAddress = data.ip_address as string | undefined;
    const metadata = data.metadata as Record<string, string> | undefined;
    checkPaymentFraud(supabase, {
      paymentId: existingPayment!.id as string,
      businessId: metadata?.business_id || '',
      amount: existingPayment!.amount as number,
      currency: (data.currency as string) || 'NGN',
      customerPhone: customer?.phone || '',
      payerIp: ipAddress,
      payerCountry: (data.authorization as Record<string, string>)?.country_code,
    });
  }).catch(() => {});

  const result = await reconcilePayment(supabase, existingPayment.id as string, 'webhook', {
    status: 'verified',
    result: {
      provider: 'paystack',
      waaiioReference: reference,
      providerTransactionId: String((data.id as number) || ''),
      amount: webhookAmountKobo / 100,
      currency: ((data.currency as string) || 'NGN').toUpperCase(),
      paymentMethod: (data.channel as string) || 'card',
      cardLast4: (authorization?.last4 as string) || undefined,
      cardBrand: (authorization?.brand as string) || undefined,
      cardAuthorization,
      gatewayFee,
      providerStatus: 'success',
      verifiedAt: new Date().toISOString(),
    },
  });

  if (result.lifecycle) {
    logger.info(`[PAYSTACK WEBHOOK] Authority result: ${result.lifecycle.status} | stages: paid=${result.lifecycle.stages.providerPaid} fin=${result.lifecycle.stages.businessFinalized} conf=${result.lifecycle.stages.customerConfirmed}`);
    if (result.lifecycle.stages.businessFinalized) return 'finalized';
  }

  if (result.providerOutcome === 'skipped') return 'already_finalized';

  return 'incomplete';
}

export async function processPaystackChargeFailed(
  data: Record<string, unknown>,
  reference: string,
  supabase: SupabaseClient,
  scope?: PaymentScope,
): Promise<void> {
  let existingPayment: Record<string, unknown> | null;
  if (scope) {
    const { data: p, error } = await supabase
      .from('payments')
      .select('id, status, amount, business_id')
      .eq('id', scope.paymentId)
      .eq('business_id', scope.businessId)
      .single();
    if (error || !p) throw new ScopedUpdateError(`Payment not found for scope id=${scope.paymentId} business=${scope.businessId}`);
    existingPayment = p;
  } else {
    const { data: p } = await supabase
      .from('payments')
      .select('id, status, amount, business_id')
      .eq('gateway_reference', reference)
      .single();
    if (!p) return;
    existingPayment = p;
  }

  const TERMINAL_STATES = new Set(['success', 'failed', 'refunded']);
  if (TERMINAL_STATES.has(existingPayment.status as string)) return;

  if (scope) {
    const { data: updated, error } = await supabase
      .from('payments')
      .update({
        status: 'failed',
        gateway_status: (data.gateway_response as string) || 'failed',
      })
      .eq('id', scope.paymentId)
      .eq('business_id', scope.businessId)
      .eq('status', 'pending')
      .select('id');
    if (error) throw new ScopedUpdateError('chargeFailed scoped update error');
    if (!updated?.length) {
      // Zero rows — re-read to confirm terminal before allowing caller to dedup
      const { data: reread, error: rereadErr } = await supabase
        .from('payments')
        .select('status')
        .eq('id', scope.paymentId)
        .eq('business_id', scope.businessId)
        .single();
      if (rereadErr || !reread) {
        throw new ScopedUpdateError(`chargeFailed zero-row update, re-read failed: ${rereadErr?.message || 'not found'}`);
      }
      if (!TERMINAL_STATES.has(reread.status)) {
        throw new ScopedUpdateError(`chargeFailed zero-row update, payment not terminal: status=${reread.status}`);
      }
      // Payment confirmed terminal — return normally so caller can dedup
      return;
    }
  } else {
    await supabase
      .from('payments')
      .update({
        status: 'failed',
        gateway_status: (data.gateway_response as string) || 'failed',
      })
      .eq('gateway_reference', reference)
      .eq('status', 'pending');
  }

  const posthog = getServerPostHog();
  posthog?.capture({ distinctId: reference, event: 'payment_failed', properties: { gateway: 'paystack', reason: (data.gateway_response as string) || 'unknown' } });

  if (existingPayment.business_id) {
    const reason = (data.gateway_response as string) || 'Payment failed';
    await createAlert(supabase, {
      businessId: existingPayment.business_id as string,
      type: 'payment_failed',
      severity: 'warning',
      title: 'Payment Failed',
      message: `A payment of ${existingPayment.amount} failed: ${reason}`,
      metadata: { paymentId: existingPayment.id, amount: existingPayment.amount, gateway: 'paystack', reference, reason },
    });
  }
}
