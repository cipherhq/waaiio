/**
 * Supabase Edge Function: contract-reminders
 *
 * Triggered every 30 minutes via CRON to:
 * 1. Send 24h reminders for pending contracts
 * 2. Send 48h reminders for pending contracts
 * 3. Auto-expire contracts past their token_expires_at
 *
 * CRON schedule (add to supabase/config.toml):
 *   [functions.contract-reminders]
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
  let sent24h = 0;
  let sent48h = 0;
  let expired = 0;

  // ── Auto-expire: set status='expired' where token_expires_at < now ──
  const { data: expiredContracts } = await supabase
    .from('contracts')
    .select('id')
    .eq('status', 'pending')
    .lt('token_expires_at', now.toISOString());

  for (const c of expiredContracts || []) {
    await supabase
      .from('contracts')
      .update({ status: 'expired' })
      .eq('id', c.id);
    expired++;
  }

  // ── 24-hour reminders ──
  // Contracts created >= 24h ago, still pending, not expired, not yet reminded
  const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

  const { data: contracts24h } = await supabase
    .from('contracts')
    .select('id, title, signer_phone, signer_name, business_id, token, token_expires_at')
    .eq('status', 'pending')
    .eq('reminder_24h_sent', false)
    .lte('created_at', twentyFourHoursAgo)
    .gt('token_expires_at', now.toISOString())
    .limit(100);

  for (const contract of contracts24h || []) {
    if (!contract.signer_phone) continue;

    // Get business name
    const { data: biz } = await supabase
      .from('businesses')
      .select('name')
      .eq('id', contract.business_id)
      .single();

    const businessName = biz?.name || 'A business';
    const hoursLeft = Math.round(
      (new Date(contract.token_expires_at).getTime() - now.getTime()) / (1000 * 60 * 60)
    );

    const appUrl = Deno.env.get('NEXT_PUBLIC_APP_URL') || 'https://waaiio.com';
    const signUrl = `${appUrl}/sign/${contract.token}`;

    const msg = [
      `\u23f0 *Reminder: Signature Requested*`,
      '',
      `${businessName} is waiting for your signature on "${contract.title}".`,
      '',
      `Sign here: ${signUrl}`,
      '',
      `\u26a0\ufe0f Expires in ${hoursLeft}h.`,
    ].join('\n');

    const phone = contract.signer_phone.replace(/\D/g, '');
    const sent = await sendWhatsApp(phone, msg);
    if (sent) {
      await supabase
        .from('contracts')
        .update({ reminder_24h_sent: true })
        .eq('id', contract.id);
      sent24h++;
    }
  }

  // ── 48-hour reminders ──
  const fortyEightHoursAgo = new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString();

  const { data: contracts48h } = await supabase
    .from('contracts')
    .select('id, title, signer_phone, signer_name, business_id, token, token_expires_at')
    .eq('status', 'pending')
    .eq('reminder_24h_sent', true)
    .eq('reminder_48h_sent', false)
    .lte('created_at', fortyEightHoursAgo)
    .gt('token_expires_at', now.toISOString())
    .limit(100);

  for (const contract of contracts48h || []) {
    if (!contract.signer_phone) continue;

    const { data: biz } = await supabase
      .from('businesses')
      .select('name')
      .eq('id', contract.business_id)
      .single();

    const businessName = biz?.name || 'A business';
    const hoursLeft = Math.round(
      (new Date(contract.token_expires_at).getTime() - now.getTime()) / (1000 * 60 * 60)
    );

    const appUrl = Deno.env.get('NEXT_PUBLIC_APP_URL') || 'https://waaiio.com';
    const signUrl = `${appUrl}/sign/${contract.token}`;

    const msg = [
      `\u26a0\ufe0f *Final Reminder: Signature Needed*`,
      '',
      `${businessName} is still waiting for your signature on "${contract.title}".`,
      '',
      `Sign here: ${signUrl}`,
      '',
      `\u23f0 This link expires in ${hoursLeft}h. Please sign soon.`,
    ].join('\n');

    const phone = contract.signer_phone.replace(/\D/g, '');
    const sent = await sendWhatsApp(phone, msg);
    if (sent) {
      await supabase
        .from('contracts')
        .update({ reminder_48h_sent: true })
        .eq('id', contract.id);
      sent48h++;
    }
  }

  const summary = `Contract reminders: 24h=${sent24h}, 48h=${sent48h}, auto-expired=${expired}`;
  log.debug(summary);

  return new Response(JSON.stringify({ success: true, summary }), {
    headers: { 'Content-Type': 'application/json' },
  });
});
