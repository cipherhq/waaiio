/**
 * Subscription activation helpers — shared by Stripe and Paystack webhook handlers.
 *
 * These are the PRODUCTION activation decision functions.
 * Tests execute these exact functions.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '@/lib/logger';

export type ActivationOutcome =
  | { result: 'activated'; subscriptionId: string }
  | { result: 'idempotent'; subscriptionId: string }
  | { result: 'db_error'; detail: string }
  | { result: 'inconsistent'; detail: string }
  | { result: 'ambiguous'; count: number }
  | { result: 'skipped'; detail: string };

/**
 * Stripe: activate a pending subscription by Checkout Session correlation.
 * Replaces the temporary cs_... with the real sub_... ID.
 */
export async function activateStripeSubscription(
  supabase: SupabaseClient,
  sessionId: string,
  stripeSubId: string,
): Promise<ActivationOutcome> {
  // Step 1: Conditional pending→active update
  const { data: activated, error: activateError } = await supabase
    .from('customer_subscriptions')
    .update({ status: 'active', gateway_subscription_code: stripeSubId })
    .eq('gateway_subscription_code', sessionId)
    .eq('status', 'pending')
    .select('id');

  if (activateError) {
    logger.error('[STRIPE ACTIVATION] DB error on pending→active update', { op: 'stripe-activation' });
    return { result: 'db_error', detail: 'activation update failed' };
  }

  if (activated && activated.length > 0) {
    logger.info(`[STRIPE ACTIVATION] Subscription activated: ${stripeSubId}`);
    return { result: 'activated', subscriptionId: activated[0].id };
  }

  // Step 2: Zero rows — check for idempotent replay
  const { data: existing, error: lookupError } = await supabase
    .from('customer_subscriptions')
    .select('id, status')
    .eq('gateway_subscription_code', stripeSubId)
    .eq('status', 'active')
    .maybeSingle();

  if (lookupError) {
    logger.error('[STRIPE ACTIVATION] DB error on already-active lookup', { op: 'stripe-activation-idempotent' });
    return { result: 'db_error', detail: 'idempotent lookup failed' };
  }

  if (existing) {
    logger.info(`[STRIPE ACTIVATION] Already active (idempotent): ${stripeSubId}`);
    return { result: 'idempotent', subscriptionId: existing.id };
  }

  logger.error('[STRIPE ACTIVATION] No pending or active subscription — inconsistent', { op: 'stripe-activation-inconsistent' });
  return { result: 'inconsistent', detail: `No subscription for session ${sessionId}` };
}

/**
 * Paystack: activate a pending subscription by exact payment_reference correlation.
 * Requires reusable authorization.
 */
export async function activatePaystackSubscription(
  supabase: SupabaseClient,
  chargeReference: string,
  authUpdate: {
    authorization_code: string;
    card_last_four: string | null;
    card_brand: string | null;
    gateway_customer_code: string | null;
  },
): Promise<ActivationOutcome> {
  // Step 1: Find pending subscriptions matching the setup reference
  const { data: exactMatch, error: lookupError } = await supabase
    .from('customer_subscriptions')
    .select('id')
    .eq('gateway', 'paystack')
    .eq('status', 'pending')
    .is('authorization_code', null)
    .contains('metadata', { payment_reference: chargeReference });

  if (lookupError) {
    logger.error('[PAYSTACK ACTIVATION] Lookup DB error', { op: 'paystack-activation-lookup' });
    return { result: 'db_error', detail: 'pending lookup failed' };
  }

  if (!exactMatch || exactMatch.length === 0) {
    return { result: 'skipped', detail: 'no pending subscription for this reference' };
  }

  if (exactMatch.length > 1) {
    logger.error('[PAYSTACK ACTIVATION] Ambiguous: multiple pending for same reference', { op: 'paystack-activation-ambiguous', count: exactMatch.length });
    return { result: 'ambiguous', count: exactMatch.length };
  }

  // Step 2: Activate the exactly one matching row
  const targetId = exactMatch[0].id;
  const { data: activated, error: activateError } = await supabase
    .from('customer_subscriptions')
    .update({ ...authUpdate, status: 'active' })
    .eq('id', targetId)
    .eq('status', 'pending')
    .select('id');

  if (activateError) {
    logger.error('[PAYSTACK ACTIVATION] UPDATE DB error', { op: 'paystack-activation-update' });
    return { result: 'db_error', detail: 'activation update failed' };
  }

  if (activated && activated.length > 0) {
    logger.info(`[PAYSTACK ACTIVATION] Activated: ${activated[0].id}`);
    return { result: 'activated', subscriptionId: activated[0].id };
  }

  // Step 3: Zero rows — check idempotent replay
  const { data: alreadyActive, error: replayLookupError } = await supabase
    .from('customer_subscriptions')
    .select('id')
    .eq('id', targetId)
    .eq('status', 'active')
    .maybeSingle();

  if (replayLookupError) {
    logger.error('[PAYSTACK ACTIVATION] Already-active lookup DB error', { op: 'paystack-activation-idempotent' });
    return { result: 'db_error', detail: 'idempotent lookup failed' };
  }

  if (alreadyActive) {
    logger.info(`[PAYSTACK ACTIVATION] Already active (idempotent): ${alreadyActive.id}`);
    return { result: 'idempotent', subscriptionId: alreadyActive.id };
  }

  logger.error('[PAYSTACK ACTIVATION] Finalization inconsistent', { op: 'paystack-activation-inconsistent' });
  return { result: 'inconsistent', detail: 'activation target not found in expected state' };
}
