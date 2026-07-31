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

  const body = await request.json();
  const { capability, action, reason } = body as {
    capability: string;
    action: 'grant' | 'revoke';
    reason?: string;
  };

  if (!capability || !action || !VALID_CAP_IDS.has(capability)) {
    return NextResponse.json({ error: 'Missing or invalid capability/action' }, { status: 400 });
  }

  // Use service client for all writes (INSERT is service_role-only per migration 182,
  // UPDATE/DELETE are service_role-only per migration 299)
  const service = createServiceClient();

  if (action === 'grant') {
    const { error: overrideError } = await service
      .from('capability_overrides')
      .upsert(
        { business_id: id, capability, granted_by: admin.id, reason: reason || null },
        { onConflict: 'business_id,capability' },
      );

    if (overrideError) {
      return NextResponse.json({ error: 'Failed to create override', detail: overrideError.message }, { status: 500 });
    }

    const { error: capError } = await service
      .from('business_capabilities')
      .upsert(
        { business_id: id, capability, is_enabled: true },
        { onConflict: 'business_id,capability' },
      );

    if (capError) {
      return NextResponse.json({ error: 'Failed to enable capability', detail: capError.message }, { status: 500 });
    }
  } else {
    const { error: deleteError } = await service
      .from('capability_overrides')
      .delete()
      .eq('business_id', id)
      .eq('capability', capability);

    if (deleteError) {
      return NextResponse.json({ error: 'Failed to remove override', detail: deleteError.message }, { status: 500 });
    }

    const { error: disableError } = await service
      .from('business_capabilities')
      .update({ is_enabled: false })
      .eq('business_id', id)
      .eq('capability', capability);

    if (disableError) {
      return NextResponse.json({ error: 'Failed to disable capability', detail: disableError.message }, { status: 500 });
    }
  }

  // Audit log (using SSR client for audit — this table has different RLS)
  const supabase = await createClient();
  await supabase.from('admin_audit_logs').insert({
    actor_id: admin.id,
    action: action === 'grant' ? 'grant_capability' : 'revoke_capability',
    entity_type: 'business',
    entity_id: id,
    details: { capability, reason: reason || null },
  });

  return NextResponse.json({ success: true });
}
