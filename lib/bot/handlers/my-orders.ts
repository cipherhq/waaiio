import type { SupabaseClient } from '@supabase/supabase-js';
import type { MessageSender } from '@/lib/channels/message-sender';
import { formatCurrency, type CountryCode } from '@/lib/constants';
import { truncTitle } from '../utils/truncate';
import type { BotSession } from '../bot-types';
import { logger } from '@/lib/logger';
import { getFlowCopy } from '../flows/flow-localization';

// ── Pure helpers ─────────────────────────────────────────

export function formatOrderStatus(status: string, lang?: string): { emoji: string; label: string } {
  const l = lang || 'en';
  const map: Record<string, { emoji: string; label: string }> = {
    pending: { emoji: '🕐', label: getFlowCopy(l, 'order_status.pending') },
    confirmed: { emoji: '✅', label: getFlowCopy(l, 'order_status.confirmed') },
    processing: { emoji: '🔄', label: getFlowCopy(l, 'order_status.processing') },
    ready: { emoji: '📦', label: getFlowCopy(l, 'order_status.ready') },
    shipped: { emoji: '🚚', label: getFlowCopy(l, 'order_status.shipped') },
    delivered: { emoji: '✅', label: getFlowCopy(l, 'order_status.delivered') },
    cancelled: { emoji: '❌', label: getFlowCopy(l, 'order_status.cancelled') },
  };
  return map[status] || { emoji: '📋', label: status };
}

export function buildOrderProgressBar(status: string, lang?: string): string {
  const l = lang || 'en';
  const stages = ['confirmed', 'processing', 'ready', 'delivered'];
  const stageLabels: Record<string, string> = {
    confirmed: getFlowCopy(l, 'order_status.confirmed'),
    processing: getFlowCopy(l, 'order_status.processing'),
    ready: getFlowCopy(l, 'order_status.ready'),
    delivered: getFlowCopy(l, 'order_status.delivered'),
  };
  const stageEmojis: Record<string, { done: string; current: string; pending: string }> = {
    confirmed: { done: '✅', current: '✅', pending: '⬜' },
    processing: { done: '✅', current: '🔄', pending: '⬜' },
    ready: { done: '✅', current: '📦', pending: '⬜' },
    delivered: { done: '✅', current: '✅', pending: '⬜' },
  };

  // If pending, nothing is done yet
  const normalizedStatus = status === 'pending' ? 'pending' : status;
  const currentIndex = stages.indexOf(normalizedStatus);

  const lines: string[] = [];
  for (let i = 0; i < stages.length; i++) {
    const stage = stages[i];
    const emojis = stageEmojis[stage];
    let icon: string;
    let marker = '';
    if (currentIndex < 0) {
      // pending — nothing started
      icon = emojis.pending;
    } else if (i < currentIndex) {
      icon = emojis.done;
    } else if (i === currentIndex) {
      icon = emojis.current;
      marker = getFlowCopy(l, 'orders.you_are_here');
    } else {
      icon = emojis.pending;
    }
    lines.push(`${icon} ${stageLabels[stage]}${marker}`);
  }
  return lines.join('\n');
}

// ── Async handlers ───────────────────────────────────────

export async function handleMyOrders(
  supabase: SupabaseClient,
  messageSender: MessageSender,
  sendText: (to: string, text: string) => Promise<void>,
  routeToMyAccountMenu: (session: BotSession, from: string) => Promise<void>,
  session: BotSession,
  from: string,
  input: string,
  lang?: string,
): Promise<void> {
  const l = lang || 'en';
  if (!input) {
    const { data: orders } = await supabase
      .from('orders')
      .select('id, reference_code, status, total_amount, created_at, businesses (name, country_code)')
      .eq('user_id', session.user_id!)
      .in('status', ['pending', 'confirmed', 'processing', 'ready', 'shipped'])
      .order('created_at', { ascending: false })
      .limit(10);

    if (!orders || orders.length === 0) {
      await messageSender.sendButtons({
        to: from,
        body: getFlowCopy(l, 'account.no_orders'),
        buttons: [{ id: 'back_to_account', title: getFlowCopy(l, 'nav.back') }],
      });
      return;
    }

    if (orders.length <= 2) {
      // Show as buttons (max 2 orders + back button = 3 total)
      const lines = orders.map((o) => {
        const b = o.businesses as unknown as { name: string; country_code?: CountryCode } | null;
        const occ = (b?.country_code as CountryCode) || 'NG';
        const { emoji: e, label } = formatOrderStatus(o.status, l);
        const dateLabel = new Date(o.created_at).toLocaleDateString('en-US', { day: 'numeric', month: 'short' });
        return `${e} *${o.reference_code}* — ${label}\n   ${b?.name || 'Order'} • ${dateLabel} • ${formatCurrency(o.total_amount || 0, occ)}`;
      });

      await sendText(from, `📦 *${getFlowCopy(l, 'orders.your_orders_title')}*\n\n${lines.join('\n\n')}`);

      const buttons = orders.map((o) => ({
        id: `order_${o.id}`,
        title: truncTitle(`${o.reference_code}`),
      }));
      buttons.push({ id: 'back_to_account', title: getFlowCopy(l, 'nav.back') });

      await messageSender.sendButtons({
        to: from,
        body: getFlowCopy(l, 'orders.select_prompt'),
        buttons,
      });
    } else {
      // Show as list with back option
      const items = orders.map((o) => {
        const b = o.businesses as unknown as { name: string; country_code?: CountryCode } | null;
        const occ = (b?.country_code as CountryCode) || 'NG';
        const { label } = formatOrderStatus(o.status, l);
        const dateLabel = new Date(o.created_at).toLocaleDateString('en-US', { day: 'numeric', month: 'short' });
        return {
          title: truncTitle(`${o.reference_code}`, 24),
          description: `${label} • ${b?.name || 'Order'} • ${formatCurrency(o.total_amount || 0, occ)}`.slice(0, 72),
          postbackText: `order_${o.id}`,
        };
      });
      items.push({ title: getFlowCopy(l, 'nav.back_to_account'), description: getFlowCopy(l, 'nav.return_to_account'), postbackText: 'back_to_account' });

      await messageSender.sendList({
        to: from,
        title: getFlowCopy(l, 'orders.your_orders_title'),
        body: `📦 ${getFlowCopy(l, 'orders.select_prompt')}`,
        buttonLabel: getFlowCopy(l, 'orders.view_orders'),
        items,
      });
    }
    return;
  }

  // Handle order selection
  if (input.startsWith('order_')) {
    const orderId = input.replace('order_', '');
    // Ownership check BEFORE storing UUID in session_data
    const { data: ownedOrder } = await supabase
      .from('orders')
      .select('id')
      .eq('id', orderId)
      .eq('user_id', session.user_id!)
      .maybeSingle();
    if (!ownedOrder) {
      await sendText(from, getFlowCopy(l, 'orders.not_found'));
      return;
    }
    session.session_data.selected_order_id = orderId;
    session.current_step = 'order_detail';
    const { data: casOrderResult, error: casOrderError } = await supabase.rpc('update_session_cas', {
      p_session_id: session.id,
      p_expected_version: session.version ?? 0,
      p_current_step: 'order_detail',
      p_session_data: session.session_data,
    });
    if (casOrderError) {
      logger.error('[MY_ORDERS] order-selection CAS RPC error:', casOrderError.message);
      throw casOrderError;
    }
    if (!casOrderResult?.success) {
      if (casOrderResult?.reason === 'version_conflict') return;
      logger.error('[MY_ORDERS] order-selection CAS unexpected:', casOrderResult?.reason);
      throw new Error(`CAS failure: ${casOrderResult?.reason || 'unknown'}`);
    }
    session.version = casOrderResult.version;
    await handleOrderDetail(supabase, messageSender, sendText, session, from, orderId, l);
    return;
  }

  // Handle "track_my_order" postback from ordering flow
  if (input === 'track_my_order') {
    await handleMyOrders(supabase, messageSender, sendText, routeToMyAccountMenu, session, from, '', l);
    return;
  }

  // Back to My Account menu
  if (input === 'back_to_account') {
    await routeToMyAccountMenu(session, from);
    return;
  }

  // Unrecognized input — re-show the orders list
  await handleMyOrders(supabase, messageSender, sendText, routeToMyAccountMenu, session, from, '', l);
}

export async function handleOrderDetail(
  supabase: SupabaseClient,
  messageSender: MessageSender,
  sendText: (to: string, text: string) => Promise<void>,
  session: BotSession,
  from: string,
  orderId: string,
  lang?: string,
): Promise<void> {
  const l = lang || 'en';
  const { data: order } = await supabase
    .from('orders')
    .select('id, reference_code, status, total_amount, created_at, shipping_cost, delivery_address, tracking_number, shipping_carrier, updated_at, businesses (name, country_code)')
    .eq('id', orderId)
    .eq('user_id', session.user_id!)
    .single();

  if (!order) {
    await sendText(from, getFlowCopy(l, 'orders.not_found'));
    await supabase.rpc('deactivate_session_atomic', { p_session_id: session.id });
    return;
  }

  const biz = order.businesses as unknown as { name: string; country_code?: CountryCode } | null;
  const cc = (biz?.country_code as CountryCode) || 'NG';
  const { emoji, label } = formatOrderStatus(order.status, l);
  const dateLabel = new Date(order.created_at).toLocaleDateString('en-US', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });

  const progressBar = buildOrderProgressBar(order.status, l);

  const lines: string[] = [
    `📦 *Order #${order.reference_code}*`,
    `🏪 ${biz?.name || 'Business'}`,
    `📅 ${dateLabel}`,
    '',
    `Status: ${emoji} *${label}*`,
    '━━━━━━━━━━━━━━━━━',
    progressBar,
    '',
    `Total: ${formatCurrency(order.total_amount || 0, cc)}`,
  ];

  if (order.delivery_address) {
    lines.push(`📍 ${order.delivery_address}`);
  }

  // Show tracking info if available
  if (order.tracking_number || order.shipping_carrier) {
    lines.push('');
    lines.push(getFlowCopy(l, 'orders.tracking_header'));
    if (order.shipping_carrier) lines.push(`Carrier: ${order.shipping_carrier}`);
    if (order.tracking_number) lines.push(`Tracking #: ${order.tracking_number}`);
  }

  if (order.updated_at) {
    const updatedLabel = new Date(order.updated_at).toLocaleDateString('en-US', {
      day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    });
    lines.push(`\n_Last updated: ${updatedLabel}_`);
  }

  await sendText(from, lines.join('\n'));

  const buttons: Array<{ id: string; title: string }> = [];
  if (['pending', 'confirmed', 'processing', 'ready', 'shipped'].includes(order.status)) {
    buttons.push({ id: 'refresh_order', title: getFlowCopy(l, 'orders.refresh_status') });
  }
  buttons.push({ id: 'back_orders', title: getFlowCopy(l, 'orders.back_to_orders') });
  buttons.push({ id: 'back_to_account', title: getFlowCopy(l, 'account.title') });

  await messageSender.sendButtons({
    to: from,
    body: getFlowCopy(l, 'orders.what_to_do'),
    buttons,
  });
}

export async function handleOrderDetailAction(
  supabase: SupabaseClient,
  messageSender: MessageSender,
  sendText: (to: string, text: string) => Promise<void>,
  routeToMyAccountMenu: (session: BotSession, from: string) => Promise<void>,
  session: BotSession,
  from: string,
  input: string,
  lang?: string,
): Promise<void> {
  const l = lang || 'en';
  const orderId = session.session_data.selected_order_id as string;

  if (!orderId) {
    await sendText(from, getFlowCopy(l, 'orders.action_error'));
    await supabase.rpc('deactivate_session_atomic', { p_session_id: session.id });
    return;
  }

  const response = input.toLowerCase();

  if (response === 'cancel' || response === 'exit' || response === 'quit') {
    await sendText(from, getFlowCopy(l, 'orders.action_cancelled'));
    await supabase.rpc('deactivate_session_atomic', { p_session_id: session.id });
    return;
  }

  if (response === 'back_orders') {
    // Update both DB and in-memory session before calling handleMyOrders
    session.current_step = 'my_orders';
    await supabase.from('bot_sessions').update({ current_step: 'my_orders' }).eq('id', session.id);
    await handleMyOrders(supabase, messageSender, sendText, routeToMyAccountMenu, session, from, '', l);
    return;
  }

  if (response === 'back_to_account') {
    await routeToMyAccountMenu(session, from);
    return;
  }

  if (response === 'refresh_order') {
    await handleOrderDetail(supabase, messageSender, sendText, session, from, orderId, l);
    return;
  }

  await sendText(from, getFlowCopy(l, 'error.tap_option'));
}
