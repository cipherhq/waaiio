import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { generateApiKey } from '@/lib/api-keys';

/**
 * GET /api/integrations/api-keys — list API keys for the authenticated user's business
 * POST /api/integrations/api-keys — generate a new API key
 */

export async function GET(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const businessId = request.nextUrl.searchParams.get('businessId');
    if (!businessId) return NextResponse.json({ error: 'businessId required' }, { status: 400 });

    // Verify ownership
    const { data: biz } = await supabase
      .from('businesses')
      .select('id')
      .eq('id', businessId)
      .eq('owner_id', user.id)
      .single();

    if (!biz) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    const { data: keys } = await supabase
      .from('api_keys')
      .select('id, key_prefix, name, created_at, last_used_at, revoked_at')
      .eq('business_id', businessId)
      .order('created_at', { ascending: false });

    return NextResponse.json({ keys: keys || [] });
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await request.json();
    const { businessId, name } = body;
    if (!businessId) return NextResponse.json({ error: 'businessId required' }, { status: 400 });

    // Verify ownership
    const { data: biz } = await supabase
      .from('businesses')
      .select('id, subscription_tier')
      .eq('id', businessId)
      .eq('owner_id', user.id)
      .single();

    if (!biz) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    // Require paid tier
    if (!biz.subscription_tier || biz.subscription_tier === 'free') {
      return NextResponse.json({ error: 'API integrations require a paid plan (Growth or above)' }, { status: 403 });
    }

    // Limit to 5 active keys per business
    const { count } = await supabase
      .from('api_keys')
      .select('id', { count: 'exact', head: true })
      .eq('business_id', businessId)
      .is('revoked_at', null);

    if ((count || 0) >= 5) {
      return NextResponse.json({ error: 'Maximum 5 active API keys per business' }, { status: 400 });
    }

    const { raw, hash, prefix } = await generateApiKey();

    await supabase.from('api_keys').insert({
      business_id: businessId,
      key_hash: hash,
      key_prefix: prefix,
      name: (name || 'Default').slice(0, 100),
    });

    return NextResponse.json({
      key: raw,
      prefix,
      message: 'Save this key now — it will not be shown again.',
    });
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
