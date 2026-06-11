import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '@/lib/logger';
import type { MessageSender } from '@/lib/channels/message-sender';
import { sanitizeFilterValue } from '@/lib/utils/sanitize';
import { getEnabledCapabilities } from '@/lib/capabilities/service';
import type { CapabilityId } from '@/lib/capabilities/types';

interface ChatSession {
  id: string;
  business_id: string;
  session_data: Record<string, unknown>;
}

/**
 * Handle chat_handoff step: bot is paused, route messages to human agent.
 */
export async function handleChatHandoff(
  supabase: SupabaseClient,
  messageSender: MessageSender,
  sendText: (to: string, text: string) => Promise<void>,
  from: string,
  session: ChatSession,
  text: string,
  messageType: string,
  mediaUrl: string | undefined,
  deactivateSession: (sessionId: string) => Promise<void>,
  reenterBot: (from: string, text: string, messageType: string, destinationPhone?: string, businessId?: string) => Promise<void>,
  forwardToBusinessOwner: (businessId: string, customerPhone: string, customerName: string | null, messageText: string) => Promise<void>,
): Promise<void> {
  const restartMatch = /^(restart|start\s*over|end\s*chat|exit\s*chat|close\s*chat|stop\s*chat|back|cancel|exit|quit|stop|menu)$/i.test(text);
  if (restartMatch) {
    await deactivateSession(session.id);
    // Also resolve the conversation so the dashboard shows it as resolved
    try {
      await supabase.from('chat_conversations').update({
        status: 'resolved',
        resolved_at: new Date().toISOString(),
      })
        .eq('business_id', session.business_id)
        .eq('customer_phone', from)
        .eq('status', 'open');
    } catch { /* non-critical */ }
    // Re-enter the bot from scratch so they get the menu
    return reenterBot(from, text, messageType, undefined, session.business_id);
  }

  // Allow bot capability selections (button payloads) during live chat
  if (text.startsWith('cap_')) {
    await deactivateSession(session.id);
    return reenterBot(from, text, messageType, undefined, session.business_id);
  }

  // Store message for human agent, update conversation
  const chatPhoneP = from.startsWith('+') ? from : `+${from}`;
  const chatPhoneN = from.startsWith('+') ? from.slice(1) : from;
  let handoffName: string | null = null;
  const { data: hProfile } = await supabase
    .from('profiles')
    .select('first_name, last_name')
    .or(`phone.eq.${sanitizeFilterValue(chatPhoneP)},phone.eq.${sanitizeFilterValue(chatPhoneN)}`)
    .limit(1)
    .maybeSingle();
  if (hProfile?.first_name) {
    handoffName = `${hProfile.first_name}${hProfile.last_name ? ' ' + hProfile.last_name : ''}`;
  }

  // Get conversation_id
  const { data: conv } = await supabase
    .from('chat_conversations')
    .select('id, created_at')
    .eq('business_id', session.business_id)
    .eq('customer_phone', from)
    .maybeSingle();

  await supabase.from('chat_messages').insert({
    business_id: session.business_id,
    customer_phone: from,
    customer_name: handoffName,
    direction: 'inbound',
    message_text: text,
    is_read: false,
    conversation_id: conv?.id || null,
    media_url: mediaUrl || null,
    media_type: mediaUrl ? (messageType || 'image') : null,
  });

  // Update last_message_at on conversation
  if (conv?.id) {
    await supabase.from('chat_conversations').update({
      last_message_at: new Date().toISOString(),
    }).eq('id', conv.id);
  }

  // ── Inactivity warning: notify customer if business hasn't replied in 10+ min ──
  if (conv?.id && !session.session_data._inactivity_warned) {
    try {
      const { data: lastOutbound } = await supabase
        .from('chat_messages')
        .select('created_at')
        .eq('conversation_id', conv.id)
        .eq('direction', 'outbound')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      const lastReplyAt = lastOutbound ? new Date(lastOutbound.created_at).getTime() : 0;
      const convCreatedAt = conv.created_at ? new Date(conv.created_at).getTime() : 0;
      const waitingSince = lastReplyAt > 0 ? lastReplyAt : convCreatedAt;
      if (waitingSince > 0 && Date.now() - waitingSince > 10 * 60 * 1000) {
        await sendText(from, "The team hasn't responded yet. You can keep waiting or type *end chat* to go back to the menu.");
        session.session_data._inactivity_warned = true;
        await supabase.from('bot_sessions').update({
          session_data: session.session_data,
        }).eq('id', session.id);
      }
    } catch { /* non-critical */ }
  }

  // ── Email notification for new chat (rate-limited: max 1 per 30 min per conversation) ──
  try {
    const lastEmailAt = session.session_data._last_chat_email_at as number || 0;
    const now = Date.now();
    if (now - lastEmailAt > 30 * 60 * 1000) {
      const { data: biz } = await supabase
        .from('businesses')
        .select('name, profiles:owner_id (email)')
        .eq('id', session.business_id)
        .single();
      const ownerEmail = (biz?.profiles as any)?.email;
      if (ownerEmail && biz) {
        const displayName = handoffName || from;
        const { sendEmail } = await import('@/lib/email/client');
        sendEmail({
          to: ownerEmail,
          subject: `New chat message from ${displayName} — ${biz.name}`,
          html: `<p><strong>${displayName}</strong> sent you a message:</p>
                 <blockquote style="border-left: 3px solid #6C2BD9; padding-left: 12px; color: #333;">${text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')}</blockquote>
                 <p><a href="${process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com'}/dashboard/chat" style="color: #6C2BD9; font-weight: bold;">Reply in your dashboard</a></p>
                 <p style="color: #999; font-size: 12px;">Powered by Waaiio</p>`,
        }).catch(() => {});
        session.session_data._last_chat_email_at = now;
        await supabase.from('bot_sessions').update({
          session_data: session.session_data,
        }).eq('id', session.id);
      }
    }
  } catch { /* non-critical */ }

  // Forward message to business owner's phone
  await forwardToBusinessOwner(session.business_id, from, handoffName, text);
}

/**
 * Handle chat_start step: chat session where first message may need FAQ auto-response.
 */
export async function handleChatStart(
  supabase: SupabaseClient,
  messageSender: MessageSender,
  sendText: (to: string, text: string) => Promise<void>,
  from: string,
  session: ChatSession,
  text: string,
  messageType: string,
  mediaUrl: string | undefined,
  deactivateSession: (sessionId: string) => Promise<void>,
  reenterBot: (from: string, text: string, messageType: string, destinationPhone?: string, businessId?: string) => Promise<void>,
  forwardToBusinessOwner: (businessId: string, customerPhone: string, customerName: string | null, messageText: string) => Promise<void>,
): Promise<void> {
  // Allow user to exit chat_start mode
  const chatExitMatch = /^(restart|start\s*over|end\s*chat|exit\s*chat|close\s*chat|stop\s*chat|hi|hello|menu)$/i.test(text);
  if (chatExitMatch) {
    await deactivateSession(session.id);
    try {
      await supabase.from('chat_conversations').update({
        status: 'resolved',
        resolved_at: new Date().toISOString(),
      })
        .eq('business_id', session.business_id)
        .eq('customer_phone', from)
        .eq('status', 'open');
    } catch { /* non-critical */ }
    return reenterBot(from, text, messageType, undefined, session.business_id);
  }

  // Allow bot capability selections during chat
  if (text.startsWith('cap_')) {
    await deactivateSession(session.id);
    return reenterBot(from, text, messageType, undefined, session.business_id);
  }

  // This is a chat session — store message and acknowledge
  // Skip if the chat flow validate() already handled this message
  const alreadyHandled = session.session_data?.first_message_handled;
  const caps = (session.session_data?.capabilities as CapabilityId[]) || await getEnabledCapabilities(supabase, session.business_id);
  if (caps.includes('chat') && !alreadyHandled) {
    // Get customer name
    const chatPhoneP = from.startsWith('+') ? from : `+${from}`;
    const chatPhoneN = from.startsWith('+') ? from.slice(1) : from;
    let customerName: string | null = null;
    const { data: profile } = await supabase
      .from('profiles')
      .select('first_name, last_name')
      .or(`phone.eq.${sanitizeFilterValue(chatPhoneP)},phone.eq.${sanitizeFilterValue(chatPhoneN)}`)
      .limit(1)
      .maybeSingle();
    if (profile?.first_name) {
      customerName = `${profile.first_name}${profile.last_name ? ' ' + profile.last_name : ''}`;
    }

    // Check existing conversation to determine if this is a new 24h window
    const { data: existingConv } = await supabase
      .from('chat_conversations')
      .select('id, last_message_at')
      .eq('business_id', session.business_id)
      .eq('customer_phone', from)
      .maybeSingle();

    const isNewConversation = !existingConv || !existingConv.last_message_at ||
      (Date.now() - new Date(existingConv.last_message_at).getTime()) > 24 * 60 * 60 * 1000;

    // Upsert conversation record
    await supabase.from('chat_conversations').upsert({
      business_id: session.business_id,
      customer_phone: from,
      customer_name: customerName,
      status: 'open',
      last_message_at: new Date().toISOString(),
    }, { onConflict: 'business_id,customer_phone' });

    const { data: chatConv } = await supabase
      .from('chat_conversations')
      .select('id')
      .eq('business_id', session.business_id)
      .eq('customer_phone', from)
      .single();

    await supabase.from('chat_messages').insert({
      business_id: session.business_id,
      customer_phone: from,
      customer_name: customerName,
      direction: 'inbound',
      message_text: text,
      is_read: false,
      conversation_id: chatConv?.id ?? null,
      media_url: mediaUrl || null,
      media_type: mediaUrl ? (messageType || 'image') : null,
    });

    // Track conversation usage (non-blocking)
    Promise.resolve(
      supabase.rpc('increment_message_usage', {
        p_business_id: session.business_id,
        p_direction: 'inbound',
        p_is_new_conversation: isNewConversation,
      })
    ).catch((err) => logger.error('[BOT] Usage tracking failed:', err));

    // Try FAQ auto-response first
    if (text && session.business_id) {
      try {
        const { tryFaqResponse } = await import('@/lib/bot/faq-responder');
        const { data: biz } = await supabase
          .from('businesses')
          .select('name, address, phone, operating_hours, metadata')
          .eq('id', session.business_id)
          .single();

        if (biz) {
          const faqAnswer = await tryFaqResponse(supabase, session.business_id, biz, text);
          if (faqAnswer) {
            await sendText(from, faqAnswer);
            return;
          }
        }
      } catch { /* FAQ lookup failed, fall through to human chat */ }
    }

    // ── Email notification for new chat (rate-limited: max 1 per 30 min per conversation) ──
    try {
      const lastEmailAt = session.session_data._last_chat_email_at as number || 0;
      const nowMs = Date.now();
      if (nowMs - lastEmailAt > 30 * 60 * 1000) {
        const { data: bizForEmail } = await supabase
          .from('businesses')
          .select('name, profiles:owner_id (email)')
          .eq('id', session.business_id)
          .single();
        const ownerEmailAddr = (bizForEmail?.profiles as any)?.email;
        if (ownerEmailAddr && bizForEmail) {
          const displayName = customerName || from;
          const { sendEmail } = await import('@/lib/email/client');
          sendEmail({
            to: ownerEmailAddr,
            subject: `New chat message from ${displayName} — ${bizForEmail.name}`,
            html: `<p><strong>${displayName}</strong> sent you a message:</p>
                   <blockquote style="border-left: 3px solid #6C2BD9; padding-left: 12px; color: #333;">${text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')}</blockquote>
                   <p><a href="${process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com'}/dashboard/chat" style="color: #6C2BD9; font-weight: bold;">Reply in your dashboard</a></p>
                   <p style="color: #999; font-size: 12px;">Powered by Waaiio</p>`,
          }).catch(() => {});
          session.session_data._last_chat_email_at = nowMs;
          await supabase.from('bot_sessions').update({
            session_data: session.session_data,
          }).eq('id', session.id);
        }
      }
    } catch { /* non-critical */ }

    // Forward message to business owner's phone
    await forwardToBusinessOwner(session.business_id, from, customerName, text);
  }

  // Send acknowledgment on the first message in this chat session
  if (!session.session_data.chat_ack_sent) {
    await sendText(from, "Thanks for your message! A team member will respond shortly.\n\nType *end chat* anytime to return to the menu.");
    await supabase.from('bot_sessions').update({
      session_data: { ...session.session_data, chat_ack_sent: true },
    }).eq('id', session.id);
  }
}
