import type { SupabaseClient } from '@supabase/supabase-js';
import * as Sentry from '@sentry/nextjs';
import { getPlatformFees } from '@/lib/getPlatformFees';
import type { SubscriptionTier } from '@/lib/constants';
import { logger } from '@/lib/logger';
import { safeLogErrorContext } from '@/lib/errors';
import { isSafeIdentifier } from '@/lib/redact';
import { markWaitlistConverted } from '@/lib/waitlist/auto-notify';
import type { FinalizationResult } from './authority';

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
 * Returns FinalizationResult so the Payment Authority can determine
 * whether Stage 2 (business finalization) completed.
 *
 * CRITICAL effects must propagate failures.
 * NONCRITICAL effects (waitlist attribution) may log and continue.
 */
export async function processSuccessfulPayment(
  supabase: SupabaseClient,
  payment: PaymentRecord,
): Promise<FinalizationResult> {
  const criticalErrors: string[] = [];

  // 1. Confirm booking (only if still pending — idempotent)
  if (payment.booking_id) {
    // Confirm booking: pending → confirmed + deposit_status='paid'
    // For already-confirmed/in_progress/completed: ensure deposit_status='paid' only
    const { error: bookingErr } = await supabase
      .from('bookings')
      .update({
        deposit_status: 'paid',
        status: 'confirmed',
        confirmed_at: new Date().toISOString(),
      })
      .eq('id', payment.booking_id)
      .in('status', ['pending']);

    if (bookingErr) {
      criticalErrors.push('booking_confirmation_failed');
      logger.withContext({ op: 'process-success.booking', ...safeLogErrorContext(bookingErr) }).error('[PROCESS-SUCCESS] Booking confirmation DB error');
    }

    // Stage-2 postcondition: verify booking is in a legitimate paid state
    // before proceeding to fee/ticket consequences.
    const { data: bookingPost, error: postErr } = await supabase
      .from('bookings')
      .select('status, deposit_status')
      .eq('id', payment.booking_id)
      .single();

    if (postErr || !bookingPost) {
      criticalErrors.push('booking_postcondition_missing');
      logger.error('[PROCESS-SUCCESS] Booking postcondition read failed for', payment.booking_id);
      // Cannot prove booking is in valid paid state — fail before fee/ticket
      return { criticalSuccess: false, errors: criticalErrors };
    } else if (bookingPost.status === 'cancelled') {
      criticalErrors.push('booking_cancelled_at_payment');
      logger.error('[PROCESS-SUCCESS] Booking cancelled before payment finalization', payment.booking_id);
      return { criticalSuccess: false, errors: criticalErrors };
    } else if (bookingPost.status === 'no_show') {
      criticalErrors.push('booking_no_show_at_payment');
      logger.error('[PROCESS-SUCCESS] Booking marked no-show at payment time', payment.booking_id);
      return { criticalSuccess: false, errors: criticalErrors };
    } else if (bookingPost.deposit_status !== 'paid') {
      // Ensure deposit_status is set for non-pending legitimate states only.
      // Guard: only repair confirmed/in_progress/completed (not cancelled/no_show).
      const { data: repairResult, error: repairErr } = await supabase.from('bookings')
        .update({ deposit_status: 'paid' })
        .eq('id', payment.booking_id)
        .in('status', ['confirmed', 'in_progress', 'completed'])
        .select('status, deposit_status')
        .single();
      if (repairErr || !repairResult) {
        criticalErrors.push('booking_deposit_repair_failed');
        logger.error('[PROCESS-SUCCESS] Booking deposit_status repair failed or no eligible row', payment.booking_id);
        return { criticalSuccess: false, errors: criticalErrors };
      }
      if (repairResult.deposit_status !== 'paid') {
        criticalErrors.push('booking_deposit_still_unpaid');
        logger.error('[PROCESS-SUCCESS] Booking deposit_status still not paid after repair', payment.booking_id);
        return { criticalSuccess: false, errors: criticalErrors };
      }
    }

    try {
      await recordPlatformFee(supabase, {
        bookingId: payment.booking_id,
        paymentId: payment.id,
        paymentAmount: payment.amount,
        gatewayFee: payment.gateway_fee,
      });
    } catch (feeErr) {
      criticalErrors.push('booking_platform_fee_failed');
      Sentry.captureException(feeErr, { tags: { type: 'platform_fee_failure', entity: 'booking' } });
      logger.withContext({ op: 'platform-fee.booking', ...safeLogErrorContext(feeErr) }).error('[PLATFORM-FEE] Failed to record fee for booking');
    }

    // NONCRITICAL: waitlist conversion tracking
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
      // Noncritical — log but do not fail finalization
      logger.withContext({ op: 'process-success.waitlist-conversion', ...safeLogErrorContext(err) }).error('[PROCESS-SUCCESS] Waitlist conversion tracking error');
    }

    // CRITICAL: For paid ticket bookings, ensure inventory + canonical ticket rows (Stage 2)
    try {
      const { ensurePaidTicketState } = await import('./ticket-business-state');
      const ticketState = await ensurePaidTicketState(supabase, { paymentBookingId: payment.booking_id });
      if (!ticketState.success) {
        criticalErrors.push(`ticket_business_state_failed:${ticketState.error}`);
      }
    } catch (err) {
      criticalErrors.push('ticket_business_state_threw');
      logger.withContext({ op: 'process-success.ticket-state', ...safeLogErrorContext(err) }).error('[PROCESS-SUCCESS] Ticket business state error');
    }

    // CRITICAL: Exactly-once customer spend via durable payment-scoped marker.
    // Amount derived from payment row inside the RPC, not caller-supplied.
    try {
      const { data: spendResult, error: spendErr } = await supabase.rpc('apply_payment_spend_once', {
        p_payment_id: payment.id,
      });
      if (spendErr) {
        criticalErrors.push('booking_spend_failed');
        logger.withContext({ op: 'process-success.booking-spend', ...safeLogErrorContext(spendErr) }).error('[PROCESS-SUCCESS] Booking spend RPC error');
      } else if (spendResult && !spendResult.applied) {
        const reason = spendResult.reason || 'unknown';
        if (reason !== 'no_supported_source') {
          // no_supported_source means this payment has no booking/reservation — valid for other entity types
          criticalErrors.push(`booking_spend_semantic_failure:${reason}`);
          logger.error('[PROCESS-SUCCESS] Booking spend semantic failure:', reason);
        }
      }
    } catch (spendThrow) {
      criticalErrors.push('booking_spend_threw');
      logger.withContext({ op: 'process-success.booking-spend', ...safeLogErrorContext(spendThrow) }).error('[PROCESS-SUCCESS] Booking spend threw');
    }
  }

  // 2. Process invoice payment
  if (payment.invoice_id) {
    try {
      await processInvoicePayment(supabase, payment.invoice_id, payment.id, payment.amount, payment.gateway_fee);
    } catch (err) {
      criticalErrors.push('invoice_payment_failed');
      logger.withContext({ op: 'process-success.invoice', ...safeLogErrorContext(err) }).error('[PROCESS-SUCCESS] Invoice payment error');
    }
  }

  // 3. Process campaign donation
  if (payment.campaign_id) {
    try {
      await processCampaignDonation(supabase, payment.id, payment.campaign_id, payment.amount, payment.gateway_fee);
    } catch (err) {
      criticalErrors.push('campaign_donation_failed');
      logger.withContext({ op: 'process-success.campaign', ...safeLogErrorContext(err) }).error('[PROCESS-SUCCESS] Campaign donation error');
    }
  }

  // 4. Confirm order + stock decrement (exactly-once via apply_order_stock_once)
  // apply_order_stock_once now also confirms order status (pending → confirmed)
  // inside the same FOR UPDATE lock, creating a real serialization contract with
  // cancel_stale_order_atomic. The order status update was previously a separate
  // unprotected call that could race with cleanup.
  const orderId = payment.order_id || (payment.metadata?.order_id as string) || null;
  if (orderId) {
    try {
      try {
        await recordPlatformFee(supabase, {
          orderId, paymentId: payment.id, paymentAmount: payment.amount, gatewayFee: payment.gateway_fee,
        });
      } catch (feeErr) {
        criticalErrors.push('order_platform_fee_failed');
        logger.withContext({ op: 'platform-fee.order', ...safeLogErrorContext(feeErr) }).error('[PLATFORM-FEE] Failed to record fee for order');
      }

      // Stock decrement + order confirmation: exactly-once via durable marker (crash-gap safe).
      // This is the SOLE authority for order pending→confirmed transition.
      // Serialized with cancel_stale_order_atomic via FOR UPDATE on order row.
      const { data: stockResult, error: stockErr } = await supabase.rpc('apply_order_stock_once', {
        p_order_id: orderId, p_payment_id: payment.id,
      });
      if (stockErr) {
        criticalErrors.push('order_stock_failed');
        logger.withContext({ op: 'process-success.stock', ...safeLogErrorContext(stockErr) }).error('[PROCESS-SUCCESS] apply_order_stock_once RPC error');
      } else if (!stockResult?.applied) {
        // Semantic failure (e.g. order_not_found, payment/order mismatch)
        criticalErrors.push(`order_stock_semantic_failure:${stockResult?.reason || 'unknown'}`);
        logger.error('[PROCESS-SUCCESS] apply_order_stock_once returned applied=false:', stockResult?.reason);
      } else if (stockResult.already_applied) {
        logger.info('[PROCESS-SUCCESS] Order stock already applied for payment ' + payment.id);
      }
    } catch (err) {
      criticalErrors.push('order_finalization_threw');
      logger.withContext({ op: 'process-success.order-confirmation', ...safeLogErrorContext(err) }).error('[PROCESS-SUCCESS] Order confirmation error');
      Sentry.captureException(err, { tags: { component: 'process-success', operation: 'order-confirmation' } });
    }

    // ACC-008: Finalize promo reservation on authoritative payment success.
    // Per-order state (reserved → finalized) via promo_reservations table.
    // CRITICAL: promo capacity accuracy depends on this transition.
    try {
      const { data: promoResult, error: promoErr } = await supabase.rpc('finalize_promo_reservation', { p_order_id: orderId });
      if (promoErr) {
        criticalErrors.push('promo_finalization_failed');
        logger.withContext({ op: 'process-success.promo-finalize', ...safeLogErrorContext(promoErr) }).error('[PROCESS-SUCCESS] Promo finalization RPC error');
      } else if (promoResult) {
        // Inspect semantic result for promo-using orders
        const reason = promoResult.reason as string | undefined;
        if (reason === 'no_reservation') {
          // Order had no promo — valid no-op, not an error
        } else if (reason === 'order_not_confirmed') {
          // Order not yet confirmed — should not happen in Stage 2, flag as critical
          criticalErrors.push('promo_finalization_order_not_confirmed');
          logger.error('[PROCESS-SUCCESS] Promo finalization rejected: order not confirmed for', orderId);
        } else if (reason === 'already_released') {
          // Reservation was released (cancellation raced payment) — critical for promo-using orders
          criticalErrors.push('promo_reservation_already_released');
          logger.error('[PROCESS-SUCCESS] Promo reservation already released for', orderId);
        }
      }
    } catch (promoThrow) {
      criticalErrors.push('promo_finalization_threw');
      logger.withContext({ op: 'process-success.promo-finalize', ...safeLogErrorContext(promoThrow) }).error('[PROCESS-SUCCESS] Promo finalization threw');
    }

    // Referral conversion: pending → converted. Critical — conversion is a required
    // payment-success consequence. Idempotent via status='pending' guard (replay-safe).
    try {
      const { data: orderForRef, error: refLoadErr } = await supabase
        .from('orders').select('referral_id, delivery_phone').eq('id', orderId).single();
      if (refLoadErr) {
        criticalErrors.push('referral_order_load_failed');
        logger.withContext({ op: 'process-success.referral-load', ...safeLogErrorContext(refLoadErr) }).error('[PROCESS-SUCCESS] Referral order load failed');
      } else if (orderForRef?.referral_id) {
        const { error: refUpdateErr } = await supabase.from('referrals')
          .update({ status: 'converted', referee_phone: orderForRef.delivery_phone, updated_at: new Date().toISOString() })
          .eq('id', orderForRef.referral_id)
          .eq('status', 'pending');
        if (refUpdateErr) {
          criticalErrors.push('referral_conversion_failed');
          logger.withContext({ op: 'process-success.referral-convert', ...safeLogErrorContext(refUpdateErr) }).error('[PROCESS-SUCCESS] Referral conversion update failed');
        }
      }
    } catch (refErr) {
      criticalErrors.push('referral_conversion_threw');
      logger.withContext({ op: 'process-success.referral-convert', ...safeLogErrorContext(refErr) }).error('[PROCESS-SUCCESS] Referral conversion threw');
    }

    // Customer spend: exactly-once via apply_customer_spend_once RPC.
    // Uses order_spend_applications(order_id UNIQUE) as durable marker.
    // CRITICAL: financial accuracy of customer spend tracking.
    try {
      const { data: spendResult, error: spendErr } = await supabase.rpc('apply_customer_spend_once', {
        p_order_id: orderId,
        p_payment_id: payment.id,
        p_amount: payment.amount,
      });
      if (spendErr) {
        criticalErrors.push('customer_spend_failed');
        logger.withContext({ op: 'process-success.customer-spend', ...safeLogErrorContext(spendErr) }).error('[PROCESS-SUCCESS] Customer spend RPC error');
      }
    } catch (spendThrow) {
      criticalErrors.push('customer_spend_threw');
      logger.withContext({ op: 'process-success.customer-spend', ...safeLogErrorContext(spendThrow) }).error('[PROCESS-SUCCESS] Customer spend threw');
    }

    // ACC-008: Fire payment_received automation from canonical Stage 2.
    // This is the single authority — fires identically for webhook and "I've Paid".
    // Non-critical: automation failure should not block payment finalization.
    try {
      const { data: orderForAutomation } = await supabase
        .from('orders').select('business_id, delivery_phone, reference_code, total_amount').eq('id', orderId).single();
      if (orderForAutomation?.business_id) {
        const { evaluateRules } = await import('@/lib/bot/automation/rules-engine');
        const noopSend = async () => {}; // No sender context in webhook path
        await evaluateRules(supabase, orderForAutomation.business_id, 'payment_received', {
          customer_phone: orderForAutomation.delivery_phone,
          reference_code: orderForAutomation.reference_code,
          reference_id: orderId,
          total_amount: orderForAutomation.total_amount || 0,
          service_type: 'order',
        }, noopSend);
      }
    } catch (autoErr) {
      logger.withContext({ op: 'process-success.payment-received-automation', ...safeLogErrorContext(autoErr) })
        .error('[PROCESS-SUCCESS] payment_received automation error (non-critical)');
    }
  }

  // 5. Confirm reservation
  if (payment.reservation_id) {
    try {
      const { error: resErr } = await supabase
        .from('reservations')
        .update({
          deposit_status: 'paid',
          status: 'confirmed',
          confirmed_at: new Date().toISOString(),
        })
        .eq('id', payment.reservation_id)
        .in('status', ['pending']);

      if (resErr) {
        criticalErrors.push('reservation_confirmation_failed');
        logger.withContext({ op: 'process-success.reservation', ...safeLogErrorContext(resErr) }).error('[PROCESS-SUCCESS] Reservation confirmation DB error');
      }

      try {
        await recordPlatformFee(supabase, {
          reservationId: payment.reservation_id,
          paymentId: payment.id,
          paymentAmount: payment.amount,
          gatewayFee: payment.gateway_fee,
        });
      } catch (feeErr) {
        criticalErrors.push('reservation_platform_fee_failed');
        logger.withContext({ op: 'platform-fee.reservation', ...safeLogErrorContext(feeErr) }).error('[PLATFORM-FEE] Failed to record fee for reservation');
      }
    } catch (err) {
      criticalErrors.push('reservation_finalization_threw');
      logger.withContext({ op: 'process-success.reservation-confirmation', ...safeLogErrorContext(err) }).error('[PROCESS-SUCCESS] Reservation confirmation error');
      Sentry.captureException(err, { tags: { component: 'process-success', operation: 'reservation-confirmation' } });
    }

    // CRITICAL: Exactly-once customer spend for reservation (same RPC, derives source from payment)
    try {
      const { data: spendResult, error: spendErr } = await supabase.rpc('apply_payment_spend_once', {
        p_payment_id: payment.id,
      });
      if (spendErr) {
        criticalErrors.push('reservation_spend_failed');
        logger.withContext({ op: 'process-success.reservation-spend', ...safeLogErrorContext(spendErr) }).error('[PROCESS-SUCCESS] Reservation spend RPC error');
      } else if (spendResult && !spendResult.applied) {
        const reason = spendResult.reason || 'unknown';
        if (reason !== 'no_supported_source') {
          criticalErrors.push(`reservation_spend_semantic_failure:${reason}`);
          logger.error('[PROCESS-SUCCESS] Reservation spend semantic failure:', reason);
        }
      }
    } catch (spendThrow) {
      criticalErrors.push('reservation_spend_threw');
      logger.withContext({ op: 'process-success.reservation-spend', ...safeLogErrorContext(spendThrow) }).error('[PROCESS-SUCCESS] Reservation spend threw');
    }
  }

  // Emit structured finalization outcome.
  // NOTE: This function runs AFTER the payment provider has already confirmed success.
  // The payment itself succeeded. A failure here means business finalization failed,
  // NOT that the payment failed. Use distinct event names to avoid confusion.
  try {
    const eventName = criticalErrors.length === 0 ? 'payment.completed' : 'payment.finalization_failed';
    logger.withContext({ op: eventName, paymentId: payment.id }).info(`[EVENT] ${eventName}`);
  } catch { /* instrumentation must never fail payment processing */ }

  return {
    criticalSuccess: criticalErrors.length === 0,
    errors: criticalErrors.length > 0 ? criticalErrors : undefined,
  };
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
  // Use actual payment amount as transaction_amount (the money collected by THIS payment)
  const transactionAmount = opts.paymentAmount;

  // Resolve business_id from the entity if not provided
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

  // Insert fee — log but don't throw on duplicate (webhook + "I've Paid" race)
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
    const isDuplicate = feeErr.message?.includes('duplicate') || feeErr.message?.includes('unique');
    logger.withContext({ op: 'platform-fee.insert', ...(typeof feeErr?.code === 'string' && isSafeIdentifier(feeErr.code) ? { errorCode: feeErr.code } : {}) }).error('[PLATFORM-FEE] Insert error (possible duplicate)');
    if (!isDuplicate) {
      Sentry.captureException(new Error(`Platform fee insert error: ${feeErr.message}`), {
        tags: { component: 'process-success', operation: 'platform-fee' },
        extra: { businessId, bookingId: opts.bookingId, invoiceId: opts.invoiceId },
      });
      // Throw on non-duplicate errors so callers can track critical failure
      throw new Error(`Platform fee insert failed: ${feeErr.message}`);
    }
    // Duplicate is idempotent success — do not throw
  }
}

/**
 * Process invoice payment with payment-level idempotency.
 * Uses apply_invoice_payment RPC which atomically:
 *   - Records the application in invoice_payment_applications (idempotent via UNIQUE)
 *   - Updates amount_paid from the authoritative ledger (SUM of all applications)
 *   - Serializes concurrent access via SELECT FOR UPDATE on the invoice row
 *
 * Same payment replayed → no second increment.
 * Different partial payments → both apply correctly.
 */
export async function processInvoicePayment(
  supabase: SupabaseClient,
  invoiceId: string,
  paymentId: string,
  paymentAmount: number,
  gatewayFee?: number,
): Promise<void> {
  // RPC loads and validates payment + invoice from DB internally
  const { data: result, error: rpcError } = await supabase.rpc('apply_invoice_payment', {
    p_invoice_id: invoiceId,
    p_payment_id: paymentId,
  });

  if (rpcError) {
    logger.error('[INVOICE-PAYMENT] RPC error:', rpcError.message);
    Sentry.captureException(new Error(`apply_invoice_payment RPC error: ${rpcError.message}`), {
      tags: { component: 'process-success', operation: 'invoice-payment' },
      extra: { invoiceId, paymentId },
    });
    throw new Error(`apply_invoice_payment RPC failed: ${rpcError.message}`);
  }

  // Fee retry logic:
  // - New payment (applied or already_applied + not legacy): attempt fee.
  //   payment_id UNIQUE prevents duplicates on retry.
  // - Legacy marker replay: do NOT create fee (legacy fees already exist with NULL payment_id).
  const shouldEnsureFee = result && !result.reason && !result.is_legacy;
  if (shouldEnsureFee) {
    // Use ONLY DB-authoritative amount from RPC — never caller-supplied
    const authoritativeAmount = result.amount ? Number(result.amount) : null;
    if (authoritativeAmount && authoritativeAmount > 0) {
      await recordPlatformFee(supabase, {
        invoiceId,
        paymentId,
        paymentAmount: authoritativeAmount,
        gatewayFee,
      });
    } else {
      logger.error('[INVOICE-PAYMENT] RPC returned fee-eligible result without valid amount', { invoiceId, paymentId, result });
      Sentry.captureException(new Error('Invoice RPC fee-eligible but missing authoritative amount'), {
        tags: { component: 'process-success', operation: 'invoice-fee' },
        extra: { invoiceId, paymentId },
      });
    }
  }
}

/**
 * Process campaign donation with payment-level idempotency.
 * Uses apply_campaign_donation RPC which atomically:
 *   - Transitions donation from pending → success (idempotency gate)
 *   - Increments raised_amount and donor_count only if transition occurred
 *
 * Same payment replayed → no second increment.
 * Different donations → each counts independently.
 */
export async function processCampaignDonation(
  supabase: SupabaseClient,
  paymentId: string,
  campaignId: string,
  amount: number,
  gatewayFee?: number,
): Promise<void> {
  const { data: result, error: rpcError } = await supabase.rpc('apply_campaign_donation', {
    p_campaign_id: campaignId,
    p_payment_id: paymentId,
  });

  if (rpcError) {
    logger.error('[CAMPAIGN-DONATION] RPC error:', rpcError.message);
    Sentry.captureException(new Error(`apply_campaign_donation RPC error: ${rpcError.message}`), {
      tags: { component: 'process-success', operation: 'campaign-donation' },
      extra: { campaignId, paymentId, amount },
    });
    throw new Error(`apply_campaign_donation RPC failed: ${rpcError.message}`);
  }

  // Fee retry logic: same as invoice — skip legacy, ensure for new/post-migration
  const shouldEnsureFee = result && !result.reason && !result.is_legacy;
  if (shouldEnsureFee) {
    // Use ONLY DB-authoritative amount from RPC — never caller-supplied
    const authoritativeAmount = result.amount ? Number(result.amount) : null;
    if (authoritativeAmount && authoritativeAmount > 0) {
      const { data: campaign } = await supabase
        .from('campaigns')
        .select('business_id')
        .eq('id', campaignId)
        .single();

      if (campaign?.business_id) {
        await recordPlatformFee(supabase, {
          campaignId,
          paymentId,
          businessId: campaign.business_id,
          paymentAmount: authoritativeAmount,
          gatewayFee,
        });
      }
    } else {
      logger.error('[CAMPAIGN-DONATION] RPC returned fee-eligible result without valid amount', { campaignId, paymentId, result });
      Sentry.captureException(new Error('Campaign RPC fee-eligible but missing authoritative amount'), {
        tags: { component: 'process-success', operation: 'campaign-fee' },
        extra: { campaignId, paymentId },
      });
    }
  }
}
