import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { evaluateBusinessAppCoexistenceConfig } from '@/lib/whatsapp/business-app-coexistence';
import { evaluateFullEligibility } from '@/lib/whatsapp/coexistence-verification';

/**
 * Business App Connect local readiness + eligibility sub-results.
 *
 * Never claims a merchant or market is Meta-eligible; never exchanges
 * tokens or mutates provider state. canConnect is ALWAYS false.
 *
 * Phase 2 adds eligibility sub-results from the gated verification service.
 * All three checks (partner, phone, country) currently return false since
 * the verification functions are gated. This response structure is stable
 * and will reflect real values when checks are ungated.
 */
export async function GET(request: NextRequest) {
  const businessId = request.nextUrl.searchParams.get('businessId');
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!businessId || !uuid.test(businessId)) {
    return NextResponse.json({ error: 'Valid businessId is required' }, { status: 400 });
  }
  const client = await createClient();
  const { data: { user }, error: authError } = await client.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { data: business, error: ownerError } = await client.from('businesses')
    .select('id, country_code').eq('id', businessId).eq('owner_id', user.id).maybeSingle();
  if (ownerError) return NextResponse.json({ error: 'Owner check unavailable' }, { status: 503 });
  if (!business) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const gate = evaluateBusinessAppCoexistenceConfig({
    enabled: process.env.META_BUSINESS_APP_COEXISTENCE_ENABLED,
    coexistConfigId: process.env.NEXT_PUBLIC_META_BUSINESS_APP_COEXISTENCE_CONFIG_ID,
    transferConfigId: process.env.NEXT_PUBLIC_META_EMBEDDED_SIGNUP_CONFIG_ID,
  });

  // Run eligibility checks (all gated — returns false for everything)
  // These never make real Meta API calls while gated.
  const eligibilityResult = await evaluateFullEligibility({
    metaAccessToken: '', // Not used while gated
    phoneNumber: '',     // Not used while gated
    countryCode: business.country_code || '',
  });

  const eligibility = {
    partnerEntitled: false,
    phoneEligible: false,
    countrySupported: false,
    allGatesMet: false,
  };

  if (eligibilityResult.eligible) {
    // Currently unreachable since all checks are gated
    eligibility.partnerEntitled = eligibilityResult.partnerEntitled;
    eligibility.phoneEligible = eligibilityResult.phoneHasBusinessApp;
    eligibility.countrySupported = eligibilityResult.countrySupported;
    eligibility.allGatesMet = true;
  } else {
    // Extract individual results from details
    eligibility.partnerEntitled = eligibilityResult.details.partnerEntitled;
    eligibility.phoneEligible = eligibilityResult.details.phoneEligible;
    eligibility.countrySupported = eligibilityResult.details.countrySupported;
  }

  // canConnect is ALWAYS false — config readiness is not Meta eligibility.
  // See lib/whatsapp/business-app-coexistence.ts for the full list of
  // provider-level gates that must be implemented before this can change.
  return NextResponse.json({
    ...gate,
    canConnect: false,
    country: business.country_code,
    countryEligibility: 'requires_meta_confirmation',
    appEligibility: 'requires_meta_confirmation',
    eligibility,
    warning: 'Do not connect an existing Business app number through standard transfer onboarding.',
  }, { headers: { 'Cache-Control': 'no-store' } });
}
