/**
 * CAS-004 — Canonical Action Dispatcher.
 * Routes READ_HISTORY, MANAGE_EXISTING, INFORMATIONAL, and NAVIGATION
 * actions to existing Waaiio handlers. Never falls through into CREATE_NEW.
 *
 * Used by BOTH new-session and existing-session paths.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { MessageSender } from '@/lib/channels/message-sender';
import type { FlowExecutor } from './flows/executor';
import type { BotSession } from './bot-types';
import type { SemanticFamily, RequestedAction } from './semantic-types';
import { sanitizeFilterValue } from '@/lib/utils/sanitize';
import { logger } from '@/lib/logger';

export interface ActionDispatchParams {
  supabase: SupabaseClient;
  messageSender: MessageSender;
  flowExecutor: FlowExecutor;
  from: string;
  businessId: string;
  businessName: string;
  sessionData: Record<string, unknown>;
  semanticFamily: SemanticFamily;
  requestedAction: RequestedAction;
  originalText: string;
  /** Existing session to deactivate if routing to a new handler */
  existingSessionId?: string;
}

export interface ActionDispatchResult {
  handled: boolean;
  /** Why it was not handled, if applicable */
  reason?: 'unsupported_action' | 'no_profile' | 'no_handler';
}

/**
 * Dispatch a non-CREATE_NEW action to existing handlers.
 * Returns { handled: true } if the action was fulfilled.
 * Returns { handled: false } if the action could not be fulfilled — caller
 * must send safe recovery, NEVER fall through into CREATE_NEW.
 */
export async function dispatchAction(
  params: ActionDispatchParams,
): Promise<ActionDispatchResult> {
  const { supabase, messageSender, flowExecutor, from, businessId, businessName, sessionData, semanticFamily, requestedAction, existingSessionId } = params;

  const sendText = async (to: string, text: string) => {
    await messageSender.sendText({ to, text });
  };

  // Resolve customer profile
  const phoneP = from.startsWith('+') ? from : `+${from}`;
  const phoneN = from.startsWith('+') ? from.slice(1) : from;
  const { data: profile } = await supabase.from('profiles').select('id')
    .or(`phone.eq.${sanitizeFilterValue(phoneP)},phone.eq.${sanitizeFilterValue(phoneN)}`)
    .limit(1).maybeSingle();

  if (!profile?.id) {
    return { handled: false, reason: 'no_profile' };
  }

  // Deactivate existing session if provided
  if (existingSessionId) {
    await supabase.from('bot_sessions').update({ is_active: false }).eq('id', existingSessionId);
  }

  // Clean up old inactive sessions for this phone+business
  await supabase.from('bot_sessions').delete()
    .eq('whatsapp_number', from).eq('is_active', false).eq('business_id', businessId);

  // READ_HISTORY
  if (requestedAction === 'read_history') {
    if (semanticFamily === 'ordering') {
      const { data: sess } = await supabase.from('bot_sessions').insert({
        whatsapp_number: from, user_id: profile.id, business_id: businessId,
        current_step: 'my_orders', session_data: sessionData,
        is_active: true, expires_at: new Date(Date.now() + 86400000).toISOString(),
      }).select().single();
      if (sess) {
        const { handleMyOrders } = await import('./handlers/my-orders');
        const routeToMenu = async (_s: BotSession, _f: string) => {};
        await handleMyOrders(supabase, messageSender, sendText, routeToMenu, sess as BotSession, from, '');
        return { handled: true };
      }
    }

    if (semanticFamily === 'service_time_booking' || semanticFamily === 'property_reservation' || semanticFamily === 'table_reservation') {
      const { data: sess } = await supabase.from('bot_sessions').insert({
        whatsapp_number: from, user_id: profile.id, business_id: businessId,
        current_step: 'my_bookings', session_data: sessionData,
        is_active: true, expires_at: new Date(Date.now() + 86400000).toISOString(),
      }).select().single();
      if (sess) {
        const { handleMyBookings } = await import('./handlers/my-bookings');
        await handleMyBookings(supabase, messageSender, sendText, flowExecutor, sess as BotSession, from, '');
        return { handled: true };
      }
    }

    if (semanticFamily === 'giving' || semanticFamily === 'payment') {
      // Transaction history
      const { handleTransactionDocument } = await import('./handlers/transaction-docs');
      await handleTransactionDocument(supabase, messageSender, sendText, from, profile.id, 'history');
      return { handled: true };
    }

    // Unsupported family for READ_HISTORY
    return { handled: false, reason: 'no_handler' };
  }

  // MANAGE_EXISTING
  if (requestedAction === 'manage_existing') {
    if (semanticFamily === 'service_time_booking' || semanticFamily === 'property_reservation' || semanticFamily === 'table_reservation') {
      const { data: sess } = await supabase.from('bot_sessions').insert({
        whatsapp_number: from, user_id: profile.id, business_id: businessId,
        current_step: 'my_bookings', session_data: sessionData,
        is_active: true, expires_at: new Date(Date.now() + 86400000).toISOString(),
      }).select().single();
      if (sess) {
        const { handleMyBookings } = await import('./handlers/my-bookings');
        await handleMyBookings(supabase, messageSender, sendText, flowExecutor, sess as BotSession, from, '');
        return { handled: true };
      }
    }

    if (semanticFamily === 'ordering') {
      const { data: sess } = await supabase.from('bot_sessions').insert({
        whatsapp_number: from, user_id: profile.id, business_id: businessId,
        current_step: 'my_orders', session_data: sessionData,
        is_active: true, expires_at: new Date(Date.now() + 86400000).toISOString(),
      }).select().single();
      if (sess) {
        const { handleMyOrders } = await import('./handlers/my-orders');
        const routeToMenu = async (_s: BotSession, _f: string) => {};
        await handleMyOrders(supabase, messageSender, sendText, routeToMenu, sess as BotSession, from, '');
        return { handled: true };
      }
    }

    if (semanticFamily === 'giving' || semanticFamily === 'payment') {
      // Show transaction history as closest MANAGE_EXISTING behavior
      const { handleTransactionDocument } = await import('./handlers/transaction-docs');
      await handleTransactionDocument(supabase, messageSender, sendText, from, profile.id, 'history');
      return { handled: true };
    }

    return { handled: false, reason: 'no_handler' };
  }

  // INFORMATIONAL
  if (requestedAction === 'informational') {
    try {
      const { answerTemporaryQuestion } = await import('./business-knowledge');
      const answer = await answerTemporaryQuestion(supabase, businessId, { type: 'general', query: params.originalText }, businessName);
      if (answer) {
        await sendText(from, answer);
        return { handled: true };
      }
    } catch (err) {
      logger.warn('[ACTION-DISPATCH] Knowledge answer failed:', err);
    }
    // No knowledge answer available
    return { handled: false, reason: 'no_handler' };
  }

  // NAVIGATION handled by escape hatches/keywords — should not reach here
  return { handled: false, reason: 'unsupported_action' };
}

/**
 * Send a safe recovery message when an action cannot be fulfilled.
 * Never falls through into CREATE_NEW.
 */
export async function sendActionRecovery(
  messageSender: MessageSender,
  from: string,
  requestedAction: RequestedAction,
  reason: string,
): Promise<void> {
  let msg: string;
  if (reason === 'no_profile') {
    msg = "I don't have an account for this number yet. Send *Hi* to get started!";
  } else if (requestedAction === 'informational') {
    msg = "I'm not sure about that. Type *menu* to see what's available, or type *Hi* to start over.";
  } else {
    msg = "I couldn't find what you're looking for. Type *my account* to view your history, or *Hi* to start over.";
  }
  await messageSender.sendText({ to: from, text: msg });
}
