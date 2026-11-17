import type { SupabaseClient } from '@supabase/supabase-js';
import { classifyBusinessPaymentCredential, isSharedPlatformPaystackCompatible } from './saved-card-compat';

/**
 * Which Paystack account a business's saved cards live on (#1065).
 * byoBusinessId null = Waaiio's shared account (cards usable at any shared-account
 * business); a business id = that merchant's own Paystack account (cards usable only
 * there, charged with the merchant's current key). Owner decision 2026-11-16: cards
 * stay with the merchant when it re-enters its key; if it moves to a different Paystack
 * account, Paystack refuses the old card and the customer pays by link instead.
 */
export type PaystackSavedCardScope =
  | { eligible: true; byoBusinessId: string | null }
  | { eligible: false; reason: string };

export async function resolvePaystackSavedCardScope(
  supabase: SupabaseClient,
  businessId: string,
): Promise<PaystackSavedCardScope> {
  const shared = await isSharedPlatformPaystackCompatible(supabase, businessId);
  if (shared.compatible) return { eligible: true, byoBusinessId: null };
  if (shared.reason !== 'byo_paystack') return { eligible: false, reason: shared.reason || 'incompatible' };

  const { classification, credential } = await classifyBusinessPaymentCredential(supabase, businessId);
  if (classification !== 'byo' || !credential?.id || credential.gateway !== 'paystack') {
    return { eligible: false, reason: 'byo_paystack_credential_unavailable' };
  }
  return { eligible: true, byoBusinessId: businessId };
}

/** True when a Paystack payment was taken on the account the scope names. */
export function paystackPaymentMatchesSavedCardScope(
  payment: { metadata?: unknown },
  businessId: string,
  scope: { byoBusinessId: string | null },
): boolean {
  const meta = (payment.metadata || {}) as Record<string, unknown>;
  if (scope.byoBusinessId === null) return meta.payment_origin === 'platform';
  return meta.payment_origin === 'byo'
    && meta.byo_business_id === businessId
    && scope.byoBusinessId === businessId;
}

/** Narrow a saved_payment_methods query to the cards that belong to a scope. */
export function withSavedCardScope<Q>(query: Q, scope: { byoBusinessId: string | null }): Q {
  // Unconstrained generic: a structural bound on the Supabase builder type is too deep for tsc.
  const filterable = query as unknown as { is(column: string, value: null): Q; eq(column: string, value: string): Q };
  return scope.byoBusinessId === null
    ? filterable.is('byo_business_id', null)
    : filterable.eq('byo_business_id', scope.byoBusinessId);
}
