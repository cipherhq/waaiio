import type { SupabaseClient } from '@supabase/supabase-js';
import { getFlowCopy } from '@/lib/bot/flows/flow-localization';

/**
 * Next-steps menu for payments confirmed by the payment confirmation (Stage 3).
 * Owner rule 2026-11-05: every completed transaction ends with a menu of next
 * things to do, with "Powered by Waaiio.com" underneath.
 *
 * Button IDs are the same words the confirmation text already tells the
 * customer to type ("my bookings", "menu", "directory", ...). A tap arrives as
 * that text, so the menu works whatever state the chat session is in.
 */
export function buildPaymentNextStepsButtons(kind: string, shared: boolean, lang = 'en'): Array<{ id: string; title: string }> {
  // Titles come from the bot's fixed copy, the same labels as the in-chat menu.
  // "Payment history" and "Search directory" have no copy key and stay English,
  // as they do in the in-chat menu.
  const history = kind === 'ordering' ? { id: 'my orders', title: getFlowCopy(lang, 'account.my_orders') }
    : kind === 'giving' || kind === 'crowdfunding' ? { id: 'my giving', title: getFlowCopy(lang, 'post.my_giving') }
      : kind === 'payment' || kind === 'invoice' ? { id: 'history', title: 'Payment history' }
        : { id: 'my bookings', title: getFlowCopy(lang, 'post.my_bookings') };
  const buttons = [history, { id: 'menu', title: getFlowCopy(lang, 'nav.view_options') }];
  if (shared) buttons.push({ id: 'directory', title: 'Search directory' });
  return buttons;
}

/** Confirmation statuses that mean Stage 3 handed the confirmation (and its menu) to Meta. */
const HANDED_TO_META = ['accepted', 'sent', 'delivered', 'read'];

/**
 * True when Stage 3 already sent this chat payment's confirmation, and so its
 * next-steps menu. The chat flow then skips its own menu so the customer gets
 * one, not two. Any lookup failure returns false: two menus beat none.
 */
export async function paymentNextStepsMenuSent(
  supabase: SupabaseClient,
  businessId: string,
  sessionData: Record<string, unknown>,
): Promise<boolean> {
  try {
    const savedCardPaymentId = typeof sessionData._saved_card_payment_id === 'string' && sessionData._saved_card_payment_id
      ? sessionData._saved_card_payment_id : null;
    const reference = typeof sessionData.payment_reference === 'string' && sessionData.payment_reference
      ? sessionData.payment_reference : null;
    if (!savedCardPaymentId && !reference) return false;

    // Always resolve through payments scoped to this business.
    const { data: payment, error: paymentError } = await supabase
      .from('payments')
      .select('id')
      .eq('business_id', businessId)
      .eq(savedCardPaymentId ? 'id' : 'gateway_reference', savedCardPaymentId ?? reference)
      .maybeSingle();
    if (paymentError) return false;
    const paymentId = (payment?.id as string | undefined) ?? null;
    if (!paymentId) return false;

    const { data, error } = await supabase
      .from('payment_confirmation_deliveries')
      .select('id')
      .eq('payment_id', paymentId)
      .in('delivery_status', HANDED_TO_META)
      .limit(1);
    if (error) return false;
    return Array.isArray(data) && data.length > 0;
  } catch {
    return false;
  }
}
