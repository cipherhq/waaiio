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

  const { id } = await params;
  const supabase = createServiceClient();
  const { searchParams } = new URL(request.url);
  const page = Math.max(1, parseInt(searchParams.get('page') || '1'));
  const limit = Math.min(100, Math.max(1, parseInt(searchParams.get('limit') || '20')));
  const offset = (page - 1) * limit;

  const { data, error, count } = await supabase
    .from('platform_campaign_participants')
    .select('*', { count: 'exact' })
    .eq('campaign_id', id)
    .order('latest_response_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) return NextResponse.json({ error: 'Failed to load participants' }, { status: 500, headers: cors });
  return NextResponse.json({ data: data || [], total: count || 0, page, limit }, { headers: cors });
}

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: adminCorsHeaders(request.headers.get('origin'), 'GET, OPTIONS') });
}
