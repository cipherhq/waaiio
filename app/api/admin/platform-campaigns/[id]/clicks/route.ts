import { NextRequest, NextResponse } from 'next/server';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { createServiceClient } from '@/lib/supabase/service';
import { adminCorsHeaders } from '@/lib/admin-cors';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const origin = request.headers.get('origin');
  const cors = adminCorsHeaders(origin, 'GET, OPTIONS');
  const admin = await requirePlatformAdmin(request, { requiredRole: 'admin' });
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 403, headers: cors });

  const { id: campaignId } = await params;
  const supabase = createServiceClient();

  // Get asset IDs for this campaign (scoped query, not unbounded)
  const { data: assets, error: assetsErr } = await supabase
    .from('platform_campaign_assets')
    .select('id')
    .eq('campaign_id', campaignId);

  if (assetsErr) return NextResponse.json({ error: 'Failed to load click data' }, { status: 500, headers: cors });

  const assetIds = (assets || []).map(a => a.id);
  if (assetIds.length === 0) {
    return NextResponse.json({ data: [], total: 0, by_asset: [] }, { headers: cors });
  }

  // Aggregate clicks per asset
  const { data: clicks, error: clickErr } = await supabase
    .from('platform_campaign_clicks')
    .select('asset_id, clicked_at')
    .in('asset_id', assetIds);

  if (clickErr) return NextResponse.json({ error: 'Failed to load click data' }, { status: 500, headers: cors });

  const byAsset = new Map<string, number>();
  for (const c of (clicks || [])) {
    byAsset.set(c.asset_id, (byAsset.get(c.asset_id) || 0) + 1);
  }

  return NextResponse.json({
    total: (clicks || []).length,
    by_asset: Array.from(byAsset.entries()).map(([asset_id, count]) => ({ asset_id, count })),
  }, { headers: cors });
}

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: adminCorsHeaders(request.headers.get('origin'), 'GET, OPTIONS') });
}
