import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { evaluateBusinessAppCoexistenceConfig } from '@/lib/whatsapp/business-app-coexistence';

/**
 * Business App Connect local readiness only. Never claims a merchant or
 * market is Meta-eligible; never exchanges tokens or mutates provider state.
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
  return NextResponse.json({
    ...gate,
    canConnect: false,
    country: business.country_code,
    countryEligibility: 'requires_meta_confirmation',
    appEligibility: 'requires_meta_confirmation',
    warning: 'Do not connect an existing Business app number through standard transfer onboarding.',
  }, { headers: { 'Cache-Control': 'no-store' } });
}
