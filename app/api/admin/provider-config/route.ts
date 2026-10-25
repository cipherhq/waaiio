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
import { consumeStepUp, StepUpError } from '@/lib/admin-step-up';
import { createServiceClient } from '@/lib/supabase/service';
import { logger } from '@/lib/logger';
import {
  verifyFlutterwavePlan,
  verifyPaystackPlan,
  verifyStripeReadiness,
} from '@/lib/payments/provider-preflight';

import { adminCorsHeaders } from '@/lib/admin-cors';

function withCors(response: NextResponse, origin: string | null): NextResponse {
  const headers = adminCorsHeaders(origin);
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
  const { action, stepUpId } = body;
  const service = createServiceClient();

  // SEC-005 Layer 4: Mutation actions require step-up with full parameter binding.
  // Every security-relevant parameter is included in the hash so that a
  // step-up for one provider config change cannot authorize a different one.
  if (action === 'save_refs' || action === 'switch_provider' || action === 'update_country' || action === 'create_country' || action === 'delete_country') {
    const stepUpParams: Record<string, unknown> = { action, country_code: body.country_code ?? null };
    if (action === 'save_refs') {
      stepUpParams.plan_refs = body.plan_refs ?? null;
      stepUpParams.expected_version_id = body.expected_version_id ?? null;
      stepUpParams.tier_prices = body.tier_prices ?? null; // M458: included in step-up hash for atomic price+plan cutover
    } else if (action === 'switch_provider') {
      stepUpParams.new_gateway = body.new_gateway ?? null;
      stepUpParams.expected_version_id = body.expected_version_id ?? null;
    } else if (action === 'update_country' || action === 'create_country') {
      stepUpParams.fields = body.fields ?? null;
    }
    try {
      await consumeStepUp(admin, stepUpId, 'provider_config', action, stepUpParams);
    } catch (err) {
      const msg = err instanceof StepUpError ? err.message : 'Step-up authorization required';
      return respond({ error: msg, code: 'step_up_required' }, 403);
    }
  }

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
  // M458: optional tier_prices enables atomic price + plan-code cutover for Paystack countries.
  if (action === 'save_refs') {
    const { country_code, plan_refs, expected_version_id, tier_prices } = body;

    if (!country_code || !plan_refs || !expected_version_id) {
      return respond({ error: 'Missing required fields: country_code, plan_refs, expected_version_id' }, { status: 400 });
    }
    if (typeof plan_refs !== 'object') {
      return respond({ error: 'plan_refs must be an object' }, { status: 400 });
    }

    // Validate tier_prices if provided (M458 atomic cutover)
    if (tier_prices !== undefined && tier_prices !== null) {
      if (typeof tier_prices !== 'object' || Array.isArray(tier_prices)) {
        return respond({ error: 'tier_prices must be an object' }, { status: 400 });
      }
      for (const [tier, val] of Object.entries(tier_prices as Record<string, unknown>)) {
        if (tier !== 'growth' && tier !== 'business') {
          return respond({ error: `tier_prices: only growth and business allowed, got "${tier}"` }, { status: 400 });
        }
        const obj = val as Record<string, unknown> | null;
        if (!obj || typeof obj !== 'object' || typeof obj.price !== 'number' || obj.price <= 0) {
          return respond({ error: `tier_prices.${tier}.price must be a positive number` }, { status: 400 });
        }
        // M458 atomicity: every tier with a price change MUST have a plan ref
        // for the country's ACTIVE gateway — prevents updating price without
        // verifying the matching provider plan, or with a wrong-gateway ref.
        const tierRefs = (plan_refs as Record<string, Record<string, string>>)[tier];
        if (!tierRefs || Object.keys(tierRefs).length === 0) {
          return respond({ error: `tier_prices.${tier} requires a matching plan_refs entry for atomic cutover` }, { status: 400 });
        }
        // Verify the ref is for the country's active gateway (read from DB below)
        // — deferred to after country DB read
      }
    }

    // Read authoritative country pricing/currency/gateway from DB
    const { data: country, error: countryErr } = await service
      .from('countries').select('currency_code, pricing, payment_gateway').eq('code', country_code).single();
    if (countryErr || !country) {
      return respond({ error: `Country "${country_code}" not found` }, { status: 404 });
    }
    const dbCurrency = country.currency_code as string;
    const dbPricing = country.pricing as Record<string, Record<string, unknown>> | null;
    const dbGateway = country.payment_gateway as string;

    // M458 atomicity: verify tier_prices refs are for the country's active gateway
    if (tier_prices) {
      for (const tier of Object.keys(tier_prices as Record<string, unknown>)) {
        const tierRefs = (plan_refs as Record<string, Record<string, string>>)[tier];
        if (!tierRefs?.[dbGateway]) {
          return respond({
            error: `tier_prices.${tier} requires a ${dbGateway} plan reference for ${country_code} (active gateway)`,
          }, { status: 400 });
        }
      }
    }

    // Preflight every ref against the provider BEFORE calling save RPC.
    // M458: When tier_prices is provided, preflight uses the NEW price (from the request)
    // instead of the current DB price, because the RPC updates prices before plan refs.
    for (const tier of ['growth', 'business'] as const) {
      const tierRefs = (plan_refs as Record<string, Record<string, string>>)[tier];
      if (!tierRefs) continue;

      // Resolve the effective price for preflight: new price if provided, else current DB price
      const newTierPrice = (tier_prices as Record<string, Record<string, number>> | undefined)?.[tier]?.price;
      const tierPrice = newTierPrice ?? ((dbPricing?.[tier]?.price as number) || 0);
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

    // All preflights passed — call RPC with exact parameter names (M458: includes p_tier_prices)
    const { data, error } = await service.rpc('save_provider_plan_refs', {
      p_country_code: country_code,
      p_plan_refs: plan_refs,
      p_expected_version_id: expected_version_id,
      p_actor_id: admin.userId,
      ...(tier_prices ? { p_tier_prices: tier_prices } : {}),
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

  // ═══ create_country/delete_country: server-only sensitive country mutations ═══
  // SEC-005: These previously went directly from the browser to Supabase,
  // bypassing action-bound verification. The M439 table grant removes that path.
  if (action === 'create_country') {
    const country_code = body.country_code;
    const fields = body.fields;
    if (typeof country_code !== 'string' || !/^[A-Z]{2}$/.test(country_code) ||
        !fields || typeof fields !== 'object' || Array.isArray(fields) ||
        fields.code !== country_code || typeof fields.name !== 'string' || !fields.name.trim() ||
        typeof fields.currency_code !== 'string' || !/^[A-Z]{3}$/.test(fields.currency_code) ||
        !['stripe', 'paystack', 'flutterwave'].includes(fields.payment_gateway)) {
      return respond({ error: 'Invalid country configuration' }, { status: 400 });
    }
    const allowed = ['code', 'name', 'flag', 'dialing_code', 'currency_code', 'currency_symbol',
      'currency_locale', 'payment_gateway', 'phone_digits', 'phone_pattern', 'phone_placeholder',
      'is_active', 'sort_order', 'cities', 'pricing', 'verification_tiers', 'doc_types'];
    if (Object.keys(fields).some(k => !allowed.includes(k))) {
      return respond({ error: 'Unknown country configuration field' }, { status: 400 });
    }
    const { error } = await service.from('countries').insert({ ...fields, updated_by: admin.userId });
    if (error) {
      logger.error('[provider-config] create_country failed', { error: error.message, country_code });
      return respond({ error: 'Failed to create country' }, { status: 500 });
    }
    return respond({ success: true });
  }

  if (action === 'delete_country') {
    const country_code = body.country_code;
    if (typeof country_code !== 'string' || !/^[A-Z]{2}$/.test(country_code)) {
      return respond({ error: 'Invalid country code' }, { status: 400 });
    }
    const { error } = await service.from('countries').delete().eq('code', country_code);
    if (error) {
      logger.error('[provider-config] delete_country failed', { error: error.message, country_code });
      return respond({ error: 'Failed to delete country' }, { status: 500 });
    }
    return respond({ success: true });
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
