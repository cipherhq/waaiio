import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { requireCapability } from '@/lib/capabilities/api-guard';

/**
 * GET /api/promotions/detail?businessId=&campaignId=
 *
 * Returns full campaign detail including prizes, batches, and aggregated stats.
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = request.nextUrl;
  const businessId = searchParams.get('businessId');
  const campaignId = searchParams.get('campaignId');

  if (!businessId || !campaignId) {
    return NextResponse.json({ error: 'businessId and campaignId are required' }, { status: 400 });
  }

  const service = createServiceClient();

  const guard = await requireCapability(supabase, service, {
    businessId,
    userId: user.id,
    capability: 'promo_verification',
    action: 'read_history',
  });
  if (!guard.allowed) return NextResponse.json(guard.denial, { status: guard.status });

  // Fetch campaign
  const { data: campaign, error: campaignError } = await service
    .from('promo_campaigns')
    .select('*')
    .eq('id', campaignId)
    .eq('business_id', businessId)
    .maybeSingle();

  if (campaignError || !campaign) {
    return NextResponse.json({ error: 'Campaign not found' }, { status: 404 });
  }

  // Fetch prizes and batches (bounded) alongside count-based aggregates (1M-safe).
  // Never load all code/redemption/attempt rows — use { count: 'exact', head: true } instead.
  const [prizesRes, batchesRes,
    totalCodesRes, unusedRes, claimedRes, voidRes, winnerCodesRes,
    totalRedemptionsRes, pendingFulfRes, fulfilledRes,
    totalAttemptsRes, invalidAttemptsRes,
    aggregatesRes] = await Promise.all([
    service.from('promo_prizes').select('*').eq('campaign_id', campaignId).order('sort_order'),
    service
      .from('promo_code_batches')
      .select('*')
      .eq('campaign_id', campaignId)
      .order('created_at', { ascending: false }),
    // Code counts
    service.from('promo_campaign_codes').select('*', { count: 'exact', head: true }).eq('campaign_id', campaignId),
    service.from('promo_campaign_codes').select('*', { count: 'exact', head: true }).eq('campaign_id', campaignId).eq('status', 'unused'),
    service.from('promo_campaign_codes').select('*', { count: 'exact', head: true }).eq('campaign_id', campaignId).eq('status', 'claimed'),
    service.from('promo_campaign_codes').select('*', { count: 'exact', head: true }).eq('campaign_id', campaignId).eq('status', 'void'),
    service.from('promo_campaign_codes').select('*', { count: 'exact', head: true }).eq('campaign_id', campaignId).eq('outcome', 'winner'),
    // Redemption counts
    service.from('promo_redemptions').select('*', { count: 'exact', head: true }).eq('campaign_id', campaignId).eq('outcome', 'winner'),
    service.from('promo_redemptions').select('*', { count: 'exact', head: true }).eq('campaign_id', campaignId).eq('fulfillment_status', 'pending'),
    service.from('promo_redemptions').select('*', { count: 'exact', head: true }).eq('campaign_id', campaignId).eq('fulfillment_status', 'fulfilled'),
    // Attempt counts
    service.from('promo_verification_attempts').select('*', { count: 'exact', head: true }).eq('campaign_id', campaignId),
    service.from('promo_verification_attempts').select('*', { count: 'exact', head: true }).eq('campaign_id', campaignId).eq('result', 'invalid'),
    // Aggregate RPC for unique_participants (1M-safe, uses DB-side DISTINCT COUNT)
    service.rpc('get_promo_campaign_aggregates', { p_campaign_ids: [campaignId] }),
  ]);

  const agg = (aggregatesRes.data as Array<{ campaign_id: string; unique_participants?: number }> | null)?.[0];

  const stats = {
    total_codes: totalCodesRes.count ?? 0,
    verified_codes: claimedRes.count ?? 0,
    unused_codes: unusedRes.count ?? 0,
    void_codes: voidRes.count ?? 0,
    winners_count: totalRedemptionsRes.count ?? 0,
    pending_fulfillment: pendingFulfRes.count ?? 0,
    fulfilled_count: fulfilledRes.count ?? 0,
    total_attempts: totalAttemptsRes.count ?? 0,
    invalid_attempts: invalidAttemptsRes.count ?? 0,
    unique_participants: agg?.unique_participants ?? 0,
  };

  return NextResponse.json({
    campaign: { ...campaign, ...stats },
    prizes: prizesRes.data || [],
    batches: batchesRes.data || [],
  });
}
