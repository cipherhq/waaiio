/**
 * Canonical payment gateway resolver.
 *
 * Binding rule: Country chooses processor. Merchant/BYO configuration
 * chooses credentials/account only — never the processor.
 *
 * Authority:
 *   1. Country config from `countries.payment_gateway` — sole processor authority
 *   2. Fail closed — no silent fallback to any provider
 *
 * BYO/dedicated merchant credentials are handled separately (credential
 * selection, not processor selection). They do NOT override the country
 * processor. An NG business always uses Paystack regardless of what
 * `businesses.payment_gateway` says.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { PaymentGatewayName } from '@/lib/constants';

export interface GatewayResolution {
  gateway: PaymentGatewayName;
  currency: string;
  source: 'country_default';
}

export interface GatewayResolutionError {
  gateway: null;
  currency: null;
  source: null;
  reason: string;
}

export type GatewayResult = GatewayResolution | GatewayResolutionError;

const VALID_GATEWAYS: ReadonlySet<string> = new Set([
  'paystack', 'stripe', 'flutterwave', 'square', 'paypal',
]);

/**
 * Resolve the canonical payment gateway for a business.
 *
 * Reads the business's country_code, then resolves gateway + currency
 * from the canonical countries table. BYO/merchant credentials do NOT
 * affect processor selection.
 *
 * @param supabase — any Supabase client (service or RLS-aware)
 * @param businessId — the business UUID
 * @returns resolved gateway + currency + source, or an error with reason
 */
export async function resolveBusinessGateway(
  supabase: SupabaseClient,
  businessId: string,
): Promise<GatewayResult> {
  const { data: biz, error: bizErr } = await supabase
    .from('businesses')
    .select('country_code')
    .eq('id', businessId)
    .single();

  if (bizErr || !biz) {
    return { gateway: null, currency: null, source: null, reason: 'business_not_found' };
  }

  // Country is the sole processor authority
  return resolveCountryGateway(supabase, biz.country_code);
}

/**
 * Resolve gateway + currency from the canonical `countries` table.
 * Used during onboarding to persist the inherited default.
 */
export async function resolveCountryGateway(
  supabase: SupabaseClient,
  countryCode: string | null,
): Promise<GatewayResult> {
  if (!countryCode) {
    return { gateway: null, currency: null, source: null, reason: 'no_country_code' };
  }

  const { data: country, error: countryErr } = await supabase
    .from('countries')
    .select('payment_gateway, currency_code')
    .eq('code', countryCode)
    .eq('is_active', true)
    .single();

  if (countryErr || !country) {
    return { gateway: null, currency: null, source: null, reason: 'country_not_found_or_inactive' };
  }

  if (!country.payment_gateway || !VALID_GATEWAYS.has(country.payment_gateway)) {
    return { gateway: null, currency: null, source: null, reason: 'country_gateway_not_configured' };
  }

  if (!country.currency_code) {
    return { gateway: null, currency: null, source: null, reason: 'country_currency_not_configured' };
  }

  return {
    gateway: country.payment_gateway as PaymentGatewayName,
    currency: country.currency_code as string,
    source: 'country_default',
  };
}

// reconcileNullGateways removed (#493 Correction A) — unbounded all-business
// mutation path is prohibited. Use the bounded admin endpoint
// POST /api/admin/reconcile-gateways instead.
