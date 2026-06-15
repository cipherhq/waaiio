import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { validateApiKey } from '@/lib/api-keys';
import { rateLimitResponse, getRateLimitKey } from '@/lib/rate-limit';
import type { SupabaseClient } from '@supabase/supabase-js';

interface BusinessRecord {
  id: string;
  name: string;
  status: string;
  subscription_tier: string;
  country_code: string;
}

interface PartnerAuth {
  business: BusinessRecord;
  keyId: string;
  supabase: SupabaseClient;
}

/**
 * Authenticate a partner API request.
 * Validates API key, checks business is active and on a paid tier.
 * Rate limits: 60 req/min per IP.
 */
export async function authenticatePartner(
  request: NextRequest,
): Promise<PartnerAuth | NextResponse> {
  // Rate limit
  const rateLimit = rateLimitResponse(getRateLimitKey(request, 'partner'), 60, 60_000);
  if (rateLimit) return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 });

  // API key
  const apiKey = request.headers.get('x-api-key');
  if (!apiKey) {
    return NextResponse.json({ error: 'Missing x-api-key header' }, { status: 401 });
  }

  const auth = await validateApiKey(apiKey);
  if (!auth) {
    return NextResponse.json({ error: 'Invalid or revoked API key' }, { status: 401 });
  }

  const supabase = createServiceClient();

  // Verify business
  const { data: business } = await supabase
    .from('businesses')
    .select('id, name, status, subscription_tier, country_code')
    .eq('id', auth.businessId)
    .single();

  if (!business || business.status !== 'active') {
    return NextResponse.json({ error: 'Business not found or inactive' }, { status: 404 });
  }

  if (!business.subscription_tier || business.subscription_tier === 'free') {
    return NextResponse.json({ error: 'Partner API requires a paid plan' }, { status: 403 });
  }

  return { business: business as BusinessRecord, keyId: auth.keyId, supabase };
}
