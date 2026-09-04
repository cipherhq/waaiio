/**
 * Supabase Edge Function: noshow-reschedule
 *
 * Triggered daily via CRON to:
 * 1. Find bookings marked as no_show in the past 24 hours
 * 2. Send WhatsApp reschedule prompt to the customer
 *
 * CRON schedule (add to supabase/config.toml):
 *   [functions.noshow-reschedule]
 *   schedule = "0 11 * * *"  # Daily at 11am UTC
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const isDev = Deno.env.get('ENVIRONMENT') !== 'production';
const log = {
  debug: (...args: unknown[]) => { if (isDev) console.log(...args); },
  error: (...args: unknown[]) => console.error(...args),
};

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const whatsappToken = Deno.env.get('WHATSAPP_TOKEN') || '';
const whatsappPhoneId = Deno.env.get('WHATSAPP_PHONE_NUMBER_ID') || '';
import { withEdgeAttemptRecording } from '../_shared/attempt-recording.ts';

async function sendWhatsApp(to: string, text: string, supabase: ReturnType<typeof createClient>, businessId: string): Promise<boolean> {
  if (!whatsappToken || !whatsappPhoneId) {
    log.debug(`[mock] WhatsApp to ${to}: ${text.slice(0, 100)}...`);
    return true;
  }

  try {
    const phone = to.replace('+', '');
    // #257: attempt → #256 guard → sending → Meta fetch (all inside withEdgeAttemptRecording)
    const result = await withEdgeAttemptRecording(
      supabase,
      { businessId, recipientPhone: to, phoneNumberId: whatsappPhoneId, flowType: 'noshow-reschedule' },
      () => fetch(
        `https://graph.facebook.com/v22.0/${whatsappPhoneId}/messages`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${whatsappToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            to: phone,
            type: 'text',
            text: { body: text },
          }),
        },
      ),
      // S-1 (#256): Suspension check inside attempt lifecycle
      async () => {
        const { data: bizCheck, error: bizErr } = await supabase
          .from('businesses')
          .select('messaging_suspended')
          .eq('id', businessId)
          .maybeSingle();
        if (bizErr || !bizCheck || bizCheck.messaging_suspended !== false) {
          log.debug(`[noshow-reschedule] Send blocked: business ${businessId} suspended/unverifiable`);
          return false;
        }
        return true;
      },
    );
    return result.ok;
  } catch (err) {
    log.error(`Failed to send WhatsApp to ${to}:`, err);
    return false;
  }
}

Deno.serve(async () => {
  const supabase = createClient(supabaseUrl, supabaseKey);
  const now = new Date();
  let prompted = 0;

  // Find no-show bookings from the past 48 hours that haven't been prompted
  const twoDaysAgo = new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString().split('T')[0];
  const today = now.toISOString().split('T')[0];

  const { data: noShows } = await supabase
    .from('bookings')
    .select(`
      id, guest_phone, guest_name, date, time, service_id,
      business_id, reschedule_prompted,
      businesses:business_id (name, slug),
      services:service_id (name)
    `)
    .eq('status', 'no_show')
    .eq('reschedule_prompted', false)
    .gte('date', twoDaysAgo)
    .lte('date', today)
    .is('deleted_at', null)
    .limit(100);

  for (const booking of noShows || []) {
    if (!booking.guest_phone) continue;

    const biz = booking.businesses as unknown as { name: string; slug: string } | null;
    const service = booking.services as unknown as { name: string } | null;
    const bizName = biz?.name || 'us';
    const serviceName = service?.name ? ` for *${service.name}*` : '';
    const name = booking.guest_name || 'there';

    const msg = `Hi ${name},\n\nWe noticed you missed your appointment${serviceName} at *${bizName}* on ${booking.date}.\n\nNo worries — things happen! Would you like to reschedule? Send *book* to pick a new time that works for you.\n\nWe'd love to see you! 😊`;

    const sent = await sendWhatsApp(booking.guest_phone, msg, supabase, booking.business_id);
    if (sent) {
      await supabase
        .from('bookings')
        .update({ reschedule_prompted: true })
        .eq('id', booking.id);
      prompted++;
    }
  }

  const summary = `No-show reschedule prompts sent: ${prompted}`;
  log.debug(summary);

  return new Response(JSON.stringify({ success: true, summary, prompted }), {
    headers: { 'Content-Type': 'application/json' },
  });
});
