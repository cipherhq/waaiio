/**
 * Admin Provider Configuration API
 *
 * Manages payment gateway provider plan refs and gateway switching per country.
 * Uses M378 RPCs with exact signatures:
 *   - save_provider_plan_refs(p_country_code, p_plan_refs JSONB, p_expected_version_id UUID, p_actor_id UUID)
 *   - switch_country_provider(p_country_code, p_new_gateway TEXT, p_expected_version_id UUID, p_actor_id UUID)
 *
 * CAS via UUID version from platform_config_versions (get_effective_commercial_config RPC).
 *
 * Server-side provider preflight is MANDATORY before every save/switch:
 * - Paystack: exists, not archived, monthly, exact DB currency, exact DB tier price in minor units
 * - Flutterwave: active, monthly, exact DB currency, exact DB tier price (accepted helper)
 * - Stripe: verifyStripeReadiness() for switch; no Stripe plan refs (inline price_data)
 * - Provider/API unavailable = fail closed, zero RPC call
 */

import { NextRequest, NextResponse } from 'next/server';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { createServiceClient } from '@/lib/supabase/service';
import { logger } from '@/lib/logger';
import {
  verifyFlutterwavePlan,
  verifyPaystackPlan,
  verifyStripeReadiness,
} from '@/lib/payments/provider-preflight';

// ═══ CORS — strict Admin-origin only ═══
const ALLOWED_ADMIN_ORIGINS = [
  process.env.ADMIN_ORIGIN || 'https://admin.waaiio.com',
  'http://localhost:8083', // local admin dev
];

function corsHeaders(origin: string | null): Record<string, string> {
  const allowed = origin && ALLOWED_ADMIN_ORIGINS.includes(origin) ? origin : '';
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };
}

function withCors(response: NextResponse, origin: string | null): NextResponse {
  const headers = corsHeaders(origin);
  for (const [key, value] of Object.entries(headers)) {
    response.headers.set(key, value);
  }
  return response;
}

export async function OPTIONS(request: NextRequest) {
  const origin = request.headers.get('origin');
  return withCors(new NextResponse(null, { status: 204 }), origin);
}

export async function POST(request: NextRequest) {
  const origin = request.headers.get('origin');
  const respond = (data: Record<string, unknown>, statusOrOpts?: number | { status: number }) => {
    const status = typeof statusOrOpts === 'number' ? statusOrOpts : statusOrOpts?.status ?? 200;
    return withCors(NextResponse.json(data, { status }), origin);
  };

  const admin = await requirePlatformAdmin(request, { requiredRole: 'admin' });
  if (!admin) {
    return respond({ error: 'Unauthorized' }, 403);
  }

  const body = await request.json();
  const { action } = body;
  const service = createServiceClient();

  // ═══ get_version: return current CAS version UUID ═══
  if (action === 'get_version') {
    const { data, error } = await service.rpc('get_effective_config');
    if (error) {
      logger.error('[provider-config] get_effective_config RPC failed', { error: error.message });
      return respond({ error: 'Failed to get config version' }, { status: 500 });
    }
    return respond({ version_id: data });
  }

  // ═══ save_refs: save provider plan refs with MANDATORY server-side preflight ═══
  if (action === 'save_refs') {
    const { country_code, plan_refs, expected_version_id } = body;

    if (!country_code || !plan_refs || !expected_version_id) {
      return respond({ error: 'Missing required fields: country_code, plan_refs, expected_version_id' }, { status: 400 });
    }
    if (typeof plan_refs !== 'object') {
      return respond({ error: 'plan_refs must be an object' }, { status: 400 });
    }

    // Read authoritative country pricing/currency from DB
    const { data: country, error: countryErr } = await service
      .from('countries').select('currency_code, pricing').eq('code', country_code).single();
    if (countryErr || !country) {
      return respond({ error: `Country "${country_code}" not found` }, { status: 404 });
    }
    const dbCurrency = country.currency_code as string;
    const dbPricing = country.pricing as Record<string, Record<string, unknown>> | null;

    // Preflight every ref against the provider BEFORE calling save RPC
    for (const tier of ['growth', 'business'] as const) {
      const tierRefs = (plan_refs as Record<string, Record<string, string>>)[tier];
      if (!tierRefs) continue;

      const tierPrice = (dbPricing?.[tier]?.price as number) || 0;
      if (tierPrice <= 0) {
        return respond({ error: `No price configured for tier "${tier}" in ${country_code}` }, { status: 400 });
      }

      for (const [provider, ref] of Object.entries(tierRefs)) {
        if (!ref || typeof ref !== 'string') continue;

        // Stripe uses inline price_data — reject plan refs
        if (provider === 'stripe') {
          return respond({ error: 'Stripe uses inline price_data and does not require plan refs' }, { status: 400 });
        }

        if (provider === 'paystack') {
          const psKey = process.env.PAYSTACK_SECRET_KEY;
          if (!psKey) return respond({ error: 'PAYSTACK_SECRET_KEY not configured' }, { status: 503 });
          const pf = await verifyPaystackPlan({ planCode: ref, expectedCurrency: dbCurrency, expectedAmountMajor: tierPrice, paystackKey: psKey });
          if (!pf.ok) return respond({ error: `Paystack ${tier} plan "${ref}" preflight failed: ${pf.reason}` }, { status: 400 });
        }

        if (provider === 'flutterwave') {
          const flwKey = process.env.FLUTTERWAVE_SECRET_KEY;
          if (!flwKey) return respond({ error: 'FLUTTERWAVE_SECRET_KEY not configured' }, { status: 503 });
          const pf = await verifyFlutterwavePlan({ planId: ref, expectedCurrency: dbCurrency, expectedAmountMajor: tierPrice, flutterwaveKey: flwKey });
          if (!pf.ok) return respond({ error: `Flutterwave ${tier} plan "${ref}" preflight failed: ${pf.reason}` }, { status: 400 });
        }
      }
    }

    // All preflights passed — call M378 RPC with exact parameter names
    const { data, error } = await service.rpc('save_provider_plan_refs', {
      p_country_code: country_code,
      p_plan_refs: plan_refs,
      p_expected_version_id: expected_version_id,
      p_actor_id: admin.userId,
    });

    if (error) {
      if (error.message?.includes('config_version_conflict')) {
        return respond({ error: 'config_version_conflict', message: 'Configuration has been modified. Please reload and try again.' }, { status: 409 });
      }
      logger.error('[provider-config] save_provider_plan_refs RPC failed', { error: error.message, country_code });
      return respond({ error: error.message }, { status: 500 });
    }

    return respond({ success: true, version_id: data });
  }

  // ═══ switch_provider: switch gateway with MANDATORY provider readiness preflight ═══
  if (action === 'switch_provider') {
    const { country_code, new_gateway, expected_version_id } = body;

    if (!country_code || !new_gateway || !expected_version_id) {
      return respond({ error: 'Missing required fields: country_code, new_gateway, expected_version_id' }, { status: 400 });
    }

    // Paystack platform lifecycle not implemented — ALWAYS deny switching TO Paystack
    if (new_gateway === 'paystack') {
      return respond({ error: 'Paystack platform subscription lifecycle is not yet implemented. Gateway switching to Paystack is disabled.' }, { status: 400 });
    }

    // Flutterwave: preflight verify actual stored Growth + Business refs
    if (new_gateway === 'flutterwave') {
      const { data: country, error: countryErr } = await service
        .from('countries').select('pricing, currency_code').eq('code', country_code).single();
      if (countryErr || !country) return respond({ error: 'Country not found' }, { status: 404 });

      const pricing = country.pricing as Record<string, Record<string, unknown>> | null;
      const currency = country.currency_code as string;
      const flwKey = process.env.FLUTTERWAVE_SECRET_KEY;
      if (!flwKey) return respond({ error: 'FLUTTERWAVE_SECRET_KEY not configured' }, { status: 503 });

      for (const tier of ['growth', 'business'] as const) {
        const refs = pricing?.[tier]?.provider_plan_refs as Record<string, string> | undefined;
        const flwRef = refs?.flutterwave;
        if (!flwRef) return respond({ error: `Flutterwave plan ref not configured for tier ${tier}` }, { status: 400 });
        const tierPrice = (pricing?.[tier]?.price as number) || 0;
        const pf = await verifyFlutterwavePlan({ planId: flwRef, expectedCurrency: currency, expectedAmountMajor: tierPrice, flutterwaveKey: flwKey });
        if (!pf.ok) return respond({ error: `Flutterwave ${tier} plan preflight failed: ${pf.reason}` }, { status: 503 });
      }
    }
    // Stripe: verify API readiness immediately before switch
    else if (new_gateway === 'stripe') {
      const stripeKey = process.env.STRIPE_SECRET_KEY;
      if (!stripeKey) return respond({ error: 'STRIPE_SECRET_KEY not configured' }, { status: 503 });
      const pf = await verifyStripeReadiness({ stripeKey });
      if (!pf.ok) return respond({ error: `Stripe readiness check failed: ${pf.reason}` }, { status: 503 });
    }
    // Unsupported gateway
    else {
      return respond({ error: `Unsupported gateway: ${new_gateway}` }, { status: 400 });
    }

    // Preflight passed — call M378 RPC
    const { data, error } = await service.rpc('switch_country_provider', {
      p_country_code: country_code,
      p_new_gateway: new_gateway,
      p_expected_version_id: expected_version_id,
      p_actor_id: admin.userId,
    });

    if (error) {
      if (error.message?.includes('config_version_conflict')) {
        return respond({ error: 'config_version_conflict', message: 'Configuration has been modified. Please reload and try again.' }, { status: 409 });
      }
      logger.error('[provider-config] switch_country_provider RPC failed', { error: error.message, country_code, new_gateway });
      return respond({ error: error.message }, { status: 500 });
    }

    return respond({ success: true, version_id: data });
  }

  // ═══ update_country: narrow partial update for non-provider fields only ═══
  if (action === 'update_country') {
    const { country_code, fields } = body;
    if (!country_code || !fields || typeof fields !== 'object') {
      return respond({ error: 'Missing country_code or fields' }, { status: 400 });
    }

    // Whitelist: ONLY non-provider-sensitive fields allowed
    const ALLOWED_FIELDS = ['name', 'flag', 'dialing_code', 'currency_symbol', 'currency_locale',
      'phone_digits', 'phone_pattern', 'phone_placeholder', 'is_active', 'sort_order',
      'cities', 'verification_tiers', 'doc_types'] as const;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const safePayload: Record<string, any> = { updated_by: admin.userId };
    for (const key of ALLOWED_FIELDS) {
      if (key in fields) safePayload[key] = fields[key];
    }

    // REJECT any attempt to include provider-sensitive fields
    const FORBIDDEN = ['payment_gateway', 'currency_code', 'pricing', 'provider_plan_refs'];
    for (const key of FORBIDDEN) {
      if (key in fields) {
        return respond({ error: `Field "${key}" cannot be changed via generic country edit` }, { status: 400 });
      }
    }

    const { error } = await service.from('countries').update(safePayload).eq('code', country_code);
    if (error) {
      logger.error('[provider-config] update_country failed', { error: error.message, country_code });
      return respond({ error: error.message }, { status: 500 });
    }

    return respond({ success: true });
  }

  return respond({ error: `Unknown action: ${action}` }, { status: 400 });
}
