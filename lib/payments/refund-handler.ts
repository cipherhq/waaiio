import type { SupabaseClient } from '@supabase/supabase-js';
import { getPaymentGatewayByName } from './factory';
import type { PaymentGatewayName } from '@/lib/constants';
import { logger } from '@/lib/logger';

interface ProcessRefundOpts {
  supabase: SupabaseClient;
  paymentId: string;
  businessId: string;
  amount: number;
  reason?: string;
  initiatedBy: string;
  initiatedByRole: 'business' | 'admin';
  /** Immutable logical refund-request ID from the initiating route. Used as the provider
   *  idempotency key. Must be stable across retries of the same logical request.
   *  Created once by the caller (API route), persisted/recoverable, reused on retry. */
  logicalRefundId: string;
}

interface ProcessRefundResult {
  success: boolean;
  refundId?: string;
  isDirectSplit?: boolean;
  errorMessage?: string;
  providerStatus?: string; // Square: PENDING, COMPLETED, FAILED, REJECTED
  idempotencyKey?: string;
}

export async function processRefund(opts: ProcessRefundOpts): Promise<ProcessRefundResult> {
  const { supabase, paymentId, businessId, amount, reason, initiatedBy, initiatedByRole } = opts;

  // 1. Load payment record
  const { data: payment, error: paymentErr } = await supabase
    .from('payments')
    .select('id, amount, currency, refund_amount, status, gateway, gateway_reference, booking_id, invoice_id, campaign_id, order_id, reservation_id, business_id, metadata, payout_account_id, collection_mode, waaiio_fee')
    .eq('id', paymentId)
    .single();

  if (paymentErr || !payment) {
    return { success: false, errorMessage: 'Payment not found' };
  }

  if (payment.status !== 'success' && payment.status !== 'refunded') {
    return { success: false, errorMessage: `Payment status "${payment.status}" is not refundable` };
  }

  if (payment.business_id && payment.business_id !== businessId) {
    return { success: false, errorMessage: 'Business ID does not match the payment record' };
  }

  if (amount <= 0) {
    return { success: false, errorMessage: 'Refund amount must be greater than 0' };
  }

  const { data: business } = await supabase
    .from('businesses')
    .select('payout_mode')
    .eq('id', businessId)
    .single();

  const isDirectSplit = business?.payout_mode === 'direct_split';
  const gatewayName = (payment.gateway || 'paystack') as PaymentGatewayName;
  const metadata = payment.metadata as Record<string, unknown> | null;
  const isSquare = gatewayName === 'square';

  // ── Square Connect path: atomic reservation → provider call → async finalization ──
  if (isSquare) {
    // Use the logical refund ID as the stable provider idempotency key.
    // Callers MUST provide this — it must be the same across retries.
    const providerIdempotencyKey = opts.logicalRefundId;

    // Square has a 45-character max for idempotency keys
    if (providerIdempotencyKey.length > 45) {
      return { success: false, errorMessage: 'Refund idempotency key exceeds 45 characters', idempotencyKey: providerIdempotencyKey };
    }

    const { data: claimResult, error: claimErr } = await supabase.rpc('claim_refund_balance', {
      p_payment_id: paymentId,
      p_refund_amount: amount,
      p_idempotency_key: providerIdempotencyKey,
      p_currency: (payment.currency as string) || 'USD',
      p_waaiio_fee_total: Number(payment.waaiio_fee) || 0,
    });

    if (claimErr) {
      return { success: false, errorMessage: `Refund reservation failed: ${claimErr.message}`, idempotencyKey: providerIdempotencyKey };
    }
    if (!claimResult?.claimed) {
      return { success: false, errorMessage: claimResult?.reason || 'Refund reservation rejected', idempotencyKey: providerIdempotencyKey };
    }

    const refundId = claimResult.refund_id as string;

    // If this is an existing claim (retry), return actual stored lifecycle state
    if (claimResult.existing) {
      const existingFee = claimResult.planned_fee_reversal as number || 0;
      // Look up the actual refund status
      const { data: existingRefund } = await supabase.from('refunds')
        .select('status, gateway_refund_reference').eq('id', refundId).single();
      const storedStatus = existingRefund?.status || 'pending';
      // If provider call never occurred (pending) or needs retry (review_required), resume below.
      // Otherwise return stored state.
      if (storedStatus !== 'pending' && storedStatus !== 'review_required') {
        return {
          success: storedStatus === 'success' || storedStatus === 'processing',
          refundId,
          isDirectSplit: true,
          providerStatus: storedStatus,
          idempotencyKey: providerIdempotencyKey,
        };
      }
      // Pending/review_required: fall through to make the provider call
      // Use stored fee for the retry
      if (existingFee > 0) {
        // Override the planned fee reversal with the stored value from the claim
        // This is used below when calling Square
      }
    }

    // Resolve seller token (fail closed)
    let sellerToken: string | undefined;
    if (payment.payout_account_id) {
      const { resolveSquareToken } = await import('@/lib/payments/square-token');
      const resolved = await resolveSquareToken(supabase, payment.payout_account_id);
      if (!resolved) {
        // Token failure: mark refund as review_required (not failed — retryable later)
        await supabase.from('refunds').update({ status: 'review_required' }).eq('id', refundId);
        return { success: false, refundId, errorMessage: 'Square seller token unresolvable', providerStatus: 'review_required', idempotencyKey: providerIdempotencyKey };
      }
      sellerToken = resolved.accessToken;
    }

    // Read planned_fee_reversal from the claim result for app fee refunding
    // For existing claims (retry), the stored fee is returned by the RPC
    const plannedFeeReversal = claimResult.planned_fee_reversal as number | undefined;

    // Call Square Refunds API
    const gateway = getPaymentGatewayByName('square');
    const result = await gateway.refundPayment({
      gatewayReference: payment.gateway_reference,
      amount,
      currency: (payment.currency as string) || 'USD',
      reason,
      metadata: metadata || undefined,
      byoSecretKey: sellerToken,
      providerIdempotencyKey,
      appFeeRefundAmount: (plannedFeeReversal && plannedFeeReversal > 0) ? plannedFeeReversal : undefined,
    });

    if (!result.success) {
      // Provider failure: mark review_required (retryable — reservation stays)
      await supabase.from('refunds').update({
        status: 'review_required',
        gateway_response: result.gatewayResponse || { error: result.errorMessage },
      }).eq('id', refundId);
      return { success: false, refundId, isDirectSplit: true, errorMessage: result.errorMessage, providerStatus: 'review_required', idempotencyKey: providerIdempotencyKey };
    }

    // Square returned a response — check the provider's status
    const squareRefund = result.gatewayResponse?.refund as Record<string, unknown> | undefined;
    const squareRefundId = result.gatewayRefundReference || (squareRefund?.id as string);
    const squareStatus = (squareRefund?.status as string) || 'PENDING';

    // Store Square refund ID immediately (needed for webhook matching)
    if (squareRefundId) {
      const { error: refUpdateErr } = await supabase.from('refunds').update({
        gateway_refund_reference: squareRefundId,
        gateway_response: result.gatewayResponse || null,
        status: squareStatus === 'PENDING' ? 'processing' : 'pending', // keep pending until finalized
      }).eq('id', refundId);
      if (refUpdateErr) {
        logger.error('[REFUND] Failed to persist Square refund ID:', refUpdateErr.message);
        return { success: false, refundId, errorMessage: 'Failed to persist refund reference', providerStatus: squareStatus, idempotencyKey: providerIdempotencyKey };
      }
    }

    // Extract actual app fee from Square response and persist it
    const actualAppFee = (squareRefund?.app_fee_money as { amount?: number } | undefined)?.amount;
    if (actualAppFee != null) {
      const actualFeeReversal = actualAppFee / 100;
      await supabase.from('refunds').update({
        planned_fee_reversal: actualFeeReversal,
      }).eq('id', refundId);
    }

    // Map Square status to finalization
    if (squareStatus === 'COMPLETED' || squareStatus === 'FAILED' || squareStatus === 'REJECTED') {
      const finalStatus = squareStatus === 'COMPLETED' ? 'success' : 'failed';
      const { data: finalResult, error: finalErr } = await supabase.rpc('finalize_square_refund', {
        p_refund_id: refundId,
        p_square_refund_id: squareRefundId,
        p_final_status: finalStatus,
        p_refund_reason: reason || null,
        p_initiated_by: initiatedBy,
      });
      if (finalErr) {
        logger.error('[REFUND] Finalization RPC error:', finalErr.message);
        return { success: false, refundId, errorMessage: 'Finalization failed', providerStatus: squareStatus, idempotencyKey: providerIdempotencyKey };
      }
      if (!finalResult?.success) {
        const finalReason = finalResult?.reason || 'unknown';
        if (finalReason !== 'already_finalized') {
          return { success: false, refundId, errorMessage: `Finalization rejected: ${finalReason}`, providerStatus: squareStatus, idempotencyKey: providerIdempotencyKey };
        }
      }
    }
    // PENDING: stays processing until webhook finalizes via same RPC

    return {
      success: squareStatus !== 'FAILED' && squareStatus !== 'REJECTED',
      refundId,
      isDirectSplit: true,
      providerStatus: squareStatus,
      idempotencyKey: providerIdempotencyKey,
    };
  }

  // ── Non-Square path (existing behavior) ──
  // Idempotency guard
  const { data: pendingRefund } = await supabase
    .from('refunds')
    .select('id')
    .eq('payment_id', paymentId)
    .eq('status', 'pending')
    .limit(1)
    .maybeSingle();

  if (pendingRefund) {
    return { success: false, errorMessage: 'A refund for this payment is already being processed' };
  }

  const existingRefund = Number(payment.refund_amount || 0);
  const paymentAmount = Number(payment.amount);
  const remaining = paymentAmount - existingRefund;

  if (amount > remaining) {
    return { success: false, errorMessage: `Refund amount (${amount}) exceeds remaining (${remaining})` };
  }

  const refundType = amount >= remaining ? 'full' : 'partial';

  const { data: refundRecord, error: insertErr } = await supabase
    .from('refunds')
    .insert({
      payment_id: paymentId,
      business_id: businessId,
      amount,
      reason: reason || null,
      status: 'pending',
      gateway: payment.gateway,
      refund_type: refundType,
      is_direct_split: isDirectSplit,
      initiated_by: initiatedBy,
      initiated_by_role: initiatedByRole,
    })
    .select('id')
    .single();

  if (insertErr || !refundRecord) {
    return { success: false, errorMessage: 'Failed to create refund record' };
  }

  if (isDirectSplit) {
    // Non-Square direct split: record-only
    await supabase.from('refunds').update({ status: 'success' }).eq('id', refundRecord.id);
  } else {
    // Platform managed: call gateway refund API
    const gateway = getPaymentGatewayByName(gatewayName);
    let byoKey = (metadata?.byo_secret_key as string) || undefined;

    const refundAmount = refundType === 'full' && existingRefund === 0 ? undefined : amount;

    const result = await gateway.refundPayment({
      gatewayReference: payment.gateway_reference,
      amount: refundAmount,
      currency: (payment.currency as string) || 'NGN',
      reason,
      metadata: metadata || undefined,
      connectAccountId: (metadata?.connect_account_id as string) || undefined,
      byoSecretKey: byoKey,
      providerIdempotencyKey: refundRecord.id,
    });

    if (result.success) {
      await supabase.from('refunds').update({
        status: 'success',
        gateway_refund_reference: result.gatewayRefundReference || null,
        gateway_response: result.gatewayResponse || null,
      }).eq('id', refundRecord.id);
    } else {
      await supabase.from('refunds').update({
        status: 'failed',
        gateway_response: result.gatewayResponse || { error: result.errorMessage },
      }).eq('id', refundRecord.id);
      return { success: false, refundId: refundRecord.id, isDirectSplit, errorMessage: result.errorMessage };
    }
  }

  // Finalize payment/ledger for non-Square (synchronous completion)
  await finalizeRefundLocally(supabase, payment, refundRecord.id, amount, reason || null, initiatedBy);

  return { success: true, refundId: refundRecord.id, isDirectSplit };
}

/**
 * Finalize refund effects on payment, booking, fees, and payout adjustments.
 * Called synchronously for non-Square or when Square returns COMPLETED immediately.
 * For Square PENDING, this is called later by the webhook via finalize_square_refund RPC.
 */
async function finalizeRefundLocally(
  supabase: SupabaseClient,
  payment: Record<string, unknown>,
  refundId: string,
  amount: number,
  reason: string | null,
  initiatedBy: string,
): Promise<void> {
  const existingRefund = Number(payment.refund_amount || 0);
  const paymentAmount = Number(payment.amount);
  const newRefundAmount = existingRefund + amount;
  const isFullyRefunded = newRefundAmount >= paymentAmount;

  await supabase.from('payments').update({
    refund_amount: newRefundAmount,
    refund_reason: reason || null,
    refunded_at: new Date().toISOString(),
    refunded_by: initiatedBy,
    ...(isFullyRefunded && { status: 'refunded' }),
  }).eq('id', payment.id as string);

  if (isFullyRefunded && payment.booking_id) {
    await supabase.from('bookings')
      .update({ deposit_status: 'refunded' })
      .eq('id', payment.booking_id as string);
  }

  if (isFullyRefunded && payment.reservation_id) {
    await supabase.from('reservations')
      .update({ deposit_status: 'refunded' })
      .eq('id', payment.reservation_id as string);
  }

  // Reverse platform fee
  const feeEntityCol = payment.booking_id ? 'booking_id' : payment.invoice_id ? 'invoice_id'
    : payment.campaign_id ? 'campaign_id' : payment.order_id ? 'order_id'
    : payment.reservation_id ? 'reservation_id' : null;
  const feeEntityVal = (payment.booking_id || payment.invoice_id || payment.campaign_id
    || payment.order_id || payment.reservation_id) as string | null;

  if (feeEntityCol && feeEntityVal) {
    if (isFullyRefunded) {
      await supabase.from('platform_fees')
        .update({ refunded_at: new Date().toISOString() })
        .eq(feeEntityCol, feeEntityVal)
        .is('refunded_at', null);
    } else {
      const { data: fee } = await supabase.from('platform_fees')
        .select('id, fee_total, transaction_amount')
        .eq(feeEntityCol, feeEntityVal)
        .is('refunded_at', null)
        .maybeSingle();
      if (fee && fee.transaction_amount > 0) {
        const feeReduction = Math.round(fee.fee_total * (amount / fee.transaction_amount) * 100) / 100;
        await supabase.from('platform_fees')
          .update({ fee_total: Math.max(0, fee.fee_total - feeReduction) })
          .eq('id', fee.id);
      }
    }
  }

  // Payout adjustment
  try {
    const { data: payment2 } = await supabase.from('payments')
      .select('created_at').eq('id', payment.id as string).single();
    if (payment2) {
      const { data: paidPayout } = await supabase.from('business_payouts')
        .select('id').eq('business_id', payment.business_id as string)
        .eq('status', 'paid').gte('period_end', payment2.created_at).maybeSingle();
      if (paidPayout) {
        await supabase.from('payout_adjustments').insert({
          business_id: payment.business_id,
          payout_id: paidPayout.id,
          amount: -amount,
          reason: `Refund for payment ${payment.gateway_reference}`,
          payment_id: payment.id,
        });
      }
    }
  } catch (adjError) {
    logger.error('[REFUND] Payout adjustment error (non-blocking):', adjError);
  }
}
