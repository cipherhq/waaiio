/**
 * Flutterwave Renewal Decision Logic
 *
 * Extracted from the retry-failed-charges cron for testability.
 * Both the production cron and tests call this same helper.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { chargeToken, verifyTransaction } from './flutterwave-recurring';
import { logger } from '@/lib/logger';

export interface FlwRenewalDeps {
  supabase: SupabaseClient;
  chargeTokenFn?: typeof chargeToken;
  verifyTransactionFn?: typeof verifyTransaction;
}

export interface FlwRenewalResult {
  action: 'finalized' | 'failure_recorded' | 'skipped' | 'error';
  reason?: string;
  failureCount?: number;
  paymentId?: string;
}

/**
 * Process a single Flutterwave subscription renewal.
 * Handles claim, reconciliation, charge, verification, and finalization.
 */
export async function processFlutterwaveRenewal(
  deps: FlwRenewalDeps,
  sub: {
    id: string;
    business_id: string;
    amount: number;
    currency: string;
    authorization_code: string;
    customer_email: string;
    customer_phone: string;
    service_id: string | null;
    frequency: string;
    failure_count: number;
  },
  splitParams?: Record<string, unknown>,
): Promise<FlwRenewalResult> {
  const { supabase } = deps;
  const charge = deps.chargeTokenFn || chargeToken;
  const verify = deps.verifyTransactionFn || verifyTransaction;

  // Step 1: Claim
  const { data: claim } = await supabase.rpc('claim_recurring_billing_cycle', {
    p_subscription_id: sub.id,
  });

  if (!claim?.claimed) {
    return { action: 'skipped', reason: claim?.reason || 'claim_failed' };
  }

  const stableRef = claim.stable_ref as string;
  const attemptRef = claim.attempt_ref as string;

  try {
    let providerSucceeded = false;

    // Step 2: Reconcile if recovered
    if (claim.recovered && !claim.provider_verified) {
      const reconciliation = await verify(attemptRef);
      if (reconciliation?.outcome === 'successful') {
        providerSucceeded = true;
        await supabase.from('processed_webhook_events')
          .update({ status: 'provider_success' })
          .eq('event_id', stableRef);
      } else if (reconciliation === null || reconciliation.outcome === 'pending' || reconciliation.outcome === 'unknown') {
        return { action: 'skipped', reason: `reconciliation_${reconciliation?.outcome || 'timeout'}` };
      }
      // else: failed → retry below
    } else if (claim.recovered && claim.provider_verified) {
      providerSucceeded = true;
    }

    // Step 3: Charge if needed
    if (!providerSucceeded) {
      const result = await charge(
        sub.authorization_code, sub.amount,
        sub.customer_email, attemptRef,
        sub.currency,
        splitParams as any,
      );

      if (result.outcome === 'successful') {
        providerSucceeded = true;
        await supabase.from('processed_webhook_events')
          .update({ status: 'provider_success' })
          .eq('event_id', stableRef);
      } else if (result.outcome === 'pending' || result.outcome === 'unknown') {
        return { action: 'skipped', reason: `charge_${result.outcome}` };
      }
      // else: outcome === 'failed' → definitive failure handled below
    }

    // Step 4: Finalize or record failure
    if (providerSucceeded) {
      const verification = await verify(attemptRef);
      if (!verification || verification.outcome !== 'successful'
        || Math.abs((verification.amount || 0) - sub.amount) > 0.01
        || (verification.currency || '').toUpperCase() !== (sub.currency || 'NGN').toUpperCase()) {
        return { action: 'error', reason: 'verification_failed' };
      }

      const { data: finResult } = await supabase.rpc('finalize_token_recurring_charge', {
        p_stable_ref: stableRef,
        p_subscription_id: sub.id,
        p_verified_amount: sub.amount,
        p_verified_currency: sub.currency || 'NGN',
        p_gateway: 'flutterwave',
      });

      if (finResult?.success) {
        return { action: 'finalized', paymentId: finResult.payment_id };
      }
      return { action: 'error', reason: 'finalize_failed' };
    } else {
      // Definitive failure — use atomic RPC (sole authority)
      const { data: failResult } = await supabase.rpc('record_flutterwave_definitive_failure', {
        p_subscription_id: sub.id,
        p_stable_ref: stableRef,
      });

      if (failResult?.recorded) {
        return { action: 'failure_recorded', failureCount: failResult.failure_count };
      }
      return { action: 'skipped', reason: failResult?.reason || 'failure_not_recorded' };
    }
  } catch (err) {
    // Internal error — do NOT count as payment failure
    logger.error('[FLW-RENEWAL] Internal error', err);
    return { action: 'error', reason: 'internal_exception' };
  }
}
