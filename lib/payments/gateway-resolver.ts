/**
 * Canonical payment gateway resolver.
 *
 * Authority chain:
 *   1. Explicit BYO/dedicated business gateway (when configured and valid)
 *   2. Country-default from `countries.payment_gateway`
 *   3. Fail closed — no silent fallback to any provider
 *
 * Every payment surface (Scan to Pay, bot flows, onboarding, orders, etc.)
 * must use this resolver instead of reading `businesses.payment_gateway`
 * directly with a hardcoded fallback.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { PaymentGatewayName } from '@/lib/constants';

export interface GatewayResolution {
  gateway: PaymentGatewayName;
  currency: string;
  source: 'business_override' | 'country_default';
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
    .select('payment_gateway, country_code')
    .eq('id', businessId)
    .single();

  if (bizErr || !biz) {
    return { gateway: null, currency: null, source: null, reason: 'business_not_found' };
  }

  // 1. If business has an explicitly configured gateway override, use it
  if (biz.payment_gateway && VALID_GATEWAYS.has(biz.payment_gateway)) {
    // Still need currency from country
    const currency = await resolveCountryCurrency(supabase, biz.country_code);
    if (!currency) {
      return { gateway: null, currency: null, source: null, reason: 'country_currency_not_configured' };
    }
    return {
      gateway: biz.payment_gateway as PaymentGatewayName,
      currency,
      source: 'business_override',
    };
  }

  // 2. Fall back to country default
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

/**
 * Resolve just the currency for a country (used when business override
 * provides the gateway but currency comes from country config).
 */
async function resolveCountryCurrency(
  supabase: SupabaseClient,
  countryCode: string | null,
): Promise<string | null> {
  if (!countryCode) return null;
  const { data } = await supabase
    .from('countries')
    .select('currency_code')
    .eq('code', countryCode)
    .eq('is_active', true)
    .single();
  return data?.currency_code ?? null;
}

/**
 * Idempotent reconciliation: assign the canonical country-default gateway
 * to businesses that have a valid country but NULL payment_gateway.
 *
 * Returns the count of businesses updated.
 * Safe to call repeatedly — only touches rows where payment_gateway IS NULL.
 */
export async function reconcileNullGateways(
  supabase: SupabaseClient,
): Promise<{ updated: number; errors: string[] }> {
  // Get all active countries with configured gateways
  const { data: countries, error: countriesErr } = await supabase
    .from('countries')
    .select('code, payment_gateway')
    .eq('is_active', true)
    .not('payment_gateway', 'is', null);

  if (countriesErr || !countries) {
    return { updated: 0, errors: ['Failed to load countries'] };
  }

  let updated = 0;
  const errors: string[] = [];

  for (const country of countries) {
    const { data: rows, error: updateErr } = await supabase
      .from('businesses')
      .update({ payment_gateway: country.payment_gateway })
      .eq('country_code', country.code)
      .is('payment_gateway', null)
      .select('id');

    if (updateErr) {
      errors.push(`${country.code}: ${updateErr.message}`);
    } else {
      updated += rows?.length ?? 0;
    }
  }

  return { updated, errors };
}
