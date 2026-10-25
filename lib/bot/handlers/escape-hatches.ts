import type { BotSession, BotContext } from '../bot-types';
import {
  normalizeInboundCommand,
  recognizeNavigationCommand,
  type NavigationCommand,
} from '../inbound-command-normalization';
import { handleCorrectionReentry } from './correction-reentry';
import { getFlowCopy, fillFlowCopy } from '../flows/flow-localization';
import { logger } from '@/lib/logger';

type TestableCommandPattern = { test(value: string): boolean };

function commandPattern(command: NavigationCommand): TestableCommandPattern {
  return { test: (value: string) => recognizeNavigationCommand(value) === command };
}

// ── Navigation commands: deterministic, exact/anchored, never overridable ──
// Keep the historical exported .test() surface so existing callers do not need
// to own language normalization or command aliases.
export const CANCEL_PATTERN = commandPattern('cancel');
export const EXIT_PATTERNS = [commandPattern('exit')];
export const MENU_PATTERNS = [commandPattern('menu'), commandPattern('restart')];
export const HOME_PATTERN = commandPattern('home');
export const BACK_PATTERNS = [commandPattern('back')];
// Combined for legacy checks — excludes "back" (handled in executor) and "menu"/"home" (handled separately)
export const ESCAPE_HATCH_PATTERNS = [
  CANCEL_PATTERN,
  ...EXIT_PATTERNS,
  ...MENU_PATTERNS,
];

/**
 * Handle escape hatch commands: back/cancel, menu/restart, exit/quit/stop.
 * Recognition is multilingual, but existing transition owners retain side effects.
 */
export async function handleEscapeHatch(
  ctx: BotContext,
  from: string,
  session: BotSession,
  text: string,
  messageType: string,
  destinationPhone: string | undefined,
  step: string,
  sendText: (to: string, text: string) => Promise<void>,
  deactivateSession: (sessionId: string) => Promise<void>,
  handleMessage: (from: string, text: string, type: string, dest?: string, bizId?: string) => Promise<void>,
  lang?: string,
): Promise<{ handled: boolean }> {
  const { supabase, messageSender, flowExecutor, intelligence } = ctx;

  const isChatMode = step === 'chat_handoff' || step === 'chat_start';
  const isBookingMgmt = step === 'my_bookings' || step === 'modify_booking' || step === 'my_orders' || step === 'order_detail' || step === 'list_subscriptions' || step === 'loyalty_menu' || step === 'invoice_list';
  const trimmedText = text.trim();
  const normalizedText = normalizeInboundCommand(trimmedText);
  const navigationCommand = recognizeNavigationCommand(trimmedText);

  // English "help" is owned by BotService immediately before this handler.
  // Canonicalize multilingual aliases back into that same owner rather than
  // duplicating help behavior here.
  if (navigationCommand === 'help' && normalizedText !== 'help') {
    await handleMessage(from, 'help', messageType, destinationPhone);
    return { handled: true };
  }

  // Slice 2 correction re-entry: this is only wiring. The deterministic parser
  // proposes a target, CAS persists the rewind, and the existing FlowExecutor
  // retains all validation/availability/stock authority. Chat/free-text handoff
  // remains untouched.
  if (!isChatMode) {
    const correctionReentry = await handleCorrectionReentry(ctx, from, session, trimmedText);
    if (correctionReentry.handled) return correctionReentry;
  }

  // "cancel" = safely abandon the flow and return to business menu (Owner decision 2026-10-25).
  // "back" = go back one step in the flow.
  const isCancel = navigationCommand === 'cancel';
  const isBack = navigationCommand === 'back';
  const isCancelOrBack = isCancel || isBack;
  const isExitWord = navigationCommand === 'exit';
  const isMenuWord = navigationCommand === 'menu' || navigationCommand === 'restart';
  const isEscapeHatch = isCancelOrBack || isExitWord || isMenuWord;

  // ── 3 SIMPLE COMMANDS: back/cancel, menu, exit ──

  // "back" or "cancel" in booking management → go back to My Account menu
  if (isCancelOrBack && isBookingMgmt && !isChatMode) {
    // Route back to My Account menu (not restart completely) — use CAS to prevent stale overwrite
    const newData: Record<string, unknown> = { ...session.session_data, active_capability: 'my_account' };
    // Clear any pending language confirmation so it doesn't trap the next input
    // after navigation completes (the executor receives '' and skips the pending handler).
    delete newData._pending_language_switch;
    const { data: casResult } = await supabase.rpc('update_session_cas', {
      p_session_id: session.id,
      p_expected_version: session.version ?? 0,
      p_current_step: 'my_account_menu',
      p_session_data: newData,
    });
    if (!casResult?.success) return { handled: true }; // stale — silently exit
    session.current_step = 'my_account_menu';
    session.session_data = newData;
    session.version = casResult.version;
    // Load business context if available
    let biz = null;
    if (session.business_id) {
      const { data } = await supabase
        .from('businesses')
        .select('id, name, slug, category, flow_type, subscription_tier, trial_ends_at, metadata, operating_hours, country_code, payment_gateway')
        .eq('id', session.business_id).single();
      biz = data;
    }
    await flowExecutor.execute(from, '', session, biz);
    return { handled: true };
  }

  // "back" in flow steps → existing executor remains the owner.
  // "cancel" → safely abandon the current flow and return to business menu.

  if (isEscapeHatch && (session.business_id || isBookingMgmt) && !isChatMode) {
    intelligence.resetAbuse(from);

    // ── "cancel" → safely abandon flow and return to business menu ──
    // Uses authoritative cancellation RPCs that handle slot release, stock
    // restoration, promo reservation release, payment-state fencing, and
    // pending-transfer cancellation. Never bypasses these authorities.
    if (isCancel && session.business_id) {
      const bizId = session.business_id;
      const d = session.session_data || {};

      // Cancel pending booking via authoritative RPC (releases slot capacity,
      // package redemptions, checks ownership). Silently succeeds if booking
      // is already cancelled/completed — the RPC handles all status guards.
      if (d.booking_id) {
        const { data: bookingResult } = await supabase.rpc('cancel_booking_with_release', {
          p_booking_id: d.booking_id as string,
          p_cancelled_by: 'customer',
          p_expected_user_id: session.user_id || '00000000-0000-0000-0000-000000000000',
        });
        if (bookingResult && !bookingResult.cancelled) {
          // Not cancellable (already confirmed+paid, completed, etc.) — safe to proceed,
          // the booking remains in its current state.
          logger.info('[ESCAPE] cancel: booking not cancellable, preserving state', {
            bookingId: d.booking_id, reason: bookingResult.reason,
          });
        }
      }

      // Cancel pending order via authoritative RPC (restores stock, releases
      // promo reservations, voids pending payments, cancels pending transfers).
      // Refuses if a successful payment exists — the order stays confirmed.
      if (d.order_id) {
        const { data: orderResult } = await supabase.rpc('cancel_order_immediate', {
          p_order_id: d.order_id as string,
          p_reason: 'customer_cancel',
        });
        if (orderResult && !orderResult.cancelled) {
          logger.info('[ESCAPE] cancel: order not cancellable, preserving state', {
            orderId: d.order_id, reason: orderResult.reason,
          });
        }
      }

      // Deactivate session AFTER cleanup so the RPCs can still read session context
      await deactivateSession(session.id);
      await handleMessage(from, 'Hi', messageType, destinationPhone, bizId);
      return { handled: true };
    }

    // ── "menu" / "restart" / "start over" → restart current business menu ──
    if (isMenuWord && session.business_id) {
      const bizId = session.business_id;
      await deactivateSession(session.id);
      // Cancel any pending booking/order
      const d = session.session_data || {};
      if (d.booking_id) {
        await supabase.from('bookings')
          .update({ status: 'cancelled', cancelled_at: new Date().toISOString() })
          .eq('id', d.booking_id as string)
          .in('status', ['pending']);
      }
      if (d.order_id) {
        await supabase.from('orders')
          .update({ status: 'cancelled' })
          .eq('id', d.order_id as string)
          .eq('status', 'pending');
      }
      await handleMessage(from, 'Hi', messageType, destinationPhone, bizId);
      return { handled: true };
    }

    // ── "back" → go back one step ──
    if (isBack) {
      // For free-text steps (enter_amount, collect_name, etc.), the executor
      // won't intercept back/cancel. Handle it here instead.
      const FREE_TEXT_STEPS = ['collect_name', 'collect_other_name', 'collect_email', 'special_requests', 'review_text', 'enter_amount', 'collect_address', 'collect_pickup_address', 'collect_dropoff_address', 'collect_package_description', 'collect_venue', 'enter_promo_code'];
      if (FREE_TEXT_STEPS.includes(step)) {
        const history = (session.session_data._step_history as string[]) || [];
        if (history.length >= 2) {
          history.pop();
          const prevStep = history[history.length - 1];
          const newData: Record<string, unknown> = { ...session.session_data, _step_history: history };
          // Clear any pending language confirmation so it doesn't trap the next input
          // after navigation completes (the executor receives '' and skips the pending handler).
          delete newData._pending_language_switch;
          const { data: casResult } = await supabase.rpc('update_session_cas', {
            p_session_id: session.id,
            p_expected_version: session.version ?? 0,
            p_current_step: prevStep,
            p_session_data: newData,
          });
          if (!casResult?.success) return { handled: true }; // stale — silently exit
          session.session_data = newData;
          session.current_step = prevStep;
          session.version = casResult.version;
          const biz = session.business_id
            ? (await supabase.from('businesses').select('*').eq('id', session.business_id).single()).data
            : null;
          if (biz) {
            await flowExecutor.execute(from, '', session as unknown as BotSession, biz);
          }
          return { handled: true };
        }
        // No history — restart menu
        if (session.business_id) {
          await deactivateSession(session.id);
          await handleMessage(from, 'Hi', messageType, destinationPhone, session.business_id);
          return { handled: true };
        }
      }
      // Non-free-text steps: if at beginning (select_capability/greeting), show options instead of dead-end
      const earlySteps = ['select_capability', 'greeting', 'post_completion'];
      if (earlySteps.includes(step) && session.business_id) {
        const { data: biz } = await supabase.from('businesses').select('name').eq('id', session.business_id).single();
        await deactivateSession(session.id);
        const exitBody = biz?.name
          ? fillFlowCopy(lang || 'en', 'nav.exit_what_next', { businessName: biz.name })
          : getFlowCopy(lang || 'en', 'nav.exit_fallback');
        await messageSender.sendButtons({
          to: from,
          body: exitBody,
          buttons: [
            { id: 'go_back_biz', title: getFlowCopy(lang || 'en', 'nav.back_to_menu') },
            { id: 'switch_biz', title: getFlowCopy(lang || 'en', 'nav.switch_business') },
          ],
        });
        return { handled: true };
      }

      // Preserve the FlowExecutor as owner of ordinary step-history navigation.
      // Existing English forms fall through unchanged. Multilingual aliases are
      // converted to the canonical English command the executor already owns.
      const legacyExecutorWords = new Set(['back', 'go back', 'previous']);
      if (!legacyExecutorWords.has(normalizedText) && session.business_id) {
        const { data: biz } = await supabase
          .from('businesses')
          .select('id, name, slug, category, flow_type, subscription_tier, trial_ends_at, metadata, country_code, payment_gateway')
          .eq('id', session.business_id)
          .single();
        if (biz) {
          await flowExecutor.execute(
            from,
            navigationCommand === 'cancel' ? 'cancel' : 'back',
            session as unknown as BotSession,
            biz,
          );
          return { handled: true };
        }
      }
      // Existing English non-free-text steps fall through to executor unchanged.
    }

    // ── "exit" / "quit" / "stop" → leave business ──
    if (isExitWord) {
      await deactivateSession(session.id);

      // Cancel any pending booking/order created during this session
      const d = session.session_data || {};
      if (d.booking_id) {
        await supabase.from('bookings')
          .update({ status: 'cancelled', cancelled_at: new Date().toISOString() })
          .eq('id', d.booking_id as string)
          .in('status', ['pending']);
      }
      if (d.order_id) {
        await supabase.from('orders')
          .update({ status: 'cancelled' })
          .eq('id', d.order_id as string)
          .eq('status', 'pending');
      }

      // Find the business — from session or from history
      let escBizId = session.business_id;
      if (!escBizId) {
        const { data: lastSess } = await supabase
          .from('bot_sessions')
          .select('business_id')
          .eq('whatsapp_number', from)
          .not('business_id', 'is', null)
          .order('updated_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        escBizId = lastSess?.business_id || null;
      }

      // Always show clear options — never dead-end text
      if (escBizId) {
        const { data: escBiz } = await supabase.from('businesses').select('name').eq('id', escBizId).single();
        const exitBody = escBiz?.name
          ? fillFlowCopy(lang || 'en', 'nav.exit_what_next', { businessName: escBiz.name })
          : getFlowCopy(lang || 'en', 'nav.exit_fallback');
        await messageSender.sendButtons({
          to: from,
          body: exitBody,
          buttons: [
            { id: 'go_back_biz', title: getFlowCopy(lang || 'en', 'nav.back_to_menu') },
            { id: 'switch_biz', title: getFlowCopy(lang || 'en', 'nav.switch_business') },
          ],
        });
      } else {
        // No business found at all — guide them
        await sendText(from, getFlowCopy(lang || 'en', 'nav.no_business_guide'));
      }
      return { handled: true };
    }
  }

  return { handled: false };
}
