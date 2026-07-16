import { NextResponse, type NextRequest } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { createServiceClient } from '@/lib/supabase/service';
import { sendEmail } from '@/lib/email/client';
import { subscriptionExpiringEmail, subscriptionExpiredEmail } from '@/lib/email/templates';
import { verifyCronAuth } from '@/lib/cron-auth';
import { createAlert } from '@/lib/alerts/create-alert';
import { logger } from '@/lib/logger';

/**
 * GET /api/cron/subscription-expiry
 *
 * Runs daily at 8am UTC. Checks active subscriptions for upcoming/past expiry:
 * - 7 days before: sends reminder email
 * - 1 day before: sends urgent reminder email
 * - Expired (current_period_end < now): downgrades to free tier, sends notification
 *
 * Dedup: checks notifications table to avoid sending the same reminder twice in 24h.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const authError = verifyCronAuth(request);
  if (authError) return authError;

  const supabase = createServiceClient();
  const now = new Date();
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com';
  const renewUrl = `${appUrl}/dashboard/settings`;

  let remindersSent = 0;
  let subscriptionsExpired = 0;
  let errors = 0;

  // ── 1. Fetch all active subscriptions with a period end date ──
  const { data: subscriptions, error: fetchError } = await supabase
    .from('subscriptions')
    .select(`
      id,
      business_id,
      plan,
      current_period_end,
      businesses!inner (
        id,
        name,
        owner_id,
        subscription_tier
      )
    `)
    .eq('status', 'active')
    .not('current_period_end', 'is', null);

  if (fetchError) {
    logger.error('[CRON:SUBSCRIPTION-EXPIRY] Failed to fetch subscriptions:', fetchError.message);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }

  if (!subscriptions || subscriptions.length === 0) {
    logger.info('[CRON:SUBSCRIPTION-EXPIRY] No active subscriptions with period end');
    return NextResponse.json({ ok: true, remindersSent: 0, subscriptionsExpired: 0 });
  }

  // ── 2. Check recent notifications to avoid duplicates ──
  const oneDayAgo = new Date(now);
  oneDayAgo.setDate(oneDayAgo.getDate() - 1);

  const businessIds = subscriptions.map(s => s.business_id);
  const { data: recentNotifications } = await supabase
    .from('notifications')
    .select('business_id, type, created_at')
    .in('business_id', businessIds)
    .eq('type', 'subscription_reminder')
    .gte('created_at', oneDayAgo.toISOString());

  const recentReminderSet = new Set(
    (recentNotifications || []).map(n => n.business_id),
  );

  // ── 3. Process each subscription ──
  for (const sub of subscriptions) {
    try {
      const business = sub.businesses as unknown as {
        id: string;
        name: string;
        owner_id: string;
        subscription_tier: string;
      };
      const periodEnd = new Date(sub.current_period_end);
      const daysUntilExpiry = Math.ceil(
        (periodEnd.getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
      );

      // Get owner email
      const { data: profile } = await supabase
        .from('profiles')
        .select('email')
        .eq('id', business.owner_id)
        .single();

      if (!profile?.email) continue;

      // ── Expired: downgrade to free ──
      if (daysUntilExpiry < 0) {
        // Update subscription status to expired
        const { error: subError } = await supabase
          .from('subscriptions')
          .update({ status: 'expired' })
          .eq('id', sub.id);

        if (subError) {
          logger.error(`[CRON:SUBSCRIPTION-EXPIRY] Failed to expire subscription ${sub.id}:`, subError.message);
          errors++;
          continue;
        }

        // Downgrade business to free tier
        const { error: bizError } = await supabase
          .from('businesses')
          .update({ subscription_tier: 'free' })
          .eq('id', business.id);

        if (bizError) {
          logger.error(`[CRON:SUBSCRIPTION-EXPIRY] Failed to downgrade business ${business.id}:`, bizError.message);
          errors++;
          continue;
        }

        // Send expiry email
        const { subject, html } = subscriptionExpiredEmail(business.name, renewUrl);
        await sendEmail({ to: profile.email, subject, html });

        // Create alert for the business dashboard
        await createAlert(supabase, {
          businessId: business.id,
          type: 'subscription_expired',
          severity: 'critical',
          title: 'Subscription Expired',
          message: `Your ${sub.plan} plan has expired. You have been moved to the Free plan. Renew to restore your features.`,
          metadata: { subscription_id: sub.id, previous_plan: sub.plan },
        });

        // Log notification to prevent duplicates
        await supabase.from('notifications').insert({
          business_id: business.id,
          type: 'subscription_reminder',
          channel: 'email',
          subject: subject,
          body: `Subscription expired and downgraded to free`,
          recipient_email: profile.email,
          status: 'delivered',
          delivered_at: new Date().toISOString(),
          metadata: { action: 'expired', plan: sub.plan },
        });

        subscriptionsExpired++;
        logger.info(`[CRON:SUBSCRIPTION-EXPIRY] Expired subscription for ${business.name} (${sub.id})`);
        continue;
      }

      // Skip reminder if already sent in last 24h
      if (recentReminderSet.has(business.id)) continue;

      // ── 7-day reminder ──
      if (daysUntilExpiry === 7) {
        const { subject, html } = subscriptionExpiringEmail(business.name, 7, renewUrl);
        await sendEmail({ to: profile.email, subject, html });

        await supabase.from('notifications').insert({
          business_id: business.id,
          type: 'subscription_reminder',
          channel: 'email',
          subject,
          body: `Subscription expires in 7 days`,
          recipient_email: profile.email,
          status: 'delivered',
          delivered_at: new Date().toISOString(),
          metadata: { action: 'reminder_7d', plan: sub.plan },
        });

        remindersSent++;
        logger.info(`[CRON:SUBSCRIPTION-EXPIRY] 7-day reminder sent for ${business.name}`);
      }

      // ── 1-day reminder ──
      if (daysUntilExpiry === 1) {
        const { subject, html } = subscriptionExpiringEmail(business.name, 1, renewUrl);
        await sendEmail({ to: profile.email, subject, html });

        await supabase.from('notifications').insert({
          business_id: business.id,
          type: 'subscription_reminder',
          channel: 'email',
          subject,
          body: `Subscription expires tomorrow`,
          recipient_email: profile.email,
          status: 'delivered',
          delivered_at: new Date().toISOString(),
          metadata: { action: 'reminder_1d', plan: sub.plan },
        });

        remindersSent++;
        logger.info(`[CRON:SUBSCRIPTION-EXPIRY] 1-day reminder sent for ${business.name}`);
      }
    } catch (err) {
      logger.error('[CRON:SUBSCRIPTION-EXPIRY] Error processing subscription:', (err as Error).message);
      Sentry.captureException(err, { tags: { cron: 'subscription-expiry' } });
      errors++;
    }
  }

  logger.info(`[CRON:SUBSCRIPTION-EXPIRY] Done — reminders: ${remindersSent}, expired: ${subscriptionsExpired}, errors: ${errors}`);

  return NextResponse.json({
    ok: true,
    remindersSent,
    subscriptionsExpired,
    errors,
    totalChecked: subscriptions.length,
  });
}
