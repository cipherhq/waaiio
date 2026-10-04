import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '@/lib/logger';
import type { PaystackCardAuthorization } from './authority';

export function normalizePaystackCardAuthorization(
  authorizationValue: unknown,
  customerValue: unknown,
): PaystackCardAuthorization | undefined {
  if (!authorizationValue || typeof authorizationValue !== 'object'
      || !customerValue || typeof customerValue !== 'object') return undefined;
  const authorization = authorizationValue as Record<string, unknown>;
  const customer = customerValue as Record<string, unknown>;
  if (authorization.reusable !== true
      || typeof authorization.authorization_code !== 'string' || !authorization.authorization_code
      || typeof customer.email !== 'string' || !customer.email) return undefined;

  const month = authorization.exp_month == null ? null : Number(authorization.exp_month);
  const year = authorization.exp_year == null ? null : Number(authorization.exp_year);
  return {
    authorization_code: authorization.authorization_code,
    customer_code: typeof customer.customer_code === 'string' ? customer.customer_code : null,
    email: customer.email,
    last4: typeof authorization.last4 === 'string' ? authorization.last4 : null,
    brand: typeof authorization.brand === 'string' ? authorization.brand : null,
    exp_month: Number.isInteger(month) ? month : null,
    exp_year: Number.isInteger(year) ? year : null,
    card_type: typeof authorization.card_type === 'string' ? authorization.card_type : null,
    bank: typeof authorization.bank === 'string' ? authorization.bank : null,
    reusable: true,
  };
}

/** Persist through an atomic RPC that validates the canonical payment row. */
export async function persistPaystackCardAuthorization(
  supabase: SupabaseClient,
  paymentId: string,
  amount: number,
  currency: string,
  authorization: PaystackCardAuthorization | undefined,
): Promise<boolean> {
  if (!authorization?.reusable || !authorization.authorization_code || !authorization.email) return false;
  const { data, error } = await supabase.rpc('persist_verified_paystack_card_authorization', {
    p_payment_id: paymentId,
    p_amount: amount,
    p_currency: currency.toUpperCase(),
    p_authorization: authorization,
  });
  if (error) {
    logger.withContext({ op: 'paystack-card-authorization.persist' }).error('[PAYSTACK SAVED CARD] Authorization persistence failed');
    return false;
  }
  return data === true;
}
