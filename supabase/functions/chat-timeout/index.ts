/**
 * Supabase Edge Function: chat-timeout
 *
 * Triggered every hour via CRON to auto-close stale chat conversations.
 * Finds open conversations with no activity for 4+ hours, resolves them,
 * deactivates the bot session, and sends a WhatsApp closure message.
 *
 * CRON schedule (add to supabase/config.toml):
 *   [functions.chat-timeout]
 *   schedule = "0 * * * *"
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const isDev = Deno.env.get('ENVIRONMENT') !== 'production';
const log = {
  debug: (...args: unknown[]) => { if (isDev) console.log(...args); },
  error: (...args: unknown[]) => console.error(...args),
};

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

/**
 * Resolve the WhatsApp channel for a business and send a text message.
 * Mimics the ChannelResolver logic: assigned_channel_id → dedicated → shared.
 */
async function sendWhatsAppForBusiness(
  supabase: ReturnType<typeof createClient>,
  businessId: string,
  to: string,
  text: string,
): Promise<boolean> {
  try {
    // Resolve channel for the business
    const { data: biz } = await supabase
      .from('businesses')
      .select('country_code, assigned_channel_id, whatsapp_channel_id')
      .eq('id', businessId)
      .single();

    if (!biz) return false;

    const channelId = biz.assigned_channel_id || biz.whatsapp_channel_id;
    let channel: Record<string, unknown> | null = null;

    if (channelId) {
      const { data } = await supabase
        .from('whatsapp_channels')
        .select('*')
        .eq('id', channelId)
        .eq('is_active', true)
        .maybeSingle();
      channel = data;
    }

    if (!channel) {
      // Try dedicated channel
      const { data } = await supabase
        .from('whatsapp_channels')
        .select('*')
        .eq('business_id', businessId)
        .eq('channel_type', 'dedicated')
        .eq('is_active', true)
        .maybeSingle();
      channel = data;
    }

    if (!channel && biz.country_code) {
      // Shared channel for country
      const { data } = await supabase
        .from('whatsapp_channels')
        .select('*')
        .eq('channel_type', 'shared')
        .eq('country_code', biz.country_code)
        .eq('is_active', true)
        .limit(1)
        .maybeSingle();
      channel = data;
    }

    if (!channel) {
      // Any shared channel as fallback
      const { data } = await supabase
        .from('whatsapp_channels')
        .select('*')
        .eq('channel_type', 'shared')
        .eq('is_active', true)
        .limit(1)
        .maybeSingle();
      channel = data;
    }

    if (!channel) {
      log.error(`No WhatsApp channel found for business ${businessId}`);
      return false;
    }

    // Send via Meta Cloud API
    const phoneNumberId = channel.phone_number_id as string;
    const accessToken = (channel.meta_access_token as string) || Deno.env.get('WHATSAPP_TOKEN') || '';

    if (!phoneNumberId || !accessToken) {
      log.error(`Missing phone_number_id or token for channel ${channel.id}`);
      return false;
    }

    const phone = to.replace('+', '');
    const response = await fetch(
      `https://graph.facebook.com/v22.0/${phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
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
    log.error(`Failed to send WhatsApp to ${to} for business ${businessId}:`, err);
    return false;
  }
}

Deno.serve(async () => {
  const supabase = createClient(supabaseUrl, supabaseKey);
  const now = new Date();
  let closed = 0;

  // Find open conversations with no activity for 4+ hours
  const fourHoursAgo = new Date(now.getTime() - 4 * 60 * 60 * 1000).toISOString();

  const { data: staleConversations } = await supabase
    .from('chat_conversations')
    .select('id, business_id, customer_phone')
    .eq('status', 'open')
    .lt('last_message_at', fourHoursAgo)
    .limit(200);

  for (const conv of staleConversations || []) {
    try {
      // 1. Mark conversation as resolved
      await supabase.from('chat_conversations').update({
        status: 'resolved',
        resolved_at: now.toISOString(),
      }).eq('id', conv.id);

      // 2. Deactivate the bot session for this customer + business
      await supabase.from('bot_sessions').update({
        is_active: false,
      })
        .eq('business_id', conv.business_id)
        .eq('whatsapp_number', conv.customer_phone)
        .eq('is_active', true);

      // 3. Send closure message to customer via the correct WhatsApp channel
      await sendWhatsAppForBusiness(
        supabase,
        conv.business_id,
        conv.customer_phone,
        'This chat session was closed due to inactivity. Send *Hi* to start a new conversation.',
      );

      closed++;
    } catch (err) {
      log.error(`Failed to close stale conversation ${conv.id}:`, err);
    }
  }

  const summary = `Stale chats closed: ${closed}`;
  log.debug(summary);

  return new Response(JSON.stringify({ success: true, summary, closed }), {
    headers: { 'Content-Type': 'application/json' },
  });
});
