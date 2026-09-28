import { NextRequest, NextResponse } from 'next/server';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { createServiceClient } from '@/lib/supabase/service';
import { adminCorsHeaders } from '@/lib/admin-cors';

export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/platform-campaigns/[id]
 * Get campaign detail with participant/event/click counts.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const origin = request.headers.get('origin');
  const cors = adminCorsHeaders(origin, 'GET, PUT, OPTIONS');
  const admin = await requirePlatformAdmin(request, { requiredRole: 'admin' });
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 403, headers: cors });

  const { id } = await params;
  const supabase = createServiceClient();

  const { data: campaign, error } = await supabase
    .from('platform_campaigns')
    .select('*')
    .eq('id', id)
    .single();

  if (error || !campaign) return NextResponse.json({ error: 'Campaign not found' }, { status: 404, headers: cors });

  // Counts
  const [participants, events, assets, clicks] = await Promise.all([
    supabase.from('platform_campaign_participants').select('id', { count: 'exact', head: true }).eq('campaign_id', id),
    supabase.from('platform_campaign_events').select('id', { count: 'exact', head: true }).eq('campaign_id', id),
    supabase.from('platform_campaign_assets').select('*').eq('campaign_id', id).order('created_at', { ascending: false }),
    supabase.from('platform_campaign_clicks').select('asset_id'),
  ]);

  // Count clicks per asset
  const assetIds = new Set((assets.data || []).map(a => a.id));
  const clicksByAsset = new Map<string, number>();
  for (const c of (clicks.data || [])) {
    if (assetIds.has(c.asset_id)) {
      clicksByAsset.set(c.asset_id, (clicksByAsset.get(c.asset_id) || 0) + 1);
    }
  }

  return NextResponse.json({
    data: campaign,
    counts: {
      participants: participants.count || 0,
      events: events.count || 0,
      assets: (assets.data || []).length,
    },
    assets: (assets.data || []).map(a => ({ ...a, click_count: clicksByAsset.get(a.id) || 0 })),
  }, { headers: cors });
}

/**
 * PUT /api/admin/platform-campaigns/[id]
 * Update campaign (status, name, config, timing). No hard delete in Slice 1.
 */
export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const origin = request.headers.get('origin');
  const cors = adminCorsHeaders(origin, 'GET, PUT, OPTIONS');
  const admin = await requirePlatformAdmin(request, { requiredRole: 'admin' });
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 403, headers: cors });

  const { id } = await params;
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers: cors });
  }

  // Only allowed update fields
  const allowed: Record<string, unknown> = {};
  if (body.name !== undefined) allowed.name = body.name;
  if (body.status !== undefined) allowed.status = body.status;
  if (body.message_config !== undefined) allowed.message_config = body.message_config;
  if (body.market_scope !== undefined) allowed.market_scope = body.market_scope;
  if (body.consent_type !== undefined) allowed.consent_type = body.consent_type;
  if (body.starts_at !== undefined) allowed.starts_at = body.starts_at;
  if (body.ends_at !== undefined) allowed.ends_at = body.ends_at;
  allowed.updated_at = new Date().toISOString();

  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from('platform_campaigns')
    .update(allowed)
    .eq('id', id)
    .select()
    .single();

  if (error || !data) return NextResponse.json({ error: 'Failed to update campaign' }, { status: 500, headers: cors });

  await supabase.from('admin_audit_logs').insert({
    actor_id: admin.userId,
    action: 'platform_campaign_updated',
    entity_type: 'platform_campaign',
    entity_id: data.id,
    details: { fields: Object.keys(allowed).filter(k => k !== 'updated_at') },
  }).then(() => {}, () => {});

  return NextResponse.json({ data }, { headers: cors });
}

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: adminCorsHeaders(request.headers.get('origin'), 'GET, PUT, OPTIONS') });
}
