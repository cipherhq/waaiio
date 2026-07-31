import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { CAPABILITIES } from '@/lib/capabilities/types';

const VALID_CAP_IDS = new Set<string>(CAPABILITIES.map(c => c.id));

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const admin = await requirePlatformAdmin(request, { requiredRole: 'admin' });
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });

  const supabase = await createClient();

  const { data: biz } = await supabase
    .from('businesses')
    .select('subscription_tier')
    .eq('id', id)
    .single();

  if (!biz) return NextResponse.json({ error: 'Business not found' }, { status: 404 });

  const { data: capRows } = await supabase
    .from('business_capabilities')
    .select('capability')
    .eq('business_id', id)
    .eq('is_enabled', true);

  const { data: overrideRows } = await supabase
    .from('capability_overrides')
    .select('capability')
    .eq('business_id', id);

  return NextResponse.json({
    tier: biz.subscription_tier,
    capabilities: (capRows || []).map(r => r.capability),
    overrides: (overrideRows || []).map(r => r.capability),
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const admin = await requirePlatformAdmin(request, { requiredRole: 'admin' });
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });

  let body: { capability?: string; action?: string; reason?: string };
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const { capability, action, reason } = body;

  if (!capability || !VALID_CAP_IDS.has(capability)) {
    return NextResponse.json({ error: 'Invalid capability' }, { status: 400 });
  }
  if (action !== 'grant' && action !== 'revoke') {
    return NextResponse.json({ error: 'Action must be grant or revoke' }, { status: 400 });
  }

  // Verify business exists
  const supabase = await createClient();
  const { data: biz } = await supabase
    .from('businesses')
    .select('id')
    .eq('id', id)
    .single();

  if (!biz) return NextResponse.json({ error: 'Business not found' }, { status: 404 });

  // Execute atomic RPC via service client
  const service = createServiceClient();
  const rpcName = action === 'grant' ? 'admin_grant_capability' : 'admin_revoke_capability';
  const { data: result, error: rpcError } = await service.rpc(rpcName, {
    p_business_id: id,
    p_capability: capability,
    p_granted_by: admin.id,
    p_reason: reason || null,
  });

  if (rpcError) {
    return NextResponse.json(
      { error: 'Operation failed. Please try again.' },
      { status: 500 },
    );
  }

  return NextResponse.json(result || { success: true });
}
