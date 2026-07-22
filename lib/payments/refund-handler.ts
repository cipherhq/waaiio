import type { SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
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

  if (!payment.business_id || payment.business_id !== businessId) {
    return { success: false, errorMessage: 'Business ID does not match the payment record' };
  }

  if (amount <= 0) {
    return { success: false, errorMessage: 'Refund amount must be greater than 0' };
  }

  const gatewayName = (payment.gateway || 'paystack') as PaymentGatewayName;
  const metadata = payment.metadata as Record<string, unknown> | null;
  const isSquare = gatewayName === 'square';
  // isDirectSplit for Square is only true for Connect mode, not platform
  const isSquareConnect = isSquare && payment.collection_mode === 'connect';
  const isConnectPayment = payment.collection_mode === 'connect';

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
      p_business_id: businessId,
      p_reason: reason || null,
      p_initiated_by: initiatedBy,
      p_initiated_by_role: initiatedByRole,
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
          isDirectSplit: isSquareConnect,
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
      // Only send app_fee_money for Connect payments (platform payments don't collect Square app fees)
      appFeeRefundAmount: isConnectPayment && plannedFeeReversal && plannedFeeReversal > 0 ? plannedFeeReversal : undefined,
    });

    if (!result.success) {
      // Provider failure: mark review_required (retryable — reservation stays)
      await supabase.from('refunds').update({
        status: 'review_required',
        gateway_response: result.gatewayResponse || { error: result.errorMessage },
      }).eq('id', refundId);
      return { success: false, refundId, isDirectSplit: isSquareConnect, errorMessage: result.errorMessage, providerStatus: 'review_required', idempotencyKey: providerIdempotencyKey };
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

    // Extract actual app fee from Square response for atomic finalization
    const actualAppFee = (squareRefund?.app_fee_money as { amount?: number } | undefined)?.amount;
    const actualFeeReversal = actualAppFee != null ? actualAppFee / 100 : undefined;

    // Map Square status to finalization
    if (squareStatus === 'COMPLETED' || squareStatus === 'FAILED' || squareStatus === 'REJECTED') {
      const finalStatus = squareStatus === 'COMPLETED' ? 'success' : 'failed';
      const { data: finalResult, error: finalErr } = await supabase.rpc('finalize_square_refund', {
        p_refund_id: refundId,
        p_square_refund_id: squareRefundId,
        p_final_status: finalStatus,
        p_fee_reversed: actualFeeReversal ?? plannedFeeReversal ?? null,
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
    // For PENDING: persist actual fee with error check
    if (squareStatus === 'PENDING' && actualFeeReversal != null) {
      const { error: feeErr } = await supabase.from('refunds').update({
        planned_fee_reversal: actualFeeReversal,
      }).eq('id', refundId);
      if (feeErr) {
        throw new Error(`Failed to persist actual fee reversal: ${feeErr.message}`);
      }
    }

    return {
      success: squareStatus !== 'FAILED' && squareStatus !== 'REJECTED',
      refundId,
      isDirectSplit: isSquareConnect,
      providerStatus: squareStatus,
      idempotencyKey: providerIdempotencyKey,
    };
  }

  // ── Non-Square path: atomic balance reservation via claim_refund_balance ──
  const providerKey = opts.logicalRefundId;
  const { data: claimResult, error: claimErr } = await supabase.rpc('claim_refund_balance', {
    p_payment_id: paymentId,
    p_refund_amount: amount,
    p_idempotency_key: providerKey,
    p_currency: (payment.currency as string) || 'USD',
    p_waaiio_fee_total: Number(payment.waaiio_fee) || 0,
    p_business_id: businessId,
    p_reason: reason || null,
    p_initiated_by: initiatedBy,
    p_initiated_by_role: initiatedByRole,
  });

  if (claimErr) {
    return { success: false, errorMessage: `Refund claim failed: ${claimErr.message}`, idempotencyKey: providerKey };
  }
  if (!claimResult?.claimed) {
    return { success: false, errorMessage: claimResult?.reason || 'Refund rejected', idempotencyKey: providerKey };
  }

  const refundId = claimResult.refund_id as string;

  // If existing claim (retry), check if already finalized
  if (claimResult.existing) {
    const { data: existingRefund } = await supabase.from('refunds')
      .select('status, gateway_refund_reference').eq('id', refundId).single();
    const storedStatus = existingRefund?.status || 'pending';
    if (storedStatus === 'success' || storedStatus === 'failed') {
      return { success: storedStatus === 'success', refundId, providerStatus: storedStatus, idempotencyKey: providerKey };
    }
    // pending/processing/review_required: fall through to provider call
  }

  const refundRecord = { id: refundId };

  // ALL non-Square refunds call the gateway provider:
  // - platform, managed_split: uses platform key (default)
  // - connect (Stripe): uses platform key (Stripe destination charges are refundable by platform)
  // - byo: uses merchant's byo_secret_key
  // - flutterwave_mid: uses platform key
  const gateway = getPaymentGatewayByName(gatewayName);
  let byoKey: string | undefined;

  if (payment.collection_mode === 'byo' && payment.payout_account_id) {
    const { data: secret, error: secretErr } = await supabase
      .from('business_connection_secrets')
      .select('encrypted_secret_key')
      .eq('payout_account_id', payment.payout_account_id)
      .is('revoked_at', null)
      .maybeSingle();

    if (secretErr) {
      return { success: false, refundId: refundRecord.id, errorMessage: 'BYO credential lookup failed', idempotencyKey: providerKey };
    }
    if (!secret?.encrypted_secret_key) {
      // Mark review_required — retryable after credential restoration
      await supabase.from('refunds').update({ status: 'review_required' }).eq('id', refundRecord.id);
      return { success: false, refundId: refundRecord.id, errorMessage: 'BYO credential missing or revoked — manual review required', providerStatus: 'review_required', idempotencyKey: providerKey };
    }
    const { decryptToken } = await import('@/lib/encryption');
    byoKey = decryptToken(secret.encrypted_secret_key);
  } else if (payment.collection_mode === 'byo' && !payment.payout_account_id) {
    await supabase.from('refunds').update({ status: 'review_required' }).eq('id', refundRecord.id);
    return { success: false, refundId: refundRecord.id, errorMessage: 'BYO payment missing payout account — manual review required', providerStatus: 'review_required', idempotencyKey: providerKey };
  }

  // ── Claim provider execution atomically — prevents duplicate provider calls ──
  const executionToken = randomUUID();
  const { data: execClaim, error: execErr } = await supabase.rpc('claim_refund_provider_execution', {
    p_refund_id: refundRecord.id,
    p_execution_token: executionToken,
    p_lease_seconds: 30,
  });

  if (execErr) {
    return { success: false, refundId: refundRecord.id, errorMessage: `Provider execution claim failed: ${execErr.message}`, idempotencyKey: providerKey };
  }

  if (!execClaim?.acquired) {
    const execReason = execClaim?.reason;

    // Provider already succeeded — skip to finalization
    if (execReason === 'already_succeeded') {
      return { success: true, refundId: refundRecord.id, idempotencyKey: providerKey };
    }
    if (execReason === 'provider_already_succeeded') {
      // Resume finalization with stored provider result
      const { data: finalResult, error: finalErr } = await supabase.rpc('finalize_refund_generic', {
        p_refund_id: refundRecord.id,
        p_gateway_refund_ref: (execClaim.gateway_refund_reference as string) || null,
        p_final_status: 'success',
        p_gateway_response: execClaim.gateway_response || null,
      });
      if (finalErr || !finalResult?.success) {
        return { success: false, refundId: refundRecord.id, errorMessage: 'Finalization failed after provider success', idempotencyKey: providerKey };
      }
      return { success: true, refundId: refundRecord.id, idempotencyKey: providerKey };
    }
    if (execReason === 'ambiguous_outcome') {
      return { success: false, refundId: refundRecord.id, errorMessage: 'Previous provider call was ambiguous — manual review required', providerStatus: 'review_required', idempotencyKey: providerKey };
    }
    if (execReason === 'execution_in_progress') {
      return { success: false, refundId: refundRecord.id, errorMessage: 'Another worker is executing the provider refund', idempotencyKey: providerKey };
    }
    return { success: false, refundId: refundRecord.id, errorMessage: `Provider execution claim rejected: ${execReason}`, idempotencyKey: providerKey };
  }

  // ── Now call the provider ──
  const existingRefundAmount = Number(payment.refund_amount || 0);
  const refundType = amount >= (Number(payment.amount) - existingRefundAmount) ? 'full' : 'partial';
  const refundAmount = refundType === 'full' && existingRefundAmount === 0 ? undefined : amount;

  const result = await gateway.refundPayment({
    gatewayReference: payment.gateway_reference,
    amount: refundAmount,
    currency: (payment.currency as string) || 'NGN',
    reason,
    metadata: { ...(metadata || {}), collection_mode: payment.collection_mode },
    connectAccountId: (metadata?.connect_account_id as string) || undefined,
    byoSecretKey: byoKey,
    providerIdempotencyKey: providerKey,
  });

  // ── Persist provider outcome atomically ──
  if (result.outcome === 'succeeded') {
    // Persist provider success atomically
    await supabase.from('refunds').update({
      provider_outcome: 'succeeded',
      gateway_refund_reference: result.gatewayRefundReference || null,
      gateway_response: result.gatewayResponse || null,
    }).eq('id', refundRecord.id).eq('provider_execution_token', executionToken);

    // Then finalize locally
    const { data: finalResult, error: finalErr } = await supabase.rpc('finalize_refund_generic', {
      p_refund_id: refundRecord.id,
      p_gateway_refund_ref: result.gatewayRefundReference || null,
      p_final_status: 'success',
      p_gateway_response: result.gatewayResponse || null,
    });
    if (finalErr) {
      logger.error('[REFUND] Generic finalization RPC error:', finalErr.message);
      return { success: false, refundId: refundRecord.id, isDirectSplit: false, errorMessage: 'Finalization failed' };
    }
    if (!finalResult?.success) {
      return { success: false, refundId: refundRecord.id, isDirectSplit: false, errorMessage: finalResult?.reason || 'Finalization rejected' };
    }
    return { success: true, refundId: refundRecord.id, isDirectSplit: false };
  } else if (result.outcome === 'definitively_failed') {
    await supabase.from('refunds').update({
      provider_outcome: 'definitively_failed',
      status: 'failed',
      gateway_response: result.gatewayResponse || null,
    }).eq('id', refundRecord.id).eq('provider_execution_token', executionToken);
    return { success: false, refundId: refundRecord.id, isDirectSplit: false, errorMessage: result.errorMessage, idempotencyKey: providerKey };
  } else {
    // ambiguous
    await supabase.from('refunds').update({
      provider_outcome: 'ambiguous',
      status: 'review_required',
      gateway_response: result.gatewayResponse || null,
    }).eq('id', refundRecord.id).eq('provider_execution_token', executionToken);
    return { success: false, refundId: refundRecord.id, isDirectSplit: false, errorMessage: 'Provider result ambiguous — manual review required', providerStatus: 'review_required', idempotencyKey: providerKey };
  }
}
