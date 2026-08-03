/**
 * CAS-004 — Canonical Action Dispatcher.
 * Routes READ_HISTORY, MANAGE_EXISTING, INFORMATIONAL, and NAVIGATION
 * actions to existing Waaiio handlers. Never falls through into CREATE_NEW.
 *
 * Used by BOTH new-session and existing-session paths.
 *
 * Session deactivation happens ONLY after confirming the handler can work.
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
  existingSessionId?: string;
}

export interface ActionDispatchResult {
  handled: boolean;
  reason?: 'unsupported_action' | 'no_profile' | 'no_handler' | 'session_create_failed' | 'handler_failed';
}

export async function dispatchAction(
  params: ActionDispatchParams,
): Promise<ActionDispatchResult> {
  const { supabase, messageSender, flowExecutor, from, businessId, businessName, sessionData, semanticFamily, requestedAction, existingSessionId } = params;

  const sendText = async (to: string, text: string) => {
    await messageSender.sendText({ to, text });
  };

  // Resolve customer profile FIRST — needed for all handlers
  const phoneP = from.startsWith('+') ? from : `+${from}`;
  const phoneN = from.startsWith('+') ? from.slice(1) : from;
  const { data: profile } = await supabase.from('profiles').select('id')
    .or(`phone.eq.${sanitizeFilterValue(phoneP)},phone.eq.${sanitizeFilterValue(phoneN)}`)
    .limit(1).maybeSingle();

  if (!profile?.id) {
    return { handled: false, reason: 'no_profile' };
  }

  // Determine which handler to use BEFORE modifying any session state
  type HandlerFn = () => Promise<void>;
  let handler: HandlerFn | null = null;
  let targetStep: string | null = null;

  // READ_HISTORY
  if (requestedAction === 'read_history') {
    if (semanticFamily === 'ordering') {
      targetStep = 'my_orders';
      handler = async () => {
        const { handleMyOrders } = await import('./handlers/my-orders');
        const routeToMenu = async (_s: BotSession, _f: string) => {};
        const { data: sess } = await createActionSession(supabase, from, profile.id, businessId, sessionData, targetStep!, existingSessionId);
        if (!sess) throw new Error('session_create_failed');
        await handleMyOrders(supabase, messageSender, sendText, routeToMenu, sess as BotSession, from, '');
      };
    } else if (semanticFamily === 'service_time_booking' || semanticFamily === 'property_reservation' || semanticFamily === 'table_reservation') {
      targetStep = 'my_bookings';
      handler = async () => {
        const { handleMyBookings } = await import('./handlers/my-bookings');
        const { data: sess } = await createActionSession(supabase, from, profile.id, businessId, sessionData, targetStep!, existingSessionId);
        if (!sess) throw new Error('session_create_failed');
        await handleMyBookings(supabase, messageSender, sendText, flowExecutor, sess as BotSession, from, '');
      };
    } else if (semanticFamily === 'giving' || semanticFamily === 'payment') {
      handler = async () => {
        const { handleTransactionDocument } = await import('./handlers/transaction-docs');
        await handleTransactionDocument(supabase, messageSender, sendText, from, profile.id, 'history');
      };
    }
  }

  // MANAGE_EXISTING — route to management handlers, NOT to read_history
  if (requestedAction === 'manage_existing') {
    if (semanticFamily === 'service_time_booking' || semanticFamily === 'property_reservation' || semanticFamily === 'table_reservation') {
      targetStep = 'my_bookings';
      handler = async () => {
        const { handleMyBookings } = await import('./handlers/my-bookings');
        const { data: sess } = await createActionSession(supabase, from, profile.id, businessId, sessionData, targetStep!, existingSessionId);
        if (!sess) throw new Error("session_create_failed");
        await handleMyBookings(supabase, messageSender, sendText, flowExecutor, sess as BotSession, from, '');
      };
    } else if (semanticFamily === 'ordering') {
      targetStep = 'my_orders';
      handler = async () => {
        const { handleMyOrders } = await import('./handlers/my-orders');
        const routeToMenu = async (_s: BotSession, _f: string) => {};
        const { data: sess } = await createActionSession(supabase, from, profile.id, businessId, sessionData, targetStep!, existingSessionId);
        if (!sess) throw new Error("session_create_failed");
        await handleMyOrders(supabase, messageSender, sendText, routeToMenu, sess as BotSession, from, '');
      };
    }
    // giving/payment MANAGE_EXISTING: no substitution to history
    // Return as unsupported if no direct management handler exists
  }

  // INFORMATIONAL
  if (requestedAction === 'informational') {
    handler = async () => {
      try {
        const { answerTemporaryQuestion } = await import('./business-knowledge');
        const answer = await answerTemporaryQuestion(supabase, businessId, { type: 'general', query: params.originalText }, businessName);
        if (answer) {
          await sendText(from, answer);
          return;
        }
      } catch (err) {
        logger.warn('[ACTION-DISPATCH] Knowledge answer failed:', err);
      }
      // No knowledge answer — send informational recovery
      await sendText(from, "I'm not sure about that. Type *menu* to see what's available, or type *Hi* to start over.");
    };
  }

  if (!handler) {
    return { handled: false, reason: 'no_handler' };
  }

  // INFORMATIONAL preserves the existing session (customer may be mid-flow)
  const preserveSession = requestedAction === 'informational';

  // Session transition is handled INSIDE the handler (after destination session
  // is successfully created). The handler throws on failure, preserving the
  // original session.

  try {
    await handler();
    return { handled: true };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error('[ACTION-DISPATCH] Handler execution failed:', errMsg);
    const reason = errMsg === 'session_create_failed' ? 'session_create_failed' as const : 'handler_failed' as const;
    return { handled: false, reason };
  }
}

async function createActionSession(
  supabase: SupabaseClient,
  from: string,
  userId: string,
  businessId: string,
  sessionData: Record<string, unknown>,
  currentStep: string,
  /** Deactivate AFTER new session is created (failure-safe) */
  existingSessionToDeactivate?: string,
) {
  // Clean up old inactive sessions first
  await supabase.from('bot_sessions').delete()
    .eq('whatsapp_number', from).eq('is_active', false).eq('business_id', businessId);

  const result = await supabase.from('bot_sessions').insert({
    whatsapp_number: from,
    user_id: userId,
    business_id: businessId,
    current_step: currentStep,
    session_data: sessionData,
    is_active: true,
    expires_at: new Date(Date.now() + 86400000).toISOString(),
  }).select().single();

  // Only deactivate old session AFTER new one is successfully created
  if (result.data && existingSessionToDeactivate) {
    await supabase.from('bot_sessions').update({ is_active: false }).eq('id', existingSessionToDeactivate);
  }

  return result;
}

/**
 * Send safe recovery for unfulfilled actions. NEVER falls into CREATE_NEW.
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
  } else if (requestedAction === 'manage_existing') {
    msg = "I couldn't find a way to manage that right now. Type *my account* to see your options, or *Hi* to start over.";
  } else {
    msg = "I couldn't find what you're looking for. Type *my account* to view your history, or *Hi* to start over.";
  }
  await messageSender.sendText({ to: from, text: msg });
}
