/**
 * #605: Reconcile Flutterwave attempts that existed when cancellation happened.
 *
 * This path deliberately has NO chargeToken dependency. It may verify an
 * existing attempt and finalize a proven provider success, never start a new
 * debit or count an unknown provider outcome as a customer failure.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { verifyTransaction } from './flutterwave-recurring';
import { logger } from '@/lib/logger';

export interface CancelledFlwClaim {
  stable_ref: string;
  attempt_ref: string;
  claim_status: string;
  subscription_id: string;
  amount: number;
  currency: string | null;
}

export interface CancelledFlwReconcileDeps {
  supabase: SupabaseClient;
  verifyTransactionFn?: typeof verifyTransaction;
}

export interface CancelledFlwReconcileResult {
  action: 'finalized' | 'skipped' | 'error';
  reason?: string;
  paymentId?: string;
}

/** Idempotent, verification-only recovery. The DB RPC selects only cancelled subscriptions. */
export async function reconcileCancelledFlutterwaveClaim(
  deps: CancelledFlwReconcileDeps,
  claim: CancelledFlwClaim,
): Promise<CancelledFlwReconcileResult> {
  const { supabase } = deps;
  const verify = deps.verifyTransactionFn || verifyTransaction;
  const stableRef = claim.stable_ref;
  const attemptRef = claim.attempt_ref;
  const expectedPrefix = `flw-${claim.subscription_id}-`;
  const datePart = stableRef?.startsWith(expectedPrefix)
    ? stableRef.slice(expectedPrefix.length)
    : '';
  const attemptSuffix = attemptRef?.startsWith(`${stableRef}-a`)
    ? attemptRef.slice(`${stableRef}-a`.length)
    : '';

  // Never trust a claim's provider reference without checking both bindings.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datePart) ||
      !/^[1-9]\d*$/.test(attemptSuffix) ||
      !['claimed', 'provider_success'].includes(claim.claim_status) ||
      !Number.isFinite(claim.amount) || claim.amount <= 0 ||
      !claim.currency) {
    return { action: 'skipped', reason: 'invalid_existing_claim' };
  }

  try {
    // Advance the bounded DB queue even if the provider still reports pending.
    // No new claim or charge is created by this update.
    const { data: touched, error: touchError } = await supabase
      .from('processed_webhook_events')
      .update({ last_attempted_at: new Date().toISOString() })
      .eq('event_id', stableRef)
      .eq('gateway', 'flutterwave')
      .eq('event_type', 'token_renewal')
      .eq('status', claim.claim_status)
      .eq('last_error', attemptRef)
      .select('event_id')
      .maybeSingle();
    if (touchError) return { action: 'error', reason: 'claim_rotation_failed' };
    if (!touched) return { action: 'skipped', reason: 'claim_changed' };

    // This is a read-only provider verification, NOT chargeToken.
    const verification = await verify(attemptRef);
    if (!verification || verification.outcome !== 'successful') {
      return { action: 'skipped', reason: `provider_${verification?.outcome || 'unknown'}` };
    }
    const verifiedAmount = verification.amount ?? NaN;
    if (verification.providerTxRef !== attemptRef ||
        !Number.isFinite(verifiedAmount) ||
        Math.abs(verifiedAmount - claim.amount) > 0.01 ||
        (verification.currency || '').toUpperCase() !== claim.currency.toUpperCase()) {
      return { action: 'error', reason: 'provider_identity_or_amount_mismatch' };
    }

    // The existing finalizer serializes on the claim row, verifies accounting
    // identity, and is idempotent on already completed cycles.
    const { data: finalized, error: finalizerError } = await supabase.rpc(
      'finalize_token_recurring_charge', {
        p_stable_ref: stableRef,
        p_subscription_id: claim.subscription_id,
        p_verified_amount: claim.amount,
        p_verified_currency: claim.currency,
        p_gateway: 'flutterwave',
        p_provider_attempt_ref: attemptRef,
      },
    );
    if (finalizerError || !finalized?.success) {
      return { action: 'error', reason: 'finalization_failed' };
    }
    return { action: 'finalized', paymentId: finalized.payment_id };
  } catch (error) {
    logger.error('[FLW-RECONCILE] Existing cancelled attempt reconciliation error', error);
    return { action: 'error', reason: 'reconciliation_exception' };
  }
}
