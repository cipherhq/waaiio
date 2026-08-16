import { logger } from '@/lib/logger';
import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { requireCapability } from '@/lib/capabilities/api-guard';
import type { PromoCampaignStatus } from '@/lib/promotions/types';

const VALID_STATUSES: PromoCampaignStatus[] = ['draft', 'scheduled', 'active', 'paused', 'ended', 'archived'];

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const businessId = request.nextUrl.searchParams.get('businessId');
  if (!businessId) {
    return NextResponse.json({ error: 'businessId is required' }, { status: 400 });
  }

  const statusParam = request.nextUrl.searchParams.get('status') as PromoCampaignStatus | null;
  if (statusParam && !VALID_STATUSES.includes(statusParam)) {
    return NextResponse.json(
      { error: `status must be one of: ${VALID_STATUSES.join(', ')}` },
      { status: 400 },
    );
  }

  const service = createServiceClient();

  const guard = await requireCapability(supabase, service, {
    businessId,
    userId: user.id,
    capability: 'promo_verification',
    action: 'read_history',
  });
  if (!guard.allowed) return NextResponse.json(guard.denial, { status: guard.status });

  // Fetch campaigns
  let query = service
    .from('promo_campaigns')
    .select('*')
    .eq('business_id', businessId)
    .order('created_at', { ascending: false });

  if (statusParam) {
    query = query.eq('status', statusParam);
  }

  const { data: campaigns, error } = await query;
  if (error) {
    logger.error('[PROMOTIONS] list error:', error);
    return NextResponse.json({ error: 'Failed to fetch campaigns' }, { status: 500 });
  }

  if (!campaigns || campaigns.length === 0) {
    return NextResponse.json({ campaigns: [] });
  }

  const campaignIds = campaigns.map((c) => c.id);

  // Use DB aggregate RPC — avoids loading raw rows for potentially large campaigns (1M-safe).
  // Returns: total_codes, total_winners, total_attempts, pending_fulfillment per campaign.
  const { data: aggregates, error: aggError } = await service.rpc('get_promo_campaign_aggregates', {
    p_campaign_ids: campaignIds,
  });

  if (aggError) {
    logger.error('[PROMOTIONS] aggregate RPC error:', aggError);
    return NextResponse.json({ error: 'Failed to fetch campaign stats' }, { status: 500 });
  }

  interface AggRow { campaign_id: string; total_codes: number; total_winners: number; total_attempts: number; pending_fulfillment: number; unique_participants: number; }
  const aggList = (aggregates || []) as AggRow[];
  const aggMap = new Map(aggList.map((a) => [a.campaign_id, a]));

  const enriched = campaigns.map((c) => {
    const agg = aggMap.get(c.id);
    return {
      ...c,
      total_codes: agg?.total_codes ?? 0,
      winners_count: agg?.total_winners ?? 0,
      total_attempts: agg?.total_attempts ?? 0,
      pending_fulfillment: agg?.pending_fulfillment ?? 0,
      unique_participants: agg?.unique_participants ?? 0,
    };
  });

  return NextResponse.json({ campaigns: enriched });
}
