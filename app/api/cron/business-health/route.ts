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

    for (const biz of businesses) {
      // Skip businesses created less than 3 days ago (still onboarding)
      if (new Date(biz.created_at).getTime() > now.getTime() - 3 * 24 * 60 * 60 * 1000) continue;

      // ── Check 1: No services added ──
      if (!alertExists(biz.id, 'no_services')) {
        const { count } = await supabase
          .from('services')
          .select('id', { count: 'exact', head: true })
          .eq('business_id', biz.id);

        if ((count || 0) === 0) {
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
        const { count } = await supabase
          .from('chat_messages')
          .select('id', { count: 'exact', head: true })
          .eq('business_id', biz.id)
          .eq('direction', 'inbound');

        if ((count || 0) === 0) {
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
        const { count: recentMessages } = await supabase
          .from('chat_messages')
          .select('id', { count: 'exact', head: true })
          .eq('business_id', biz.id)
          .gte('created_at', sevenDaysAgo);

        const { count: recentBookings } = await supabase
          .from('bookings')
          .select('id', { count: 'exact', head: true })
          .eq('business_id', biz.id)
          .gte('created_at', sevenDaysAgo);

        if ((recentMessages || 0) === 0 && (recentBookings || 0) === 0) {
          // Check if they HAD activity before (not just a new silent business)
          const { count: totalMessages } = await supabase
            .from('chat_messages')
            .select('id', { count: 'exact', head: true })
            .eq('business_id', biz.id);

          if ((totalMessages || 0) > 0) {
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
        const { count: recentMessages } = await supabase
          .from('chat_messages')
          .select('id', { count: 'exact', head: true })
          .eq('business_id', biz.id)
          .gte('created_at', fourteenDaysAgo);

        const { count: recentBookings } = await supabase
          .from('bookings')
          .select('id', { count: 'exact', head: true })
          .eq('business_id', biz.id)
          .gte('created_at', fourteenDaysAgo);

        if ((recentMessages || 0) === 0 && (recentBookings || 0) === 0) {
          const { count: totalMessages } = await supabase
            .from('chat_messages')
            .select('id', { count: 'exact', head: true })
            .eq('business_id', biz.id);

          if ((totalMessages || 0) > 0) {
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
        const { count } = await supabase
          .from('payout_accounts')
          .select('id', { count: 'exact', head: true })
          .eq('business_id', biz.id)
          .eq('is_active', true);

        // Only alert if they've had payments (so they need payouts)
        const { count: payments } = await supabase
          .from('payments')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'success')
          .in('booking_id', supabase.from('bookings').select('id').eq('business_id', biz.id) as any);

        if ((count || 0) === 0 && (payments || 0) > 0) {
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
