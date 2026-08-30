/**
 * Refund execution handler (#232).
 *
 * 6-state model: pending → provider_pending | provider_ambiguous
 *                         → provider_success_unfinalized → success
 *                         → failed
 *
 * Provider outcome classification drives state transitions:
 *   terminal_success → provider_success_unfinalized → finalize
 *   terminal_failure → failed
 *   provider_pending → provider_pending (await reconciliation)
 *   transport_unknown → provider_ambiguous
 *
 * Token-bound recovery for interrupted Tier-1 dispatches.
 * Service_role for all execution-ledger writes.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { createServiceClient } from '@/lib/supabase/service';
import { getPaymentGatewayByName } from './factory';
import type { PaymentGatewayName } from '@/lib/constants';
import type { RefundOutcome } from './types';
import { logger } from '@/lib/logger';
import { safeLogErrorContext } from '@/lib/errors';

// Tier-1: proven provider-side idempotent replay (Stripe 24h, PayPal documented)
const TIER1_GATEWAYS = new Set<string>(['stripe', 'paypal']);

interface ProcessRefundOpts {
  supabase: SupabaseClient;
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

  // ── 1. Load + validate payment ──
  const { data: payment, error: paymentErr } = await supabase
    .from('payments')
    .select('id, amount, currency, refund_amount, status, gateway, gateway_reference, booking_id, invoice_id, campaign_id, order_id, reservation_id, business_id, metadata')
    .eq('id', paymentId)
    .single();
  if (paymentErr || !payment) return { success: false, errorMessage: 'Payment not found' };
  if (payment.status !== 'success' && payment.status !== 'refunded')
    return { success: false, errorMessage: `Payment status "${payment.status}" is not refundable` };

  const { data: completedRefunds } = await service.from('refunds').select('amount').eq('payment_id', paymentId).eq('status', 'success');
  const ledgerRefunded = (completedRefunds || []).reduce((s, r) => s + Number(r.amount), 0);
  const paymentAmount = Number(payment.amount);
  const remaining = paymentAmount - ledgerRefunded;

  if (amount <= 0) return { success: false, errorMessage: 'Refund amount must be greater than 0' };
  if (amount > remaining) return { success: false, errorMessage: `Refund amount (${amount}) exceeds remaining refundable amount (${remaining})` };
  if (payment.business_id && payment.business_id !== businessId) return { success: false, errorMessage: 'Business ID does not match the payment record' };

  const { data: business } = await supabase.from('businesses').select('payout_mode').eq('id', businessId).single();
  const isDirectSplit = business?.payout_mode === 'direct_split';
  const refundType = amount >= remaining ? 'full' : 'partial';
  const metadata = payment.metadata as Record<string, unknown> | null;

  // ── 2. Create or resume refund record ──
  const { data: refundRecord, error: insertErr } = await service
    .from('refunds')
    .insert({
      payment_id: paymentId, business_id: businessId, amount, reason: reason || null,
      status: 'pending', gateway: payment.gateway, refund_type: refundType,
      is_direct_split: isDirectSplit, initiated_by: initiatedBy, initiated_by_role: initiatedByRole,
      connect_account_id: (metadata?.connect_account_id as string) || null,
      provider_connection_id: (metadata?.provider_connection_id as string) || null,
    })
    .select('id')
    .single();

  if (insertErr?.code === '23505') {
    return resumeExistingRefund(service, paymentId, payment, isDirectSplit);
  }
  if (insertErr || !refundRecord) return { success: false, errorMessage: 'Failed to create refund record' };

  // ── 3. Dispatch ──
  return dispatchAndFinalize(service, refundRecord.id, null, payment, isDirectSplit);
}

/** Resume an existing non-terminal refund. */
async function resumeExistingRefund(
  service: ReturnType<typeof createServiceClient>,
  paymentId: string, payment: Record<string, unknown>, isDirectSplit: boolean,
): Promise<ProcessRefundResult> {
  const { data: existing } = await service
    .from('refunds')
    .select('id, status, gateway, dispatched_at, amount, provider_refund_id, recovery_token')
    .eq('payment_id', paymentId)
    .in('status', ['pending', 'provider_pending', 'provider_ambiguous', 'provider_success_unfinalized'])
    .limit(1).maybeSingle();

  if (!existing) return { success: false, errorMessage: 'A refund for this payment is already being processed' };
  const isTier1 = TIER1_GATEWAYS.has(existing.gateway || '');

  // provider_success_unfinalized → finalize locally, NO provider call
  if (existing.status === 'provider_success_unfinalized') {
    return finalizeOnly(service, existing.id, isDirectSplit);
  }

  // provider_pending → attempt reconciliation via provider query
  if (existing.status === 'provider_pending' && existing.provider_refund_id) {
    return reconcileAndFinalize(service, existing, payment, isDirectSplit);
  }

  // provider_ambiguous → Tier-1 recover+re-dispatch; Tier-2 fail closed
  if (existing.status === 'provider_ambiguous') {
    if (!isTier1) return { success: false, refundId: existing.id, isDirectSplit, errorMessage: 'Refund outcome unknown — requires manual reconciliation (non-replay-safe gateway)' };
    const { data: recResult } = await service.rpc('recover_ambiguous_refund', { p_refund_id: existing.id });
    const rec = recResult as Record<string, unknown>;
    if (!rec?.recovered) return { success: false, refundId: existing.id, isDirectSplit, errorMessage: `Recovery failed: ${rec?.reason || 'unknown'}` };
    return dispatchAndFinalize(service, existing.id, rec.recovery_token as string, payment, isDirectSplit);
  }

  // pending + dispatched (interrupted) → Tier-1 token-bound recovery; Tier-2 → ambiguous
  if (existing.status === 'pending' && existing.dispatched_at) {
    if (isTier1) {
      const { data: recResult } = await service.rpc('recover_interrupted_dispatch', { p_refund_id: existing.id });
      const rec = recResult as Record<string, unknown>;
      if (!rec?.recovered) return { success: false, refundId: existing.id, isDirectSplit, errorMessage: `Interrupted recovery failed: ${rec?.reason || 'unknown'}` };
      return dispatchAndFinalize(service, existing.id, rec.recovery_token as string, payment, isDirectSplit);
    }
    // Tier-2: mark ambiguous
    await service.from('refunds').update({ status: 'provider_ambiguous', gateway_response: { error: 'interrupted_dispatch_tier2' } }).eq('id', existing.id);
    return { success: false, refundId: existing.id, isDirectSplit, errorMessage: 'Interrupted refund — requires manual reconciliation' };
  }

  // pending + undispatched → dispatch normally
  if (existing.status === 'pending' && !existing.dispatched_at) {
    return dispatchAndFinalize(service, existing.id, null, payment, isDirectSplit);
  }

  return { success: false, errorMessage: 'A refund for this payment is already being processed' };
}

/** Finalize a provider_success_unfinalized refund without calling the provider. */
async function finalizeOnly(service: ReturnType<typeof createServiceClient>, refundId: string, isDirectSplit: boolean): Promise<ProcessRefundResult> {
  const { data: finResult, error: finErr } = await service.rpc('finalize_refund_execution', { p_refund_id: refundId });
  if (finErr) return { success: false, refundId, isDirectSplit, errorMessage: 'Re-finalization failed' };
  const fr = finResult as Record<string, unknown>;
  return { success: !!fr?.finalized, refundId, isDirectSplit };
}

/** Reconcile a provider_pending refund by querying the provider, then finalize if terminal. */
async function reconcileAndFinalize(
  service: ReturnType<typeof createServiceClient>,
  existing: Record<string, unknown>, payment: Record<string, unknown>, isDirectSplit: boolean,
): Promise<ProcessRefundResult> {
  const refundId = existing.id as string;
  try {
    const gatewayName = (existing.gateway as string) || 'paystack';
    const gateway = getPaymentGatewayByName(gatewayName as PaymentGatewayName);
    if (!gateway.queryRefundStatus) {
      return { success: false, refundId, isDirectSplit, errorMessage: 'Gateway does not support refund status query' };
    }
    const metadata = payment.metadata as Record<string, unknown> | null;
    const statusResult = await gateway.queryRefundStatus(existing.provider_refund_id as string, {
      byoSecretKey: undefined, // resolved at runtime if needed
      connectAccountId: (metadata?.connect_account_id as string) || undefined,
    });

    if (statusResult.outcome === 'terminal_success') {
      await service.rpc('reconcile_pending_refund', { p_refund_id: refundId, p_provider_status: statusResult.providerStatus, p_terminal_outcome: 'terminal_success' });
      return finalizeOnly(service, refundId, isDirectSplit);
    }
    if (statusResult.outcome === 'terminal_failure') {
      await service.rpc('reconcile_pending_refund', { p_refund_id: refundId, p_provider_status: statusResult.providerStatus, p_terminal_outcome: 'terminal_failure' });
      return { success: false, refundId, isDirectSplit, errorMessage: 'Provider confirmed refund failure' };
    }
    // Still pending — no mutation
    return { success: false, refundId, isDirectSplit, errorMessage: 'Refund still pending at provider' };
  } catch (err) {
    // Query transport failure — remain provider_pending, no mutation
    logger.warn(`[REFUND] Reconciliation query failed for ${refundId}: ${err}`);
    return { success: false, refundId, isDirectSplit, errorMessage: 'Reconciliation query failed — refund remains pending' };
  }
}

/** Dispatch a refund attempt and finalize on terminal success. */
async function dispatchAndFinalize(
  service: ReturnType<typeof createServiceClient>,
  refundId: string, recoveryToken: string | null,
  payment: Record<string, unknown>, isDirectSplit: boolean,
): Promise<ProcessRefundResult> {
  // Atomic dispatch claim (token-bound if recovering)
  const { data: claimResult } = await service.rpc('claim_refund_dispatch', {
    p_refund_id: refundId,
    p_recovery_token: recoveryToken || null,
  });
  const claim = (claimResult as Array<Record<string, unknown>>)?.[0];
  if (!claim?.claimed) {
    // Check if it reached a resumable state while we tried to claim
    const { data: cur } = await service.from('refunds').select('status').eq('id', refundId).single();
    if (cur?.status === 'provider_success_unfinalized') return finalizeOnly(service, refundId, isDirectSplit);
    return { success: false, refundId, errorMessage: 'Failed to claim refund for dispatch' };
  }

  // Read immutable request parameters from the refund row
  const { data: refRow } = await service
    .from('refunds').select('amount, gateway, refund_type, reason, connect_account_id, provider_connection_id, is_direct_split')
    .eq('id', refundId).single();
  if (!refRow) return { success: false, refundId, errorMessage: 'Refund row not found after claim' };

  if (refRow.is_direct_split) {
    const { error: dsErr } = await service.from('refunds')
      .update({ status: 'provider_success_unfinalized', gateway_refund_reference: 'direct_split', provider_status: 'direct_split' })
      .eq('id', refundId);
    if (dsErr) return { success: false, refundId, isDirectSplit: true, errorMessage: 'Failed to record direct split state' };
  } else {
    const gatewayName = (refRow.gateway || 'paystack') as PaymentGatewayName;
    const gateway = getPaymentGatewayByName(gatewayName);

    // Resolve BYO credential from trusted boundary if needed
    let byoSecretKey: string | undefined;
    if (refRow.provider_connection_id) {
      const { data: cred } = await service.from('payout_accounts').select('secret_key').eq('id', refRow.provider_connection_id).eq('is_active', true).maybeSingle();
      if (!cred?.secret_key) {
        // Credential missing/deactivated — fail closed
        const { error: ambErr } = await service.from('refunds')
          .update({ status: 'provider_ambiguous', gateway_response: { error: 'credential_not_found' } })
          .eq('id', refundId);
        if (ambErr) logger.error(`[REFUND] Credential missing AND state write failed: ${refundId}`);
        return { success: false, refundId, isDirectSplit, errorMessage: 'BYO credential not found — requires reconciliation' };
      }
      byoSecretKey = cred.secret_key;
    }

    const result = await gateway.refundPayment({
      gatewayReference: payment.gateway_reference as string,
      amount: refRow.refund_type === 'full' ? undefined : Number(refRow.amount),
      currency: ((payment.currency as string) || 'NGN'),
      reason: refRow.reason || undefined,
      connectAccountId: refRow.connect_account_id || undefined,
      byoSecretKey,
      idempotencyKey: refundId,
    });

    // Persist provider refund ID + status regardless of outcome
    if (result.providerRefundId || result.providerStatus) {
      await service.from('refunds').update({
        provider_refund_id: result.providerRefundId || null,
        provider_status: result.providerStatus || null,
        gateway_refund_reference: result.gatewayRefundReference || result.providerRefundId || null,
        gateway_response: result.gatewayResponse || null,
      }).eq('id', refundId);
    }

    // Outcome-based state transition
    const outcome: RefundOutcome = result.outcome;

    if (outcome === 'terminal_success') {
      const { error: durErr } = await service.from('refunds')
        .update({ status: 'provider_success_unfinalized' }).eq('id', refundId);
      if (durErr) {
        logger.error(`[REFUND] Provider success but durability write failed: ${refundId}`);
        return { success: false, refundId, isDirectSplit, errorMessage: 'Provider refund succeeded but state update failed — will be recovered' };
      }
    } else if (outcome === 'terminal_failure') {
      const { error: failErr } = await service.from('refunds')
        .update({ status: 'failed' }).eq('id', refundId);
      if (failErr) logger.error(`[REFUND] Failed state write failed: ${refundId}`);
      return { success: false, refundId, isDirectSplit, errorMessage: result.errorMessage || 'Gateway refund failed' };
    } else if (outcome === 'provider_pending') {
      const { error: pendErr } = await service.from('refunds')
        .update({ status: 'provider_pending' }).eq('id', refundId);
      if (pendErr) logger.error(`[REFUND] Provider pending state write failed: ${refundId}`);
      return { success: false, refundId, isDirectSplit, errorMessage: 'Refund accepted by provider — awaiting completion' };
    } else {
      // transport_unknown → provider_ambiguous
      const { error: ambErr } = await service.from('refunds')
        .update({ status: 'provider_ambiguous' }).eq('id', refundId);
      if (ambErr) logger.error(`[REFUND] Ambiguous state write failed: ${refundId}`);
      return { success: false, refundId, isDirectSplit, errorMessage: 'Refund outcome unknown' };
    }
  }

  // ── Finalize ──
  const { data: finalizeResult, error: finalizeErr } = await service.rpc('finalize_refund_execution', { p_refund_id: refundId });
  if (finalizeErr) {
    logger.withContext({ op: 'refund.finalize', ...safeLogErrorContext(finalizeErr) }).error(`[REFUND] Finalization RPC failed for ${refundId}`);
    return { success: false, refundId, isDirectSplit, errorMessage: 'Refund processed but finalization failed — will be retried' };
  }
  const finResult = finalizeResult as Record<string, unknown>;
  return { success: !!finResult?.finalized, refundId, isDirectSplit };
}
