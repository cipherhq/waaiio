/**
 * Server-side price authority for a Waaiio plan payment.
 *
 * Mirrors the pricing used by `app/api/onboarding/subscribe/route.ts` when it
 * creates a checkout: the business's country chooses the currency
 * (`resolveCountryGateway`), and `countries.pricing[plan].price` (major units,
 * monthly only) is the plan price. There are no trials, promo codes or
 * discounts on the paid checkout path.
 *
 * `app/api/onboarding/verify/route.ts` uses this to check a provider payment
 * against the real plan price before any subscription row is written, so the
 * stored subscription amount is never copied from an unchecked payment.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveCountryGateway } from '@/lib/payments/gateway-resolver';

export type ExpectedPlanPrice =
  | { ok: true; amountMinor: number; currency: string }
  | { ok: false; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function resolveExpectedPlanPrice(
  service: SupabaseClient,
  businessId: string,
  plan: string,
): Promise<ExpectedPlanPrice> {
  const { data: biz, error: bizErr } = await service
    .from('businesses')
    .select('country_code')
    .eq('id', businessId)
    .single();
  if (bizErr || !biz?.country_code) {
    return { ok: false, reason: 'business_country_unavailable' };
  }

  const countryCode = biz.country_code as string;
  const gatewayResult = await resolveCountryGateway(service, countryCode);
  if (!gatewayResult.gateway) {
    return { ok: false, reason: gatewayResult.reason };
  }

  const { data: countryRow, error: countryErr } = await service
    .from('countries')
    .select('pricing')
    .eq('code', countryCode)
    .eq('is_active', true)
    .single();
  if (countryErr || !countryRow || !isRecord(countryRow.pricing)) {
    return { ok: false, reason: 'regional_pricing_unavailable' };
  }

  const tierPricing = countryRow.pricing[plan];
  if (!isRecord(tierPricing) || typeof tierPricing.price !== 'number' || tierPricing.price <= 0) {
    return { ok: false, reason: 'plan_pricing_unavailable' };
  }

  return {
    ok: true,
    // Subscribe sends `price * 100` to the provider; round to whole minor units.
    amountMinor: Math.round(tierPricing.price * 100),
    currency: gatewayResult.currency.toUpperCase(),
  };
}
