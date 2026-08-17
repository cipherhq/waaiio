/**
 * CAS-004 — Canonical Action Dispatcher.
 * Routes non-CREATE_NEW actions to existing handlers.
 * Never falls through into CREATE_NEW.
 *
 * Session transitions use CAS update (same row) when an existing session
 * exists, or normal insert for new sessions. Atomic and failure-safe.
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
  /** Existing session — will be CAS-updated to destination step, NOT deleted */
  existingSession?: { id: string; version: number };
}

export interface ActionDispatchResult {
  handled: boolean;
  reason?: 'unsupported_action' | 'no_profile' | 'no_handler' | 'session_create_failed' | 'session_cas_conflict' | 'handler_failed';
}

export async function dispatchAction(
  params: ActionDispatchParams,
): Promise<ActionDispatchResult> {
  const { supabase, messageSender, flowExecutor, from, businessId, businessName, sessionData, semanticFamily, requestedAction, existingSession } = params;

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

  // Determine handler BEFORE modifying session state
  type HandlerFn = (session: BotSession) => Promise<void>;
  let handler: HandlerFn | null = null;
  let targetStep: string | null = null;

  // READ_HISTORY
  if (requestedAction === 'read_history') {
    if (semanticFamily === 'ordering') {
      targetStep = 'my_orders';
      handler = async (sess) => {
        const { handleMyOrders } = await import('./handlers/my-orders');
        const routeToMenu = async (_s: BotSession, _f: string) => {};
        await handleMyOrders(supabase, messageSender, sendText, routeToMenu, sess, from, '');
      };
    } else if (semanticFamily === 'service_time_booking' || semanticFamily === 'class_booking' || semanticFamily === 'property_reservation' || semanticFamily === 'table_reservation') {
      targetStep = 'my_bookings';
      handler = async (sess) => {
        const { handleMyBookings } = await import('./handlers/my-bookings');
        await handleMyBookings(supabase, messageSender, sendText, flowExecutor, sess, from, '');
      };
    } else if (semanticFamily === 'giving' || semanticFamily === 'payment') {
      handler = async () => {
        const { handleTransactionDocument } = await import('./handlers/transaction-docs');
        await handleTransactionDocument(supabase, messageSender, sendText, from, profile.id, 'history');
      };
    }
  }

  // MANAGE_EXISTING
  if (requestedAction === 'manage_existing') {
    if (semanticFamily === 'service_time_booking' || semanticFamily === 'class_booking' || semanticFamily === 'property_reservation' || semanticFamily === 'table_reservation') {
      targetStep = 'my_bookings';
      handler = async (sess) => {
        const { handleMyBookings } = await import('./handlers/my-bookings');
        await handleMyBookings(supabase, messageSender, sendText, flowExecutor, sess, from, '');
      };
    } else if (semanticFamily === 'ordering') {
      targetStep = 'my_orders';
      handler = async (sess) => {
        const { handleMyOrders } = await import('./handlers/my-orders');
        const routeToMenu = async (_s: BotSession, _f: string) => {};
        await handleMyOrders(supabase, messageSender, sendText, routeToMenu, sess, from, '');
      };
    }
  }

  // INFORMATIONAL — preserves existing session
  if (requestedAction === 'informational') {
    handler = async () => {
      try {
        const { answerTemporaryQuestion } = await import('./business-knowledge');
        const answer = await answerTemporaryQuestion(supabase, businessId, { type: 'general', query: params.originalText }, businessName);
        if (answer) { await sendText(from, answer); return; }
      } catch (err) { logger.warn('[ACTION-DISPATCH] Knowledge answer failed:', err); }
      await sendText(from, "I'm not sure about that. Type *menu* to see what's available, or type *Hi* to start over.");
    };
  }

  if (!handler) {
    return { handled: false, reason: 'no_handler' };
  }

  // INFORMATIONAL preserves session — no transition needed
  if (requestedAction === 'informational') {
    try {
      // Pass existing session if available, or a minimal placeholder
      const sess = existingSession
        ? { id: existingSession.id, user_id: profile.id, business_id: businessId, current_step: 'informational', session_data: sessionData, version: existingSession.version } as unknown as BotSession
        : { id: '', user_id: profile.id, business_id: businessId, current_step: 'informational', session_data: sessionData, version: 0 } as unknown as BotSession;
      await handler(sess);
      return { handled: true };
    } catch (err) {
      logger.error('[ACTION-DISPATCH] Informational handler failed:', err);
      return { handled: false, reason: 'handler_failed' };
    }
  }

  // TRANSITION: CAS-update existing session to destination step (atomic)
  let actionSession: BotSession;

  if (existingSession && targetStep) {
    // Atomic CAS update — same row, no delete/insert race
    const updatedData = { ...sessionData, user_id: profile.id };
    const { data: casResult } = await supabase.rpc('update_session_cas', {
      p_session_id: existingSession.id,
      p_expected_version: existingSession.version,
      p_current_step: targetStep,
      p_session_data: updatedData,
    });

    if (!casResult?.success) {
      logger.warn('[ACTION-DISPATCH] CAS conflict:', casResult?.reason);
      return { handled: false, reason: 'session_cas_conflict' };
    }

    actionSession = {
      id: existingSession.id,
      user_id: profile.id,
      business_id: businessId,
      current_step: targetStep,
      session_data: updatedData,
      version: casResult.version,
    } as unknown as BotSession;
  } else if (targetStep) {
    // No existing session — create new (for new-session action dispatch)
    await supabase.from('bot_sessions').delete()
      .eq('whatsapp_number', from).eq('is_active', false).eq('business_id', businessId);

    const { data: newSess, error: insertErr } = await supabase.from('bot_sessions').insert({
      whatsapp_number: from, user_id: profile.id, business_id: businessId,
      current_step: targetStep, session_data: sessionData,
      is_active: true, expires_at: new Date(Date.now() + 86400000).toISOString(),
    }).select().single();

    if (insertErr || !newSess) {
      return { handled: false, reason: 'session_create_failed' };
    }
    actionSession = newSess as BotSession;
  } else {
    // Handler doesn't need a session transition (e.g., transaction history)
    actionSession = { id: '', user_id: profile.id, business_id: businessId, current_step: '', session_data: sessionData, version: 0 } as unknown as BotSession;
  }

  try {
    await handler(actionSession);
    return { handled: true };
  } catch (err) {
    logger.error('[ACTION-DISPATCH] Handler failed:', err);
    return { handled: false, reason: 'handler_failed' };
  }
}

export async function sendActionRecovery(
  messageSender: MessageSender,
  from: string,
  requestedAction: RequestedAction,
  reason: string,
): Promise<void> {
  let msg: string;
  if (reason === 'no_profile') msg = "I don't have an account for this number yet. Send *Hi* to get started!";
  else if (requestedAction === 'informational') msg = "I'm not sure about that. Type *menu* to see what's available, or type *Hi* to start over.";
  else if (requestedAction === 'manage_existing') msg = "I couldn't find a way to manage that right now. Type *my account* to see your options, or *Hi* to start over.";
  else if (reason === 'session_cas_conflict') msg = "Something changed. Please try again.";
  else msg = "I couldn't find what you're looking for. Type *my account* to view your history, or *Hi* to start over.";
  await messageSender.sendText({ to: from, text: msg });
}
