import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { generateApiKey } from '@/lib/api-keys';

/**
 * GET /api/integrations/api-keys — list API keys for the authenticated user's business
 * POST /api/integrations/api-keys — generate a new API key (atomic via DB RPC)
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
    // Authenticate via session
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await request.json();
    const { businessId, name } = body;
    if (!businessId) return NextResponse.json({ error: 'businessId required' }, { status: 400 });

    // Generate key material before the RPC call
    const { raw, hash, prefix } = await generateApiKey();

    // Atomic issuance via service-role RPC:
    // Verifies ownership, paid tier, 5-key limit, and inserts — all under a row lock.
    const service = createServiceClient();
    const { data: keyId, error: rpcError } = await service.rpc('issue_api_key', {
      p_business_id: businessId,
      p_key_hash: hash,
      p_key_prefix: prefix,
      p_name: (name || 'Default').slice(0, 100),
      p_actor_user_id: user.id,
    });

    if (rpcError) {
      // Map custom PG error codes to HTTP responses
      const code = rpcError.code;
      if (code === 'WA001') {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }
      if (code === 'WA002') {
        return NextResponse.json({ error: 'Maximum 5 active API keys per business' }, { status: 400 });
      }
      // Unexpected error — fail closed, never leak the raw key
      return NextResponse.json({ error: 'Failed to create API key' }, { status: 500 });
    }

    if (!keyId) {
      // RPC returned null/empty — fail closed
      return NextResponse.json({ error: 'Failed to create API key' }, { status: 500 });
    }

    // Only return the raw key after verified successful insert
    return NextResponse.json({
      key: raw,
      prefix,
      message: 'Save this key now — it will not be shown again.',
    });
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
