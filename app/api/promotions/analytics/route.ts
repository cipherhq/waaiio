import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { requireCapability } from '@/lib/capabilities/api-guard';

/**
 * GET /api/promotions/analytics?businessId=&campaignId=
 *
 * Returns analytics data for a single campaign including:
 * - Aggregate stats (attempts, winners, participants, etc.)
 * - Verification attempts over time (by day, last 30 days)
 * - Winners over time (by day)
 * - Suspicious activity metrics
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const businessId = request.nextUrl.searchParams.get('businessId');
  const campaignId = request.nextUrl.searchParams.get('campaignId');

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

  // Verify campaign belongs to business
  const { data: campaign } = await service
    .from('promo_campaigns')
    .select('id, rate_limit_window_minutes')
    .eq('id', campaignId)
    .eq('business_id', businessId)
    .maybeSingle();

  if (!campaign) {
    return NextResponse.json({ error: 'Campaign not found' }, { status: 404 });
  }

  const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();

  // Use count queries for aggregate totals (1M-safe) + bounded row queries for time-series only.
  const [
    totalCodesRes, claimedCodesRes, unusedCodesRes, voidCodesRes,
    totalAttemptsRes, validAttemptsRes, invalidAttemptsRes, rateLimitedAttemptsRes,
    winnersRes, fulfilledRes, pendingRes,
    // Bounded time-series rows for the 60-day charts and suspicious-activity analysis
    recentAttemptsRes, recentRedemptionsRes,
    // Aggregate RPC for authoritative unique_participants (1M-safe, DB-side DISTINCT COUNT)
    aggregatesRes,
  ] = await Promise.all([
    // Code counts
    service.from('promo_campaign_codes').select('*', { count: 'exact', head: true }).eq('campaign_id', campaignId),
    service.from('promo_campaign_codes').select('*', { count: 'exact', head: true }).eq('campaign_id', campaignId).eq('status', 'claimed'),
    service.from('promo_campaign_codes').select('*', { count: 'exact', head: true }).eq('campaign_id', campaignId).eq('status', 'unused'),
    service.from('promo_campaign_codes').select('*', { count: 'exact', head: true }).eq('campaign_id', campaignId).eq('status', 'void'),
    // Attempt counts
    service.from('promo_verification_attempts').select('*', { count: 'exact', head: true }).eq('campaign_id', campaignId),
    service.from('promo_verification_attempts').select('*', { count: 'exact', head: true }).eq('campaign_id', campaignId).in('result', ['winner', 'try_again']),
    service.from('promo_verification_attempts').select('*', { count: 'exact', head: true }).eq('campaign_id', campaignId).eq('result', 'invalid'),
    service.from('promo_verification_attempts').select('*', { count: 'exact', head: true }).eq('campaign_id', campaignId).eq('result', 'rate_limited'),
    // Redemption counts
    service.from('promo_redemptions').select('*', { count: 'exact', head: true }).eq('campaign_id', campaignId).eq('outcome', 'winner'),
    service.from('promo_redemptions').select('*', { count: 'exact', head: true }).eq('campaign_id', campaignId).eq('fulfillment_status', 'fulfilled'),
    service.from('promo_redemptions').select('*', { count: 'exact', head: true }).eq('campaign_id', campaignId).eq('fulfillment_status', 'pending'),
    // Bounded rows for time-series charts (last 60 days, capped at 5 000 rows)
    service
      .from('promo_verification_attempts')
      .select('result, phone_e164, created_at')
      .eq('campaign_id', campaignId)
      .gte('created_at', sixtyDaysAgo)
      .order('created_at', { ascending: true })
      .limit(5000),
    service
      .from('promo_redemptions')
      .select('outcome, fulfillment_status, phone_e164, claimed_at')
      .eq('campaign_id', campaignId)
      .eq('outcome', 'winner')
      .gte('claimed_at', sixtyDaysAgo)
      .limit(5000),
    service.rpc('get_promo_campaign_aggregates', { p_campaign_ids: [campaignId] }),
  ]);

  // Totals from count queries
  const totalCodes = totalCodesRes.count ?? 0;
  const verifiedCodes = claimedCodesRes.count ?? 0;
  const unusedCodes = unusedCodesRes.count ?? 0;
  const voidCodes = voidCodesRes.count ?? 0;

  const totalAttempts = totalAttemptsRes.count ?? 0;
  const validAttempts = validAttemptsRes.count ?? 0;
  const invalidAttempts = invalidAttemptsRes.count ?? 0;
  const rateLimitedAttempts = rateLimitedAttemptsRes.count ?? 0;

  const winners = winnersRes.count ?? 0;
  const fulfilledWinners = fulfilledRes.count ?? 0;
  const pendingFulfillment = pendingRes.count ?? 0;

  const recentRedemptions = recentRedemptionsRes.data || [];

  // unique_participants from authoritative aggregate RPC (1M-safe, DB-side DISTINCT COUNT)
  const agg = (aggregatesRes.data as Array<{ campaign_id: string; unique_participants?: number }> | null)?.[0];
  const uniqueParticipants = Number(agg?.unique_participants ?? 0);

  const claimRate = totalAttempts > 0 ? Math.round((winners / totalAttempts) * 100 * 10) / 10 : 0;
  const fulfillmentRate = winners > 0 ? Math.round((fulfilledWinners / winners) * 100 * 10) / 10 : 0;

  // Build time-series data (attempts by day, last 60 days) from bounded rows
  const attempts = recentAttemptsRes.data || [];

  const attemptsByDay = new Map<string, { total: number; valid: number; invalid: number; rateLimited: number }>();
  for (const a of attempts) {
    const day = a.created_at.slice(0, 10); // YYYY-MM-DD
    if (!attemptsByDay.has(day)) {
      attemptsByDay.set(day, { total: 0, valid: 0, invalid: 0, rateLimited: 0 });
    }
    const entry = attemptsByDay.get(day)!;
    entry.total++;
    if (a.result === 'winner' || a.result === 'try_again') entry.valid++;
    if (a.result === 'invalid') entry.invalid++;
    if (a.result === 'rate_limited') entry.rateLimited++;
  }

  // recentRedemptions already filtered to winner + last-60-days by the DB query above
  const winnersByDay = new Map<string, number>();
  for (const r of recentRedemptions) {
    const day = r.claimed_at.slice(0, 10);
    winnersByDay.set(day, (winnersByDay.get(day) || 0) + 1);
  }

  // Build a sorted daily array covering all days with data
  const allDays = new Set([...attemptsByDay.keys(), ...winnersByDay.keys()]);
  const dailySeries = Array.from(allDays)
    .sort()
    .map((day) => {
      const a = attemptsByDay.get(day) || { total: 0, valid: 0, invalid: 0, rateLimited: 0 };
      return {
        date: day,
        attempts: a.total,
        validAttempts: a.valid,
        invalidAttempts: a.invalid,
        rateLimitedAttempts: a.rateLimited,
        winners: winnersByDay.get(day) || 0,
      };
    });

  // Suspicious activity: phones with repeated invalid attempts
  const invalidByPhone = new Map<string, number>();
  for (const a of attempts) {
    if (a.result === 'invalid' && a.phone_e164) {
      invalidByPhone.set(a.phone_e164, (invalidByPhone.get(a.phone_e164) || 0) + 1);
    }
  }
  const suspiciousPhones = Array.from(invalidByPhone.entries())
    .filter(([, count]) => count >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([phone, count]) => ({
      phone: phone.slice(0, 4) + '••••' + phone.slice(-4),
      invalidAttempts: count,
    }));

  return NextResponse.json({
    stats: {
      totalCodes,
      verifiedCodes,
      unusedCodes,
      voidCodes,
      totalAttempts,
      validAttempts,
      invalidAttempts,
      rateLimitedAttempts,
      winners,
      uniqueParticipants,
      fulfilledWinners,
      pendingFulfillment,
      claimRate,
      fulfillmentRate,
    },
    dailySeries,
    suspiciousActivity: {
      rateLimitedCount: rateLimitedAttempts,
      suspiciousPhones,
    },
  });
}
