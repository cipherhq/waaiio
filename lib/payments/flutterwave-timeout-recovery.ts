/**
 * Flutterwave subscription checkout timeout-recovery orchestration (M378 Phase 1).
 *
 * Extracted production orchestration function called by the actual subscribe route.
 * Handles the timeout boundary path: discover → verify → decide → finalize/replace/retain.
 *
 * This exact function is tested by the production orchestration test suite.
 */

import { discoverAndVerifyTransaction } from '@/lib/payments/flutterwave-verify';
import { correlateProviderSubscription } from '@/lib/payments/flutterwave-subscription';
import {
  decideTimeoutRecovery,
  decideSubscriptionCorrelation,
  decideFinalizerResult,
} from '@/lib/payments/flutterwave-decisions';

export type TimeoutRecoveryResult =
  | { outcome: 'finalized'; reference: string }
  | { outcome: 'replaced' }
  | { outcome: 'replacement_failed' }
  | { outcome: 'retained'; checkoutUrl: string; reference: string }
  | { outcome: 'unavailable' }
  | { outcome: 'finalization_failed' }
  | { outcome: 'subscription_pending' };

export interface TimeoutRecoveryInput {
  intentId: string;
  idempotencyKey: string;
  intentCreatedAt: string;
  providerCheckoutUrl: string;
  flutterwaveKey: string;
  /** Parameters for replace_terminal_checkout_intent */
  replaceParams: {
    businessId: string;
    plan: string;
    currency: string;
    amount: number;
    providerPlanRef: string;
    configVersionId: string;
    subscriberEmail: string;
    actorId: string;
  };
}

/**
 * Production timeout-recovery orchestration.
 *
 * The subscribe route calls this exact function. It performs:
 * 1. discoverAndVerifyTransaction with bounded window
 * 2. decideTimeoutRecovery
 * 3. On finalize: correlateProviderSubscription → finalize_flutterwave_subscription_checkout RPC
 * 4. On replace: replace_terminal_checkout_intent RPC
 * 5. On retain: return existing checkout URL
 *
 * All Supabase RPCs are performed via the passed service client.
 */
export async function executeTimeoutRecovery(
  service: {
    rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;
  },
  input: TimeoutRecoveryInput,
): Promise<TimeoutRecoveryResult> {
  // Step 1: Discover and verify the provider transaction state
  const verifyResult = await discoverAndVerifyTransaction(
    input.idempotencyKey,
    input.flutterwaveKey,
    {
      fromDate: input.intentCreatedAt,
      toDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
    },
  );

  // Step 2: Production decision
  const timeoutDecision = decideTimeoutRecovery(verifyResult);

  if (timeoutDecision.action === 'fail_closed') {
    return { outcome: 'unavailable' };
  }

  // Step 3a: Finalize — customer paid, finalize the ORIGINAL intent
  if (timeoutDecision.action === 'finalize') {
    const subCorrelation = await correlateProviderSubscription(
      timeoutDecision.tx.id,
      input.flutterwaveKey,
    );
    const subDecision = decideSubscriptionCorrelation(subCorrelation);
    if (subDecision.action === 'fail_closed') {
      return { outcome: 'subscription_pending' };
    }

    const verifiedAmountMinor = Math.round(timeoutDecision.tx.amount * 100);
    const { data: finResult, error: finErr } = await service.rpc(
      'finalize_flutterwave_subscription_checkout',
      {
        p_intent_id: input.intentId,
        p_provider_tx_id: String(timeoutDecision.tx.id),
        p_provider_subscription_id: subDecision.subscriptionId,
        p_provider_plan_id: subDecision.planId,
        p_verified_amount_minor: verifiedAmountMinor,
        p_verified_currency: timeoutDecision.tx.currency,
        p_provider_paid_at: timeoutDecision.tx.created_at,
      },
    );

    const finDecision = decideFinalizerResult(
      finResult as Record<string, unknown> | null,
      finErr,
    );
    if (finDecision.action !== 'success') {
      return { outcome: 'finalization_failed' };
    }

    return { outcome: 'finalized', reference: input.idempotencyKey };
  }

  // Step 3b: Replace — provider transaction is definitively terminal
  if (timeoutDecision.action === 'replace') {
    const { replaceParams: rp } = input;
    const { data: replacement } = await service.rpc('replace_terminal_checkout_intent', {
      p_old_intent_id: input.intentId,
      p_business_id: rp.businessId,
      p_plan: rp.plan,
      p_gateway: 'flutterwave',
      p_currency: rp.currency,
      p_amount: rp.amount,
      p_provider_plan_ref: rp.providerPlanRef,
      p_config_version_id: rp.configVersionId,
      p_subscriber_email: rp.subscriberEmail,
      p_session_duration: 30,
      p_actor_id: rp.actorId,
    });

    const newClaim = (replacement as Record<string, unknown>[])?.[0];
    if (!newClaim) {
      return { outcome: 'replacement_failed' };
    }
    return { outcome: 'replaced' };
  }

  // Step 3c: Retain — checkout may still be live
  return {
    outcome: 'retained',
    checkoutUrl: input.providerCheckoutUrl,
    reference: input.idempotencyKey,
  };
}
