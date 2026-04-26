/**
 * Supabase Edge Function: abandoned-cart-reminder
 *
 * Triggered every 30 minutes via CRON to:
 * 1. Find bot sessions stuck in ordering flow (cart not empty) for 1-4 hours
 * 2. Send WhatsApp reminder to complete their order
 *
 * CRON schedule (add to supabase/config.toml):
 *   [functions.abandoned-cart-reminder]
 *   schedule = "*/30 * * * *"
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
  let reminded = 0;

  // Find sessions with cart items that have been idle for 1-4 hours
  const oneHourAgo = new Date(now.getTime() - 1 * 60 * 60 * 1000).toISOString();
  const fourHoursAgo = new Date(now.getTime() - 4 * 60 * 60 * 1000).toISOString();

  const { data: abandonedSessions } = await supabase
    .from('bot_sessions')
    .select('id, whatsapp_number, business_id, session_data, updated_at')
    .eq('is_active', true)
    .eq('cart_reminder_sent', false)
    .lte('updated_at', oneHourAgo)
    .gte('updated_at', fourHoursAgo)
    .in('current_step', [
      'add_to_cart', 'view_cart', 'checkout_confirm',
      'select_product', 'select_variant', 'delivery_address',
    ])
    .limit(100);

  for (const session of abandonedSessions || []) {
    const data = session.session_data as Record<string, unknown>;
    const cart = data?.cart as Array<Record<string, unknown>> | undefined;

    // Only remind if there are items in cart
    if (!cart || cart.length === 0) continue;

    // Get business name
    const { data: biz } = await supabase
      .from('businesses')
      .select('name')
      .eq('id', session.business_id)
      .single();

    const bizName = biz?.name || 'your order';
    const itemCount = cart.length;
    const itemText = itemCount === 1 ? '1 item' : `${itemCount} items`;

    const msg = `Hey there! 👋\n\nYou left *${itemText}* in your cart at *${bizName}*.\n\nReady to complete your order? Just send *cart* to pick up where you left off!\n\nYour cart is saved and waiting for you. 🛒`;

    const phone = session.whatsapp_number;
    const sent = await sendWhatsApp(phone, msg);
    if (sent) {
      await supabase
        .from('bot_sessions')
        .update({ cart_reminder_sent: true })
        .eq('id', session.id);
      reminded++;
    }
  }

  const summary = `Abandoned cart reminders sent: ${reminded}`;
  log.debug(summary);

  return new Response(JSON.stringify({ success: true, summary, reminded }), {
    headers: { 'Content-Type': 'application/json' },
  });
});
