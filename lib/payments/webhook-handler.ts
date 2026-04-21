import type { SupabaseClient } from '@supabase/supabase-js';
import { getPlatformFees } from '@/lib/getPlatformFees';
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
    .select('id, status, amount, booking_id, invoice_id, gateway')
    .eq('gateway_reference', reference)
    .single();

  if (!existingPayment || existingPayment.status === 'success') return;

  const webhookAmountKobo = data.amount as number;
  const expectedKobo = existingPayment.amount * 100;

  if (webhookAmountKobo !== expectedKobo) {
    await supabase
      .from('payments')
      .update({ status: 'failed', gateway_status: 'amount_mismatch' })
      .eq('gateway_reference', reference);
    return;
  }

  const authorization = data.authorization as Record<string, string> | undefined;
  await supabase
    .from('payments')
    .update({
      status: 'success',
      gateway_status: 'success',
      payment_method: (data.channel as string) || 'card',
      card_last_four: authorization?.last4 || null,
      card_brand: authorization?.brand || null,
      paid_at: new Date().toISOString(),
    })
    .eq('gateway_reference', reference);

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
    await supabase
      .from('invoices')
      .update({
        status: 'paid',
        amount_paid: existingPayment.amount,
        paid_at: new Date().toISOString(),
      })
      .eq('id', existingPayment.invoice_id);

    await recordPlatformFeeForInvoice(supabase, existingPayment.invoice_id, existingPayment.amount);
  }
}

export async function processPaystackChargeFailed(
  data: Record<string, unknown>,
  reference: string,
  supabase: SupabaseClient,
): Promise<void> {
  const { data: existingPayment } = await supabase
    .from('payments')
    .select('id, status')
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
