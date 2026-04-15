import type { SupabaseClient } from '@supabase/supabase-js';
import type { MessageSender } from '@/lib/channels/message-sender';
import { dispatchWebhook } from '@/lib/webhooks/dispatcher';

interface EscalateParams {
  supabase: SupabaseClient;
  sender: MessageSender;
  from: string;
  businessId: string;
  businessName: string;
  sessionId: string;
  sessionData: Record<string, unknown>;
  currentStep: string;
  customerName: string | null;
}

interface ResolveParams {
  supabase: SupabaseClient;
  sender: MessageSender;
  businessId: string;
  customerPhone: string;
  resolvedBy?: string;
}

export async function escalateToHuman(params: EscalateParams): Promise<void> {
  const {
    supabase, sender, from, businessId, businessName,
    sessionId, sessionData, currentStep, customerName,
  } = params;

  // 1. Update bot session: pause at chat_handoff, mark as handed off
  await supabase.from('bot_sessions').update({
    current_step: 'chat_handoff',
    handed_off: true,
    session_data: {
      ...sessionData,
      _pre_handoff_step: currentStep,
    },
  }).eq('id', sessionId);

  // 2. Upsert chat_conversations
  await supabase.from('chat_conversations').upsert({
    business_id: businessId,
    customer_phone: from,
    customer_name: customerName,
    status: 'open',
    escalated_from_step: currentStep,
    escalated_at: new Date().toISOString(),
    bot_session_id: sessionId,
    session_context: sessionData,
    last_message_at: new Date().toISOString(),
  }, { onConflict: 'business_id,customer_phone' });

  // 3. Send customer message
  await sender.sendText({
    to: from,
    text: `Connecting you to a team member at *${businessName}*... 🙋\n\nType *end chat* to close this session and return to the menu.`,
  });

  // 4. Insert system message in chat_messages
  const { data: conv } = await supabase
    .from('chat_conversations')
    .select('id')
    .eq('business_id', businessId)
    .eq('customer_phone', from)
    .single();

  await supabase.from('chat_messages').insert({
    business_id: businessId,
    customer_phone: from,
    customer_name: customerName,
    direction: 'inbound',
    message_text: `[Escalated from bot: ${currentStep.replace(/_/g, ' ')}]`,
    is_read: false,
    conversation_id: conv?.id || null,
  });

  // 5. Dispatch webhook (non-critical)
  try {
    await dispatchWebhook(supabase, businessId, 'chat.escalated', {
      customer_phone: from,
      customer_name: customerName,
      escalated_from_step: currentStep,
    });
  } catch { /* non-critical */ }

  // 6. Send WhatsApp notification to business owner if phone available
  try {
    const { data: biz } = await supabase
      .from('businesses')
      .select('phone, owner_id')
      .eq('id', businessId)
      .single();

    if (biz?.phone) {
      const ownerPhone = biz.phone.startsWith('+') ? biz.phone.slice(1) : biz.phone;
      const displayName = customerName || from;
      await sender.sendText({
        to: ownerPhone,
        text: `🔔 *Live chat request*\n\n${displayName} wants to speak with someone at ${businessName}.\n\nCheck your dashboard → Chat to respond.`,
      });
    }
  } catch { /* non-critical */ }
}

export async function resolveConversation(params: ResolveParams): Promise<void> {
  const { supabase, sender, businessId, customerPhone, resolvedBy } = params;

  // 1. Update conversation status
  await supabase.from('chat_conversations').update({
    status: 'resolved',
    resolved_at: new Date().toISOString(),
    resolved_by: resolvedBy || null,
  })
    .eq('business_id', businessId)
    .eq('customer_phone', customerPhone);

  // 2. Deactivate any active bot session for this customer+business (chat_handoff or chat_start)
  await supabase.from('bot_sessions').update({
    is_active: false,
    handed_off: false,
  })
    .eq('whatsapp_number', customerPhone)
    .eq('business_id', businessId)
    .eq('is_active', true);

  // 3. Send resolution message to customer
  const phone = customerPhone.startsWith('+') ? customerPhone.slice(1) : customerPhone;
  await sender.sendText({
    to: phone,
    text: "This chat session has been closed. ✅\n\nSend *Hi* to continue with bookings, payments, and other services. 🙏",
  });
}
