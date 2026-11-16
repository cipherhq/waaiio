import type { SupabaseClient } from '@supabase/supabase-js';
import { classifyBusinessPaymentCredential, isSharedPlatformPaystackCompatible } from './saved-card-compat';

/**
 * Which Paystack account a business's saved cards live on (#1065).
 * credentialId null = Waaiio's shared account (cards usable at any shared-account
 * business); a credential id = that merchant's own Paystack connection (cards usable
 * only there, charged with that merchant's key).
 */
export type PaystackSavedCardScope =
  | { eligible: true; credentialId: string | null }
  | { eligible: false; reason: string };

export async function resolvePaystackSavedCardScope(
  supabase: SupabaseClient,
  businessId: string,
): Promise<PaystackSavedCardScope> {
  const shared = await isSharedPlatformPaystackCompatible(supabase, businessId);
  if (shared.compatible) return { eligible: true, credentialId: null };
  if (shared.reason !== 'byo_paystack') return { eligible: false, reason: shared.reason || 'incompatible' };

  const { classification, credential } = await classifyBusinessPaymentCredential(supabase, businessId);
  if (classification !== 'byo' || !credential?.id || credential.gateway !== 'paystack') {
    return { eligible: false, reason: 'byo_paystack_credential_unavailable' };
  }
  return { eligible: true, credentialId: credential.id };
}

/** True when a Paystack payment was taken on exactly the account the scope names. */
export function paystackPaymentMatchesSavedCardScope(
  payment: { metadata?: unknown },
  businessId: string,
  scope: { credentialId: string | null },
): boolean {
  const meta = (payment.metadata || {}) as Record<string, unknown>;
  if (scope.credentialId === null) return meta.payment_origin === 'platform';
  return meta.payment_origin === 'byo'
    && meta.byo_business_id === businessId
    && meta.provider_connection_id === scope.credentialId;
}

/** Narrow a saved_payment_methods query to the cards that belong to a scope. */
export function withSavedCardScope<Q>(query: Q, scope: { credentialId: string | null }): Q {
  // Unconstrained generic: a structural bound on the Supabase builder type is too deep for tsc.
  const filterable = query as unknown as { is(column: string, value: null): Q; eq(column: string, value: string): Q };
  return scope.credentialId === null
    ? filterable.is('provider_credential_id', null)
    : filterable.eq('provider_credential_id', scope.credentialId);
}
