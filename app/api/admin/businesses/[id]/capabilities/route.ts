import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // Verify admin
  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle();

  if (!profile || profile.role !== 'admin') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Fetch business tier
  const { data: biz } = await supabase
    .from('businesses')
    .select('subscription_tier')
    .eq('id', id)
    .single();

  if (!biz) return NextResponse.json({ error: 'Business not found' }, { status: 404 });

  // Fetch enabled capabilities
  const { data: capRows } = await supabase
    .from('business_capabilities')
    .select('capability')
    .eq('business_id', id)
    .eq('is_enabled', true);

  // Fetch overrides
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
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // Verify admin
  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle();

  if (!profile || profile.role !== 'admin') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json();
  const { capability, action, reason } = body as {
    capability: string;
    action: 'grant' | 'revoke';
    reason?: string;
  };

  if (!capability || !action) {
    return NextResponse.json({ error: 'Missing capability or action' }, { status: 400 });
  }

  if (action === 'grant') {
    // Insert override
    await supabase
      .from('capability_overrides')
      .upsert(
        { business_id: id, capability, granted_by: user.id, reason: reason || null },
        { onConflict: 'business_id,capability' },
      );

    // Enable the capability
    await supabase
      .from('business_capabilities')
      .upsert(
        { business_id: id, capability, is_enabled: true },
        { onConflict: 'business_id,capability' },
      );
  } else {
    // Delete override
    await supabase
      .from('capability_overrides')
      .delete()
      .eq('business_id', id)
      .eq('capability', capability);

    // Disable the capability
    await supabase
      .from('business_capabilities')
      .update({ is_enabled: false })
      .eq('business_id', id)
      .eq('capability', capability);
  }

  // Audit log
  await supabase.from('admin_audit_logs').insert({
    actor_id: user.id,
    action: action === 'grant' ? 'grant_capability' : 'revoke_capability',
    entity_type: 'business',
    entity_id: id,
    details: { capability, reason: reason || null },
  });

  return NextResponse.json({ success: true });
}
