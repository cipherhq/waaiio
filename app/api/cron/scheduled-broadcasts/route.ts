import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
import { GupshupService } from '@/lib/channels/gupshup';
import { verifyCronAuth } from '@/lib/cron-auth';
import { logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const authError = verifyCronAuth(request);
  if (authError) return authError;

  const supabase = createServiceClient();

  // Find broadcasts that are due
  const { data: due } = await supabase
    .from('business_broadcasts')
    .select('id, business_id, message, template_name, phones, recipient_count')
    .eq('status', 'scheduled')
    .lte('scheduled_at', new Date().toISOString())
    .order('scheduled_at', { ascending: true })
    .limit(5); // Process max 5 per cron tick to stay within 60s

  if (!due || due.length === 0) {
    return NextResponse.json({ processed: 0 });
  }

  let totalProcessed = 0;

  for (const broadcast of due) {
    // Mark as sending (prevents duplicate processing)
    const { error: lockErr } = await supabase
      .from('business_broadcasts')
      .update({ status: 'sending' })
      .eq('id', broadcast.id)
      .eq('status', 'scheduled');

    if (lockErr) continue; // Another instance grabbed it

    try {
      // Fetch business for sender resolution
      const { data: business } = await supabase
        .from('businesses')
        .select('id, name, country_code')
        .eq('id', broadcast.business_id)
        .single();

      if (!business) {
        await supabase.from('business_broadcasts').update({
          status: 'failed', error_message: 'Business not found',
        }).eq('id', broadcast.id);
        continue;
      }

      // Resolve sender
      const resolver = new ChannelResolver(supabase);
      const resolved = await resolver.resolveByBusinessId(broadcast.business_id);
      const sender = resolved?.sender || new GupshupService();

      let sentCount = 0;
      let failedCount = 0;

      for (const phone of broadcast.phones) {
        try {
          if (broadcast.template_name && sender.sendTemplate) {
            await sender.sendTemplate({
              to: phone,
              templateName: broadcast.template_name,
              templateParams: [business.name, broadcast.message],
            });
          } else {
            await sender.sendText({ to: phone, text: broadcast.message });
          }

          await supabase.from('notifications').insert({
            business_id: broadcast.business_id,
            recipient_phone: phone,
            type: 'system',
            channel: 'whatsapp',
            status: 'sent',
            body: broadcast.message,
            sent_at: new Date().toISOString(),
          });

          sentCount++;
        } catch (err) {
          failedCount++;
          logger.error(`[SCHEDULED BROADCAST] Failed to send to ${phone}:`, (err as Error).message);
          await supabase.from('notifications').insert({
            business_id: broadcast.business_id,
            recipient_phone: phone,
            type: 'system',
            channel: 'whatsapp',
            status: 'failed',
            body: broadcast.message,
            failed_reason: (err as Error).message,
          });
        }
      }

      // Increment usage
      await supabase.rpc('increment_broadcast_usage', {
        p_business_id: broadcast.business_id,
        p_recipient_count: broadcast.phones.length,
      });

      // Mark as sent
      await supabase.from('business_broadcasts').update({
        status: 'sent',
        sent_at: new Date().toISOString(),
        sent_count: sentCount,
        failed_count: failedCount,
      }).eq('id', broadcast.id);

      totalProcessed++;
      logger.info(`[SCHEDULED BROADCAST] Processed ${broadcast.id}: ${sentCount} sent, ${failedCount} failed`);
    } catch (err) {
      logger.error(`[SCHEDULED BROADCAST] Error processing ${broadcast.id}:`, err);
      await supabase.from('business_broadcasts').update({
        status: 'failed',
        error_message: (err as Error).message,
      }).eq('id', broadcast.id);
    }
  }

  return NextResponse.json({ processed: totalProcessed, total_due: due.length });
}
