/**
 * Stale "I've Paid" recovery (#197/#219).
 *
 * Handles the case where a customer taps a stale "I've Paid" button
 * after their payment-waiting session has been deactivated by Stage 3.
 *
 * #219: Recovery is PAYMENT-FIRST. Generic recovery queries payments directly
 * and resolves purpose from entity FKs. Never "newest payment wins."
 *
 * Legacy order-reference recovery (recoverByOrderReference) is retained for
 * backwards compatibility with already-issued i_paid:<order-ref> buttons.
 *
 * Payment Authority remains the sole financial writer.
 * This module NEVER calls sendProactiveConfirmation or replays
 * post-completion/loyalty/fee/ticket/owner effects.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '@/lib/logger';
import { formatCurrency, type CountryCode } from '@/lib/constants';
import { stripPlus } from '@/lib/utils/phone';
import { safeLogErrorContext } from '@/lib/errors';
import { sanitizeFilterValue } from '@/lib/utils/sanitize';

/** #219: Payment purpose resolved from entity FKs */
type PaymentPurpose = 'order' | 'payment' | 'appointment' | 'ticket' | 'reservation' | 'invoice' | 'donation' | 'unknown';

export type StaleRecoveryOutcome =
  | { type: 'confirmed'; referenceCode: string; amount: number; countryCode: CountryCode; message: string }
  | { type: 'reconciling'; referenceCode: string; message: string }
  | { type: 'not_found'; message: string }
  | { type: 'disambiguation'; candidates: Array<{ gatewayReference: string; referenceCode: string; amount: number; purpose: PaymentPurpose }>; message: string }
  | { type: 'integrity_error'; message: string }
  | { type: 'error'; message: string };

interface RecoveryContext {
  supabase: SupabaseClient;
  businessId: string;
  userId: string | null;
  phone: string; // normalized, no +
  countryCode: CountryCode;
}

// ── Purpose-appropriate copy helpers ──

function purposeLabel(purpose: PaymentPurpose): string {
  switch (purpose) {
    case 'order': return 'order';
    case 'payment': return 'payment';
    case 'appointment': return 'appointment';
    case 'ticket': return 'ticket purchase';
    case 'reservation': return 'reservation';
    case 'invoice': return 'invoice payment';
    case 'donation': return 'donation';
    default: return 'payment';
  }
}

function purposeTips(purpose: PaymentPurpose): string {
  switch (purpose) {
    case 'order': return '💡 Type *my orders* to track, *receipt* for your receipt, or *Hi* to order again.';
    case 'payment': return '💡 Type *my bookings* to view your payments, or *receipt* for your receipt.';
    case 'appointment': return '💡 Type *my bookings* to view your appointments, or *receipt* for your receipt.';
    case 'ticket': return '💡 Type *my tickets* to view your tickets, or *receipt* for your receipt.';
    case 'reservation': return '💡 Type *my bookings* to view your reservations, or *receipt* for your receipt.';
    case 'invoice': return '💡 Type *receipt* for your receipt.';
    case 'donation': return '💡 Type *receipt* for your donation receipt.';
    default: return '💡 Type *receipt* for your receipt.';
  }
}

// ── Resolve purpose from payment entity FKs ──

async function resolvePaymentPurpose(
  supabase: SupabaseClient,
  payment: { order_id?: string | null; booking_id?: string | null; invoice_id?: string | null; campaign_id?: string | null; reservation_id?: string | null },
): Promise<{ purpose: PaymentPurpose; referenceCode: string; phone: string | null }> {
  if (payment.order_id) {
    const { data: order } = await supabase.from('orders').select('reference_code, delivery_phone').eq('id', payment.order_id).maybeSingle();
    return { purpose: 'order', referenceCode: order?.reference_code || '', phone: order?.delivery_phone || null };
  }
  if (payment.booking_id) {
    const { data: booking } = await supabase.from('bookings').select('reference_code, flow_type, guest_phone').eq('id', payment.booking_id).maybeSingle();
    const ft = booking?.flow_type || '';
    const purpose: PaymentPurpose = ft === 'ticketing' ? 'ticket' : ft === 'scheduling' || ft === 'appointment' ? 'appointment' : 'payment';
    return { purpose, referenceCode: booking?.reference_code || '', phone: booking?.guest_phone || null };
  }
  if (payment.reservation_id) {
    const { data: res } = await supabase.from('reservations').select('reference_code, guest_phone').eq('id', payment.reservation_id).maybeSingle();
    return { purpose: 'reservation', referenceCode: res?.reference_code || '', phone: res?.guest_phone || null };
  }
  if (payment.invoice_id) {
    const { data: inv } = await supabase.from('invoices').select('reference_code, customer_phone').eq('id', payment.invoice_id).maybeSingle();
    return { purpose: 'invoice', referenceCode: inv?.reference_code || '', phone: inv?.customer_phone || null };
  }
  if (payment.campaign_id) {
    const { data: donation } = await supabase.from('campaign_donations')
      .select('reference_code, donor_phone')
      .eq('payment_id', payment.order_id || '') // fallback — campaign donations link by payment_id
      .maybeSingle();
    return { purpose: 'donation', referenceCode: donation?.reference_code || '', phone: donation?.donor_phone || null };
  }
  return { purpose: 'unknown', referenceCode: '', phone: null };
}

/**
 * #219: Recover a stale "I've Paid" for a specific payment gateway reference.
 * i_paid_ref:<gateway-reference> — locator only, not authorization.
 * Full tenant + identity authorization required.
 * Converges through canonical Payment Authority for pending payments.
 */
export async function recoverByPaymentReference(
  ctx: RecoveryContext,
  gatewayReference: string,
): Promise<StaleRecoveryOutcome> {
  const { supabase, businessId, userId, phone, countryCode } = ctx;
  const logPrefix = '[STALE-RECOVERY payment-ref]';

  const { data: payment, error: payErr } = await supabase
    .from('payments')
    .select('id, status, gateway_reference, user_id, amount, business_id, booking_id, order_id, invoice_id, campaign_id, reservation_id')
    .eq('gateway_reference', gatewayReference)
    .eq('business_id', businessId)
    .maybeSingle();

  if (payErr) {
    logger.withContext({ op: 'stale-recovery.payment-ref-lookup', ...safeLogErrorContext(payErr) })
      .error(`${logPrefix} Payment lookup failed`);
    return { type: 'error', message: 'Something went wrong. Please try again.' };
  }

  if (!payment) {
    return { type: 'not_found', message: 'No payment found. Please contact support if you believe you have paid.' };
  }

  // Identity authorization
  if (payment.user_id) {
    if (!userId || payment.user_id !== userId) {
      logger.warn(`${logPrefix} Identity mismatch for payment ${payment.id}`);
      return { type: 'not_found', message: 'No payment found. Please contact support if you believe you have paid.' };
    }
  } else {
    // No durable identity on payment — try phone match via entity
    const resolved = await resolvePaymentPurpose(supabase, payment);
    if (resolved.phone) {
      const authResult = authorizeByPhone(resolved.phone, phone);
      if (!authResult) {
        logger.warn(`${logPrefix} Phone mismatch for payment ${payment.id}`);
        return { type: 'not_found', message: 'No payment found. Please contact support if you believe you have paid.' };
      }
    }
    // No phone on entity and no user_id — allow (legacy, fail-open for genuinely identity-less)
  }

  // Resolve purpose for copy
  const { purpose, referenceCode } = await resolvePaymentPurpose(supabase, payment);
  const amount = payment.amount || 0;
  const ref = referenceCode || gatewayReference.slice(-8);

  // Branch on payment status
  switch (payment.status) {
    case 'success':
      return {
        type: 'confirmed',
        referenceCode: ref,
        amount,
        countryCode,
        message: `✅ *Payment Confirmed!*\n\nYour ${purposeLabel(purpose)} *${ref}* for ${formatCurrency(amount, countryCode)} is confirmed.\n\n${purposeTips(purpose)}`,
      };

    case 'pending': {
      // Converge through canonical Payment Authority (#168 outcome fidelity)
      const { reconcilePayment } = await import('./reconcile');
      const result = await reconcilePayment(supabase, payment.id, 'ive_paid');
      const lifecycle = result.lifecycle;
      const isComplete = lifecycle?.status === 'completed' || lifecycle?.status === 'already_completed' || lifecycle?.status === 'not_deliverable';

      if (result.providerOutcome === 'verified' && isComplete) {
        return {
          type: 'confirmed',
          referenceCode: ref,
          amount,
          countryCode,
          message: `✅ *Payment Confirmed!*\n\nYour ${purposeLabel(purpose)} *${ref}* for ${formatCurrency(amount, countryCode)} is being processed.\n\n${purposeTips(purpose)}`,
        };
      }
      if (result.providerOutcome === 'verified') {
        return { type: 'reconciling', referenceCode: ref, message: `✅ Payment received! Your ${purposeLabel(purpose)} is being processed.\n\nYou'll get a confirmation shortly.` };
      }
      if (result.providerOutcome === 'not_paid') {
        return { type: 'not_found', message: `Payment for *${ref}* has not been received yet.` };
      }
      // provider_error, config_error, retryable — no fresh-charge encouragement
      return { type: 'error', message: 'We\'re having trouble verifying your payment. Please try again in a moment.' };
    }

    case 'failed':
      return { type: 'not_found', message: `Your ${purposeLabel(purpose)} payment did not succeed. Please try again or contact support.` };

    case 'refunded':
      return { type: 'not_found', message: `Your ${purposeLabel(purpose)} payment for *${ref}* was refunded.` };

    default:
      return { type: 'not_found', message: `No active payment found. Please contact support if you believe you have paid.` };
  }
}

/**
 * #219: Recover a generic stale "I've Paid" interaction (payment-first).
 * Queries payments directly, resolves purpose from entity FKs.
 * Disambiguates across purposes when necessary.
 */
export async function recoverGeneric(
  ctx: RecoveryContext,
): Promise<StaleRecoveryOutcome> {
  const { supabase, businessId, userId, phone, countryCode } = ctx;
  const logPrefix = '[STALE-RECOVERY generic]';

  const phonePlus = phone.startsWith('+') ? phone : `+${phone}`;
  const phoneNoPlus = phone.startsWith('+') ? phone.slice(1) : phone;
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  // Payment-first: query payments directly by business + user identity
  let candidates: Array<{ id: string; gateway_reference: string; status: string; user_id: string | null; amount: number; booking_id: string | null; order_id: string | null; invoice_id: string | null; campaign_id: string | null; reservation_id: string | null }> = [];

  if (userId) {
    const { data, error } = await supabase
      .from('payments')
      .select('id, gateway_reference, status, user_id, amount, booking_id, order_id, invoice_id, campaign_id, reservation_id')
      .eq('business_id', businessId)
      .eq('user_id', userId)
      .in('status', ['success', 'pending'])
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(10);

    if (error) {
      logger.withContext({ op: 'stale-recovery.payment-candidates-user', ...safeLogErrorContext(error) })
        .error(`${logPrefix} Payment candidate lookup failed`);
      return { type: 'error', message: 'Something went wrong. Please try again.' };
    }
    candidates = data || [];
  }

  // Legacy phone fallback: payments with NULL user_id, matched via entity phone
  if (candidates.length === 0) {
    // Query payments without user_id, then filter by entity phone
    const { data: legacyPayments, error: legacyErr } = await supabase
      .from('payments')
      .select('id, gateway_reference, status, user_id, amount, booking_id, order_id, invoice_id, campaign_id, reservation_id')
      .eq('business_id', businessId)
      .is('user_id', null)
      .in('status', ['success', 'pending'])
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(20);

    if (legacyErr) {
      logger.withContext({ op: 'stale-recovery.payment-candidates-phone', ...safeLogErrorContext(legacyErr) })
        .error(`${logPrefix} Legacy payment candidate lookup failed`);
      return { type: 'error', message: 'Something went wrong. Please try again.' };
    }

    // Filter by entity phone match
    for (const p of legacyPayments || []) {
      if (candidates.length >= 10) break;
      const resolved = await resolvePaymentPurpose(supabase, p);
      if (resolved.phone && authorizeByPhone(resolved.phone, phone)) {
        candidates.push(p);
      }
    }
  }

  if (candidates.length === 0) {
    return { type: 'not_found', message: 'No recent payment found for this business.' };
  }

  // Deduplicate by gateway_reference and resolve purpose
  const eligible: Array<{ gatewayReference: string; referenceCode: string; amount: number; purpose: PaymentPurpose; paymentId: string; status: string }> = [];
  const seen = new Set<string>();

  for (const p of candidates) {
    if (seen.has(p.gateway_reference)) continue;
    seen.add(p.gateway_reference);

    const { purpose, referenceCode } = await resolvePaymentPurpose(supabase, p);
    eligible.push({
      gatewayReference: p.gateway_reference,
      referenceCode: referenceCode || p.gateway_reference.slice(-8),
      amount: p.amount || 0,
      purpose,
      paymentId: p.id,
      status: p.status,
    });
  }

  if (eligible.length === 0) {
    return { type: 'not_found', message: 'No recent payment found for this business.' };
  }

  if (eligible.length === 1) {
    // Single candidate — inspect directly
    return recoverByPaymentReference(ctx, eligible[0].gatewayReference);
  }

  // Multiple candidates — disambiguation
  return {
    type: 'disambiguation',
    candidates: eligible.slice(0, 3).map(e => ({
      gatewayReference: e.gatewayReference,
      referenceCode: e.referenceCode,
      amount: e.amount,
      purpose: e.purpose,
    })),
    message: 'You have multiple recent payments. Which one are you checking?',
  };
}

/**
 * Legacy: Recover a stale "I've Paid" interaction for an exact order reference.
 * i_paid:<order-reference> — locator only, not authentication.
 * Full tenant + identity authorization required.
 * Retained for backwards compatibility with already-issued buttons.
 */
export async function recoverByOrderReference(
  ctx: RecoveryContext,
  orderReference: string,
): Promise<StaleRecoveryOutcome> {
  const { supabase, businessId, userId, phone } = ctx;
  const logPrefix = '[STALE-RECOVERY exact-ref]';

  // Step 1: Resolve order with tenant boundary
  const { data: order, error: orderErr } = await supabase
    .from('orders')
    .select('id, reference_code, status, user_id, delivery_phone, business_id')
    .eq('reference_code', orderReference)
    .eq('business_id', businessId)
    .maybeSingle();

  if (orderErr) {
    logger.withContext({ op: 'stale-recovery.order-lookup', ...safeLogErrorContext(orderErr) })
      .error(`${logPrefix} Order lookup failed`);
    return { type: 'error', message: 'Something went wrong. Please try again or type *my orders*.' };
  }

  if (!order) {
    return { type: 'not_found', message: `No order found with reference ${orderReference}. Type *my orders* to see your recent orders.` };
  }

  // Step 2: Identity authorization (order-first)
  const authResult = authorizeIdentity(order, userId, phone);
  if (!authResult.authorized) {
    logger.warn(`${logPrefix} Identity mismatch: ${authResult.reason}`, {
      orderId: order.id, orderUserId: order.user_id, sessionUserId: userId,
    });
    return { type: 'not_found', message: `No order found with reference ${orderReference}. Type *my orders* to see your recent orders.` };
  }

  // Step 3: Inspect all payment attempts for this order
  return inspectOrderPayments(ctx, order.id, order.reference_code);
}

/**
 * Inspect all payment attempts for a single authorized order.
 * Status precedence: success outranks pending. Multiple pending fail closed.
 */
async function inspectOrderPayments(
  ctx: RecoveryContext,
  orderId: string,
  referenceCode: string,
): Promise<StaleRecoveryOutcome> {
  const { supabase, businessId, userId, countryCode } = ctx;
  const logPrefix = '[STALE-RECOVERY inspect]';

  const { data: payments, error: payErr } = await supabase
    .from('payments')
    .select('id, status, gateway_reference, user_id, finalization_completed_at, confirmation_sent_at, paid_at, amount, created_at')
    .eq('order_id', orderId)
    .eq('business_id', businessId)
    .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
    .order('created_at', { ascending: false });

  if (payErr || !payments) {
    logger.withContext({ op: 'stale-recovery.payment-inspect', ...safeLogErrorContext(payErr) })
      .error(`${logPrefix} Payment inspection failed`);
    return { type: 'error', message: 'Something went wrong checking your payment. Please try again.' };
  }

  // Cross-check payment identity — if ANY payment has durable user_id, it governs.
  for (const p of payments) {
    if (p.user_id) {
      if (!userId) {
        logger.error(`${logPrefix} Payment ${p.id} has user_id=${p.user_id} but session has no user_id`);
        return { type: 'integrity_error', message: 'Something went wrong. Please type *my orders* or contact support.' };
      }
      if (p.user_id !== userId) {
        logger.error(`${logPrefix} Payment ${p.id} user_id mismatch: payment=${p.user_id} session=${userId}`);
        return { type: 'integrity_error', message: 'Something went wrong. Please type *my orders* or contact support.' };
      }
    }
  }

  const successful = payments.filter(p => p.status === 'success');
  const pending = payments.filter(p => p.status === 'pending');

  if (successful.length > 0) {
    if (successful.length > 1) {
      logger.error(`${logPrefix} INTEGRITY: ${successful.length} successful payments for order ${orderId}`, {
        paymentIds: successful.map(p => p.id), alert: 'duplicate_success',
      });
    }
    const amount = successful[0].amount || 0;
    return {
      type: 'confirmed',
      referenceCode,
      amount,
      countryCode,
      message: `✅ *Payment Confirmed!*\n\nYour order *${referenceCode}* for ${formatCurrency(amount, countryCode)} is confirmed.\n\n💡 Type *my orders* to track, *receipt* for your receipt, or *Hi* to order again.`,
    };
  }

  if (pending.length === 1) {
    const { reconcilePayment } = await import('./reconcile');
    const result = await reconcilePayment(supabase, pending[0].id, 'ive_paid');
    const lifecycle = result.lifecycle;
    const isComplete = lifecycle?.status === 'completed' || lifecycle?.status === 'already_completed' || lifecycle?.status === 'not_deliverable';

    if (result.providerOutcome === 'verified' && isComplete) {
      const amount = pending[0].amount || 0;
      return {
        type: 'confirmed', referenceCode, amount, countryCode,
        message: `✅ *Payment Confirmed!*\n\nOrder *${referenceCode}* for ${formatCurrency(amount, countryCode)} is being processed.\n\n💡 Type *my orders* to track, *receipt* for your receipt, or *Hi* to order again.`,
      };
    }
    if (result.providerOutcome === 'verified') {
      return { type: 'reconciling', referenceCode, message: '✅ Payment received! Your order is being processed.\n\nYou\'ll get a confirmation shortly. If not, tap *I\'ve Paid* again.' };
    }
    if (result.providerOutcome === 'not_paid') {
      return { type: 'not_found', message: `Payment for order *${referenceCode}* has not been received yet.\n\nIf you haven't paid, type *order* to get a new payment link.` };
    }
    return { type: 'error', message: 'We\'re having trouble verifying your payment. Please try again in a moment.' };
  }

  if (pending.length > 1) {
    logger.warn(`${logPrefix} Multiple pending payments (${pending.length}) for order ${orderId} — failing closed`);
    return { type: 'error', message: `Multiple payment attempts found for order *${referenceCode}*. Please contact support or type *my orders* to check your order status.` };
  }

  return { type: 'not_found', message: `No recent payment found for order *${referenceCode}*. Type *order* to start a new order.` };
}


/**
 * Authorize identity for an order. Order-first: orders.user_id governs
 * even if payments.user_id is NULL. Phone fallback only for genuine
 * legacy missing-user identity.
 */
function authorizeIdentity(
  order: { user_id: string | null; delivery_phone: string | null; business_id: string },
  sessionUserId: string | null,
  sessionPhone: string,
): { authorized: boolean; reason?: string } {
  const phonePlus = sessionPhone.startsWith('+') ? sessionPhone : `+${sessionPhone}`;
  const phoneNoPlus = sessionPhone.startsWith('+') ? sessionPhone.slice(1) : sessionPhone;

  if (order.user_id) {
    if (!sessionUserId) {
      return { authorized: false, reason: 'order_has_user_id_but_session_does_not' };
    }
    if (order.user_id !== sessionUserId) {
      return { authorized: false, reason: 'user_id_mismatch' };
    }
    return { authorized: true };
  }

  if (!order.delivery_phone) {
    return { authorized: false, reason: 'no_identity_on_order' };
  }

  const orderPhone = order.delivery_phone;
  if (orderPhone === phonePlus || orderPhone === phoneNoPlus ||
      stripPlus(orderPhone) === stripPlus(sessionPhone)) {
    return { authorized: true };
  }

  return { authorized: false, reason: 'phone_mismatch' };
}

/** Phone-based authorization helper for non-order entities */
function authorizeByPhone(entityPhone: string, sessionPhone: string): boolean {
  const phonePlus = sessionPhone.startsWith('+') ? sessionPhone : `+${sessionPhone}`;
  const phoneNoPlus = sessionPhone.startsWith('+') ? sessionPhone.slice(1) : sessionPhone;
  return entityPhone === phonePlus || entityPhone === phoneNoPlus ||
    stripPlus(entityPhone) === stripPlus(sessionPhone);
}
