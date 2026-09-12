/**
 * Admin Provider Configuration API
 *
 * Manages payment gateway provider plan refs and gateway switching per country.
 * Uses M378 RPCs with exact signatures:
 *   - save_provider_plan_refs(p_country_code, p_plan_refs JSONB, p_expected_version_id UUID, p_actor_id UUID)
 *   - switch_country_provider(p_country_code, p_new_gateway TEXT, p_expected_version_id UUID, p_actor_id UUID)
 *
 * CAS via UUID version from platform_config_versions (get_effective_config RPC).
 */

import { NextRequest, NextResponse } from 'next/server';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { createServiceClient } from '@/lib/supabase/service';
import { logger } from '@/lib/logger';

const FLUTTERWAVE_SECRET_KEY = process.env.FLUTTERWAVE_SECRET_KEY || '';

/**
 * Verify a Flutterwave payment plan exists and matches expected currency/amount.
 * GET /v3/payment-plans/{id}
 */
async function verifyFlutterwavePlan(
  planId: string,
  expectedCurrency: string,
  expectedAmount: number,
): Promise<{ ok: boolean; reason?: string }> {
  if (!FLUTTERWAVE_SECRET_KEY) {
    if (process.env.NODE_ENV === 'production') {
      return { ok: false, reason: 'Flutterwave secret key not configured' };
    }
    // Dev/test: allow mock plans
    return { ok: true };
  }

  try {
    const response = await fetch(
      `https://api.flutterwave.com/v3/payment-plans/${encodeURIComponent(planId)}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${FLUTTERWAVE_SECRET_KEY}`,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(10000),
      },
    );
    const data = await response.json();

    if (data.status !== 'success') {
      return { ok: false, reason: `Plan ${planId} not found or API error: ${data.message || 'unknown'}` };
    }

    const plan = data.data as Record<string, unknown>;
    const planAmount = plan.amount as number;
    const planCurrency = (plan.currency as string) || '';

    // Verify currency matches
    if (planCurrency && expectedCurrency && planCurrency.toUpperCase() !== expectedCurrency.toUpperCase()) {
      return { ok: false, reason: `Plan ${planId} currency ${planCurrency} does not match country currency ${expectedCurrency}` };
    }

    // Verify amount matches tier price
    if (planAmount !== expectedAmount) {
      return { ok: false, reason: `Plan ${planId} amount ${planAmount} does not match expected tier price ${expectedAmount}` };
    }

    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `Flutterwave API error: ${err instanceof Error ? err.message : 'unknown'}` };
  }
}

/**
 * POST /api/admin/provider-config
 *
 * Actions:
 * - save_refs: Save provider plan refs for a country
 * - switch_provider: Switch active payment gateway for a country
 * - get_version: Get current CAS version ID
 */
export async function POST(request: NextRequest) {
  const admin = await requirePlatformAdmin(request, { requiredRole: 'admin' });
  if (!admin) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
  }

  const body = await request.json();
  const { action } = body;

  const service = createServiceClient();

  if (action === 'get_version') {
    // Return the current effective config version UUID
    const { data, error } = await service.rpc('get_effective_config');
    if (error) {
      logger.error('[provider-config] get_effective_config RPC failed', { error: error.message });
      return NextResponse.json({ error: 'Failed to get config version' }, { status: 500 });
    }
    return NextResponse.json({ version_id: data });
  }

  if (action === 'save_refs') {
    const { country_code, plan_refs, expected_version_id } = body;

    if (!country_code || !plan_refs || !expected_version_id) {
      return NextResponse.json(
        { error: 'Missing required fields: country_code, plan_refs, expected_version_id' },
        { status: 400 },
      );
    }

    // plan_refs expected shape: { growth: { flutterwave: "123" }, business: { flutterwave: "456" } }
    // Validate it's a proper nested object
    if (typeof plan_refs !== 'object') {
      return NextResponse.json({ error: 'plan_refs must be an object' }, { status: 400 });
    }

    // Call the M378 RPC with exact parameter names
    const { data, error } = await service.rpc('save_provider_plan_refs', {
      p_country_code: country_code,
      p_plan_refs: plan_refs,
      p_expected_version_id: expected_version_id,
      p_actor_id: admin.userId,
    });

    if (error) {
      // Check for CAS conflict
      if (error.message?.includes('version') || error.message?.includes('conflict') || error.message?.includes('stale')) {
        return NextResponse.json(
          { error: 'config_version_conflict', message: 'Configuration has been modified. Please reload and try again.' },
          { status: 409 },
        );
      }
      logger.error('[provider-config] save_provider_plan_refs RPC failed', { error: error.message, country_code });
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true, version_id: data });
  }

  if (action === 'switch_provider') {
    const { country_code, new_gateway, expected_version_id } = body;

    if (!country_code || !new_gateway || !expected_version_id) {
      return NextResponse.json(
        { error: 'Missing required fields: country_code, new_gateway, expected_version_id' },
        { status: 400 },
      );
    }

    // For flutterwave: preflight verify both Growth and Business plan refs exist and are valid
    if (new_gateway === 'flutterwave') {
      // Read the country to get stored plan refs and currency
      const { data: country, error: countryErr } = await service
        .from('countries')
        .select('pricing, currency_code')
        .eq('code', country_code)
        .single();

      if (countryErr || !country) {
        return NextResponse.json({ error: 'Country not found' }, { status: 404 });
      }

      const pricing = country.pricing as Record<string, Record<string, unknown>> | null;
      const currency = country.currency_code as string;

      // Check Growth tier ref
      const growthRefs = pricing?.growth?.provider_plan_refs as Record<string, string> | undefined;
      const growthFlwRef = growthRefs?.flutterwave;
      if (!growthFlwRef) {
        return NextResponse.json(
          { error: 'Flutterwave plan ref not configured for tier Growth' },
          { status: 400 },
        );
      }

      // Check Business tier ref
      const businessRefs = pricing?.business?.provider_plan_refs as Record<string, string> | undefined;
      const businessFlwRef = businessRefs?.flutterwave;
      if (!businessFlwRef) {
        return NextResponse.json(
          { error: 'Flutterwave plan ref not configured for tier Business' },
          { status: 400 },
        );
      }

      // Preflight verify both plans at Flutterwave
      const growthPrice = (pricing?.growth?.price as number) || 0;
      const businessPrice = (pricing?.business?.price as number) || 0;

      const [growthCheck, businessCheck] = await Promise.all([
        verifyFlutterwavePlan(growthFlwRef, currency, growthPrice),
        verifyFlutterwavePlan(businessFlwRef, currency, businessPrice),
      ]);

      if (!growthCheck.ok) {
        return NextResponse.json(
          { error: `Flutterwave Growth plan preflight failed: ${growthCheck.reason}` },
          { status: 503 },
        );
      }

      if (!businessCheck.ok) {
        return NextResponse.json(
          { error: `Flutterwave Business plan preflight failed: ${businessCheck.reason}` },
          { status: 503 },
        );
      }
    }

    // Call the M378 RPC with exact parameter names
    const { data, error } = await service.rpc('switch_country_provider', {
      p_country_code: country_code,
      p_new_gateway: new_gateway,
      p_expected_version_id: expected_version_id,
      p_actor_id: admin.userId,
    });

    if (error) {
      if (error.message?.includes('version') || error.message?.includes('conflict') || error.message?.includes('stale')) {
        return NextResponse.json(
          { error: 'config_version_conflict', message: 'Configuration has been modified. Please reload and try again.' },
          { status: 409 },
        );
      }
      logger.error('[provider-config] switch_country_provider RPC failed', { error: error.message, country_code, new_gateway });
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true, version_id: data });
  }

  return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
}
