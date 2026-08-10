import type { SupabaseClient } from '@supabase/supabase-js';
import * as Sentry from '@sentry/nextjs';
import { getServerPostHog } from '@/lib/posthog/server';
import { createAlert } from '@/lib/alerts/create-alert';
import { logger } from '@/lib/logger';
import { reconcilePayment } from './reconcile';

/**
 * Shared webhook processing logic for both platform and BYO payment webhooks.
 * Handles charge.success and charge.failed events for deposit bookings.
 */

export async function processPaystackChargeSuccess(
  data: Record<string, unknown>,
  reference: string,
  supabase: SupabaseClient,
): Promise<void> {
  const { data: existingPayment } = await supabase
    .from('payments')
    .select('id, status, amount, booking_id, invoice_id, campaign_id, reservation_id, order_id, metadata, gateway, payment_authority_version, finalization_completed_at')
    .eq('gateway_reference', reference)
    .single();

  if (!existingPayment) return;

  // For new-authority payments: always reconcile (Stage 2/3 may be incomplete even if provider-paid)
  // For legacy payments: skip if already success (preserve existing behavior)
  if (existingPayment.status === 'success' && existingPayment.payment_authority_version !== 1) return;
  if (existingPayment.status === 'success' && existingPayment.finalization_completed_at) {
    // Fully finalized — safe to skip (confirmation has its own lifecycle)
    return;
  }

  // Extract Paystack processing fee (in kobo) and convert to naira
  const paystackFeeKobo = (data.fees as number) || 0;
  const gatewayFee = Math.round(paystackFeeKobo / 100);

  const webhookAmountKobo = data.amount as number;
  const expectedKobo = existingPayment.amount * 100;

  if (webhookAmountKobo !== expectedKobo) {
    Sentry.captureMessage('Payment amount mismatch', { level: 'warning', extra: { reference, webhookAmountKobo, expectedKobo } });
    await supabase
      .from('payments')
      .update({ status: 'failed', gateway_status: 'amount_mismatch' })
      .eq('gateway_reference', reference);
    return;
  }

  // Persist non-authoritative provider metadata (card info, fee) WITHOUT setting status.
  // Authority owns the pending → success transition (Stage 1).
  const authorization = data.authorization as Record<string, unknown> | undefined;
  await supabase
    .from('payments')
    .update({
      payment_method: (data.channel as string) || 'card',
      card_last_four: (authorization?.last4 as string) || null,
      card_brand: (authorization?.brand as string) || null,
      gateway_fee: gatewayFee,
    })
    .eq('gateway_reference', reference);

  // Card saving is consent-based — customer must type "save card" after payment.
  // Store authorization data on the payment metadata so it's available for later opt-in.
  if (authorization?.reusable && authorization?.authorization_code) {
    const customer = data.customer as Record<string, string> | undefined;
    const { data: currentPayment } = await supabase
      .from('payments').select('metadata').eq('gateway_reference', reference).single();
    const existingMeta = (currentPayment?.metadata || {}) as Record<string, unknown>;
    await supabase.from('payments').update({
      metadata: {
        ...existingMeta,
        _card_authorization: {
          authorization_code: authorization.authorization_code,
          customer_code: (customer?.customer_code as string) || null,
          last4: (authorization.last4 as string) || null,
          brand: (authorization.brand as string) || null,
          exp_month: authorization.exp_month ? Number(authorization.exp_month) : null,
          exp_year: authorization.exp_year ? Number(authorization.exp_year) : null,
          card_type: (authorization.card_type as string) || null,
          bank: (authorization.bank as string) || null,
          reusable: true,
        },
      },
    }).eq('gateway_reference', reference);
  }

  // Track payment success
  const posthog = getServerPostHog();
  posthog?.capture({ distinctId: reference, event: 'payment_success', properties: { gateway: 'paystack', amount: existingPayment.amount } });

  // Run fraud detection (non-blocking)
  import('@/lib/fraud/detect').then(({ checkPaymentFraud }) => {
    const customer = data.customer as Record<string, string> | undefined;
    const ipAddress = data.ip_address as string | undefined;
    const metadata = data.metadata as Record<string, string> | undefined;
    checkPaymentFraud(supabase, {
      paymentId: existingPayment.id,
      businessId: metadata?.business_id || '',
      amount: existingPayment.amount,
      currency: (data.currency as string) || 'NGN',
      customerPhone: customer?.phone || '',
      payerIp: ipAddress,
      payerCountry: (data.authorization as Record<string, string>)?.country_code,
    });
  }).catch(() => {});

  // ── Canonical Payment Authority: one engine for all payment completion ──
  // Webhook data is already authenticated by signature — pass as pre-verified provider truth.
  const result = await reconcilePayment(supabase, existingPayment.id, 'webhook', {
    status: 'verified',
    result: {
      provider: 'paystack',
      waaiioReference: reference,
      providerTransactionId: String((data.id as number) || ''),
      amount: webhookAmountKobo / 100, // kobo → naira
      currency: ((data.currency as string) || 'NGN').toUpperCase(),
      paymentMethod: (data.channel as string) || 'card',
      cardLast4: (authorization?.last4 as string) || undefined,
      cardBrand: (authorization?.brand as string) || undefined,
      gatewayFee,
      providerStatus: 'success',
      verifiedAt: new Date().toISOString(),
    },
  });

  if (result.lifecycle) {
    logger.info(`[PAYSTACK WEBHOOK] Authority result: ${result.lifecycle.status} | stages: paid=${result.lifecycle.stages.providerPaid} fin=${result.lifecycle.stages.businessFinalized} conf=${result.lifecycle.stages.customerConfirmed}`);
  }
}

export async function processPaystackChargeFailed(
  data: Record<string, unknown>,
  reference: string,
  supabase: SupabaseClient,
): Promise<void> {
  const { data: existingPayment } = await supabase
    .from('payments')
    .select('id, status, amount, business_id')
    .eq('gateway_reference', reference)
    .single();

  if (!existingPayment || existingPayment.status === 'success') return;

  await supabase
    .from('payments')
    .update({
      status: 'failed',
      gateway_status: (data.gateway_response as string) || 'failed',
    })
    .eq('gateway_reference', reference);

  // Track payment failure
  const posthog = getServerPostHog();
  posthog?.capture({ distinctId: reference, event: 'payment_failed', properties: { gateway: 'paystack', reason: (data.gateway_response as string) || 'unknown' } });

  // Create alert for business owner
  if (existingPayment.business_id) {
    const reason = (data.gateway_response as string) || 'Payment failed';
    await createAlert(supabase, {
      businessId: existingPayment.business_id,
      type: 'payment_failed',
      severity: 'warning',
      title: 'Payment Failed',
      message: `A payment of ${existingPayment.amount} failed: ${reason}`,
      metadata: { paymentId: existingPayment.id, amount: existingPayment.amount, gateway: 'paystack', reference, reason },
    });
  }
}

