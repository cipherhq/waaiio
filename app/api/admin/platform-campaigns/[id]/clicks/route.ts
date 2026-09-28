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
    return NextResponse.json({ total: 0, by_asset: [] }, { headers: cors });
  }

  // Bounded click counts — one count query per asset (head: true, never loads rows)
  const clickCountResults = await Promise.all(
    assetIds.map(assetId =>
      supabase
        .from('platform_campaign_clicks')
        .select('id', { count: 'exact', head: true })
        .eq('asset_id', assetId)
        .then(res => ({ assetId, count: res.count ?? 0, error: res.error }))
    ),
  );

  const byAsset: { asset_id: string; count: number }[] = [];
  let total = 0;
  for (const r of clickCountResults) {
    if (r.error) {
      return NextResponse.json({ error: `Failed to load click data for asset ${r.assetId}` }, { status: 500, headers: cors });
    }
    byAsset.push({ asset_id: r.assetId, count: r.count });
    total += r.count;
  }

  return NextResponse.json({ total, by_asset: byAsset }, { headers: cors });
}

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: adminCorsHeaders(request.headers.get('origin'), 'GET, OPTIONS') });
}
