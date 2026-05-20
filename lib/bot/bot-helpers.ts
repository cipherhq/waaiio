import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '@/lib/logger';
import type { MessageSender } from '@/lib/channels/message-sender';
import type { BotSession, BotContext } from './bot-types';

/**
 * Find the active (non-expired) bot session for a phone number.
 * Also cleans up any expired sessions.
 */
export async function getActiveSession(supabase: SupabaseClient, phone: string): Promise<BotSession | null> {
  const now = new Date().toISOString();
  const { data } = await supabase
    .from('bot_sessions')
    .select('*')
    .eq('whatsapp_number', phone)
    .eq('is_active', true)
    .gte('expires_at', now) // Only return non-expired sessions
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (!data) {
    // Clean up any expired sessions for this phone
    await supabase
      .from('bot_sessions')
      .update({ is_active: false })
      .eq('whatsapp_number', phone)
      .eq('is_active', true)
      .lt('expires_at', now);
    return null;
  }

  return (data as BotSession) || null;
}

/**
 * Deactivate a bot session by ID.
 */
export async function deactivateSession(supabase: SupabaseClient, sessionId: string): Promise<void> {
  await supabase
    .from('bot_sessions')
    .update({ is_active: false })
    .eq('id', sessionId);
}

/**
 * Send a text message via the message sender, with logging.
 * Renamed from sendText to avoid naming conflicts with class method.
 */
export async function sendBotText(messageSender: MessageSender, to: string, text: string): Promise<void> {
  try {
    logger.debug('[BOT] sendText to:', to, 'text:', text.slice(0, 100));
    const result = await messageSender.sendText({ to, text });
    logger.debug('[BOT] sendText result:', JSON.stringify(result));
  } catch (err) {
    logger.error('[BOT] sendText FAILED to:', to, 'error:', err);
  }
}

/**
 * Forward an inbound chat message to the business owner's phone via WhatsApp.
 * Checks: forwarding toggle is ON + business is on a paid tier.
 * Tracks usage per month for billing.
 * Non-critical — failures are silently ignored.
 */
export async function forwardToBusinessOwner(
  ctx: BotContext,
  businessId: string,
  customerPhone: string,
  customerName: string | null,
  messageText: string,
): Promise<void> {
  try {
    // Check if forwarding is enabled for this business
    const { data: waConfig } = await ctx.supabase
      .from('whatsapp_config')
      .select('forward_chat_to_phone')
      .eq('business_id', businessId)
      .maybeSingle();

    if (!waConfig?.forward_chat_to_phone) return;

    // Check paid tier (free tier cannot use forwarding)
    const { data: biz } = await ctx.supabase
      .from('businesses')
      .select('phone, name, subscription_tier')
      .eq('id', businessId)
      .single();

    if (!biz?.phone) return;
    if (biz.subscription_tier === 'free') return;

    const ownerPhone = biz.phone.startsWith('+') ? biz.phone.slice(1) : biz.phone;
    // Don't forward to the customer's own number
    const normalizedCustomer = customerPhone.replace(/^\+/, '');
    if (ownerPhone === normalizedCustomer) return;

    const displayName = customerName || customerPhone;
    await ctx.messageSender.sendText({
      to: ownerPhone,
      text: `💬 *${displayName}*:\n${messageText}\n\n_Reply from your dashboard → Chat_`,
    });

    // Track usage for billing
    await ctx.supabase.rpc('increment_chat_forwards', { p_business_id: businessId });
  } catch {
    // Non-critical — don't break the flow
  }
}
