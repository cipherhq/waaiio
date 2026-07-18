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
  gateway_fee?: number;
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
  // 1. Confirm booking (only if still pending — idempotent)
  if (payment.booking_id) {
    await supabase
      .from('bookings')
      .update({
        deposit_status: 'paid',
        status: 'confirmed',
        confirmed_at: new Date().toISOString(),
      })
      .eq('id', payment.booking_id)
      .in('status', ['pending']);

    try {
      await recordPlatformFee(supabase, {
        bookingId: payment.booking_id,
        paymentId: payment.id,
        paymentAmount: payment.amount,
        gatewayFee: payment.gateway_fee,
      });
    } catch (feeErr) {
      Sentry.captureException(feeErr, { tags: { type: 'platform_fee_failure', entity: 'booking' } });
      logger.error('[PLATFORM-FEE] Failed to record fee for booking:', feeErr);
      // Don't block the booking confirmation — but ops is alerted via Sentry
    }

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

      // Deduct session from package enrollment if customer has an active package for this service
      if (booking?.service_id && booking?.guest_phone && booking?.business_id) {
        try {
          await deductPackageSession(supabase, {
            businessId: booking.business_id,
            customerPhone: booking.guest_phone,
            serviceId: booking.service_id,
            bookingId: payment.booking_id,
          });
        } catch (pkgErr) {
          logger.error('[PROCESS-SUCCESS] Package session deduction error:', pkgErr);
          Sentry.captureException(pkgErr, { tags: { component: 'process-success', operation: 'package-session-deduction' } });
        }
      }
    } catch (err) {
      logger.error('[PROCESS-SUCCESS] Waitlist conversion tracking error:', err);
      Sentry.captureException(err, { tags: { component: 'process-success', operation: 'waitlist-conversion' } });
    }
  }

  // 2. Process invoice payment (guard: only if payment not already marked success)
  if (payment.invoice_id) {
    const { data: paymentRecord } = await supabase
      .from('payments')
      .select('status')
      .eq('id', payment.id)
      .single();
    // Only process invoice accumulation if this payment hasn't already been applied.
    // The webhook handler marks payment as 'success' before calling this function,
    // so on first call it will be 'success'. On retry, we check the invoice's amount_paid
    // to see if it already includes this payment's amount.
    if (paymentRecord) {
      await processInvoicePayment(supabase, payment.invoice_id, payment.id, payment.amount, payment.gateway_fee);
    }
  }

  // 3. Process campaign donation
  if (payment.campaign_id) {
    await processCampaignDonation(supabase, payment.id, payment.campaign_id, payment.amount, payment.gateway_fee);
  }

  // 4. Confirm order
  const orderId = payment.order_id || (payment.metadata?.order_id as string) || null;
  if (orderId) {
    try {
      // Only confirm if still pending (idempotent). Check if update actually matched.
      const { data: confirmedOrder } = await supabase
        .from('orders')
        .update({
          status: 'confirmed',
          paid_at: new Date().toISOString(),
        })
        .eq('id', orderId)
        .in('status', ['pending'])
        .select('id')
        .maybeSingle();

      await recordPlatformFee(supabase, {
        orderId,
        paymentId: payment.id,
        paymentAmount: payment.amount,
        gatewayFee: payment.gateway_fee,
      });

      // Decrement stock only if we actually confirmed the order (prevents double-decrement
      // when bot "I've Paid" path already decremented stock before webhook fires)
      if (confirmedOrder) {
        const { data: orderItems } = await supabase
          .from('order_items')
          .select('product_id, variant_id, quantity')
          .eq('order_id', orderId);

        if (orderItems) {
          for (const item of orderItems) {
            if (item.variant_id) {
              await supabase.rpc('decrement_variant_stock', { p_variant_id: item.variant_id, qty: item.quantity });
            } else if (item.product_id) {
              await supabase.rpc('decrement_stock', { p_product_id: item.product_id, qty: item.quantity });
            }
          }
        }
      }
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
        paymentId: payment.id,
        paymentAmount: payment.amount,
        gatewayFee: payment.gateway_fee,
      });
    } catch (err) {
      logger.error('[PROCESS-SUCCESS] Reservation confirmation error:', err);
      Sentry.captureException(err, { tags: { component: 'process-success', operation: 'reservation-confirmation' } });
    }
  }
}

/**
 * Confirm a booking's payment status. Idempotent — only updates if still pending.
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
    .eq('id', bookingId)
    .in('status', ['pending']);
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
    paymentId?: string;
    paymentAmount: number;
    gatewayFee?: number;
  },
): Promise<void> {
  let businessId = opts.businessId;
  // Always use the actual payment amount — never replace with entity totals.
  // Deposits and partial payments must record only the amount actually collected.
  const transactionAmount = opts.paymentAmount;

  // Resolve business_id from the entity (but do NOT override transactionAmount)
  if (opts.bookingId && !businessId) {
    const { data: booking } = await supabase
      .from('bookings')
      .select('business_id')
      .eq('id', opts.bookingId)
      .single();
    if (!booking?.business_id) return;
    businessId = booking.business_id;
  }

  if (opts.orderId && !businessId) {
    const { data: order } = await supabase
      .from('orders')
      .select('business_id')
      .eq('id', opts.orderId)
      .single();
    if (!order?.business_id) return;
    businessId = order.business_id;
  }

  if (opts.invoiceId && !businessId) {
    const { data: invoice } = await supabase
      .from('invoices')
      .select('business_id')
      .eq('id', opts.invoiceId)
      .single();
    if (!invoice?.business_id) return;
    businessId = invoice.business_id;
  }

  if (opts.reservationId && !businessId) {
    const { data: reservation } = await supabase
      .from('reservations')
      .select('business_id')
      .eq('id', opts.reservationId)
      .single();
    if (!reservation?.business_id) return;
    businessId = reservation.business_id;
  }

  if (!businessId) return;

  const { data: business } = await supabase
    .from('businesses')
    .select('subscription_tier, trial_ends_at, payout_mode, custom_fee_percentage, custom_fee_flat, reseller_id')
    .eq('id', businessId)
    .single();

  if (!business) return;
  if (business.payout_mode === 'direct_split') return;

  const tier = (business.subscription_tier || 'free') as SubscriptionTier;
  const isInTrial = tier === 'free' && new Date(business.trial_ends_at) > new Date();

  const { feePercentage, feeFlat, feeTotal } = await getPlatformFees(transactionAmount, tier, isInTrial, {
    feePercentage: business.custom_fee_percentage != null ? Number(business.custom_fee_percentage) : null,
    feeFlat: business.custom_fee_flat != null ? Number(business.custom_fee_flat) : null,
  });

  // Calculate reseller commission if this business belongs to a reseller
  let resellerId: string | null = business.reseller_id || null;
  let resellerCommission = 0;

  if (resellerId && feeTotal > 0) {
    const { data: reseller } = await supabase
      .from('resellers')
      .select('id, commission_percentage, status')
      .eq('id', resellerId)
      .maybeSingle();

    if (reseller && reseller.status === 'active' && reseller.commission_percentage > 0) {
      resellerCommission = Math.round(feeTotal * (Number(reseller.commission_percentage) / 100));
    } else {
      // Don't assign commission to suspended resellers
      resellerId = null;
    }
  }

  // Insert fee — log but don't throw on duplicate (webhook + "I've Paid" race).
  // UNIQUE index on payment_id ensures at most one fee per successful payment.
  const { error: feeErr } = await supabase.from('platform_fees').insert({
    business_id: businessId,
    payment_id: opts.paymentId || null,
    booking_id: opts.bookingId || null,
    invoice_id: opts.invoiceId || null,
    campaign_id: opts.campaignId || null,
    reservation_id: opts.reservationId || null,
    order_id: opts.orderId || null,
    transaction_amount: transactionAmount,
    fee_percentage: feePercentage,
    fee_flat: feeFlat,
    fee_total: feeTotal,
    gateway_fee: opts.gatewayFee || 0,
    tier,
    reseller_id: resellerId,
    reseller_commission: resellerCommission,
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
 * Idempotent: checks if payment was already applied before incrementing amount_paid.
 */
export async function processInvoicePayment(
  supabase: SupabaseClient,
  invoiceId: string,
  paymentId: string,
  paymentAmount: number,
  gatewayFee?: number,
): Promise<void> {
  const { data: invoice } = await supabase
    .from('invoices')
    .select('business_id, total_amount, amount_paid, status')
    .eq('id', invoiceId)
    .single();

  if (!invoice) return;

  // Skip if already fully paid (saves a roundtrip — RPC also checks internally)
  if (invoice.status === 'paid') return;

  // Atomic RPC: records fee + increments amount_paid in one transaction.
  // Two concurrent calls for the same payment_id produce one increment and one fee.
  // UNIQUE index on payment_id is unconditional — refunds don't make it reusable.
  const { data: rpcResult, error: rpcError } = await supabase.rpc('apply_invoice_payment', {
    p_invoice_id: invoiceId,
    p_payment_id: paymentId,
    p_payment_amount: paymentAmount,
    p_business_id: invoice.business_id,
    p_gateway_fee: gatewayFee || 0,
  });

  if (rpcError) {
    if (rpcError.message?.includes('duplicate') || rpcError.message?.includes('unique') || rpcError.message?.includes('already_applied')) {
      return; // Idempotent — already applied
    }
    logger.error('[INVOICE-PAYMENT] RPC error:', rpcError.message);
    return;
  }

  // Alert on overpayment — money already received, needs human review
  if (rpcResult?.overpayment_amount > 0) {
    logger.warn('[INVOICE-PAYMENT] Overpayment detected', {
      invoiceId,
      paymentId,
      paymentAmount,
      appliedAmount: rpcResult.applied_amount,
      overpaymentAmount: rpcResult.overpayment_amount,
    });
    Sentry.captureMessage('Invoice overpayment detected — manual review required', {
      level: 'warning',
      tags: { type: 'overpayment', component: 'invoice-payment' },
      extra: { invoiceId, paymentId, paymentAmount, overpayment: rpcResult.overpayment_amount },
    });
  }
}

/**
 * Process campaign donation: mark as success, increment stats, record fee.
 */
export async function processCampaignDonation(
  supabase: SupabaseClient,
  paymentId: string,
  campaignId: string,
  amount: number,
  gatewayFee?: number,
): Promise<void> {
  // Atomic RPC: transitions donation + increments campaign in one transaction.
  // If donation is already processed, returns already_processed (idempotent).
  // Two concurrent calls produce one increment.
  const { data: result, error: rpcError } = await supabase.rpc('apply_campaign_donation', {
    p_payment_id: paymentId,
    p_campaign_id: campaignId,
    p_amount: amount,
    p_business_id: '', // Business ID resolved from campaign inside RPC
  });

  if (rpcError) {
    // Log but don't throw — payment confirmation should not be blocked
    logger.error('[CAMPAIGN-DONATION] RPC error:', rpcError.message);
  }

  if (!result?.success) {
    // Already processed — skip fee recording
    return;
  }

  // Record platform fee (unique index on payment_id prevents duplicates)
  const { data: campaign } = await supabase
    .from('campaigns')
    .select('business_id')
    .eq('id', campaignId)
    .single();

  if (campaign?.business_id) {
    await recordPlatformFee(supabase, {
      campaignId,
      businessId: campaign.business_id,
      paymentId,
      paymentAmount: amount,
      gatewayFee,
    });
  }
}

/**
 * Deduct a session from the customer's active package enrollment.
 * Fully atomic RPC handles enrollment lookup + deduction + replay protection
 * in a single database transaction. Non-blocking — errors are logged and captured.
 */
async function deductPackageSession(
  supabase: SupabaseClient,
  opts: {
    businessId: string;
    customerPhone: string;
    serviceId: string;
    bookingId: string;
  },
): Promise<void> {
  try {
    const { data: deducted, error } = await supabase.rpc('deduct_package_session', {
      p_business_id: opts.businessId,
      p_customer_phone: opts.customerPhone,
      p_service_id: opts.serviceId,
      p_booking_id: opts.bookingId,
    });

    if (error) {
      logger.error('[PACKAGE-DEDUCT] RPC error:', error.message);
      Sentry.captureException(error, { tags: { area: 'package-deduction' } });
      return;
    }

    if (deducted) {
      logger.info(`[PACKAGE-DEDUCT] Session deducted for booking ${opts.bookingId}`);
    }
  } catch (err) {
    logger.error('[PACKAGE-DEDUCT] Error:', err);
    Sentry.captureException(err, { tags: { area: 'package-deduction' } });
  }
}
