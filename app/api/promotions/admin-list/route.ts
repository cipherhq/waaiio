import { logger } from '@/lib/logger';
import { NextResponse, type NextRequest } from 'next/server';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { createServiceClient } from '@/lib/supabase/service';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

function corsHeaders(origin?: string | null) {
  const allowedOrigins = [
    process.env.ADMIN_ORIGIN || 'https://admin.waaiio.com',
    'http://localhost:8083',
  ];
  const allowed = origin && allowedOrigins.includes(origin) ? origin : allowedOrigins[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

export async function OPTIONS(request: NextRequest) {
  const origin = request.headers.get('Origin');
  return NextResponse.json({}, { headers: corsHeaders(origin) });
}

export async function GET(request: NextRequest) {
  const origin = request.headers.get('Origin');

  const admin = await requirePlatformAdmin(request, {
    requiredRole: ['admin', 'support', 'operations'],
  });
  if (!admin) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403, headers: corsHeaders(origin) });
  }

  const { searchParams } = request.nextUrl;
  const statusFilter = searchParams.get('status');
  const businessIdFilter = searchParams.get('businessId');
  const pageParam = parseInt(searchParams.get('page') || '1', 10);
  const limitParam = Math.min(
    parseInt(searchParams.get('limit') || String(DEFAULT_PAGE_SIZE), 10),
    MAX_PAGE_SIZE,
  );
  const page = isNaN(pageParam) || pageParam < 1 ? 1 : pageParam;
  const limit = isNaN(limitParam) || limitParam < 1 ? DEFAULT_PAGE_SIZE : limitParam;
  const offset = (page - 1) * limit;

  const service = createServiceClient();

  // Build campaign query
  let query = service
    .from('promo_campaigns')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (statusFilter) {
    query = query.eq('status', statusFilter);
  }
  if (businessIdFilter) {
    query = query.eq('business_id', businessIdFilter);
  }

  const { data: campaigns, count, error } = await query;
  if (error) {
    logger.error('[ADMIN PROMOTIONS] list error:', error);
    return NextResponse.json({ error: 'Failed to fetch campaigns' }, { status: 500, headers: corsHeaders(origin) });
  }

  if (!campaigns || campaigns.length === 0) {
    return NextResponse.json(
      { campaigns: [], total: count ?? 0, page, limit },
      { headers: corsHeaders(origin) },
    );
  }

  // Resolve business names
  const bizIds = [...new Set(campaigns.map((c) => c.business_id))];
  const { data: businesses } = await service
    .from('businesses')
    .select('id, name, country_code')
    .in('id', bizIds);

  const bizMap = new Map((businesses || []).map((b) => [b.id, b]));

  // Aggregate stats via RPC — avoids loading raw rows for large campaigns
  const campaignIds = campaigns.map((c) => c.id);

  const { data: aggregates } = await service.rpc('get_promo_campaign_aggregates', {
    p_campaign_ids: campaignIds,
  });

  interface AggRow { campaign_id: string; total_codes: number; total_winners: number; total_attempts: number; pending_fulfillment: number; }
  const aggList = (aggregates || []) as AggRow[];
  const aggMap = new Map(aggList.map(a => [a.campaign_id, a]));

  const enriched = campaigns.map((c) => {
    const biz = bizMap.get(c.business_id);
    const agg = aggMap.get(c.id);
    return {
      ...c,
      business_name: biz?.name || null,
      business_country: biz?.country_code || null,
      total_codes: agg?.total_codes ?? 0,
      total_winners: agg?.total_winners ?? 0,
      total_attempts: agg?.total_attempts ?? 0,
      pending_fulfillment: agg?.pending_fulfillment ?? 0,
    };
  });

  return NextResponse.json(
    {
      campaigns: enriched,
      total: count ?? 0,
      page,
      limit,
      totalPages: Math.ceil((count ?? 0) / limit),
    },
    { headers: corsHeaders(origin) },
  );
}
