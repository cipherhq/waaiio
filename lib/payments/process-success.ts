import type { SupabaseClient } from '@supabase/supabase-js';
import * as Sentry from '@sentry/nextjs';
import { getPlatformFees } from '@/lib/getPlatformFees';
import type { SubscriptionTier } from '@/lib/constants';
import { logger } from '@/lib/logger';
import { markWaitlistConverted } from '@/lib/waitlist/auto-notify';

interface PaymentRecord {
  id: string;
  amount: number;
  booking_id: string | null;
  invoice_id: string | null;
  campaign_id: string | null;
  reservation_id?: string | null;
  order_id?: string | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * Shared post-verification pipeline for all payment gateways.
 * Called after a payment is verified as successful.
 *
 * Handles:
 * 1. Confirm booking (deposit_status: paid, status: confirmed)
 * 2. Record platform fee (for booking, invoice, or campaign)
 * 3. Process invoice partial payment accumulation
 * 4. Process campaign donation (mark success + increment stats)
 */
export async function processSuccessfulPayment(
  supabase: SupabaseClient,
  payment: PaymentRecord,
): Promise<void> {
  // 1. Confirm booking
  if (payment.booking_id) {
    await supabase
      .from('bookings')
      .update({
        deposit_status: 'paid',
        status: 'confirmed',
        confirmed_at: new Date().toISOString(),
      })
      .eq('id', payment.booking_id);

    await recordPlatformFee(supabase, {
      bookingId: payment.booking_id,
      paymentAmount: payment.amount,
    });

    // Track waitlist conversion: if this customer was notified via waitlist, mark as converted
    try {
      const { data: booking } = await supabase
        .from('bookings')
        .select('business_id, service_id, guest_phone')
        .eq('id', payment.booking_id)
        .single();

      if (booking?.guest_phone) {
        await markWaitlistConverted({
          supabase,
          businessId: booking.business_id,
          customerPhone: booking.guest_phone,
          serviceId: booking.service_id,
          bookingId: payment.booking_id,
        });
      }
    } catch (err) {
      logger.error('[PROCESS-SUCCESS] Waitlist conversion tracking error:', err);
      Sentry.captureException(err, { tags: { component: 'process-success', operation: 'waitlist-conversion' } });
    }
  }

  // 2. Process invoice payment
  if (payment.invoice_id) {
    await processInvoicePayment(supabase, payment.invoice_id, payment.amount);
  }

  // 3. Process campaign donation
  if (payment.campaign_id) {
    await processCampaignDonation(supabase, payment.id, payment.campaign_id, payment.amount);
  }

  // 4. Confirm order
  const orderId = payment.order_id || (payment.metadata?.order_id as string) || null;
  if (orderId) {
    try {
      await supabase
        .from('orders')
        .update({
          status: 'confirmed',
          paid_at: new Date().toISOString(),
        })
        .eq('id', orderId)
        .in('status', ['pending']); // Only confirm if still pending (idempotent)

      await recordPlatformFee(supabase, {
        orderId,
        paymentAmount: payment.amount,
      });
    } catch (err) {
      logger.error('[PROCESS-SUCCESS] Order confirmation error:', err);
      Sentry.captureException(err, { tags: { component: 'process-success', operation: 'order-confirmation' } });
    }
  }

  // 5. Confirm reservation
  if (payment.reservation_id) {
    try {
      await supabase
        .from('reservations')
        .update({
          deposit_status: 'paid',
          status: 'confirmed',
          confirmed_at: new Date().toISOString(),
        })
        .eq('id', payment.reservation_id)
        .in('status', ['pending']); // Only confirm if still pending (idempotent)

      await recordPlatformFee(supabase, {
        reservationId: payment.reservation_id,
        paymentAmount: payment.amount,
      });
    } catch (err) {
      logger.error('[PROCESS-SUCCESS] Reservation confirmation error:', err);
      Sentry.captureException(err, { tags: { component: 'process-success', operation: 'reservation-confirmation' } });
    }
  }
}

/**
 * Confirm a booking's payment status. Idempotent — safe to call multiple times.
 */
export async function confirmBookingPayment(
  supabase: SupabaseClient,
  bookingId: string,
): Promise<void> {
  await supabase
    .from('bookings')
    .update({
      deposit_status: 'paid',
      status: 'confirmed',
      confirmed_at: new Date().toISOString(),
    })
    .eq('id', bookingId);
}

/**
 * Record platform fee for a transaction.
 * Looks up business tier, checks payout_mode, calculates fee, inserts record.
 * Skips for direct_split businesses (gateway already collected the fee).
 */
export async function recordPlatformFee(
  supabase: SupabaseClient,
  opts: {
    bookingId?: string;
    invoiceId?: string;
    campaignId?: string;
    orderId?: string;
    reservationId?: string;
    businessId?: string;
    paymentAmount: number;
  },
): Promise<void> {
  let businessId = opts.businessId;
  let transactionAmount = opts.paymentAmount;

  // Resolve business_id and total_amount from the entity
  if (opts.bookingId && !businessId) {
    const { data: booking } = await supabase
      .from('bookings')
      .select('business_id, total_amount')
      .eq('id', opts.bookingId)
      .single();
    if (!booking?.business_id) return;
    businessId = booking.business_id;
    transactionAmount = booking.total_amount || opts.paymentAmount;
  }

  if (opts.orderId && !businessId) {
    const { data: order } = await supabase
      .from('orders')
      .select('business_id, total_amount')
      .eq('id', opts.orderId)
      .single();
    if (!order?.business_id) return;
    businessId = order.business_id;
    transactionAmount = order.total_amount || opts.paymentAmount;
  }

  if (opts.invoiceId && !businessId) {
    const { data: invoice } = await supabase
      .from('invoices')
      .select('business_id, total_amount')
      .eq('id', opts.invoiceId)
      .single();
    if (!invoice?.business_id) return;
    businessId = invoice.business_id;
    transactionAmount = invoice.total_amount || opts.paymentAmount;
  }

  if (opts.reservationId && !businessId) {
    const { data: reservation } = await supabase
      .from('reservations')
      .select('business_id, total_amount')
      .eq('id', opts.reservationId)
      .single();
    if (!reservation?.business_id) return;
    businessId = reservation.business_id;
    transactionAmount = reservation.total_amount || opts.paymentAmount;
  }

  if (!businessId) return;

  const { data: business } = await supabase
    .from('businesses')
    .select('subscription_tier, trial_ends_at, payout_mode')
    .eq('id', businessId)
    .single();

  if (!business) return;
  if (business.payout_mode === 'direct_split') return;

  const isInTrial = new Date(business.trial_ends_at) > new Date();
  const tier = (business.subscription_tier || 'free') as SubscriptionTier;

  const { feePercentage, feeFlat, feeTotal } = await getPlatformFees(transactionAmount, tier, isInTrial);

  // Insert fee — log but don't throw on duplicate (webhook + "I've Paid" race)
  const { error: feeErr } = await supabase.from('platform_fees').insert({
    business_id: businessId,
    booking_id: opts.bookingId || null,
    invoice_id: opts.invoiceId || null,
    campaign_id: opts.campaignId || null,
    reservation_id: opts.reservationId || null,
    transaction_amount: transactionAmount,
    fee_percentage: feePercentage,
    fee_flat: feeFlat,
    fee_total: feeTotal,
    tier,
  });
  if (feeErr) {
    console.error('[PLATFORM-FEE] Insert error (possible duplicate):', feeErr.message);
    // Only report to Sentry if it's not a duplicate key violation
    if (!feeErr.message?.includes('duplicate') && !feeErr.message?.includes('unique')) {
      Sentry.captureException(new Error(`Platform fee insert error: ${feeErr.message}`), {
        tags: { component: 'process-success', operation: 'platform-fee' },
        extra: { businessId, bookingId: opts.bookingId, invoiceId: opts.invoiceId },
      });
    }
  }
}

/**
 * Process invoice payment with partial payment accumulation.
 */
export async function processInvoicePayment(
  supabase: SupabaseClient,
  invoiceId: string,
  paymentAmount: number,
): Promise<void> {
  const { data: invoice } = await supabase
    .from('invoices')
    .select('business_id, total_amount, amount_paid')
    .eq('id', invoiceId)
    .single();

  if (!invoice) return;

  const newAmountPaid = (Number(invoice.amount_paid) || 0) + paymentAmount;
  const totalAmount = Number(invoice.total_amount) || 0;
  const isFullyPaid = newAmountPaid >= totalAmount;

  await supabase
    .from('invoices')
    .update({
      status: isFullyPaid ? 'paid' : 'sent',
      amount_paid: newAmountPaid,
      paid_at: isFullyPaid ? new Date().toISOString() : null,
    })
    .eq('id', invoiceId);

  await recordPlatformFee(supabase, { invoiceId, paymentAmount });
}

/**
 * Process campaign donation: mark as success, increment stats, record fee.
 */
export async function processCampaignDonation(
  supabase: SupabaseClient,
  paymentId: string,
  campaignId: string,
  amount: number,
): Promise<void> {
  // Mark donation as success — try by payment_id first, fallback to campaign_id
  const { data: updated } = await supabase
    .from('campaign_donations')
    .update({ status: 'success' })
    .eq('payment_id', paymentId)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle();

  if (!updated) {
    await supabase
      .from('campaign_donations')
      .update({ status: 'success', payment_id: paymentId })
      .eq('campaign_id', campaignId)
      .eq('status', 'pending')
      .is('payment_id', null);
  }

  // Atomic increment of campaign stats (prevents double-counting under race)
  if (typeof supabase.rpc === 'function') {
    await supabase.rpc('increment_campaign_donation', {
      p_campaign_id: campaignId,
      p_amount: amount,
      p_donor_count: 1,
    });
  } else {
    // Fallback for test environments without RPC support
    const { data: camp } = await supabase.from('campaigns').select('raised_amount, donor_count').eq('id', campaignId).single();
    if (camp) {
      await supabase.from('campaigns').update({
        raised_amount: Number(camp.raised_amount || 0) + amount,
        donor_count: (camp.donor_count || 0) + 1,
      }).eq('id', campaignId);
    }
  }

  // Record platform fee (unique index prevents duplicates)
  const { data: campaign } = await supabase
    .from('campaigns')
    .select('business_id')
    .eq('id', campaignId)
    .single();

  if (campaign?.business_id) {
    await recordPlatformFee(supabase, {
      campaignId,
      businessId: campaign.business_id,
      paymentAmount: amount,
    });
  }
}
