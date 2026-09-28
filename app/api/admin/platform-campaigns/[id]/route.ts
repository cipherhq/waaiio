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

  // Counts — scoped queries only
  const [participantsRes, eventsRes, assetsRes] = await Promise.all([
    supabase.from('platform_campaign_participants').select('id', { count: 'exact', head: true }).eq('campaign_id', id),
    supabase.from('platform_campaign_events').select('id', { count: 'exact', head: true }).eq('campaign_id', id),
    supabase.from('platform_campaign_assets').select('*').eq('campaign_id', id).order('created_at', { ascending: false }),
  ]);

  if (participantsRes.error || eventsRes.error || assetsRes.error) {
    return NextResponse.json({ error: 'Failed to load campaign details' }, { status: 500, headers: cors });
  }

  const assetsList = assetsRes.data || [];
  const assetIds = assetsList.map(a => a.id);

  // Scoped click counts — only for this campaign's assets
  const clicksByAsset = new Map<string, number>();
  if (assetIds.length > 0) {
    const { data: clicks } = await supabase
      .from('platform_campaign_clicks')
      .select('asset_id')
      .in('asset_id', assetIds);

    for (const c of (clicks || [])) {
      clicksByAsset.set(c.asset_id, (clicksByAsset.get(c.asset_id) || 0) + 1);
    }
  }

  return NextResponse.json({
    data: campaign,
    counts: {
      participants: participantsRes.count || 0,
      events: eventsRes.count || 0,
      assets: assetsList.length,
    },
    assets: assetsList.map(a => ({ ...a, click_count: clicksByAsset.get(a.id) || 0 })),
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

  // Validate and build update fields
  const allowed: Record<string, unknown> = {};

  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || !(body.name as string).trim()) {
      return NextResponse.json({ error: 'name must be a non-empty string' }, { status: 400, headers: cors });
    }
    allowed.name = (body.name as string).trim().slice(0, 200);
  }

  if (body.status !== undefined) {
    const validStatuses = ['draft', 'active', 'paused', 'completed', 'archived'];
    if (!validStatuses.includes(body.status as string)) {
      return NextResponse.json({ error: `status must be one of: ${validStatuses.join(', ')}` }, { status: 400, headers: cors });
    }
    allowed.status = body.status;
  }

  if (body.consent_type !== undefined) {
    const validConsent = ['opt_in', 'informational', 'transactional'];
    if (!validConsent.includes(body.consent_type as string)) {
      return NextResponse.json({ error: `consent_type must be one of: ${validConsent.join(', ')}` }, { status: 400, headers: cors });
    }
    allowed.consent_type = body.consent_type;
  }

  if (body.message_config !== undefined) allowed.message_config = body.message_config;
  if (body.starts_at !== undefined) allowed.starts_at = body.starts_at;
  if (body.ends_at !== undefined) allowed.ends_at = body.ends_at;

  // Validate timing ordering
  if (body.starts_at && body.ends_at && new Date(body.starts_at as string) >= new Date(body.ends_at as string)) {
    return NextResponse.json({ error: 'starts_at must be before ends_at' }, { status: 400, headers: cors });
  }

  const supabase = createServiceClient();

  // BLOCKER 7: market_scope update must not orphan active assets
  if (body.market_scope !== undefined) {
    if (!Array.isArray(body.market_scope)) {
      return NextResponse.json({ error: 'market_scope must be an array' }, { status: 400, headers: cors });
    }
    const newScope = body.market_scope as string[];
    if (newScope.length > 0) {
      const { data: activeAssets } = await supabase
        .from('platform_campaign_assets')
        .select('market')
        .eq('campaign_id', id)
        .eq('is_active', true);

      const orphaned = (activeAssets || []).filter(a => !newScope.includes(a.market));
      if (orphaned.length > 0) {
        const markets = [...new Set(orphaned.map(a => a.market))];
        return NextResponse.json({
          error: `Cannot narrow market_scope: ${orphaned.length} active asset(s) in market(s) ${markets.join(', ')} would be outside the new scope. Deactivate them first.`,
        }, { status: 400, headers: cors });
      }
    }
    allowed.market_scope = newScope;
  }

  allowed.updated_at = new Date().toISOString();

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
