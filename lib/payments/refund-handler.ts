/**
 * Refund execution handler (#232).
 *
 * State model: pending → (claim_dispatch) → provider call →
 *   provider_success_unfinalized → (finalize_refund_execution) → success
 *   provider_ambiguous (unknown outcome)
 *   failed (provider confirmed failure)
 *
 * Resume paths (on 23505 unique-index conflict):
 *   provider_success_unfinalized → finalize locally (no provider call)
 *   provider_ambiguous + Tier-1 within window → recover + re-dispatch same ID/key
 *   provider_ambiguous + Tier-2 or expired → fail closed (reconciliation)
 *   pending + dispatched_at set → Tier-1 re-dispatch / Tier-2 fail closed
 *   pending + dispatched_at null → claim + dispatch normally
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

// Gateways with proven provider-side idempotent replay via stable request key.
// Stripe: 24h idempotency retention (documented). PayPal: documented request-ID retention.
// Square: NOT proven — treated as reconciliation-only for ambiguous outcomes.
const TIER1_GATEWAYS = new Set<string>(['stripe', 'paypal']);

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

  // Over-refund guard from execution ledger (authoritative)
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

  // ── 5. Create or resume refund record ──
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

  if (insertErr?.code === '23505' || (!refundRecord && insertErr)) {
    if (insertErr?.code === '23505') {
      // Non-terminal refund exists — try to resume it
      return resumeExistingRefund(service, paymentId, payment, isDirectSplit);
    }
    return { success: false, errorMessage: 'Failed to create refund record' };
  }
  if (!refundRecord) {
    return { success: false, errorMessage: 'Failed to create refund record' };
  }

  // ── 6. Dispatch and finalize (new attempt) ──
  return dispatchAndFinalize(service, refundRecord.id, payment, isDirectSplit, amount, ledgerRefunded, refundType, reason);
}

/**
 * Resume an existing non-terminal refund based on its current state.
 */
async function resumeExistingRefund(
  service: ReturnType<typeof createServiceClient>,
  paymentId: string,
  payment: Record<string, unknown>,
  isDirectSplit: boolean,
): Promise<ProcessRefundResult> {
  const { data: existing } = await service
    .from('refunds')
    .select('id, status, gateway, dispatched_at, amount, gateway_refund_reference')
    .eq('payment_id', paymentId)
    .in('status', ['pending', 'provider_ambiguous', 'provider_success_unfinalized'])
    .limit(1)
    .maybeSingle();

  if (!existing) {
    return { success: false, errorMessage: 'A refund for this payment is already being processed' };
  }

  const isTier1 = TIER1_GATEWAYS.has(existing.gateway || '');

  // ── provider_success_unfinalized: finalize locally, NO provider call ──
  if (existing.status === 'provider_success_unfinalized') {
    const { data: finResult, error: finErr } = await service.rpc('finalize_refund_execution', {
      p_refund_id: existing.id,
    });
    if (finErr) {
      return { success: false, refundId: existing.id, isDirectSplit, errorMessage: 'Re-finalization failed' };
    }
    const fr = finResult as Record<string, unknown>;
    return { success: !!fr?.finalized, refundId: existing.id, isDirectSplit };
  }

  // ── provider_ambiguous: Tier-1 recover + re-dispatch; Tier-2 fail closed ──
  if (existing.status === 'provider_ambiguous') {
    if (!isTier1) {
      return { success: false, refundId: existing.id, isDirectSplit, errorMessage: 'Refund outcome unknown — requires manual reconciliation (Tier-2 gateway)' };
    }
    // Tier-1: attempt recovery via RPC (DB enforces gateway + window)
    const { data: recoveryResult } = await service.rpc('recover_ambiguous_refund', {
      p_refund_id: existing.id,
    });
    const recovery = recoveryResult as Record<string, unknown>;
    if (!recovery?.recovered) {
      return { success: false, refundId: existing.id, isDirectSplit, errorMessage: `Recovery failed: ${recovery?.reason || 'unknown'}` };
    }
    // Recovered to pending — fall through to re-dispatch the same row
    return dispatchAndFinalize(
      service, existing.id, payment, isDirectSplit,
      Number(existing.amount), 0, 'partial', undefined,
    );
  }

  // ── pending + dispatched_at set: interrupted dispatch ──
  if (existing.status === 'pending' && existing.dispatched_at) {
    if (isTier1) {
      // Tier-1: safe to re-dispatch with same idempotency key
      return dispatchAndFinalize(
        service, existing.id, payment, isDirectSplit,
        Number(existing.amount), 0, 'partial', undefined,
      );
    }
    // Tier-2: provider may have acted — fail closed to ambiguous
    const { error: ambErr } = await service
      .from('refunds')
      .update({ status: 'provider_ambiguous', gateway_response: { error: 'interrupted_dispatch_tier2' } })
      .eq('id', existing.id);
    if (ambErr) {
      logger.error(`[REFUND] Failed to mark interrupted Tier-2 dispatch as ambiguous: ${ambErr.message}`);
    }
    return { success: false, refundId: existing.id, isDirectSplit, errorMessage: 'Interrupted refund — requires manual reconciliation (Tier-2 gateway)' };
  }

  // ── pending + undispatched: claim and dispatch normally ──
  if (existing.status === 'pending' && !existing.dispatched_at) {
    return dispatchAndFinalize(
      service, existing.id, payment, isDirectSplit,
      Number(existing.amount), 0, 'partial', undefined,
    );
  }

  return { success: false, errorMessage: 'A refund for this payment is already being processed' };
}

/**
 * Dispatch a refund attempt (claim → provider call → durability write → finalize).
 * Uses the refund row's own ID as the provider idempotency key.
 */
async function dispatchAndFinalize(
  service: ReturnType<typeof createServiceClient>,
  refundId: string,
  payment: Record<string, unknown>,
  isDirectSplit: boolean,
  amount: number,
  ledgerRefunded: number,
  refundType: string,
  reason: string | undefined,
): Promise<ProcessRefundResult> {
  // ── Atomic dispatch claim ──
  const { data: claimResult } = await service.rpc('claim_refund_dispatch', {
    p_refund_id: refundId,
  });
  const claim = (claimResult as Array<Record<string, unknown>>)?.[0];
  if (!claim?.claimed) {
    // Already dispatched — check if it's now in a resumable state
    const { data: currentState } = await service
      .from('refunds')
      .select('status')
      .eq('id', refundId)
      .single();
    if (currentState?.status === 'provider_success_unfinalized') {
      // Race: another worker dispatched and got provider success. Just finalize.
      const { data: finResult } = await service.rpc('finalize_refund_execution', { p_refund_id: refundId });
      const fr = finResult as Record<string, unknown>;
      return { success: !!fr?.finalized, refundId, isDirectSplit };
    }
    return { success: false, refundId, errorMessage: 'Failed to claim refund for dispatch' };
  }

  // ── Process refund ──
  if (isDirectSplit) {
    const { error: dsErr } = await service
      .from('refunds')
      .update({ status: 'provider_success_unfinalized', gateway_refund_reference: 'direct_split' })
      .eq('id', refundId);
    if (dsErr) {
      return { success: false, refundId, isDirectSplit, errorMessage: 'Failed to record direct split refund state' };
    }
  } else {
    const gatewayName = ((payment.gateway as string) || 'paystack') as PaymentGatewayName;
    const gateway = getPaymentGatewayByName(gatewayName);
    const metadata = payment.metadata as Record<string, unknown> | null;
    const isTier1 = TIER1_GATEWAYS.has(gatewayName);

    let result;
    try {
      result = await gateway.refundPayment({
        gatewayReference: payment.gateway_reference as string,
        amount: refundType === 'full' && ledgerRefunded === 0 ? undefined : amount,
        currency: ((payment.currency as string) || 'NGN'),
        reason,
        connectAccountId: (metadata?.connect_account_id as string) || undefined,
        byoSecretKey: (metadata?.byo_secret_key as string) || undefined,
        idempotencyKey: refundId,
      });
    } catch (err) {
      // Transport/timeout — outcome unknown. Check state persistence.
      const { error: ambWriteErr } = await service
        .from('refunds')
        .update({ status: 'provider_ambiguous', gateway_response: { error: String(err) } })
        .eq('id', refundId);

      if (ambWriteErr) {
        // State persistence failed too — row stays pending+dispatched.
        // Tier-1: safe to re-dispatch later (idempotent key). Tier-2: stuck until reconciliation.
        logger.error(`[REFUND] Both provider and state-write failed for ${refundId}`);
      }

      return {
        success: false,
        refundId,
        isDirectSplit,
        errorMessage: isTier1
          ? 'Refund outcome unknown — safe to retry with same attempt key'
          : 'Refund outcome unknown — requires manual reconciliation',
      };
    }

    if (result.success) {
      const { error: durabilityErr } = await service
        .from('refunds')
        .update({
          status: 'provider_success_unfinalized',
          gateway_refund_reference: result.gatewayRefundReference || null,
          gateway_response: result.gatewayResponse || null,
        })
        .eq('id', refundId);

      if (durabilityErr) {
        // Provider succeeded but durability write failed.
        // Row stays pending+dispatched. Tier-1 can safely re-dispatch (idempotent).
        logger.withContext({ op: 'refund.durability-write', refundId })
          .error(`[REFUND] Provider success but durability write failed: ${durabilityErr.message}`);
        return {
          success: false,
          refundId,
          isDirectSplit,
          errorMessage: 'Provider refund succeeded but local state update failed — will be recovered',
        };
      }
    } else {
      const { error: failWriteErr } = await service
        .from('refunds')
        .update({
          status: 'failed',
          gateway_response: result.gatewayResponse || { error: result.errorMessage },
        })
        .eq('id', refundId);

      if (failWriteErr) {
        logger.error(`[REFUND] Provider failed AND state-write failed for ${refundId}`);
      }

      return {
        success: false,
        refundId,
        isDirectSplit,
        errorMessage: result.errorMessage || 'Gateway refund failed',
      };
    }
  }

  // ── Atomic finalization ──
  const { data: finalizeResult, error: finalizeErr } = await service.rpc('finalize_refund_execution', {
    p_refund_id: refundId,
  });

  if (finalizeErr) {
    logger.withContext({ op: 'refund.finalize', ...safeLogErrorContext(finalizeErr) })
      .error(`[REFUND] Finalization RPC failed for refund ${refundId}`);
    return {
      success: false,
      refundId,
      isDirectSplit,
      errorMessage: 'Refund processed at gateway but local finalization failed — will be retried',
    };
  }

  const finResult = finalizeResult as Record<string, unknown>;
  if (!finResult?.finalized) {
    return {
      success: false,
      refundId,
      isDirectSplit,
      errorMessage: `Finalization returned: ${finResult?.reason || 'unknown'}`,
    };
  }

  return { success: true, refundId, isDirectSplit };
}
