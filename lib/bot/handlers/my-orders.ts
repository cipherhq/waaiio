import type { SupabaseClient } from '@supabase/supabase-js';
import type { MessageSender } from '@/lib/channels/message-sender';
import { formatCurrency, type CountryCode } from '@/lib/constants';
import { truncTitle } from '../utils/truncate';
import type { BotSession } from '../bot-types';

// ── Pure helpers ─────────────────────────────────────────

export function formatOrderStatus(status: string): { emoji: string; label: string } {
  const map: Record<string, { emoji: string; label: string }> = {
    pending: { emoji: '🕐', label: 'Pending' },
    confirmed: { emoji: '✅', label: 'Confirmed' },
    processing: { emoji: '🔄', label: 'Processing' },
    ready: { emoji: '📦', label: 'Ready for pickup' },
    shipped: { emoji: '🚚', label: 'Shipped' },
    delivered: { emoji: '✅', label: 'Delivered' },
    cancelled: { emoji: '❌', label: 'Cancelled' },
  };
  return map[status] || { emoji: '📋', label: status };
}

export function buildOrderProgressBar(status: string): string {
  const stages = ['confirmed', 'processing', 'ready', 'delivered'];
  const stageLabels: Record<string, string> = {
    confirmed: 'Confirmed',
    processing: 'Processing',
    ready: 'Ready for pickup',
    delivered: 'Delivered',
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
      marker = '  ← You are here';
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
): Promise<void> {
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
        body: "You don't have any active orders.",
        buttons: [{ id: 'back_to_account', title: '← Back' }],
      });
      return;
    }

    if (orders.length <= 2) {
      // Show as buttons (max 2 orders + back button = 3 total)
      const lines = orders.map((o) => {
        const b = o.businesses as unknown as { name: string; country_code?: CountryCode } | null;
        const occ = (b?.country_code as CountryCode) || 'NG';
        const { emoji: e, label } = formatOrderStatus(o.status);
        const dateLabel = new Date(o.created_at).toLocaleDateString('en-US', { day: 'numeric', month: 'short' });
        return `${e} *${o.reference_code}* — ${label}\n   ${b?.name || 'Order'} • ${dateLabel} • ${formatCurrency(o.total_amount || 0, occ)}`;
      });

      await sendText(from, `📦 *Your Orders*\n\n${lines.join('\n\n')}`);

      const buttons = orders.map((o) => ({
        id: `order_${o.id}`,
        title: truncTitle(`${o.reference_code}`),
      }));
      buttons.push({ id: 'back_to_account', title: '← Back' });

      await messageSender.sendButtons({
        to: from,
        body: 'Select an order to view details:',
        buttons,
      });
    } else {
      // Show as list with back option
      const items = orders.map((o) => {
        const b = o.businesses as unknown as { name: string; country_code?: CountryCode } | null;
        const occ = (b?.country_code as CountryCode) || 'NG';
        const { label } = formatOrderStatus(o.status);
        const dateLabel = new Date(o.created_at).toLocaleDateString('en-US', { day: 'numeric', month: 'short' });
        return {
          title: truncTitle(`${o.reference_code}`, 24),
          description: `${label} • ${b?.name || 'Order'} • ${formatCurrency(o.total_amount || 0, occ)}`.slice(0, 72),
          postbackText: `order_${o.id}`,
        };
      });
      items.push({ title: '← Back to My Account', description: 'Return to account menu', postbackText: 'back_to_account' });

      await messageSender.sendList({
        to: from,
        title: 'Your Orders',
        body: '📦 Select an order to view details:',
        buttonLabel: 'View Orders',
        items,
      });
    }
    return;
  }

  // Handle order selection
  if (input.startsWith('order_')) {
    const orderId = input.replace('order_', '');
    session.session_data.selected_order_id = orderId;
    session.current_step = 'order_detail';
    await supabase.from('bot_sessions').update({
      current_step: 'order_detail',
      session_data: session.session_data,
    }).eq('id', session.id);
    await handleOrderDetail(supabase, messageSender, sendText, session, from, orderId);
    return;
  }

  // Handle "track_my_order" postback from ordering flow
  if (input === 'track_my_order') {
    await handleMyOrders(supabase, messageSender, sendText, routeToMyAccountMenu, session, from, '');
    return;
  }

  // Back to My Account menu
  if (input === 'back_to_account') {
    await routeToMyAccountMenu(session, from);
    return;
  }

  // Unrecognized input — re-show the orders list
  await handleMyOrders(supabase, messageSender, sendText, routeToMyAccountMenu, session, from, '');
}

export async function handleOrderDetail(
  supabase: SupabaseClient,
  messageSender: MessageSender,
  sendText: (to: string, text: string) => Promise<void>,
  session: BotSession,
  from: string,
  orderId: string,
): Promise<void> {
  const { data: order } = await supabase
    .from('orders')
    .select('id, reference_code, status, total_amount, created_at, shipping_cost, delivery_address, tracking_number, shipping_carrier, updated_at, businesses (name, country_code)')
    .eq('id', orderId)
    .single();

  if (!order) {
    await sendText(from, 'Order not found. Type *my orders* to see your orders.');
    await supabase.from('bot_sessions').update({ is_active: false }).eq('id', session.id);
    return;
  }

  const biz = order.businesses as unknown as { name: string; country_code?: CountryCode } | null;
  const cc = (biz?.country_code as CountryCode) || 'NG';
  const { emoji, label } = formatOrderStatus(order.status);
  const dateLabel = new Date(order.created_at).toLocaleDateString('en-US', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });

  const progressBar = buildOrderProgressBar(order.status);

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
    lines.push('🚚 *Tracking Info*');
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
    buttons.push({ id: 'refresh_order', title: 'Refresh Status' });
  }
  buttons.push({ id: 'back_orders', title: 'Back to Orders' });
  buttons.push({ id: 'back_to_account', title: 'My Account' });

  await messageSender.sendButtons({
    to: from,
    body: 'What would you like to do?',
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
): Promise<void> {
  const orderId = session.session_data.selected_order_id as string;

  if (!orderId) {
    await sendText(from, 'Something went wrong. Type *my orders* to try again.');
    await supabase.from('bot_sessions').update({ is_active: false }).eq('id', session.id);
    return;
  }

  const response = input.toLowerCase();

  if (response === 'cancel' || response === 'exit' || response === 'quit') {
    await sendText(from, 'Action cancelled. Send *Hi* to start over. 🙏');
    await supabase.from('bot_sessions').update({ is_active: false }).eq('id', session.id);
    return;
  }

  if (response === 'back_orders') {
    // Update both DB and in-memory session before calling handleMyOrders
    session.current_step = 'my_orders';
    await supabase.from('bot_sessions').update({ current_step: 'my_orders' }).eq('id', session.id);
    await handleMyOrders(supabase, messageSender, sendText, routeToMyAccountMenu, session, from, '');
    return;
  }

  if (response === 'back_to_account') {
    await routeToMyAccountMenu(session, from);
    return;
  }

  if (response === 'refresh_order') {
    await handleOrderDetail(supabase, messageSender, sendText, session, from, orderId);
    return;
  }

  await sendText(from, 'Please tap one of the options above.');
}
