import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';

/**
 * Public-safe pricing projection — #270
 *
 * Reads authoritative commercial state via service client and returns
 * an exact allowlisted DTO. No raw config_snapshot, no generic
 * platform_settings rows, no internal fee-policy fields.
 *
 * Fail-closed: returns 503 if any authoritative read fails.
 */

// Category labels for customer-facing presentation
const CATEGORY_LABELS: Record<string, string> = {
  scheduling: 'Appointments & Scheduling',
  reservation: 'Reservations',
  ticketing: 'Events & Tickets',
  ordering: 'Orders & Delivery',
  invoice: 'Invoices',
  giving: 'Donations & Giving',
  payment: 'Payments',
  recurring: 'Recurring Payments',
};

export const revalidate = 60; // ISR — revalidate every 60s

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const countryCode = (searchParams.get('country') || 'NG').toUpperCase().slice(0, 4);

    const supabase = createServiceClient();

    // 1. Read latest effective config snapshot
    const { data: versionRow, error: versionError } = await supabase
      .from('platform_config_versions')
      .select('id, config_snapshot')
      .lte('effective_from', new Date().toISOString())
      .order('effective_from', { ascending: false })
      .limit(1)
      .single();

    if (versionError || !versionRow?.config_snapshot) {
      console.error('[public/pricing] Failed to read config version:', versionError?.message);
      return NextResponse.json(
        { error: 'pricing_unavailable', message: 'Pricing information is temporarily unavailable. Please try again.' },
        { status: 503 },
      );
    }

    const snapshot = versionRow.config_snapshot as Record<string, unknown>;

    // 2. Read the requested country row
    const { data: countryRow, error: countryError } = await supabase
      .from('countries')
      .select('code, name, currency_code, currency_symbol, currency_locale, flag, pricing, payment_gateway')
      .eq('code', countryCode)
      .eq('is_active', true)
      .single();

    if (countryError || !countryRow?.pricing) {
      console.error('[public/pricing] Failed to read country:', countryCode, countryError?.message);
      return NextResponse.json(
        { error: 'pricing_unavailable', message: 'Pricing information is temporarily unavailable for this region.' },
        { status: 503 },
      );
    }

    // 3. Read all active countries for the country picker
    const { data: allCountries, error: countriesError } = await supabase
      .from('countries')
      .select('code, name, currency_code, currency_symbol, currency_locale, flag, pricing, payment_gateway')
      .eq('is_active', true)
      .order('sort_order', { ascending: true });

    if (countriesError || !allCountries?.length) {
      console.error('[public/pricing] Failed to read countries list:', countriesError?.message);
      return NextResponse.json(
        { error: 'pricing_unavailable', message: 'Pricing information is temporarily unavailable.' },
        { status: 503 },
      );
    }

    // 4. Extract ONLY safe fields from snapshot — field-by-field, no spread
    const trialDays = typeof snapshot.trial_days === 'number' ? snapshot.trial_days : null;
    if (trialDays === null) {
      console.error('[public/pricing] trial_days missing or invalid in config snapshot');
      return NextResponse.json(
        { error: 'pricing_unavailable', message: 'Pricing configuration is incomplete.' },
        { status: 503 },
      );
    }

    const annualDiscountPercentage = typeof snapshot.annual_discount_percentage === 'number'
      ? snapshot.annual_discount_percentage
      : null;
    if (annualDiscountPercentage === null) {
      console.error('[public/pricing] annual_discount_percentage missing or invalid in config snapshot');
      return NextResponse.json(
        { error: 'pricing_unavailable', message: 'Pricing configuration is incomplete.' },
        { status: 503 },
      );
    }

    // Extract tier fee presentation from snapshot.pricing_tiers
    const snapshotTiers = snapshot.pricing_tiers as Record<string, Record<string, unknown>> | undefined;
    const tierFees: Record<string, { feePercentage: number }> = {};
    if (snapshotTiers && typeof snapshotTiers === 'object') {
      for (const tier of ['free', 'growth', 'business'] as const) {
        const t = snapshotTiers[tier];
        if (t && typeof t.feePercentage === 'number') {
          tierFees[tier] = { feePercentage: t.feePercentage };
        }
      }
    }
    if (!tierFees.free || !tierFees.growth || !tierFees.business) {
      console.error('[public/pricing] Incomplete tier fee data in config snapshot');
      return NextResponse.json(
        { error: 'pricing_unavailable', message: 'Pricing configuration is incomplete.' },
        { status: 503 },
      );
    }

    // 5. Extract safe category fee rates (percentage only, with labels)
    const rawCategoryRates = snapshot.category_fee_rates as Record<string, Record<string, unknown>> | undefined;
    const categoryFees: Record<string, { label: string; feePercentage: number }> = {};
    if (rawCategoryRates && typeof rawCategoryRates === 'object') {
      for (const [cat, val] of Object.entries(rawCategoryRates)) {
        if (val && typeof val === 'object' && typeof val.feePercentage === 'number' && CATEGORY_LABELS[cat]) {
          categoryFees[cat] = {
            label: CATEGORY_LABELS[cat],
            feePercentage: val.feePercentage,
          };
        }
      }
    }

    // 6. Build safe country pricing projection
    const countryPricing = (countryRow.pricing as Record<string, Record<string, unknown>>) || {};
    const safeCountryPricing: Record<string, { price: number; feeFlat: number; feePercentage: number }> = {};
    for (const tier of ['free', 'growth', 'business'] as const) {
      const tp = countryPricing[tier];
      if (tp && typeof tp.price === 'number' && typeof tp.feeFlat === 'number' && typeof tp.feePercentage === 'number') {
        safeCountryPricing[tier] = {
          price: tp.price,
          feeFlat: tp.feeFlat,
          feePercentage: tp.feePercentage,
        };
      }
    }

    // 7. Build safe countries list for picker
    const safeCountries = allCountries.map(c => ({
      code: c.code as string,
      name: c.name as string,
      currencyCode: c.currency_code as string,
      currencySymbol: c.currency_symbol as string,
      currencyLocale: c.currency_locale as string,
      flag: c.flag as string,
      gateway: c.payment_gateway as string,
      pricing: (() => {
        const p = (c.pricing as Record<string, Record<string, unknown>>) || {};
        const result: Record<string, { price: number; feeFlat: number; feePercentage: number }> = {};
        for (const tier of ['free', 'growth', 'business'] as const) {
          const tp = p[tier];
          if (tp && typeof tp.price === 'number' && typeof tp.feeFlat === 'number' && typeof tp.feePercentage === 'number') {
            result[tier] = { price: tp.price, feeFlat: tp.feeFlat, feePercentage: tp.feePercentage };
          }
        }
        return result;
      })(),
    }));

    // 8. Return exact allowlisted DTO — no extra keys
    return NextResponse.json({
      trialDays,
      annualDiscountPercentage,
      tierFees,
      categoryFees,
      byoFeePolicy: '0% Waaiio fee when you bring your own payment gateway',
      country: {
        code: countryRow.code,
        name: countryRow.name,
        currencyCode: countryRow.currency_code,
        currencySymbol: countryRow.currency_symbol,
        currencyLocale: countryRow.currency_locale,
        flag: countryRow.flag,
        gateway: countryRow.payment_gateway,
        pricing: safeCountryPricing,
      },
      countries: safeCountries,
    });
  } catch (error) {
    console.error('[public/pricing] Unexpected error:', error);
    return NextResponse.json(
      { error: 'pricing_unavailable', message: 'Pricing information is temporarily unavailable.' },
      { status: 503 },
    );
  }
}
