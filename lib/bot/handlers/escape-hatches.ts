import type { BotSession, BotContext } from '../bot-types';

// ── Navigation commands: always hardcoded, never overridable ──
export const CANCEL_PATTERN = /^cancel$/i;
export const EXIT_PATTERNS = [/^exit$/i, /^quit$/i, /^stop$/i, /^end$/i];
export const MENU_PATTERNS = [/^menu$/i, /^restart$/i, /^start\s*over$/i];
export const HOME_PATTERN = /^home$/i;
export const BACK_PATTERNS = [/^back$/i, /^go\s*back$/i, /^previous$/i];
// Combined for legacy checks — excludes "back" (handled in executor) and "menu"/"home" (handled separately)
export const ESCAPE_HATCH_PATTERNS = [
  CANCEL_PATTERN,
  ...EXIT_PATTERNS,
  ...MENU_PATTERNS,
];

/**
 * Handle escape hatch commands: back/cancel, menu/restart, exit/quit/stop.
 *
 * @param ctx - BotContext with supabase, messageSender, intelligence, flowExecutor
 * @param from - Customer WhatsApp number
 * @param session - Active bot session
 * @param text - Raw message text (already trimmed by caller)
 * @param messageType - WhatsApp message type
 * @param destinationPhone - Destination phone (for routing)
 * @param step - Current session step
 * @param sendText - Callback to send plain text
 * @param deactivateSession - Callback to deactivate a session
 * @param handleMessage - Recursive callback for restarting flows
 * @returns `{ handled: true }` if the escape hatch was consumed, `{ handled: false }` to fall through
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
): Promise<{ handled: boolean }> {
  const { supabase, messageSender, flowExecutor, intelligence } = ctx;

  const isChatMode = step === 'chat_handoff' || step === 'chat_start';
  const isBookingMgmt = step === 'my_bookings' || step === 'modify_booking' || step === 'my_orders' || step === 'order_detail';
  const trimmedText = text.trim();
  // Simplified: cancel = back (go back one step)
  const isCancelOrBack = CANCEL_PATTERN.test(trimmedText) || BACK_PATTERNS.some(p => p.test(trimmedText));
  const isExitWord = EXIT_PATTERNS.some(p => p.test(trimmedText));
  const isMenuWord = MENU_PATTERNS.some(p => p.test(trimmedText));
  const isEscapeHatch = isCancelOrBack || isExitWord || isMenuWord;

  // ── 3 SIMPLE COMMANDS: back/cancel, menu, exit ──

  // "back" or "cancel" in booking management → go to business menu
  if (isCancelOrBack && isBookingMgmt && !isChatMode) {
    if (session.business_id) {
      await deactivateSession(session.id);
      await handleMessage(from, 'Hi', messageType, destinationPhone, session.business_id);
      return { handled: true };
    }
  }

  // "back" or "cancel" in flow steps → handled by executor (let it fall through)
  // The executor pops step history and re-prompts the previous step

  if (isEscapeHatch && (session.business_id || isBookingMgmt) && !isChatMode) {
    intelligence.resetAbuse(from);

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

    // ── "cancel" / "back" → go back one step ──
    if (isCancelOrBack) {
      // For free-text steps (enter_amount, collect_name, etc.), the executor
      // won't intercept back/cancel. Handle it here instead.
      const FREE_TEXT_STEPS = ['collect_name', 'collect_other_name', 'collect_email', 'special_requests', 'review_text', 'enter_amount', 'collect_address', 'collect_pickup_address', 'collect_dropoff_address', 'collect_package_description', 'collect_venue', 'enter_promo_code'];
      if (FREE_TEXT_STEPS.includes(step)) {
        const history = (session.session_data._step_history as string[]) || [];
        if (history.length >= 2) {
          history.pop();
          const prevStep = history[history.length - 1];
          session.session_data._step_history = history;
          session.current_step = prevStep;
          await supabase.from('bot_sessions').update({
            current_step: prevStep,
            session_data: session.session_data,
          }).eq('id', session.id);
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
        await messageSender.sendButtons({
          to: from,
          body: `You've left ${biz?.name || 'the business'}. What next?`,
          buttons: [
            { id: 'go_back_biz', title: 'Back to Menu' },
            { id: 'switch_biz', title: 'Switch Business' },
          ],
        });
        return { handled: true };
      }
      // Other non-free-text steps: fall through to executor (it handles back/cancel)
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
      const bizName = escBiz?.name || 'the business';
      await messageSender.sendButtons({
        to: from,
        body: `You've left ${bizName}. What next?`,
        buttons: [
          { id: 'go_back_biz', title: 'Back to Menu' },
          { id: 'switch_biz', title: 'Switch Business' },
        ],
      });
    } else {
      // No business found at all — guide them
      await sendText(from, 'Send a *business code* to get started, or visit waaiio.com/directory to find a business.');
    }
      return { handled: true };
    }
  }

  return { handled: false };
}
