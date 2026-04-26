/**
 * Supabase Edge Function: birthday-campaign
 *
 * Triggered daily via CRON to:
 * 1. Find customers with birthdays today
 * 2. Send personalized WhatsApp birthday message from businesses they frequent
 *
 * CRON schedule (add to supabase/config.toml):
 *   [functions.birthday-campaign]
 *   schedule = "0 7 * * *"  # Daily at 7am UTC
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
  const currentYear = now.getFullYear();
  const todayMonth = now.getMonth() + 1; // 1-based
  const todayDay = now.getDate();
  let birthdaysSent = 0;

  // Find customer profiles with birthday today that haven't been wished this year
  // We query by extracting month and day from date_of_birth
  const { data: birthdayCustomers } = await supabase
    .from('customer_profiles')
    .select(`
      id, phone, name, business_id, total_visits, birthday_wished_year,
      date_of_birth, notification_opt_in,
      businesses:business_id (name, category, metadata)
    `)
    .eq('notification_opt_in', true)
    .not('date_of_birth', 'is', null)
    .limit(500);

  for (const customer of birthdayCustomers || []) {
    // Check if birthday is today
    const dob = new Date(customer.date_of_birth as string);
    if (dob.getMonth() + 1 !== todayMonth || dob.getDate() !== todayDay) continue;

    // Skip if already wished this year
    if (customer.birthday_wished_year === currentYear) continue;

    const biz = customer.businesses as unknown as { name: string; category: string; metadata: Record<string, unknown> } | null;
    if (!biz) continue;

    const name = customer.name || 'there';
    const bizName = biz.name;

    // Check if business has a custom birthday message
    const customMsg = biz.metadata?.birthday_message as string | undefined;

    // Check if business offers a birthday discount
    const birthdayDiscount = biz.metadata?.birthday_discount as number | undefined;

    let msg: string;
    if (customMsg) {
      msg = customMsg
        .replace(/\{\{name\}\}/g, name)
        .replace(/\{\{business\}\}/g, bizName);
    } else if (birthdayDiscount) {
      msg = `🎂 *Happy Birthday, ${name}!* 🎉\n\nFrom all of us at *${bizName}*, we wish you a wonderful day!\n\nAs a birthday gift, enjoy *${birthdayDiscount}% off* your next visit! Just mention your birthday when you come in.\n\nHave an amazing day! 🥳`;
    } else {
      msg = `🎂 *Happy Birthday, ${name}!* 🎉\n\nFrom all of us at *${bizName}*, we wish you a wonderful birthday!\n\nWe'd love to celebrate with you — visit us soon! Send *Hi* to get started.\n\nHave an amazing day! 🥳`;
    }

    const sent = await sendWhatsApp(customer.phone, msg);
    if (sent) {
      await supabase
        .from('customer_profiles')
        .update({ birthday_wished_year: currentYear })
        .eq('id', customer.id);
      birthdaysSent++;
    }
  }

  const summary = `Birthday messages sent: ${birthdaysSent}`;
  log.debug(summary);

  return new Response(JSON.stringify({ success: true, summary, birthdaysSent }), {
    headers: { 'Content-Type': 'application/json' },
  });
});
