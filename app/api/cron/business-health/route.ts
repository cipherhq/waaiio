import { NextResponse } from 'next/server';
import { type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { createAlert } from '@/lib/alerts/create-alert';
import { logger } from '@/lib/logger';
import { verifyCronAuth } from '@/lib/cron-auth';

/**
 * GET /api/cron/business-health
 *
 * Run daily via cron to detect:
 * 1. Churn risk — businesses inactive for 7+ days
 * 2. Missing setup — no services, no operating hours
 * 3. No messages — bot hasn't received any messages
 * 4. Declining activity — bookings dropped significantly
 *
 * Creates alerts in the alerts table for the admin dashboard.
 */
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const authError = verifyCronAuth(request);
  if (authError) return authError;

  const supabase = createServiceClient();
  let alertsCreated = 0;

  try {
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();

    // Get all active businesses
    const { data: businesses } = await supabase
      .from('businesses')
      .select('id, name, created_at')
      .eq('status', 'active');

    if (!businesses || businesses.length === 0) {
      return NextResponse.json({ message: 'No active businesses', alerts: 0 });
    }

    // Get existing unresolved alerts to avoid duplicates
    const { data: existingAlerts } = await supabase
      .from('alerts')
      .select('business_id, type')
      .is('resolved_at', null);

    const alertExists = (bizId: string, type: string) =>
      (existingAlerts || []).some(a => a.business_id === bizId && a.type === type);

    // ── Batch queries — fetch aggregated data for ALL businesses at once ──
    // This replaces up to 8 sequential queries per business with 8 total queries.
    const bizIds = businesses.map(b => b.id);

    // Helper: build a Map<business_id, count> from a flat rows array
    const countByBiz = (rows: Array<{ business_id: string }> | null): Map<string, number> => {
      const map = new Map<string, number>();
      for (const row of rows || []) {
        map.set(row.business_id, (map.get(row.business_id) || 0) + 1);
      }
      return map;
    };

    const [
      { data: servicesRows },
      { data: inboundMsgRows },
      { data: recentMsgRows7d },
      { data: recentMsgRows14d },
      { data: totalMsgRows },
      { data: recentBookingRows7d },
      { data: recentBookingRows14d },
      { data: payoutAccountRows },
      { data: platformFeeRows },
    ] = await Promise.all([
      // services count per business
      supabase.from('services').select('business_id').in('business_id', bizIds).limit(5000),
      // inbound messages (bot ever used)
      supabase.from('chat_messages').select('business_id').in('business_id', bizIds).eq('direction', 'inbound').limit(5000),
      // recent messages last 7 days
      supabase.from('chat_messages').select('business_id').in('business_id', bizIds).gte('created_at', sevenDaysAgo).limit(5000),
      // recent messages last 14 days
      supabase.from('chat_messages').select('business_id').in('business_id', bizIds).gte('created_at', fourteenDaysAgo).limit(5000),
      // total messages ever (to detect previously-active businesses)
      supabase.from('chat_messages').select('business_id').in('business_id', bizIds).limit(5000),
      // recent bookings last 7 days
      supabase.from('bookings').select('business_id').in('business_id', bizIds).gte('created_at', sevenDaysAgo).limit(5000),
      // recent bookings last 14 days
      supabase.from('bookings').select('business_id').in('business_id', bizIds).gte('created_at', fourteenDaysAgo).limit(5000),
      // active payout accounts
      supabase.from('payout_accounts').select('business_id').in('business_id', bizIds).eq('is_active', true).limit(5000),
      // platform fees (to detect businesses that have had payments)
      supabase.from('platform_fees').select('business_id').in('business_id', bizIds).limit(5000),
    ]);

    const serviceCount = countByBiz(servicesRows);
    const inboundMsgCount = countByBiz(inboundMsgRows);
    const recentMsgCount7d = countByBiz(recentMsgRows7d);
    const recentMsgCount14d = countByBiz(recentMsgRows14d);
    const totalMsgCount = countByBiz(totalMsgRows);
    const recentBookingCount7d = countByBiz(recentBookingRows7d);
    const recentBookingCount14d = countByBiz(recentBookingRows14d);
    const payoutAccountCount = countByBiz(payoutAccountRows);
    const platformFeeCount = countByBiz(platformFeeRows);

    for (const biz of businesses) {
      // Skip businesses created less than 3 days ago (still onboarding)
      if (new Date(biz.created_at).getTime() > now.getTime() - 3 * 24 * 60 * 60 * 1000) continue;

      // ── Check 1: No services added ──
      if (!alertExists(biz.id, 'no_services')) {
        if ((serviceCount.get(biz.id) || 0) === 0) {
          await createAlert(supabase, {
            businessId: biz.id,
            type: 'no_services',
            severity: 'warning',
            title: 'No services added',
            message: `${biz.name} hasn't added any services yet. Their bot can't take bookings or orders without services.`,
          });
          alertsCreated++;
        }
      }

      // ── Check 2: No inbound messages (bot never used) ──
      if (!alertExists(biz.id, 'no_messages')) {
        if ((inboundMsgCount.get(biz.id) || 0) === 0) {
          await createAlert(supabase, {
            businessId: biz.id,
            type: 'no_messages',
            severity: 'info',
            title: 'Bot hasn\'t received any messages',
            message: `${biz.name} hasn't received any WhatsApp messages yet. They may need help sharing their bot link.`,
          });
          alertsCreated++;
        }
      }

      // ── Check 3: Churn risk — no activity in 7+ days ──
      if (!alertExists(biz.id, 'churn_risk_7d')) {
        const recentMessages = recentMsgCount7d.get(biz.id) || 0;
        const recentBookings = recentBookingCount7d.get(biz.id) || 0;

        if (recentMessages === 0 && recentBookings === 0) {
          // Only alert if they HAD activity before (not just a new silent business)
          if ((totalMsgCount.get(biz.id) || 0) > 0) {
            await createAlert(supabase, {
              businessId: biz.id,
              type: 'churn_risk_7d',
              severity: 'warning',
              title: 'No activity in 7 days',
              message: `${biz.name} has had no messages or bookings in the last 7 days. They may be at risk of churning.`,
              metadata: { last_activity_check: sevenDaysAgo },
            });
            alertsCreated++;
          }
        }
      }

      // ── Check 4: Critical churn — no activity in 14+ days ──
      if (!alertExists(biz.id, 'churn_risk_14d')) {
        const recentMessages = recentMsgCount14d.get(biz.id) || 0;
        const recentBookings = recentBookingCount14d.get(biz.id) || 0;

        if (recentMessages === 0 && recentBookings === 0) {
          if ((totalMsgCount.get(biz.id) || 0) > 0) {
            await createAlert(supabase, {
              businessId: biz.id,
              type: 'churn_risk_14d',
              severity: 'critical',
              title: 'No activity in 14 days — churn risk',
              message: `${biz.name} has been completely inactive for 14+ days. Immediate outreach recommended.`,
              metadata: { last_activity_check: fourteenDaysAgo },
            });
            alertsCreated++;
          }
        }
      }

      // ── Check 5: No payout account ──
      if (!alertExists(biz.id, 'no_payout')) {
        const hasPayoutAccount = (payoutAccountCount.get(biz.id) || 0) > 0;
        const hasPayments = (platformFeeCount.get(biz.id) || 0) > 0;

        if (!hasPayoutAccount && hasPayments) {
          await createAlert(supabase, {
            businessId: biz.id,
            type: 'no_payout',
            severity: 'warning',
            title: 'No payout account configured',
            message: `${biz.name} has received payments but hasn't set up a payout account. Money is accumulating on the platform.`,
          });
          alertsCreated++;
        }
      }
    }

    logger.debug(`[BUSINESS-HEALTH] Created ${alertsCreated} alerts for ${businesses.length} businesses`);
    return NextResponse.json({ message: 'Health check complete', businesses: businesses.length, alerts: alertsCreated });
  } catch (error) {
    logger.error('[BUSINESS-HEALTH] Error:', error);
    return NextResponse.json({ error: 'Health check failed' }, { status: 500 });
  }
}
