/**
 * Supabase Edge Function: recurring-reminder
 *
 * Triggered daily via CRON to:
 * 1. Send WhatsApp reminders for due subscriptions without card auth
 * 2. Send recovery messages for past_due subscriptions
 *
 * CRON schedule (add to supabase/config.toml):
 *   [functions.recurring-reminder]
 *   schedule = "0 8 * * *"  # Daily at 8am UTC
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
    log.error('WhatsApp send error:', err);
    return false;
  }
}

Deno.serve(async (req) => {
  try {
    const supabase = createClient(supabaseUrl, supabaseKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const results = { reminders: { processed: 0, reminded: 0, errors: 0 }, recovery: { processed: 0, messaged: 0 } };

    // ── Process due reminders (no card auth) ──
    const { data: dueSubs } = await supabase
      .from('customer_subscriptions')
      .select(`
        id, business_id, user_id, service_id, amount, currency, frequency,
        customer_name, customer_phone,
        businesses:business_id (name, slug, country_code)
      `)
      .eq('status', 'active')
      .is('authorization_code', null)
      .lte('next_charge_at', new Date().toISOString());

    for (const sub of dueSubs || []) {
      results.reminders.processed++;
      const phone = sub.customer_phone;
      if (!phone) { results.reminders.errors++; continue; }

      const biz = sub.businesses as unknown as { name: string; slug: string; country_code: string } | null;
      const cc = biz?.country_code || 'NG';
      const currencySymbol = cc === 'NG' ? '\u20a6' : cc === 'GH' ? 'GH\u20b5' : cc === 'GB' ? '\u00a3' : '$';

      let serviceName = 'payment';
      if (sub.service_id) {
        const { data: svc } = await supabase.from('services').select('name').eq('id', sub.service_id).single();
        if (svc) serviceName = svc.name;
      }

      const appUrl = Deno.env.get('NEXT_PUBLIC_APP_URL') || 'https://waaiio.com';
      const msg = `Hi ${sub.customer_name || 'there'},\n\nYour ${sub.frequency} *${serviceName}* of *${currencySymbol}${sub.amount.toLocaleString()}* for *${biz?.name || 'Business'}* is due.\n\nTap below to pay:\n${appUrl}/recurring/${biz?.slug || 'pay'}?amount=${sub.amount}&service=${sub.service_id || ''}`;

      const sent = await sendWhatsApp(phone, msg);
      if (sent) results.reminders.reminded++;
      else results.reminders.errors++;

      // Advance next_charge_at
      const next = new Date();
      if (sub.frequency === 'weekly') next.setDate(next.getDate() + 7);
      else next.setMonth(next.getMonth() + 1);

      await supabase.from('customer_subscriptions').update({ next_charge_at: next.toISOString() }).eq('id', sub.id);
    }

    // ── Process past_due recovery ──
    const { data: pastDueSubs } = await supabase
      .from('customer_subscriptions')
      .select(`
        id, amount, currency, frequency, customer_name, customer_phone, failure_count,
        auto_cancel_notified,
        businesses:business_id (name, country_code)
      `)
      .eq('status', 'past_due');

    for (const sub of pastDueSubs || []) {
      results.recovery.processed++;
      const phone = sub.customer_phone;
      if (!phone) continue;

      const biz = sub.businesses as unknown as { name: string; country_code: string } | null;
      const cc = biz?.country_code || 'NG';
      const currencySymbol = cc === 'NG' ? '\u20a6' : cc === 'GH' ? 'GH\u20b5' : cc === 'GB' ? '\u00a3' : '$';

      // Auto-cancel after 3+ failures
      if (sub.failure_count >= 3) {
        if (!sub.auto_cancel_notified) {
          await supabase
            .from('customer_subscriptions')
            .update({
              status: 'cancelled',
              cancelled_at: new Date().toISOString(),
              auto_cancel_notified: true,
            })
            .eq('id', sub.id);

          const cancelMsg = `Hi ${sub.customer_name || 'there'},\n\nYour recurring payment of *${currencySymbol}${sub.amount.toLocaleString()}* for *${biz?.name || 'Business'}* has been automatically cancelled after ${sub.failure_count} failed payment attempts.\n\nIf you'd like to resubscribe, type *subscriptions* to set up a new payment.\n\nWe're sorry for the inconvenience.`;

          await sendWhatsApp(phone, cancelMsg);
          results.recovery.messaged++;
        }
        continue;
      }

      const msg = `Hi ${sub.customer_name || 'there'},\n\nYour recurring payment of *${currencySymbol}${sub.amount.toLocaleString()}* for *${biz?.name || 'Business'}* has failed (attempt ${sub.failure_count}/3).\n\nPlease update your payment method or make a manual payment to keep your subscription active. After 3 failed attempts, it will be automatically cancelled.\n\nType *subscriptions* to manage your recurring payments.`;

      const sent = await sendWhatsApp(phone, msg);
      if (sent) results.recovery.messaged++;
    }

    return new Response(JSON.stringify({ success: true, results }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    log.error('Recurring reminder error:', err);
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
});
