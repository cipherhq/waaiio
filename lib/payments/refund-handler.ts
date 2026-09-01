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

// Valid durable refund states stored in the database
const VALID_REFUND_STATES = new Set<RefundState>([
  'pending', 'provider_pending', 'provider_ambiguous',
  'provider_success_unfinalized', 'success', 'failed',
]);

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

/**
 * Canonical 6-state refund domain vocabulary.
 * Each state maps to the durable refunds.status or pre-dispatch condition:
 *   pending                       — refund row exists but not yet dispatched / claim loser
 *   provider_pending              — provider accepted, awaiting settlement
 *   provider_ambiguous            — outcome unknown (transport error, persistence failure)
 *   provider_success_unfinalized  — provider confirmed success, local finalization incomplete
 *   success                       — fully finalized
 *   failed                        — terminal failure (validation or provider)
 */
export type RefundState =
  | 'pending'
  | 'provider_pending'
  | 'provider_ambiguous'
  | 'provider_success_unfinalized'
  | 'success'
  | 'failed';

export interface ProcessRefundResult {
  success: boolean;
  refundId?: string;
  isDirectSplit?: boolean;
  errorMessage?: string;
  state: RefundState;
}

/**
 * Read the durable refund status from the database.
 * Used to ensure API responses reflect the actual persisted state,
 * not the code branch that was executing when a failure occurred.
 */
async function readDurableRefundState(
  service: ReturnType<typeof createServiceClient>,
  refundId: string,
): Promise<RefundState> {
  const { data } = await service.from('refunds').select('status').eq('id', refundId).single();
  const status = data?.status as string | undefined;
  if (status && VALID_REFUND_STATES.has(status as RefundState)) return status as RefundState;
  return 'failed'; // defensive: unknown/missing → failed
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
  if (paymentErr || !payment) return { success: false, errorMessage: 'Payment not found', state: 'failed' };
  if (payment.status !== 'success' && payment.status !== 'refunded')
    return { success: false, errorMessage: `Payment status "${payment.status}" is not refundable`, state: 'failed' };

  const { data: completedRefunds } = await service.from('refunds').select('amount').eq('payment_id', paymentId).eq('status', 'success');
  const ledgerRefunded = (completedRefunds || []).reduce((s, r) => s + Number(r.amount), 0);
  const paymentAmount = Number(payment.amount);
  const remaining = paymentAmount - ledgerRefunded;

  if (amount <= 0) return { success: false, errorMessage: 'Refund amount must be greater than 0', state: 'failed' };
  if (amount > remaining) return { success: false, errorMessage: `Refund amount (${amount}) exceeds remaining refundable amount (${remaining})`, state: 'failed' };
  if (payment.business_id && payment.business_id !== businessId) return { success: false, errorMessage: 'Business ID does not match the payment record', state: 'failed' };

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
  if (insertErr || !refundRecord) return { success: false, errorMessage: 'Failed to create refund record', state: 'failed' };

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
    .select('id, status, gateway, dispatched_at, amount, provider_refund_id, recovery_token, provider_connection_id, connect_account_id')
    .eq('payment_id', paymentId)
    .in('status', ['pending', 'provider_pending', 'provider_ambiguous', 'provider_success_unfinalized'])
    .limit(1).maybeSingle();

  if (!existing) return { success: false, errorMessage: 'A refund for this payment is already being processed', state: 'failed' };
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
    if (!isTier1) return { success: false, refundId: existing.id, isDirectSplit, errorMessage: 'Refund outcome unknown — requires manual reconciliation (non-replay-safe gateway)', state: 'provider_ambiguous' };
    const { data: recResult } = await service.rpc('recover_ambiguous_refund', { p_refund_id: existing.id });
    const rec = recResult as Record<string, unknown>;
    if (!rec?.recovered) return { success: false, refundId: existing.id, isDirectSplit, errorMessage: `Recovery failed: ${rec?.reason || 'unknown'}`, state: 'provider_ambiguous' };
    return dispatchAndFinalize(service, existing.id, rec.recovery_token as string, payment, isDirectSplit);
  }

  // pending + dispatched (interrupted) → Tier-1 token-bound recovery; Tier-2 → ambiguous
  if (existing.status === 'pending' && existing.dispatched_at) {
    if (isTier1) {
      const { data: recResult } = await service.rpc('recover_interrupted_dispatch', { p_refund_id: existing.id });
      const rec = recResult as Record<string, unknown>;
      if (!rec?.recovered) return { success: false, refundId: existing.id, isDirectSplit, errorMessage: `Interrupted recovery failed: ${rec?.reason || 'unknown'}`, state: 'provider_ambiguous' };
      return dispatchAndFinalize(service, existing.id, rec.recovery_token as string, payment, isDirectSplit);
    }
    // Tier-2: mark ambiguous
    await service.from('refunds').update({ status: 'provider_ambiguous', gateway_response: { error: 'interrupted_dispatch_tier2' } }).eq('id', existing.id);
    return { success: false, refundId: existing.id, isDirectSplit, errorMessage: 'Interrupted refund — requires manual reconciliation', state: 'provider_ambiguous' };
  }

  // pending + undispatched → dispatch normally
  if (existing.status === 'pending' && !existing.dispatched_at) {
    return dispatchAndFinalize(service, existing.id, null, payment, isDirectSplit);
  }

  // Catchall: return the actual durable state, not 'failed'
  // e.g. provider_pending without provider_refund_id — still provider_pending, not failed
  const durableState = (VALID_REFUND_STATES.has(existing.status as RefundState) ? existing.status : 'failed') as RefundState;
  return { success: false, refundId: existing.id, isDirectSplit, errorMessage: 'A refund for this payment is already being processed', state: durableState };
}

/** Finalize a provider_success_unfinalized refund without calling the provider. */
async function finalizeOnly(service: ReturnType<typeof createServiceClient>, refundId: string, isDirectSplit: boolean): Promise<ProcessRefundResult> {
  const { data: finResult, error: finErr } = await service.rpc('finalize_refund_execution', { p_refund_id: refundId });
  if (finErr) return { success: false, refundId, isDirectSplit, errorMessage: 'Re-finalization failed', state: 'provider_success_unfinalized' };
  const fr = finResult as Record<string, unknown>;
  const finalized = !!fr?.finalized;
  return { success: finalized, refundId, isDirectSplit, state: finalized ? 'success' : 'provider_success_unfinalized' };
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
      return { success: false, refundId, isDirectSplit, errorMessage: 'Gateway does not support refund status query', state: 'provider_pending' };
    }
    // Resolve credential from the persisted provider_connection_id (same as original dispatch)
    let byoSecretKey: string | undefined;
    let connectAccountId: string | undefined;
    const providerConnId = existing.provider_connection_id as string | undefined;
    if (providerConnId) {
      const { data: cred } = await service
        .from('business_payment_credentials')
        .select('secret_key, connect_account_id')
        .eq('id', providerConnId).eq('is_active', true).maybeSingle();
      if (!cred) {
        return { success: false, refundId, isDirectSplit, errorMessage: 'Payment credential not found for reconciliation', state: 'provider_pending' };
      }
      if (cred.secret_key) byoSecretKey = cred.secret_key;
      if (cred.connect_account_id) connectAccountId = cred.connect_account_id;
    }

    const statusResult = await gateway.queryRefundStatus(existing.provider_refund_id as string, {
      byoSecretKey,
      connectAccountId,
    });

    if (statusResult.outcome === 'terminal_success') {
      const { error: recErr } = await service.rpc('reconcile_pending_refund', { p_refund_id: refundId, p_provider_status: statusResult.providerStatus, p_terminal_outcome: 'terminal_success' });
      if (recErr) {
        logger.error(`[REFUND] Reconciliation persistence failed for terminal success ${refundId}: ${recErr.message}`);
        return { success: false, refundId, isDirectSplit, errorMessage: 'Reconciliation persistence failed — refund remains pending, safe to retry', state: 'provider_pending' };
      }
      return finalizeOnly(service, refundId, isDirectSplit);
    }
    if (statusResult.outcome === 'terminal_failure') {
      const { error: recErr } = await service.rpc('reconcile_pending_refund', { p_refund_id: refundId, p_provider_status: statusResult.providerStatus, p_terminal_outcome: 'terminal_failure' });
      if (recErr) {
        logger.error(`[REFUND] Reconciliation persistence failed for terminal failure ${refundId}: ${recErr.message}`);
        return { success: false, refundId, isDirectSplit, errorMessage: 'Reconciliation persistence failed — refund remains pending, safe to retry', state: 'provider_pending' };
      }
      return { success: false, refundId, isDirectSplit, errorMessage: 'Provider confirmed refund failure', state: 'failed' };
    }
    // Still pending — no mutation
    return { success: false, refundId, isDirectSplit, errorMessage: 'Refund still pending at provider', state: 'provider_pending' };
  } catch (err) {
    // Query transport failure — remain provider_pending, no mutation
    logger.warn(`[REFUND] Reconciliation query failed for ${refundId}: ${err}`);
    return { success: false, refundId, isDirectSplit, errorMessage: 'Reconciliation query failed — refund remains pending', state: 'provider_pending' };
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
    // Read the actual durable state — another caller may have advanced it
    const durableState = await readDurableRefundState(service, refundId);
    if (durableState === 'provider_success_unfinalized') return finalizeOnly(service, refundId, isDirectSplit);
    return { success: false, refundId, errorMessage: 'Failed to claim refund for dispatch', state: durableState };
  }

  // Read immutable request parameters from the refund row
  const { data: refRow } = await service
    .from('refunds').select('amount, gateway, refund_type, reason, connect_account_id, provider_connection_id, is_direct_split')
    .eq('id', refundId).single();
  if (!refRow) return { success: false, refundId, errorMessage: 'Refund row not found after claim', state: 'failed' };

  if (refRow.is_direct_split) {
    const { error: dsErr } = await service.from('refunds')
      .update({ status: 'provider_success_unfinalized', gateway_refund_reference: 'direct_split', provider_status: 'direct_split' })
      .eq('id', refundId);
    if (dsErr) return { success: false, refundId, isDirectSplit: true, errorMessage: 'Failed to record direct split state', state: 'failed' };
  } else {
    const gatewayName = (refRow.gateway || 'paystack') as PaymentGatewayName;
    const gateway = getPaymentGatewayByName(gatewayName);

    // Resolve BYO credential from trusted boundary (business_payment_credentials)
    let byoSecretKey: string | undefined;
    let connectAccountId: string | undefined = refRow.connect_account_id || undefined;
    if (refRow.provider_connection_id) {
      const { data: cred } = await service
        .from('business_payment_credentials')
        .select('secret_key, connect_account_id, connection_type')
        .eq('id', refRow.provider_connection_id)
        .eq('is_active', true)
        .maybeSingle();
      if (!cred) {
        // Credential missing/deactivated — fail closed to reconciliation
        const { error: ambErr } = await service.from('refunds')
          .update({ status: 'provider_ambiguous', gateway_response: { error: 'credential_not_found' } })
          .eq('id', refundId);
        if (ambErr) logger.error(`[REFUND] Credential missing AND state write failed: ${refundId}`);
        return { success: false, refundId, isDirectSplit, errorMessage: 'Payment credential not found or deactivated — requires reconciliation', state: 'provider_ambiguous' };
      }
      if (cred.secret_key) byoSecretKey = cred.secret_key;
      if (cred.connect_account_id) connectAccountId = cred.connect_account_id;
    }

    const result = await gateway.refundPayment({
      gatewayReference: payment.gateway_reference as string,
      amount: refRow.refund_type === 'full' ? undefined : Number(refRow.amount),
      currency: ((payment.currency as string) || 'NGN'),
      reason: refRow.reason || undefined,
      connectAccountId,
      byoSecretKey,
      idempotencyKey: refundId,
    });

    // Persist provider refund ID + status — FAIL-SAFE: if this write fails,
    // the row stays pending+dispatched; Tier-1 can safely re-dispatch, Tier-2 requires reconciliation.
    if (result.providerRefundId || result.providerStatus) {
      const { error: refPersistErr } = await service.from('refunds').update({
        provider_refund_id: result.providerRefundId || null,
        provider_status: result.providerStatus || null,
        gateway_refund_reference: result.gatewayRefundReference || result.providerRefundId || null,
        gateway_response: result.gatewayResponse || null,
      }).eq('id', refundId);
      if (refPersistErr) {
        logger.error(`[REFUND] Provider reference persistence failed for ${refundId}: ${refPersistErr.message}`);
        // FAIL-SAFE: do not continue with state transition — reference needed for reconciliation
        return { success: false, refundId, isDirectSplit, errorMessage: 'Provider reference persistence failed — requires recovery', state: 'provider_ambiguous' };
      }
    }

    // Outcome-based state transition — every write is checked
    const outcome: RefundOutcome = result.outcome;

    if (outcome === 'terminal_success') {
      const { error: durErr } = await service.from('refunds')
        .update({ status: 'provider_success_unfinalized' }).eq('id', refundId);
      if (durErr) {
        logger.error(`[REFUND] Provider success but durability write failed: ${refundId}`);
        // Return the actual durable state — the write failed, so DB is still pending+dispatched
        const durableState = await readDurableRefundState(service, refundId);
        return { success: false, refundId, isDirectSplit, errorMessage: 'Provider refund succeeded but state update failed — will be recovered', state: durableState };
      }
    } else if (outcome === 'terminal_failure') {
      const { error: failErr } = await service.from('refunds')
        .update({ status: 'failed' }).eq('id', refundId);
      if (failErr) {
        logger.error(`[REFUND] Failed state write failed: ${refundId}`);
        // FAIL-SAFE: row stays pending+dispatched; reconciliation required
        return { success: false, refundId, isDirectSplit, errorMessage: 'Provider failure confirmed but state persistence failed — requires recovery', state: 'provider_ambiguous' };
      }
      return { success: false, refundId, isDirectSplit, errorMessage: result.errorMessage || 'Gateway refund failed', state: 'failed' };
    } else if (outcome === 'provider_pending') {
      const { error: pendErr } = await service.from('refunds')
        .update({ status: 'provider_pending' }).eq('id', refundId);
      if (pendErr) {
        logger.error(`[REFUND] Provider pending state write failed: ${refundId}`);
        // FAIL-SAFE: row stays pending+dispatched; reconciliation required
        return { success: false, refundId, isDirectSplit, errorMessage: 'Provider accepted but state persistence failed — requires recovery', state: 'provider_ambiguous' };
      }
      return { success: false, refundId, isDirectSplit, errorMessage: 'Refund accepted by provider — awaiting completion', state: 'provider_pending' };
    } else {
      // transport_unknown → provider_ambiguous
      const { error: ambErr } = await service.from('refunds')
        .update({ status: 'provider_ambiguous' }).eq('id', refundId);
      if (ambErr) {
        logger.error(`[REFUND] Ambiguous state write failed: ${refundId}`);
        // FAIL-SAFE: row stays pending+dispatched; reconciliation required
        return { success: false, refundId, isDirectSplit, errorMessage: 'Outcome unknown and state persistence failed — requires recovery', state: 'provider_ambiguous' };
      }
      return { success: false, refundId, isDirectSplit, errorMessage: 'Refund outcome unknown', state: 'provider_ambiguous' };
    }
  }

  // ── Finalize ──
  const { data: finalizeResult, error: finalizeErr } = await service.rpc('finalize_refund_execution', { p_refund_id: refundId });
  if (finalizeErr) {
    logger.withContext({ op: 'refund.finalize', ...safeLogErrorContext(finalizeErr) }).error(`[REFUND] Finalization RPC failed for ${refundId}`);
    return { success: false, refundId, isDirectSplit, errorMessage: 'Refund processed but finalization failed — will be retried', state: 'provider_success_unfinalized' };
  }
  const finResult = finalizeResult as Record<string, unknown>;
  const finalized = !!finResult?.finalized;
  // If finalization didn't complete, return the durable state (provider_success_unfinalized)
  // — never downgrade to 'failed', which is for true terminal failures only
  return { success: finalized, refundId, isDirectSplit, state: finalized ? 'success' : 'provider_success_unfinalized' };
}
