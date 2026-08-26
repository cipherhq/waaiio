/**
 * Stale "I've Paid" recovery for ordering flow (#197).
 *
 * Handles the case where a customer taps a stale "I've Paid" button
 * after their payment-waiting session has been deactivated by Stage 3.
 *
 * Recovery is ORDER-CENTRIC: resolve the order first, then inspect
 * all payment attempts for that order. Never "newest payment row wins."
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

export type StaleRecoveryOutcome =
  | { type: 'confirmed'; referenceCode: string; amount: number; countryCode: CountryCode; message: string }
  | { type: 'reconciling'; referenceCode: string; message: string }
  | { type: 'not_found'; message: string }
  | { type: 'disambiguation'; orders: Array<{ referenceCode: string; amount: number }>; message: string }
  | { type: 'integrity_error'; message: string }
  | { type: 'error'; message: string };

interface RecoveryContext {
  supabase: SupabaseClient;
  businessId: string;
  userId: string | null;
  phone: string; // normalized, no +
  countryCode: CountryCode;
}

/**
 * Recover a stale "I've Paid" interaction for an exact order reference.
 * i_paid:<order-reference> — locator only, not authentication.
 * Full tenant + identity authorization required.
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
 * Recover a generic stale "I've Paid" interaction.
 * Finds eligible orders for this user/business, deduplicates by order.
 */
export async function recoverGeneric(
  ctx: RecoveryContext,
): Promise<StaleRecoveryOutcome> {
  const { supabase, businessId, userId, phone } = ctx;
  const logPrefix = '[STALE-RECOVERY generic]';

  const phonePlus = phone.startsWith('+') ? phone : `+${phone}`;
  const phoneNoPlus = phone.startsWith('+') ? phone.slice(1) : phone;

  // Find eligible orders with recent ordering payments
  const { data: candidates, error: candidateErr } = await supabase
    .from('orders')
    .select('id, reference_code, status, user_id, delivery_phone, total_amount, business_id')
    .eq('business_id', businessId)
    .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
    .order('created_at', { ascending: false })
    .limit(10);

  if (candidateErr) {
    logger.withContext({ op: 'stale-recovery.candidates', ...safeLogErrorContext(candidateErr) })
      .error(`${logPrefix} Candidate lookup failed`);
    return { type: 'error', message: 'Something went wrong. Please try again.' };
  }

  if (!candidates || candidates.length === 0) {
    return { type: 'not_found', message: 'No recent payment found for this business. Type *order* to start a new order.' };
  }

  // Filter by identity and verify they have payments
  const eligible: Array<{ orderId: string; referenceCode: string; amount: number }> = [];
  const seen = new Set<string>();

  for (const order of candidates) {
    if (seen.has(order.reference_code)) continue;

    const auth = authorizeIdentity(order, userId, phone);
    if (!auth.authorized) continue;

    // Check if this order has any recent eligible payments
    const { data: payments } = await supabase
      .from('payments')
      .select('id, status')
      .eq('order_id', order.id)
      .eq('business_id', businessId)
      .in('status', ['success', 'pending'])
      .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
      .limit(1);

    if (payments && payments.length > 0) {
      seen.add(order.reference_code);
      eligible.push({
        orderId: order.id,
        referenceCode: order.reference_code,
        amount: order.total_amount || 0,
      });
    }
  }

  if (eligible.length === 0) {
    return { type: 'not_found', message: 'No recent payment found for this business. Type *order* to start a new order.' };
  }

  if (eligible.length === 1) {
    return inspectOrderPayments(ctx, eligible[0].orderId, eligible[0].referenceCode);
  }

  // Multiple eligible orders — disambiguation required
  return {
    type: 'disambiguation',
    orders: eligible.slice(0, 3).map(e => ({ referenceCode: e.referenceCode, amount: e.amount })),
    message: 'You have multiple recent orders. Which one did you pay for?',
  };
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

  // Cross-check payment identity
  for (const p of payments) {
    if (p.user_id && userId && p.user_id !== userId) {
      logger.error(`${logPrefix} Payment ${p.id} user_id mismatch: payment=${p.user_id} session=${userId}`);
      return { type: 'integrity_error', message: 'Something went wrong. Please type *my orders* or contact support.' };
    }
  }

  const successful = payments.filter(p => p.status === 'success');
  const pending = payments.filter(p => p.status === 'pending');

  // Case 1: At least one successful payment
  if (successful.length > 0) {
    if (successful.length > 1) {
      // Integrity anomaly: multiple successful payments for same order
      logger.error(`${logPrefix} INTEGRITY: ${successful.length} successful payments for order ${orderId}`, {
        paymentIds: successful.map(p => p.id),
        alert: 'duplicate_success',
      });
      // No new financial mutation — report durable truth
    }

    const payment = successful[0];
    const amount = payment.amount || 0;

    // #197: Durable-truth reply only — do NOT consume delivery attempt budget.
    // The BotService interceptor sends the confirmation text directly.
    // If a bounded delivery retry is needed, the caller must execute the
    // full claim→begin→send→complete/fail/indeterminate lifecycle.

    return {
      type: 'confirmed',
      referenceCode,
      amount,
      countryCode,
      message: `✅ *Payment Confirmed!*\n\nYour order *${referenceCode}* for ${formatCurrency(amount, countryCode)} is confirmed.\n\n💡 Type *my orders* to track, *receipt* for your receipt, or *Hi* to order again.`,
    };
  }

  // Case 2: No success, exactly one pending
  if (pending.length === 1) {
    const { reconcilePayment } = await import('./reconcile');
    const result = await reconcilePayment(supabase, pending[0].id, 'ive_paid');

    const lifecycle = result.lifecycle;
    const isComplete = lifecycle?.status === 'completed' || lifecycle?.status === 'already_completed' || lifecycle?.status === 'not_deliverable';

    if (result.providerOutcome === 'verified' && isComplete) {
      const amount = pending[0].amount || 0;
      return {
        type: 'confirmed',
        referenceCode,
        amount,
        countryCode,
        message: `✅ *Payment Confirmed!*\n\nOrder *${referenceCode}* for ${formatCurrency(amount, countryCode)} is being processed.\n\n💡 Type *my orders* to track, *receipt* for your receipt, or *Hi* to order again.`,
      };
    }

    if (result.providerOutcome === 'verified') {
      return {
        type: 'reconciling',
        referenceCode,
        message: '✅ Payment received! Your order is being processed.\n\nYou\'ll get a confirmation shortly. If not, tap *I\'ve Paid* again.',
      };
    }

    if (result.providerOutcome === 'not_paid') {
      return {
        type: 'not_found',
        message: `Payment for order *${referenceCode}* has not been received yet.\n\nIf you haven't paid, type *order* to get a new payment link.`,
      };
    }

    // Provider error or config error — don't claim unpaid
    return {
      type: 'error',
      message: 'We\'re having trouble verifying your payment. Please try again in a moment.',
    };
  }

  // Case 3: No success, multiple pending — fail closed
  if (pending.length > 1) {
    logger.warn(`${logPrefix} Multiple pending payments (${pending.length}) for order ${orderId} — failing closed`);
    return {
      type: 'error',
      message: `Multiple payment attempts found for order *${referenceCode}*. Please contact support or type *my orders* to check your order status.`,
    };
  }

  // Case 4: No eligible payments
  return {
    type: 'not_found',
    message: `No recent payment found for order *${referenceCode}*. Type *order* to start a new order.`,
  };
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
    // Durable user identity exists on order — it governs
    if (!sessionUserId) {
      return { authorized: false, reason: 'order_has_user_id_but_session_does_not' };
    }
    if (order.user_id !== sessionUserId) {
      return { authorized: false, reason: 'user_id_mismatch' };
    }
    return { authorized: true };
  }

  // Legacy: no durable user identity on order — phone fallback allowed
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
