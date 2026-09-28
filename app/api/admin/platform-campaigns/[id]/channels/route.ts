import { NextRequest, NextResponse } from 'next/server';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { createServiceClient } from '@/lib/supabase/service';
import { adminCorsHeaders } from '@/lib/admin-cors';

export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/platform-campaigns/[id]/channels
 * List eligible active shared WhatsApp channels for asset creation.
 * Filters by campaign market_scope when non-empty.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const origin = request.headers.get('origin');
  const cors = adminCorsHeaders(origin, 'GET, OPTIONS');
  const admin = await requirePlatformAdmin(request, { requiredRole: 'admin' });
  if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 403, headers: cors });

  const { id: campaignId } = await params;
  const supabase = createServiceClient();

  const { data: campaign } = await supabase
    .from('platform_campaigns')
    .select('market_scope')
    .eq('id', campaignId)
    .single();

  if (!campaign) return NextResponse.json({ error: 'Campaign not found' }, { status: 404, headers: cors });

  let query = supabase
    .from('whatsapp_channels')
    .select('id, phone_number, country_code, display_name')
    .eq('channel_type', 'shared')
    .eq('is_active', true)
    .order('country_code');

  const scope = (campaign.market_scope as string[]) || [];
  if (scope.length > 0) {
    query = query.in('country_code', scope);
  }

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: 'Failed to load channels' }, { status: 500, headers: cors });

  return NextResponse.json({ data: data || [] }, { headers: cors });
}

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: adminCorsHeaders(request.headers.get('origin'), 'GET, OPTIONS') });
}
