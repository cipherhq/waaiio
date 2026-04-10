/**
 * Supabase Edge Function: customer-reengagement
 *
 * Triggered daily via CRON to:
 * 1. Find customers who haven't interacted in 14-30 days
 * 2. Send personalized WhatsApp re-engagement message
 *
 * CRON schedule (add to supabase/config.toml):
 *   [functions.customer-reengagement]
 *   schedule = "0 10 * * *"  # Daily at 10am UTC
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
      `https://graph.facebook.com/v18.0/${whatsappPhoneId}/messages`,
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
  let reengaged = 0;

  // Find customers who last interacted 14-30 days ago and haven't been re-engaged recently
  const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const { data: inactiveCustomers } = await supabase
    .from('customer_profiles')
    .select(`
      id, phone, name, business_id, total_visits, total_spent, last_seen_at,
      reengagement_sent_at, notification_opt_in,
      businesses:business_id (name, category, country_code)
    `)
    .eq('notification_opt_in', true)
    .lte('last_seen_at', fourteenDaysAgo)
    .gte('last_seen_at', thirtyDaysAgo)
    .gte('total_visits', 2)
    .limit(200);

  for (const customer of inactiveCustomers || []) {
    // Skip if recently re-engaged (within 7 days)
    if (customer.reengagement_sent_at && customer.reengagement_sent_at > sevenDaysAgo) continue;

    const biz = customer.businesses as unknown as { name: string; category: string; country_code: string } | null;
    if (!biz) continue;

    const name = customer.name || 'there';
    const bizName = biz.name;

    // Personalize based on category
    let cta = 'Send *Hi* to get started!';
    switch (biz.category) {
      case 'restaurant':
        cta = 'Send *menu* to see what\'s new!';
        break;
      case 'barber':
      case 'salon':
      case 'spa':
        cta = 'Send *book* to schedule your next appointment!';
        break;
      case 'shop':
      case 'food_delivery':
        cta = 'Send *browse* to check out new products!';
        break;
      case 'gym':
        cta = 'Send *Hi* to book your next session!';
        break;
    }

    const visitText = customer.total_visits > 5 ? 'one of our valued customers' : 'a returning customer';
    const msg = `Hi ${name}! 👋\n\nWe miss you at *${bizName}*! As ${visitText}, we'd love to see you again.\n\n${cta}\n\nWe're here whenever you're ready! 😊`;

    const sent = await sendWhatsApp(customer.phone, msg);
    if (sent) {
      await supabase
        .from('customer_profiles')
        .update({ reengagement_sent_at: now.toISOString() })
        .eq('id', customer.id);
      reengaged++;
    }
  }

  const summary = `Re-engagement messages sent: ${reengaged}`;
  log.debug(summary);

  return new Response(JSON.stringify({ success: true, summary, reengaged }), {
    headers: { 'Content-Type': 'application/json' },
  });
});
