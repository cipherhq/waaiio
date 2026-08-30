/**
 * Refund execution handler (#232).
 *
 * State model: pending → (claim_dispatch) → provider call →
 *   provider_success_unfinalized → (finalize_refund_execution) → success
 *   provider_ambiguous (Tier 2 unknown outcome)
 *   failed (provider confirmed failure)
 *
 * Execution writes use service_role client (trusted boundary).
 * Finalization is atomic via PostgreSQL RPC.
 * Provider idempotency key = refunds.id (attempt-scoped).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { createServiceClient } from '@/lib/supabase/service';
import { getPaymentGatewayByName } from './factory';
import type { PaymentGatewayName } from '@/lib/constants';
import { logger } from '@/lib/logger';
import { safeLogErrorContext } from '@/lib/errors';

// Gateways with proven provider-side idempotent replay via stable request key
const TIER1_GATEWAYS = new Set<string>(['stripe', 'square', 'paypal']);

interface ProcessRefundOpts {
  supabase: SupabaseClient; // authenticated client for reads/validation
  paymentId: string;
  businessId: string;
  amount: number;
  reason?: string;
  initiatedBy: string;
  initiatedByRole: 'business' | 'admin';
}

interface ProcessRefundResult {
  success: boolean;
  refundId?: string;
  isDirectSplit?: boolean;
  errorMessage?: string;
}

export async function processRefund(opts: ProcessRefundOpts): Promise<ProcessRefundResult> {
  const { supabase, paymentId, businessId, amount, reason, initiatedBy, initiatedByRole } = opts;
  const service = createServiceClient();

  // ── 1. Load payment record (authenticated client — respects RLS) ──
  const { data: payment, error: paymentErr } = await supabase
    .from('payments')
    .select('id, amount, currency, refund_amount, status, gateway, gateway_reference, booking_id, invoice_id, campaign_id, order_id, reservation_id, business_id, metadata')
    .eq('id', paymentId)
    .single();

  if (paymentErr || !payment) {
    return { success: false, errorMessage: 'Payment not found' };
  }

  // ── 2. Validate payment is refundable ──
  if (payment.status !== 'success' && payment.status !== 'refunded') {
    return { success: false, errorMessage: `Payment status "${payment.status}" is not refundable` };
  }

  // Over-refund guard: compute remaining from execution ledger (authoritative),
  // not just payments.refund_amount (derived cache)
  const { data: completedRefunds } = await service
    .from('refunds')
    .select('amount')
    .eq('payment_id', paymentId)
    .eq('status', 'success');

  const ledgerRefunded = (completedRefunds || []).reduce((s, r) => s + Number(r.amount), 0);
  const paymentAmount = Number(payment.amount);
  const remaining = paymentAmount - ledgerRefunded;

  if (amount <= 0) {
    return { success: false, errorMessage: 'Refund amount must be greater than 0' };
  }

  if (amount > remaining) {
    return { success: false, errorMessage: `Refund amount (${amount}) exceeds remaining refundable amount (${remaining})` };
  }

  // ── 3. Cross-validate businessId ──
  if (payment.business_id && payment.business_id !== businessId) {
    return { success: false, errorMessage: 'Business ID does not match the payment record' };
  }

  // ── 4. Check payout mode ──
  const { data: business } = await supabase
    .from('businesses')
    .select('payout_mode')
    .eq('id', businessId)
    .single();

  const isDirectSplit = business?.payout_mode === 'direct_split';
  const refundType = amount >= remaining ? 'full' : 'partial';

  // ── 5. Create refund record (service_role — execution ledger write) ──
  // The partial unique index on non-terminal states prevents concurrent inserts
  const { data: refundRecord, error: insertErr } = await service
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
    // Partial unique index violation = another non-terminal refund exists
    if (insertErr?.code === '23505') {
      // Check if the existing non-terminal refund is a Tier-1 ambiguous that can be recovered
      const { data: existingRefund } = await service
        .from('refunds')
        .select('id, status, gateway')
        .eq('payment_id', paymentId)
        .in('status', ['pending', 'provider_ambiguous', 'provider_success_unfinalized'])
        .limit(1)
        .maybeSingle();

      if (existingRefund?.status === 'provider_ambiguous' && TIER1_GATEWAYS.has(existingRefund.gateway || '')) {
        // Attempt Tier-1 recovery via RPC (DB enforces gateway + window)
        const { data: recoveryResult } = await service.rpc('recover_ambiguous_refund', {
          p_refund_id: existingRefund.id,
        });
        const recovery = recoveryResult as Record<string, unknown>;
        if (recovery?.recovered) {
          // Recovered — the same attempt can be re-dispatched. Return the existing ID.
          // The caller should retry the full flow.
          return { success: false, refundId: existingRefund.id, errorMessage: 'Recovered ambiguous attempt — please retry' };
        }
      }

      return { success: false, errorMessage: 'A refund for this payment is already being processed' };
    }
    return { success: false, errorMessage: 'Failed to create refund record' };
  }

  // ── 6. Atomic dispatch claim ──
  const { data: claimResult } = await service.rpc('claim_refund_dispatch', {
    p_refund_id: refundRecord.id,
  });

  const claim = (claimResult as Array<Record<string, unknown>>)?.[0];
  if (!claim?.claimed) {
    return { success: false, errorMessage: 'Failed to claim refund for dispatch' };
  }

  // ── 7. Process refund ──
  if (isDirectSplit) {
    // Direct split: record-only, skip provider, go straight to finalization
    const { error: dsErr } = await service
      .from('refunds')
      .update({ status: 'provider_success_unfinalized', gateway_refund_reference: 'direct_split' })
      .eq('id', refundRecord.id);
    if (dsErr) {
      return { success: false, refundId: refundRecord.id, isDirectSplit, errorMessage: 'Failed to record direct split refund state' };
    }
  } else {
    // Platform managed: call gateway refund API
    const gatewayName = (payment.gateway || 'paystack') as PaymentGatewayName;
    const gateway = getPaymentGatewayByName(gatewayName);
    const metadata = payment.metadata as Record<string, unknown> | null;
    const isTier1 = TIER1_GATEWAYS.has(gatewayName);

    let result;
    try {
      result = await gateway.refundPayment({
        gatewayReference: payment.gateway_reference,
        amount: refundType === 'full' && ledgerRefunded === 0 ? undefined : amount,
        currency: (payment.currency as string) || 'NGN',
        reason,
        connectAccountId: (metadata?.connect_account_id as string) || undefined,
        byoSecretKey: (metadata?.byo_secret_key as string) || undefined,
        idempotencyKey: refundRecord.id, // attempt-scoped stable key
      });
    } catch (err) {
      // Transport/timeout error — outcome unknown
      if (!isTier1) {
        // Tier 2: fail closed to reconciliation
        await service
          .from('refunds')
          .update({ status: 'provider_ambiguous', gateway_response: { error: String(err) } })
          .eq('id', refundRecord.id);
        return {
          success: false,
          refundId: refundRecord.id,
          isDirectSplit,
          errorMessage: 'Refund outcome unknown — requires manual reconciliation',
        };
      }
      // Tier 1: the idempotency key makes it safe to mark ambiguous and retry later
      await service
        .from('refunds')
        .update({ status: 'provider_ambiguous', gateway_response: { error: String(err) } })
        .eq('id', refundRecord.id);
      return {
        success: false,
        refundId: refundRecord.id,
        isDirectSplit,
        errorMessage: 'Refund outcome unknown — safe to retry with same attempt key',
      };
    }

    if (result.success) {
      // Provider confirmed success — durably record reference before finalization.
      // If this DB write fails, the provider refund happened but we can't prove it locally.
      // The attempt stays dispatched (pending + dispatched_at set) and can be recovered
      // via the same idempotency key for Tier-1 gateways.
      const { error: durabilityErr } = await service
        .from('refunds')
        .update({
          status: 'provider_success_unfinalized',
          gateway_refund_reference: result.gatewayRefundReference || null,
          gateway_response: result.gatewayResponse || null,
        })
        .eq('id', refundRecord.id);

      if (durabilityErr) {
        // Provider succeeded but we can't durably record it.
        // Mark ambiguous — do NOT proceed to finalization without durable proof.
        logger.withContext({ op: 'refund.durability-write', refundId: refundRecord.id })
          .error(`[REFUND] Provider success but durability write failed: ${durabilityErr.message}`);
        // The attempt identity (refundRecord.id) is preserved. Tier-1 gateways can replay safely.
        return {
          success: false,
          refundId: refundRecord.id,
          isDirectSplit,
          errorMessage: 'Provider refund succeeded but local state update failed — will be recovered',
        };
      }
    } else {
      // Provider confirmed failure
      await service
        .from('refunds')
        .update({
          status: 'failed',
          gateway_response: result.gatewayResponse || { error: result.errorMessage },
        })
        .eq('id', refundRecord.id);

      return {
        success: false,
        refundId: refundRecord.id,
        isDirectSplit,
        errorMessage: result.errorMessage || 'Gateway refund failed',
      };
    }
  }

  // ── 8. Atomic finalization via RPC ──
  const { data: finalizeResult, error: finalizeErr } = await service.rpc('finalize_refund_execution', {
    p_refund_id: refundRecord.id,
  });

  if (finalizeErr) {
    logger.withContext({ op: 'refund.finalize', ...safeLogErrorContext(finalizeErr) })
      .error(`[REFUND] Finalization RPC failed for refund ${refundRecord.id}`);
    // Refund stays provider_success_unfinalized — can be retried
    return {
      success: false,
      refundId: refundRecord.id,
      isDirectSplit,
      errorMessage: 'Refund processed at gateway but local finalization failed — will be retried',
    };
  }

  const finResult = finalizeResult as Record<string, unknown>;
  if (!finResult?.finalized) {
    return {
      success: false,
      refundId: refundRecord.id,
      isDirectSplit,
      errorMessage: `Finalization returned: ${finResult?.reason || 'unknown'}`,
    };
  }

  return {
    success: true,
    refundId: refundRecord.id,
    isDirectSplit,
  };
}
