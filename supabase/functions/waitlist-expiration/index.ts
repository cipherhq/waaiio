/**
 * Supabase Edge Function: waitlist-expiration
 *
 * Triggered daily via CRON to:
 * 1. Expire waitlist entries past their expires_at date
 * 2. Expire entries that have been waiting 30+ days with no preferred date
 * 3. Notify customers their waitlist spot has expired
 *
 * CRON schedule (add to supabase/config.toml):
 *   [functions.waitlist-expiration]
 *   schedule = "0 9 * * *"  # Daily at 9am UTC
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

async function sendWhatsApp(to: string, text: string): Promise<boolean> {
  if (!whatsappToken || !whatsappPhoneId) {
    log.debug(`[mock] WhatsApp to ${to}: ${text.slice(0, 100)}...`);
    return true;
  }

  try {
    const phone = to.replace('+', '');
    const response = await fetch(
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
    );
    return response.ok;
  } catch (err) {
    log.error(`Failed to send WhatsApp to ${to}:`, err);
    return false;
  }
}

Deno.serve(async () => {
  const supabase = createClient(supabaseUrl, supabaseKey);
  const now = new Date();
  let expired = 0;
  let notified = 0;

  // 1. Find entries with explicit expires_at that have passed
  const { data: expiredByDate } = await supabase
    .from('waitlist_entries')
    .select(`
      id, customer_phone, customer_name, business_id, service_id, expiry_notified,
      businesses:business_id (name),
      services:service_id (name)
    `)
    .eq('status', 'waiting')
    .not('expires_at', 'is', null)
    .lte('expires_at', now.toISOString())
    .limit(200);

  // 2. Find entries waiting 30+ days without expires_at
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data: expiredByAge } = await supabase
    .from('waitlist_entries')
    .select(`
      id, customer_phone, customer_name, business_id, service_id, expiry_notified,
      businesses:business_id (name),
      services:service_id (name)
    `)
    .eq('status', 'waiting')
    .is('expires_at', null)
    .lte('created_at', thirtyDaysAgo)
    .limit(200);

  const allExpired = [...(expiredByDate || []), ...(expiredByAge || [])];

  for (const entry of allExpired) {
    // Mark as expired
    await supabase
      .from('waitlist_entries')
      .update({ status: 'expired', updated_at: now.toISOString() })
      .eq('id', entry.id);
    expired++;

    // Notify if not already notified
    if (!entry.expiry_notified && entry.customer_phone) {
      const biz = entry.businesses as unknown as { name: string } | null;
      const service = entry.services as unknown as { name: string } | null;
      const bizName = biz?.name || 'the business';
      const serviceName = service?.name ? ` for *${service.name}*` : '';

      const msg = `Hi ${entry.customer_name || 'there'},\n\nYour waitlist spot${serviceName} at *${bizName}* has expired.\n\nIf you're still interested, you can rejoin the waitlist anytime by sending *waitlist* to us!\n\nThank you for your patience. 🙏`;

      const sent = await sendWhatsApp(entry.customer_phone, msg);
      if (sent) {
        await supabase
          .from('waitlist_entries')
          .update({ expiry_notified: true })
          .eq('id', entry.id);
        notified++;
      }
    }
  }

  const summary = `Waitlist: ${expired} expired, ${notified} notified`;
  log.debug(summary);

  return new Response(JSON.stringify({ success: true, summary, expired, notified }), {
    headers: { 'Content-Type': 'application/json' },
  });
});
