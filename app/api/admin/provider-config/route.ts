/**
 * POST /api/admin/provider-config
 *
 * Admin-only route for provider configuration: saving plan refs and switching providers.
 *
 * Actions:
 * - save_refs: Save provider plan references after preflight verification
 * - switch_provider: Switch a country's payment provider after preflight verification
 *
 * All currency/pricing data is read from DB (authoritative), never browser-supplied.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { logger } from '@/lib/logger';
import { safeLogErrorContext } from '@/lib/errors';
import {
  verifyPaystackPlan,
  verifyFlutterwavePlan,
  verifyStripeReadiness,
} from '@/lib/payments/provider-preflight';

function corsHeaders(origin?: string | null) {
  const allowedOrigins = [
    process.env.ADMIN_ORIGIN || 'https://admin.waaiio.com',
    'http://localhost:8083',
  ];
  const allowed = origin && allowedOrigins.includes(origin) ? origin : allowedOrigins[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request.headers.get('origin')) });
}

/** Read authoritative country row from DB (currency_code, pricing, payment_gateway, config_version). */
async function readCountryFromDb(countryCode: string) {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from('countries')
    .select('code, currency_code, pricing, payment_gateway, config_version')
    .eq('code', countryCode)
    .single();

  if (error || !data) {
    return null;
  }
  return data as {
    code: string;
    currency_code: string;
    pricing: Record<string, { price: number; feeFlat: number }>;
    payment_gateway: string;
    config_version: number | null;
  };
}

export async function POST(request: NextRequest) {
  const origin = request.headers.get('origin');
  const cors = corsHeaders(origin);

  const admin = await requirePlatformAdmin(request);
  if (!admin) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403, headers: cors });
  }

  try {
    const body = await request.json() as {
      action: string;
      country_code: string;
      provider?: string;
      tier_refs?: Record<string, string>;
      config_version?: number;
    };

    const { action, country_code } = body;

    if (!action || !country_code) {
      return NextResponse.json(
        { error: 'Missing required fields: action, country_code' },
        { status: 400, headers: cors },
      );
    }

    // Read authoritative country data from DB
    const country = await readCountryFromDb(country_code);
    if (!country) {
      return NextResponse.json(
        { error: `Country "${country_code}" not found` },
        { status: 404, headers: cors },
      );
    }

    if (action === 'save_refs') {
      return handleSaveRefs(body, country, admin.userId, cors);
    }

    if (action === 'switch_provider') {
      return handleSwitchProvider(body, country, admin.userId, cors);
    }

    return NextResponse.json(
      { error: `Unknown action: ${action}` },
      { status: 400, headers: cors },
    );
  } catch (err) {
    logger.error('provider-config route error', safeLogErrorContext(err));
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500, headers: cors },
    );
  }
}

// ────────────────────────────────────────────────────────────────────────────
// save_refs — Save provider plan references after preflight verification
// ────────────────────────────────────────────────────────────────────────────

async function handleSaveRefs(
  body: { country_code: string; provider?: string; tier_refs?: Record<string, string> },
  country: { code: string; currency_code: string; pricing: Record<string, { price: number; feeFlat: number }>; payment_gateway: string },
  adminUserId: string,
  cors: Record<string, string>,
) {
  const provider = body.provider || country.payment_gateway;
  const tierRefs = body.tier_refs;

  // Stripe uses inline price_data — no plan refs to save
  if (provider === 'stripe') {
    return NextResponse.json(
      { error: 'Stripe uses inline price_data and does not require plan refs' },
      { status: 400, headers: cors },
    );
  }

  if (!tierRefs || Object.keys(tierRefs).length === 0) {
    return NextResponse.json(
      { error: 'Missing tier_refs' },
      { status: 400, headers: cors },
    );
  }

  const dbCurrency = country.currency_code;
  const dbPricing = country.pricing;

  // Preflight: verify each tier ref against the provider
  for (const [tier, ref] of Object.entries(tierRefs)) {
    const tierPricing = dbPricing[tier];
    if (!tierPricing) {
      return NextResponse.json(
        { error: `No pricing found for tier "${tier}" in country ${country.code}` },
        { status: 400, headers: cors },
      );
    }

    let preflight;

    if (provider === 'paystack') {
      const paystackKey = process.env.PAYSTACK_SECRET_KEY;
      if (!paystackKey) {
        return NextResponse.json(
          { error: 'PAYSTACK_SECRET_KEY not configured' },
          { status: 503, headers: cors },
        );
      }
      preflight = await verifyPaystackPlan({
        planCode: ref,
        expectedCurrency: dbCurrency,
        expectedAmountMajor: tierPricing.price,
        paystackKey,
      });
    } else if (provider === 'flutterwave') {
      const flwKey = process.env.FLUTTERWAVE_SECRET_KEY;
      if (!flwKey) {
        return NextResponse.json(
          { error: 'FLUTTERWAVE_SECRET_KEY not configured' },
          { status: 503, headers: cors },
        );
      }
      preflight = await verifyFlutterwavePlan({
        planId: ref,
        expectedCurrency: dbCurrency,
        expectedAmountMajor: tierPricing.price,
        flutterwaveKey: flwKey,
      });
    } else {
      return NextResponse.json(
        { error: `Unsupported provider for plan refs: ${provider}` },
        { status: 400, headers: cors },
      );
    }

    if (!preflight.ok) {
      logger.warn('Provider preflight failed for save_refs', {
        country: country.code,
        provider,
        tier,
        ref,
        reason: preflight.reason,
      });
      return NextResponse.json(
        { error: `Preflight failed for tier "${tier}": ${preflight.reason}` },
        { status: 400, headers: cors },
      );
    }
  }

  // All preflights passed — save via RPC
  const supabase = createServiceClient();
  const { error: rpcError } = await supabase.rpc('save_provider_plan_refs', {
    p_country_code: country.code,
    p_provider: provider,
    p_tier_refs: tierRefs,
    p_admin_id: adminUserId,
  });

  if (rpcError) {
    logger.error('save_provider_plan_refs RPC failed', { country: country.code, provider, error: rpcError.message });
    return NextResponse.json(
      { error: `Failed to save plan refs: ${rpcError.message}` },
      { status: 500, headers: cors },
    );
  }

  return NextResponse.json({ success: true, provider, tiers_saved: Object.keys(tierRefs) }, { headers: cors });
}

// ────────────────────────────────────────────────────────────────────────────
// switch_provider — Switch a country's payment provider
// ────────────────────────────────────────────────────────────────────────────

async function handleSwitchProvider(
  body: { country_code: string; provider?: string; config_version?: number },
  country: { code: string; currency_code: string; pricing: Record<string, { price: number; feeFlat: number }>; payment_gateway: string; config_version: number | null },
  adminUserId: string,
  cors: Record<string, string>,
) {
  const targetProvider = body.provider;

  if (!targetProvider) {
    return NextResponse.json(
      { error: 'Missing required field: provider' },
      { status: 400, headers: cors },
    );
  }

  // CAS: config_version must match DB
  if (body.config_version !== undefined && body.config_version !== country.config_version) {
    return NextResponse.json(
      {
        error: 'config_version_conflict',
        message: 'Country configuration has been modified since you loaded it. Refresh and retry.',
        expected: body.config_version,
        actual: country.config_version,
      },
      { status: 409, headers: cors },
    );
  }

  // Paystack platform subscription lifecycle not yet implemented
  if (targetProvider === 'paystack') {
    return NextResponse.json(
      { error: 'Paystack platform subscription lifecycle is not yet implemented. Gateway switching to Paystack is disabled.' },
      { status: 400, headers: cors },
    );
  }

  const dbCurrency = country.currency_code;
  const dbPricing = country.pricing;

  // Preflight BEFORE switching
  if (targetProvider === 'flutterwave') {
    const flwKey = process.env.FLUTTERWAVE_SECRET_KEY;
    if (!flwKey) {
      return NextResponse.json(
        { error: 'FLUTTERWAVE_SECRET_KEY not configured' },
        { status: 503, headers: cors },
      );
    }

    // Verify all paid tier refs
    for (const [tier, pricing] of Object.entries(dbPricing)) {
      if (pricing.price === 0) continue; // Skip free tier

      // Flutterwave requires pre-created plan refs — check provider_plan_refs
      // For switch_provider, the refs must already exist. Read from country data.
      // This will be validated by the RPC itself; the preflight here checks
      // that Flutterwave is reachable and properly configured.
      const testPreflight = await verifyFlutterwavePlan({
        planId: '0', // Placeholder — actual refs validated by RPC
        expectedCurrency: dbCurrency,
        expectedAmountMajor: pricing.price,
        flutterwaveKey: flwKey,
      });

      // We only care about connectivity/auth failures here, not plan-not-found
      if (testPreflight.reason?.includes('HTTP 401') || testPreflight.reason?.includes('HTTP 403')) {
        return NextResponse.json(
          { error: `Flutterwave authentication failed: ${testPreflight.reason}` },
          { status: 503, headers: cors },
        );
      }
    }
  } else if (targetProvider === 'stripe') {
    const stripeKey = process.env.STRIPE_SECRET_KEY;
    if (!stripeKey) {
      return NextResponse.json(
        { error: 'STRIPE_SECRET_KEY not configured' },
        { status: 503, headers: cors },
      );
    }

    const readiness = await verifyStripeReadiness({ stripeKey });
    if (!readiness.ok) {
      logger.warn('Stripe readiness check failed for switch_provider', {
        country: country.code,
        reason: readiness.reason,
      });
      return NextResponse.json(
        { error: `Stripe is not ready: ${readiness.reason}` },
        { status: 503, headers: cors },
      );
    }
  } else {
    return NextResponse.json(
      { error: `Unsupported target provider: ${targetProvider}` },
      { status: 400, headers: cors },
    );
  }

  // Preflight passed — execute the switch via RPC
  const supabase = createServiceClient();
  const { data: switchResult, error: rpcError } = await supabase.rpc('switch_country_provider', {
    p_country_code: country.code,
    p_new_provider: targetProvider,
    p_expected_version: body.config_version ?? country.config_version,
    p_admin_id: adminUserId,
  });

  if (rpcError) {
    // Check for CAS conflict from RPC
    if (rpcError.message?.includes('config_version')) {
      return NextResponse.json(
        { error: 'config_version_conflict', message: rpcError.message },
        { status: 409, headers: cors },
      );
    }
    logger.error('switch_country_provider RPC failed', { country: country.code, targetProvider, error: rpcError.message });
    return NextResponse.json(
      { error: `Failed to switch provider: ${rpcError.message}` },
      { status: 500, headers: cors },
    );
  }

  return NextResponse.json(
    { success: true, provider: targetProvider, result: switchResult },
    { headers: cors },
  );
}
