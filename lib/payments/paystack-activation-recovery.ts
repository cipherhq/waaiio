/**
 * Paystack initial-activation recovery (#493).
 *
 * Extracted from the cron handler so both the production route
 * and tests invoke the same implementation.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '@/lib/logger';

export type RecoveryOutcome =
  | 'converged'
  | 'already_converged'
  | 'no_evidence'
  | 'rpc_failed'
  | 'rpc_rejected'
  | 'biz_update_failed';

/**
 * Attempt to recover a stuck Paystack initial subscription activation.
 *
 * Finds successful payment evidence, checks current sub/biz state,
 * calls activate_paid_subscription RPC if needed, and transitions
 * business status. Idempotent and partial-convergence safe.
 */
export async function processPaystackActivationRecovery(
  svc: SupabaseClient,
  subId: string,
  bizId: string,
): Promise<RecoveryOutcome> {
  // Find successful payment evidence
  const { data: evidence } = await svc
    .from('subscription_payments')
    .select('id')
    .eq('subscription_id', subId)
    .eq('status', 'success')
    .eq('gateway', 'paystack')
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (!evidence) return 'no_evidence';

  // Check current state for partial convergence
  const { data: currentSub } = await svc
    .from('subscriptions').select('status').eq('id', subId).single();
  const { data: currentBiz } = await svc
    .from('businesses').select('status').eq('id', bizId).single();

  const subAlreadyActive = currentSub?.status === 'active';
  const bizAlreadyActive = currentBiz?.status === 'active';

  // Fully converged — idempotent no-op
  if (subAlreadyActive && bizAlreadyActive) {
    logger.info('[RECOVERY] Paystack already fully converged', { subId, bizId });
    return 'already_converged';
  }

  // Subscription still pending — attempt RPC activation
  if (!subAlreadyActive) {
    const { data: activationResult, error: activationError } = await svc.rpc(
      'activate_paid_subscription', { p_payment_id: evidence.id },
    );
    if (activationError) {
      logger.error('[RECOVERY] Paystack activation RPC failed', {
        subId, bizId, paymentId: evidence.id, error: String(activationError),
      });
      return 'rpc_failed';
    }
    if (!activationResult || activationResult.activated !== true) {
      logger.warn('[RECOVERY] Paystack activation rejected', {
        subId, bizId, paymentId: evidence.id, reason: activationResult?.reason,
      });
      return 'rpc_rejected';
    }
  }

  // Subscription now active. Complete business status if still pending.
  if (!bizAlreadyActive) {
    const { error: statusErr } = await svc
      .from('businesses')
      .update({ status: 'active' })
      .eq('id', bizId)
      .eq('status', 'pending');
    if (statusErr) {
      logger.warn('[RECOVERY] Paystack business status update failed (retryable)', {
        subId, bizId, error: String(statusErr),
      });
      return 'biz_update_failed';
    }
  }

  logger.info('[RECOVERY] Paystack activation recovered', { subId, bizId });
  return 'converged';
}
