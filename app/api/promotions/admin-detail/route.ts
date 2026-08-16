import { logger } from '@/lib/logger';
import { NextResponse, type NextRequest } from 'next/server';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { createServiceClient } from '@/lib/supabase/service';

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

  const campaignId = request.nextUrl.searchParams.get('campaignId');
  if (!campaignId) {
    return NextResponse.json({ error: 'campaignId is required' }, { status: 400, headers: corsHeaders(origin) });
  }

  const service = createServiceClient();

  // Fetch full campaign
  const { data: campaign, error: campaignError } = await service
    .from('promo_campaigns')
    .select('*')
    .eq('id', campaignId)
    .maybeSingle();

  if (campaignError || !campaign) {
    return NextResponse.json({ error: 'Campaign not found' }, { status: 404, headers: corsHeaders(origin) });
  }

  // Use count queries for 1M-safe aggregation — never load all code rows
  const [bizRes, prizesRes, batchesRes,
    totalCodesRes, unusedCodesRes, claimedCodesRes, voidCodesRes, winnerCodesRes,
    winnerRedemptionsRes, pendingFulfRes, fulfilledRes, rejectedRes,
    totalAttemptsRes, invalidAttemptsRes, rateLimitedAttemptsRes,
    recentRedemptionsRes, recentAttemptsRes] = await Promise.all([
    service.from('businesses').select('id, name, country_code, owner_id, subscription_tier, capabilities').eq('id', campaign.business_id).maybeSingle(),
    service.from('promo_prizes').select('*').eq('campaign_id', campaignId).order('sort_order'),
    service.from('promo_code_batches').select('*').eq('campaign_id', campaignId).order('created_at', { ascending: false }),
    service.from('promo_campaign_codes').select('*', { count: 'exact', head: true }).eq('campaign_id', campaignId),
    service.from('promo_campaign_codes').select('*', { count: 'exact', head: true }).eq('campaign_id', campaignId).eq('status', 'unused'),
    service.from('promo_campaign_codes').select('*', { count: 'exact', head: true }).eq('campaign_id', campaignId).eq('status', 'claimed'),
    service.from('promo_campaign_codes').select('*', { count: 'exact', head: true }).eq('campaign_id', campaignId).eq('status', 'void'),
    service.from('promo_campaign_codes').select('*', { count: 'exact', head: true }).eq('campaign_id', campaignId).eq('outcome', 'winner'),
    service.from('promo_redemptions').select('*', { count: 'exact', head: true }).eq('campaign_id', campaignId).eq('outcome', 'winner'),
    service.from('promo_redemptions').select('*', { count: 'exact', head: true }).eq('campaign_id', campaignId).eq('fulfillment_status', 'pending'),
    service.from('promo_redemptions').select('*', { count: 'exact', head: true }).eq('campaign_id', campaignId).eq('fulfillment_status', 'fulfilled'),
    service.from('promo_redemptions').select('*', { count: 'exact', head: true }).eq('campaign_id', campaignId).eq('fulfillment_status', 'rejected'),
    service.from('promo_verification_attempts').select('*', { count: 'exact', head: true }).eq('campaign_id', campaignId),
    service.from('promo_verification_attempts').select('*', { count: 'exact', head: true }).eq('campaign_id', campaignId).eq('result', 'invalid'),
    service.from('promo_verification_attempts').select('*', { count: 'exact', head: true }).eq('campaign_id', campaignId).eq('result', 'rate_limited'),
    service.from('promo_redemptions').select('outcome, fulfillment_status, phone_e164, claimed_at').eq('campaign_id', campaignId).order('claimed_at', { ascending: false }).limit(50),
    service.from('promo_verification_attempts').select('result, phone_e164, created_at').eq('campaign_id', campaignId).order('created_at', { ascending: false }).limit(100),
  ]);

  const redemptions = recentRedemptionsRes.data || [];
  const attempts = recentAttemptsRes.data || [];

  // Code stats from count queries (1M-safe)
  const totalCodes = totalCodesRes.count ?? 0;
  const unusedCodes = unusedCodesRes.count ?? 0;
  const claimedCodes = claimedCodesRes.count ?? 0;
  const voidCodes = voidCodesRes.count ?? 0;
  const winnerCodes = winnerCodesRes.count ?? 0;

  // Redemption stats from count queries
  const winners = winnerRedemptionsRes.count ?? 0;
  // Note: uniqueParticipants is from recent sample (50 rows), not an authoritative total
  const uniqueParticipants_recent = new Set(redemptions.map((r) => r.phone_e164)).size;
  const pendingFulfillment = pendingFulfRes.count ?? 0;
  const fulfilledCount = fulfilledRes.count ?? 0;
  const rejectedCount = rejectedRes.count ?? 0;

  // Attempt stats from count queries
  const totalAttempts = totalAttemptsRes.count ?? 0;
  const invalidAttempts = invalidAttemptsRes.count ?? 0;
  const rateLimitedAttempts = rateLimitedAttemptsRes.count ?? 0;

  // Fraud indicators: phones with 3+ invalid attempts
  const invalidByPhone = new Map<string, number>();
  for (const a of attempts) {
    if (a.result === 'invalid' && a.phone_e164) {
      invalidByPhone.set(a.phone_e164, (invalidByPhone.get(a.phone_e164) || 0) + 1);
    }
  }
  const fraudIndicators = Array.from(invalidByPhone.entries())
    .filter(([, count]) => count >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([phone, count]) => ({
      // Mask for display while preserving admin utility
      phone_masked: phone.slice(0, 4) + '••••' + phone.slice(-4),
      invalid_attempts: count,
    }));

  return NextResponse.json(
    {
      campaign,
      business: bizRes.data || null,
      prizes: prizesRes.data || [],
      batches: batchesRes.data || [],
      codes_summary: {
        total: totalCodes,
        unused: unusedCodes,
        claimed: claimedCodes,
        void: voidCodes,
        winner_codes: winnerCodes,
      },
      redemptions: {
        recent: redemptions,
        winners,
        unique_participants_recent: uniqueParticipants_recent, // from recent sample, not authoritative total
        pending_fulfillment: pendingFulfillment,
        fulfilled: fulfilledCount,
        rejected: rejectedCount,
      },
      attempts: {
        recent: attempts,
        total: totalAttempts,
        invalid: invalidAttempts,
        rate_limited: rateLimitedAttempts,
      },
      fraud_indicators: fraudIndicators,
    },
    { headers: corsHeaders(origin) },
  );
}
