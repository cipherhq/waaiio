import type { SupabaseClient } from '@supabase/supabase-js';
import type { MessageSender } from '@/lib/channels/message-sender';
import { logger } from '@/lib/logger';
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

export interface EscalateResult {
  success: boolean;
  reason?: 'already_active' | 'session_not_found' | 'transaction_failed' | 'cross_business' | 'phone_mismatch';
}

interface ResolveParams {
  supabase: SupabaseClient;
  sender: MessageSender;
  businessId: string;
  customerPhone: string;
  resolvedBy?: string;
}

export async function escalateToHuman(params: EscalateParams): Promise<EscalateResult> {
  const {
    supabase, sender, from, businessId, businessName,
    sessionId, sessionData, currentStep, customerName,
  } = params;

  // Atomic handoff: session update + conversation upsert in one transaction
  const { data: rpcResult, error: rpcErr } = await supabase.rpc('atomic_escalate_to_human', {
    p_session_id: sessionId,
    p_business_id: businessId,
    p_customer_phone: from,
    p_customer_name: customerName,
    p_session_data: sessionData as any,
    p_current_step: currentStep,
  });

  if (rpcErr) {
    logger.error('[HANDOFF] Atomic escalation RPC failed:', rpcErr);
    return { success: false, reason: 'transaction_failed' };
  }

  if (!rpcResult || !rpcResult.success) {
    const reason = rpcResult?.reason;
    if (reason === 'cross_business') {
      logger.error('[HANDOFF] Cross-business escalation blocked:', { sessionId, businessId });
      return { success: false, reason: 'cross_business' };
    }
    if (reason === 'session_not_found') {
      logger.error('[HANDOFF] Session not found:', sessionId);
      return { success: false, reason: 'session_not_found' };
    }
    if (reason === 'phone_mismatch') {
      logger.error('[HANDOFF] Phone mismatch:', { sessionId, businessId });
      return { success: false, reason: 'phone_mismatch' };
    }
    logger.error('[HANDOFF] Atomic escalation failed:', rpcResult);
    return { success: false, reason: 'transaction_failed' };
  }

  const outcome = rpcResult.outcome as string;

  // Already-active: idempotent response, no duplicate state
  if (outcome === 'already_active') {
    await sender.sendText({
      to: from,
      text: `You're already connected to the team at *${businessName}*. A team member will respond shortly.\n\nType *end chat* to return to the menu.`,
    });
    return { success: true, reason: 'already_active' };
  }

  // Transaction succeeded (created or repaired) — now send customer confirmation
  await sender.sendText({
    to: from,
    text: `Connecting you to a team member at *${businessName}*... 🙋\n\nType *end chat* to close this session and return to the menu.`,
  });

  // Non-critical: insert system message in chat_messages
  try {
    const convId = rpcResult.conversation_id;
    await supabase.from('chat_messages').insert({
      business_id: businessId,
      customer_phone: from,
      customer_name: customerName,
      direction: 'inbound',
      message_text: `[Escalated from bot: ${currentStep.replace(/_/g, ' ')}]`,
      is_read: false,
      conversation_id: convId || null,
    });
  } catch (err) { logger.warn('[HANDOFF] System message insert failed (non-critical):', err); }

  // Non-critical: dispatch webhook
  try {
    await dispatchWebhook(supabase, businessId, 'chat.escalated', {
      customer_phone: from,
      customer_name: customerName,
      escalated_from_step: currentStep,
    });
  } catch (err) { logger.warn('[HANDOFF] Webhook dispatch failed (non-critical):', err); }

  // Non-critical: send WhatsApp notification to business owner
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
  } catch (err) { logger.warn('[HANDOFF] Owner WhatsApp notification failed (non-critical):', err); }

  return { success: true };
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
    text: "This chat session has been closed. ✅\n\nSend *Hi* to continue with bookings, payments, and other services. 🙏\n\n💡 *What you can do:*\n• Type *Hi* to start a new conversation\n• Type *my bookings* to check your bookings",
  });
}
