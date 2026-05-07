import type { SupabaseClient } from '@supabase/supabase-js';
import * as Sentry from '@sentry/nextjs';
import { getPlatformFees } from '@/lib/getPlatformFees';
import { getServerPostHog } from '@/lib/posthog/server';
import { createAlert } from '@/lib/alerts/create-alert';
import type { SubscriptionTier } from '@/lib/constants';

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
    .select('id, status, amount, booking_id, invoice_id, campaign_id, gateway')
    .eq('gateway_reference', reference)
    .single();

  if (!existingPayment || existingPayment.status === 'success') return;

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

  const authorization = data.authorization as Record<string, unknown> | undefined;
  await supabase
    .from('payments')
    .update({
      status: 'success',
      gateway_status: 'success',
      payment_method: (data.channel as string) || 'card',
      card_last_four: (authorization?.last4 as string) || null,
      card_brand: (authorization?.brand as string) || null,
      paid_at: new Date().toISOString(),
    })
    .eq('gateway_reference', reference);

  // Save reusable payment method for future one-tap payments
  if (authorization?.reusable && authorization?.authorization_code) {
    const customer = data.customer as Record<string, string> | undefined;
    const metadata = data.metadata as Record<string, string> | undefined;
    const businessId = metadata?.business_id;
    const phone = customer?.phone;

    if (businessId && phone) {
      await supabase.from('saved_payment_methods').upsert({
        business_id: businessId,
        customer_phone: phone,
        gateway: 'paystack',
        authorization_code: authorization.authorization_code as string,
        customer_code: (customer?.customer_code as string) || null,
        card_last4: (authorization.last4 as string) || null,
        card_brand: (authorization.brand as string) || null,
        card_exp_month: authorization.exp_month ? Number(authorization.exp_month) : null,
        card_exp_year: authorization.exp_year ? Number(authorization.exp_year) : null,
        card_type: (authorization.card_type as string) || null,
        bank_name: (authorization.bank as string) || null,
        is_active: true,
        last_used_at: new Date().toISOString(),
      }, { onConflict: 'business_id,customer_phone,gateway' });
      // Non-blocking — ignore upsert errors
    }
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

  if (existingPayment.booking_id) {
    await supabase
      .from('bookings')
      .update({
        deposit_status: 'paid',
        status: 'confirmed',
        confirmed_at: new Date().toISOString(),
      })
      .eq('id', existingPayment.booking_id);

    // Record platform fee for confirmed payment
    await recordPlatformFeeForBooking(supabase, existingPayment.booking_id, existingPayment.amount);
  }

  if (existingPayment.invoice_id) {
    // Get current amount_paid for partial payment accumulation
    const { data: invoice } = await supabase
      .from('invoices')
      .select('amount_paid, total_amount')
      .eq('id', existingPayment.invoice_id)
      .single();

    const newAmountPaid = (Number(invoice?.amount_paid) || 0) + existingPayment.amount;
    const totalAmount = Number(invoice?.total_amount) || 0;
    const isFullyPaid = newAmountPaid >= totalAmount;

    await supabase
      .from('invoices')
      .update({
        status: isFullyPaid ? 'paid' : 'sent', // Stay 'sent' if partial
        amount_paid: newAmountPaid,
        paid_at: isFullyPaid ? new Date().toISOString() : null,
      })
      .eq('id', existingPayment.invoice_id);

    await recordPlatformFeeForInvoice(supabase, existingPayment.invoice_id, existingPayment.amount);
  }

  // Update campaign donation on successful payment
  if (existingPayment.campaign_id) {
    // Mark donation as success
    await supabase
      .from('campaign_donations')
      .update({ status: 'success', payment_id: existingPayment.id })
      .eq('reference_code', reference)
      .eq('status', 'pending');

    // Increment campaign raised_amount and donor_count atomically
    const { data: campaign } = await supabase
      .from('campaigns')
      .select('raised_amount, donor_count')
      .eq('id', existingPayment.campaign_id)
      .single();

    if (campaign) {
      await supabase
        .from('campaigns')
        .update({
          raised_amount: Number(campaign.raised_amount || 0) + existingPayment.amount,
          donor_count: (campaign.donor_count || 0) + 1,
        })
        .eq('id', existingPayment.campaign_id);
    }
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

async function recordPlatformFeeForBooking(
  supabase: SupabaseClient,
  bookingId: string,
  paymentAmount: number,
): Promise<void> {
  const { data: booking } = await supabase
    .from('bookings')
    .select('business_id, total_amount')
    .eq('id', bookingId)
    .single();

  if (!booking?.business_id) return;

  const { data: business } = await supabase
    .from('businesses')
    .select('subscription_tier, trial_ends_at')
    .eq('id', booking.business_id)
    .single();

  if (!business) return;

  const isInTrial = new Date(business.trial_ends_at) > new Date();
  const tier = (business.subscription_tier || 'free') as SubscriptionTier;
  const amount = booking.total_amount || paymentAmount;

  const { feePercentage, feeFlat, feeTotal } = await getPlatformFees(amount, tier, isInTrial);

  await supabase.from('platform_fees').insert({
    business_id: booking.business_id,
    booking_id: bookingId,
    transaction_amount: amount,
    fee_percentage: feePercentage,
    fee_flat: feeFlat,
    fee_total: feeTotal,
    tier,
  });
}

async function recordPlatformFeeForInvoice(
  supabase: SupabaseClient,
  invoiceId: string,
  paymentAmount: number,
): Promise<void> {
  const { data: invoice } = await supabase
    .from('invoices')
    .select('business_id, total_amount')
    .eq('id', invoiceId)
    .single();

  if (!invoice?.business_id) return;

  const { data: business } = await supabase
    .from('businesses')
    .select('subscription_tier, trial_ends_at')
    .eq('id', invoice.business_id)
    .single();

  if (!business) return;

  const isInTrial = new Date(business.trial_ends_at) > new Date();
  const tier = (business.subscription_tier || 'free') as SubscriptionTier;
  const amount = invoice.total_amount || paymentAmount;

  const { feePercentage, feeFlat, feeTotal } = await getPlatformFees(amount, tier, isInTrial);

  await supabase.from('platform_fees').insert({
    business_id: invoice.business_id,
    invoice_id: invoiceId,
    transaction_amount: amount,
    fee_percentage: feePercentage,
    fee_flat: feeFlat,
    fee_total: feeTotal,
    tier,
  });
}
