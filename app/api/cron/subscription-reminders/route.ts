import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
import { verifyCronAuth } from '@/lib/cron-auth';
import { sendOrEmail, findCustomerEmail } from '@/lib/channels/send-or-email';
import { logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Cron: Handle Stripe subscriptions stuck in "pending" status.
 * - 24h–72h old: send WhatsApp reminder to complete payment setup
 * - >72h old: mark as "failed" and send final notification
 *
 * Schedule: daily at 8:30 AM UTC
 */
export async function GET(request: NextRequest) {
  const authError = verifyCronAuth(request);
  if (authError) return authError;

  const supabase = createServiceClient();
  const now = new Date();
  const h24Ago = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const h48Ago = new Date(now.getTime() - 48 * 60 * 60 * 1000);
  const h72Ago = new Date(now.getTime() - 72 * 60 * 60 * 1000);

  let reminded = 0;
  let failed = 0;
  let errors = 0;

  try {
    const { data: pendingSubs, error } = await supabase
      .from('customer_subscriptions')
      .select('id, business_id, customer_phone, customer_name, customer_email, created_at, businesses!inner(name)')
      .eq('status', 'pending')
      .eq('gateway', 'stripe')
      .lt('created_at', h24Ago.toISOString());

    if (error) {
      logger.error('[CRON:SUB-REMINDERS] Query failed:', error.message);
      return NextResponse.json({ error: 'Internal error' }, { status: 500 });
    }

    if (!pendingSubs || pendingSubs.length === 0) {
      return NextResponse.json({ ok: true, reminded: 0, failed: 0 });
    }

    const resolver = new ChannelResolver(supabase);

    for (const sub of pendingSubs) {
      try {
        const createdAt = new Date(sub.created_at);
        const business = sub.businesses as unknown as { name: string };
        const phone = sub.customer_phone;

        if (!phone) continue;

        // >72h — mark as failed, send final notice
        if (createdAt < h72Ago) {
          await supabase
            .from('customer_subscriptions')
            .update({ status: 'failed', metadata: { failed_reason: 'setup_timeout_72h' } })
            .eq('id', sub.id);

          const resolved = await resolver.resolveByBusinessId(sub.business_id);
          if (resolved) {
            const email = sub.customer_email || await findCustomerEmail(supabase, phone, sub.business_id);
            await sendOrEmail({
              supabase,
              sender: resolved.sender,
              to: phone,
              text: `Hi ${sub.customer_name || 'there'}, your recurring payment setup with ${business.name} has expired. Please contact them if you still wish to subscribe.`,
              email: email ? { address: email, subject: 'Subscription Setup Expired', html: `<p>Your recurring payment setup with <strong>${business.name}</strong> has expired. Please contact them for a new link if you'd like to subscribe.</p>` } : null,
              businessName: business.name,
              smsFallback: true,
            });
          }
          failed++;
          continue;
        }

        // 24h–48h — send reminder (only once per 24h window)
        if (createdAt < h48Ago && createdAt >= h72Ago) continue; // Between 48-72h, already reminded

        const resolved = await resolver.resolveByBusinessId(sub.business_id);
        if (!resolved) continue;

        const email = sub.customer_email || await findCustomerEmail(supabase, phone, sub.business_id);
        await sendOrEmail({
          supabase,
          sender: resolved.sender,
          to: phone,
          text: `Hi ${sub.customer_name || 'there'}, your recurring payment setup with ${business.name} is pending. Please complete your payment to activate automatic charges. Contact ${business.name} for a new link if needed.`,
          email: email ? { address: email, subject: 'Complete Your Subscription Setup', html: `<p>Your recurring payment setup with <strong>${business.name}</strong> is still pending. Please complete your payment to activate automatic charges. Contact them for a new link if needed.</p>` } : null,
          businessName: business.name,
          smsFallback: true,
        });
        reminded++;
      } catch (err) {
        logger.error(`[CRON:SUB-REMINDERS] Error processing ${sub.id}:`, (err as Error).message);
        errors++;
      }
    }
  } catch (err) {
    logger.error('[CRON:SUB-REMINDERS] Fatal error:', (err as Error).message);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }

  logger.info(`[CRON:SUB-REMINDERS] Done — reminded: ${reminded}, failed: ${failed}, errors: ${errors}`);
  return NextResponse.json({ ok: true, reminded, failed, errors });
}
