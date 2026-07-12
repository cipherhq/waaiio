import type { SupabaseClient } from '@supabase/supabase-js';
import type { MessageSender } from '@/lib/channels/message-sender';
import type { FlowExecutor } from '../flows/executor';
import { logger } from '@/lib/logger';
import { getEnabledCapabilities } from '@/lib/capabilities/service';
import { sanitizeFilterValue } from '@/lib/utils/sanitize';
import type { BotSession, BusinessRecord } from '../bot-types';
import { handleMyOrders, handleOrderDetail } from './my-orders';
import { handleMyBookings } from './my-bookings';
import { handleTransactionDocument } from './transaction-docs';
import { handleSaveCard, handleRemoveCard } from './saved-cards';
import { routeToMyAccountMenu } from './my-account-menu';

// ── Intent detection regex functions ────────────────────────

export function isOrdersQuery(text: string): boolean {
  return /^my\s+orders?$/i.test(text)
    || /^(check|view|show|list|see)\s+(my\s+)?orders?$/i.test(text)
    || /^(order\s+status|track\s+(my\s+)?order|where'?s?\s+(is\s+)?(my\s+)?order|delivery\s+status|order\s+history)$/i.test(text)
    || /^track\s+my\s+order$/i.test(text)
    || /^where\s+is\s+my\s+(order|delivery|package)$/i.test(text);
}

export function isReferenceCodeMatch(text: string): RegExpMatchArray | null {
  return text.match(/^([A-Z]{2,}-[A-Z]?\d{3,})$/i);
}

export function isBookingsQuery(text: string): boolean {
  return /^(my\s+)?(bookings?|reservations?|appointments?|appts?|sessions?|upcoming|schedule)$/i.test(text)
    || /^(check|view|show|list|see)\s+(my\s+)?(bookings?|reservations?|appointments?|appts?|schedule)$/i.test(text);
}

export function isRescheduleQuery(text: string): boolean {
  return /^(reschedule|change\s+(my\s+)?(time|date|appointment|booking)|move\s+(my\s+)?(appointment|booking))$/i.test(text);
}

export function isLocationQuery(text: string): boolean {
  return /^(where|location|address|directions?|how\s+to\s+get|find\s+you|map)$/i.test(text)
    || /^(where\s+(are|is)\s+(you|the|your))/i.test(text);
}

export function isHistoryQuery(text: string): boolean {
  return /^(my\s+)?(transaction\s*|payment\s*)?history$/i.test(text)
    || /^(show\s+)?(my\s+)?transaction\s*history$/i.test(text)
    || /^(all|past)\s+(transactions?|payments?)$/i.test(text);
}

export function isReceiptQuery(text: string): boolean {
  return /^(my\s+)?receipt$/i.test(text)
    || /^(last|latest|recent)\s+(receipt|transaction|payment)$/i.test(text)
    || /^send\s+(my\s+)?receipt$/i.test(text);
}

export function isAnnualQuery(text: string): boolean {
  return /annual\s+statement/i.test(text)
    || /yearly\s+summary/i.test(text)
    || /tax\s+receipt/i.test(text)
    || /donation\s+(receipt|summary)/i.test(text)
    || /year[\s-]*end\s+statement/i.test(text)
    || /yearly\s+statement/i.test(text);
}

export function isSubscriptionsQuery(text: string): boolean {
  return /^(my\s+)?subscriptions?$/i.test(text)
    || /^(my\s+)?recurring(\s+payments?)?$/i.test(text)
    || /^(manage|view|show|check)\s+(my\s+)?(subscriptions?|recurring)$/i.test(text);
}

export function isLoyaltyQuery(text: string): boolean {
  return /^(my\s+)?(loyalty|points|rewards?|stars?)$/i.test(text)
    || /^(check|view|show)\s+(my\s+)?(loyalty|points|rewards?|balance)$/i.test(text);
}

export function isInvoiceQuery(text: string): boolean {
  return /^(my\s+)?(invoices?|bills?)$/i.test(text)
    || /^(check|view|show|pay)\s+(my\s+)?(invoices?|bills?)$/i.test(text);
}

export function isGivingQuery(text: string): boolean {
  return /^(my\s+)?(giving|donations?|tithes?|offerings?)(\s+history)?$/i.test(text)
    || /^(check|view|show)\s+(my\s+)?(giving|donations?|tithes?|offerings?)$/i.test(text)
    || /^(giving|donation)\s+history$/i.test(text);
}

export function isContractQuery(text: string): boolean {
  return /^(my\s+)?(contracts?|signatures?|documents?\s+to\s+sign)$/i.test(text)
    || /^(check|view|show)\s+(my\s+)?(contracts?|signatures?)$/i.test(text);
}

export function isQuoteQuery(text: string): boolean {
  return /^(my\s+)?(quotes?|price\s+requests?)$/i.test(text)
    || /^(check|view|show)\s+(my\s+)?(quotes?|price\s+requests?)$/i.test(text);
}

export function isMyAccountQuery(text: string): boolean {
  return /^(my\s+)?account$/i.test(text)
    || /^(manage|my\s+stuff)$/i.test(text);
}

export function isQueueQuery(text: string): boolean {
  return /^(join\s+)?queue$/i.test(text)
    || /^check\s*in$/i.test(text)
    || /^(join|enter)\s+(the\s+)?(queue|line|waiting\s*list)$/i.test(text);
}

export function isSaveCardQuery(text: string): boolean {
  return /^save\s+card$/i.test(text) || /^save\s+my\s+card$/i.test(text);
}

export function isRemoveCardQuery(text: string): boolean {
  return /^remove\s+card$/i.test(text) || /^delete\s+card$/i.test(text) || /^remove\s+my\s+card$/i.test(text);
}

export function isReorderQuery(text: string): boolean {
  return /^(reorder|re-order|same\s+again|order\s+(the\s+)?same(\s+thing)?|repeat\s+order|last\s+order)$/i.test(text);
}

// ── Main handler ────────────────────────────────────────────

interface GlobalQueryParams {
  supabase: SupabaseClient;
  messageSender: MessageSender;
  flowExecutor: FlowExecutor;
  sendText: (to: string, text: string) => Promise<void>;
  from: string;
  session: BotSession | null;
  text: string;
  messageType: string;
  destinationPhone?: string;
  getProfile: () => Promise<{ id: string } | null>;
  handleMessage: (from: string, text: string, messageType: string, destinationPhone?: string, preResolvedBusinessId?: string) => Promise<void>;
}

/**
 * Handle all "my X" global query intents.
 * Returns { handled: true, session } if a query was handled, { handled: false } otherwise.
 * The returned session may be updated (e.g. newly created) for callers that need it.
 */
export async function handleGlobalQuery(params: GlobalQueryParams): Promise<{ handled: boolean; session: BotSession | null }> {
  const { supabase, messageSender, flowExecutor, sendText, from, text, messageType, destinationPhone, getProfile, handleMessage } = params;
  let { session } = params;

  const phoneP = from.startsWith('+') ? from : `+${from}`;
  const phoneN = from.startsWith('+') ? from.slice(1) : from;

  // ── Location query — send business address/location ──
  if (isLocationQuery(text) && session?.business_id) {
    const { data: biz } = await supabase
      .from('businesses')
      .select('name, address, metadata')
      .eq('id', session.business_id)
      .single();
    if (biz?.address) {
      const meta = biz.metadata as Record<string, unknown> | null;
      const lat = meta?.latitude as number | undefined;
      const lng = meta?.longitude as number | undefined;
      if (lat && lng && messageSender.sendLocation) {
        try {
          await messageSender.sendLocation({ to: from, latitude: lat, longitude: lng, name: biz.name, address: biz.address });
        } catch (err) {
          logger.warn('[GLOBAL-QUERIES] Location send failed, falling back to text:', err);
          await sendText(from, `📍 *${biz.name}*\n${biz.address}`);
        }
      } else {
        await sendText(from, `📍 *${biz.name}*\n${biz.address}`);
      }
    } else {
      await sendText(from, 'Sorry, no address is available for this business.');
    }
    return { handled: true, session };
  }

  // ── My Orders / Order Tracking ──
  if (isOrdersQuery(text)) {
    if (session) {
      await supabase.from('bot_sessions').update({ is_active: false }).eq('id', session.id);
    }
    const profile = await getProfile();
    if (!profile?.id) {
      await sendText(from, "We don't have an account for this number yet. Send *Hi* to start over.");
      return { handled: true, session };
    }
    await supabase.from('bot_sessions')
      .delete()
      .eq('whatsapp_number', from)
      .is('business_id', null)
      .eq('is_active', false);
    const { data: newSession } = await supabase.from('bot_sessions').insert({
      whatsapp_number: from, user_id: profile.id, business_id: null,
      current_step: 'my_orders', session_data: {}, is_active: true,
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    }).select().single();
    if (!newSession) { await sendText(from, 'Something went wrong. Try again.'); return { handled: true, session }; }
    session = newSession as BotSession;
    const routeToAccount = (s: BotSession, f: string) => routeToMyAccountMenu(supabase, flowExecutor, s, f);
    await handleMyOrders(supabase, messageSender, sendText, routeToAccount, session, from, '');
    return { handled: true, session };
  }

  // ── Reference code lookup (e.g. BW-O1234) ──
  const referenceCodeMatch = isReferenceCodeMatch(text);
  if (referenceCodeMatch && !session?.business_id) {
    const refCode = referenceCodeMatch[1].toUpperCase();
    const profile = await getProfile();
    if (profile?.id) {
      const { data: order } = await supabase
        .from('orders')
        .select('id, reference_code, status, total_amount, created_at, businesses (name, country_code)')
        .eq('reference_code', refCode)
        .eq('user_id', profile.id)
        .maybeSingle();
      if (order) {
        if (session) {
          await supabase.from('bot_sessions').update({ is_active: false }).eq('id', session.id);
        }
        await supabase.from('bot_sessions')
          .delete()
          .eq('whatsapp_number', from)
          .is('business_id', null)
          .eq('is_active', false);
        const { data: newSession } = await supabase.from('bot_sessions').insert({
          whatsapp_number: from, user_id: profile.id, business_id: null,
          current_step: 'order_detail', session_data: { selected_order_id: order.id }, is_active: true,
          expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        }).select().single();
        if (newSession) {
          await handleOrderDetail(supabase, messageSender, sendText, newSession as BotSession, from, order.id);
          return { handled: true, session: newSession as BotSession };
        }
      }
      // Try bookings
      const { data: booking } = await supabase
        .from('bookings')
        .select('id')
        .eq('reference_code', refCode)
        .eq('user_id', profile.id)
        .maybeSingle();
      if (booking) {
        if (session) {
          await supabase.from('bot_sessions').update({ is_active: false }).eq('id', session.id);
        }
        await supabase.from('bot_sessions')
          .delete()
          .eq('whatsapp_number', from)
          .is('business_id', null)
          .eq('is_active', false);
        const { data: newSession } = await supabase.from('bot_sessions').insert({
          whatsapp_number: from, user_id: profile.id, business_id: null,
          current_step: 'my_bookings', session_data: { selected_booking_id: booking.id }, is_active: true,
          expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        }).select().single();
        if (newSession) {
          session = newSession as BotSession;
          await handleMyBookings(supabase, messageSender, sendText, flowExecutor, session, from, `booking_${booking.id}`);
          return { handled: true, session };
        }
      }
      // Not found — fall through to normal flow (don't interrupt)
    }
  }

  // ── My Bookings / Reschedule ──
  if (isBookingsQuery(text) || isRescheduleQuery(text)) {
    if (session) {
      await supabase.from('bot_sessions').update({ is_active: false }).eq('id', session.id);
    }
    const profile = await getProfile();
    if (!profile?.id) {
      await sendText(from, "We don't have an account for this number yet. Send *Hi* to start over.");
      return { handled: true, session };
    }
    await supabase.from('bot_sessions')
      .delete()
      .eq('whatsapp_number', from)
      .is('business_id', null)
      .eq('is_active', false);
    const { data: newSession } = await supabase.from('bot_sessions').insert({
      whatsapp_number: from, user_id: profile.id, business_id: null,
      current_step: 'my_bookings', session_data: {}, is_active: true,
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    }).select().single();
    if (!newSession) { await sendText(from, 'Something went wrong. Try again.'); return { handled: true, session }; }
    session = newSession as BotSession;
    await handleMyBookings(supabase, messageSender, sendText, flowExecutor, session, from, '');
    return { handled: true, session };
  }

  // ── History / Receipt ──
  if (isHistoryQuery(text) || isReceiptQuery(text)) {
    if (session) {
      await supabase.from('bot_sessions').update({ is_active: false }).eq('id', session.id);
    }
    const profile = await getProfile();
    if (!profile?.id) {
      await sendText(from, "We don't have an account for this number yet. Send *Hi* to start over.");
      return { handled: true, session };
    }
    await handleTransactionDocument(supabase, messageSender, sendText, from, profile.id, isHistoryQuery(text) ? 'history' : 'receipt');
    return { handled: true, session };
  }

  // ── Annual Statement ──
  if (isAnnualQuery(text)) {
    if (session) {
      await supabase.from('bot_sessions').update({ is_active: false }).eq('id', session.id);
    }
    const profile = await getProfile();
    if (!profile?.id) {
      await sendText(from, "We don't have an account for this number yet. Send *Hi* to start over.");
      return { handled: true, session };
    }
    await handleTransactionDocument(supabase, messageSender, sendText, from, profile.id, 'annual');
    return { handled: true, session };
  }

  // ── Save Card (consent-based) ──
  if (isSaveCardQuery(text)) {
    await handleSaveCard(supabase, sendText, from, session, getProfile);
    return { handled: true, session };
  }

  // ── Remove Card ──
  if (isRemoveCardQuery(text)) {
    await handleRemoveCard(supabase, sendText, from, session);
    return { handled: true, session };
  }

  // ── Reorder: repeat last order ──
  if (isReorderQuery(text) && session?.business_id) {
    // Find last completed order for this business
    const { data: lastOrder } = await supabase
      .from('orders')
      .select('id, reference_code, total_amount')
      .eq('business_id', session.business_id)
      .or(`delivery_phone.eq.${sanitizeFilterValue(phoneP)},delivery_phone.eq.${sanitizeFilterValue(phoneN)}`)
      .in('status', ['confirmed', 'delivered', 'ready'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!lastOrder) {
      await sendText(from, "No previous orders found for this business. Type *order* to browse the menu.");
      return { handled: true, session };
    }

    // Get order items
    const { data: items } = await supabase
      .from('order_items')
      .select('product_id, product_name, quantity, unit_price, variant_label')
      .eq('order_id', lastOrder.id);

    if (!items || items.length === 0) {
      await sendText(from, "Couldn't load your last order. Type *order* to browse the menu.");
      return { handled: true, session };
    }

    // Pre-fill cart with last order items
    const cart = items.map(i => ({
      product_id: i.product_id,
      name: i.product_name,
      price: i.unit_price,
      quantity: i.quantity,
      variant: null,
      variant_label: i.variant_label || null,
    }));

    const itemList = items.map(i => `• ${i.quantity}x ${i.product_name}${i.variant_label ? ` (${i.variant_label})` : ''}`).join('\n');

    // Start ordering flow with pre-filled cart
    await supabase.from('bot_sessions').update({ is_active: false }).eq('id', session.id);

    const { data: biz } = await supabase
      .from('businesses')
      .select('id, name, slug, category, flow_type, subscription_tier, trial_ends_at, metadata, operating_hours, country_code, payment_gateway')
      .eq('id', session.business_id)
      .single();

    const profile = await getProfile();
    const caps = await getEnabledCapabilities(supabase, session.business_id);

    const { data: newSession } = await supabase.from('bot_sessions').insert({
      whatsapp_number: from, user_id: profile?.id || null, business_id: session.business_id,
      current_step: 'continue_or_checkout',
      session_data: { active_capability: 'ordering', capabilities: caps, cart, _reorder: true },
      is_active: true,
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    }).select().single();

    if (!newSession) {
      await sendText(from, 'Something went wrong. Try again.');
      return { handled: true, session };
    }

    await sendText(from, `Reordering from your last order (${lastOrder.reference_code}):\n\n${itemList}\n\nReady to checkout?`);
    await flowExecutor.execute(from, '', newSession as unknown as BotSession, biz as BusinessRecord | null);
    return { handled: true, session: newSession as BotSession };
  }

  // ── Subscriptions ──
  if (isSubscriptionsQuery(text)) {
    const businessId = session?.business_id || null;
    if (session) {
      await supabase.from('bot_sessions').update({ is_active: false }).eq('id', session.id);
    }

    const profile = await getProfile();
    if (!profile?.id) {
      await sendText(from, "We don't have an account for this number yet. Send *Hi* to start over.");
      return { handled: true, session };
    }

    // If no business from session, find the most recent business they have subscriptions with
    let resolvedBusinessId = businessId;
    if (!resolvedBusinessId) {
      const { data: recentSub } = await supabase
        .from('customer_subscriptions')
        .select('business_id')
        .eq('customer_phone', phoneP)
        .in('status', ['active', 'paused', 'past_due'])
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      resolvedBusinessId = recentSub?.business_id || null;
    }

    if (!resolvedBusinessId) {
      await sendText(from, "You don't have any recurring payments set up. Send *Hi* to make a payment!");
      return { handled: true, session };
    }

    // Clean up old inactive sessions to avoid unique constraint
    await supabase.from('bot_sessions')
      .delete()
      .eq('whatsapp_number', from)
      .eq('is_active', false);

    const { data: newSession } = await supabase.from('bot_sessions').insert({
      whatsapp_number: from, user_id: profile.id, business_id: resolvedBusinessId,
      current_step: 'list_subscriptions', session_data: {}, is_active: true,
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    }).select().single();

    if (!newSession) { await sendText(from, 'Something went wrong. Try again.'); return { handled: true, session }; }

    const { data: biz } = await supabase
      .from('businesses')
      .select('id, name, slug, category, flow_type, subscription_tier, trial_ends_at, metadata, operating_hours, country_code, payment_gateway')
      .eq('id', resolvedBusinessId)
      .single();

    await flowExecutor.execute(from, '', newSession as unknown as BotSession, biz as BusinessRecord | null);
    return { handled: true, session: newSession as BotSession };
  }

  // ── Loyalty ──
  if (isLoyaltyQuery(text)) {
    if (session) {
      await supabase.from('bot_sessions').update({ is_active: false }).eq('id', session.id);
    }
    const profile = await getProfile();
    if (!profile?.id) {
      await sendText(from, "We don't have an account for this number yet. Send *Hi* to start over.");
      return { handled: true, session };
    }

    // Find most recent loyalty_points entry to get business_id
    const { data: loyaltyEntry } = await supabase
      .from('loyalty_points')
      .select('business_id')
      .or(`customer_phone.eq.${sanitizeFilterValue(phoneP)},customer_phone.eq.${sanitizeFilterValue(phoneN)}`)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    const resolvedBusinessId = session?.business_id || loyaltyEntry?.business_id || null;
    if (!resolvedBusinessId) {
      await sendText(from, "You don't have any loyalty points yet. Visit a business to start earning!");
      return { handled: true, session };
    }

    const caps = await getEnabledCapabilities(supabase, resolvedBusinessId);
    if (!caps.includes('loyalty')) {
      await sendText(from, "This business doesn't have a loyalty program. Send *Hi* to start over.");
      return { handled: true, session };
    }

    await supabase.from('bot_sessions').delete()
      .eq('whatsapp_number', from).eq('is_active', false);

    const { data: newSession } = await supabase.from('bot_sessions').insert({
      whatsapp_number: from, user_id: profile.id, business_id: resolvedBusinessId,
      current_step: 'loyalty_menu', session_data: { loyalty_business_id: resolvedBusinessId }, is_active: true,
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    }).select().single();

    if (!newSession) { await sendText(from, 'Something went wrong. Try again.'); return { handled: true, session }; }

    const { data: biz } = await supabase
      .from('businesses')
      .select('id, name, slug, category, flow_type, subscription_tier, trial_ends_at, metadata, operating_hours, country_code, payment_gateway')
      .eq('id', resolvedBusinessId)
      .single();

    await flowExecutor.execute(from, '', newSession as unknown as BotSession, biz as BusinessRecord | null);
    return { handled: true, session: newSession as BotSession };
  }

  // ── Invoices ──
  if (isInvoiceQuery(text)) {
    if (session) {
      await supabase.from('bot_sessions').update({ is_active: false }).eq('id', session.id);
    }
    const profile = await getProfile();
    if (!profile?.id) {
      await sendText(from, "We don't have an account for this number yet. Send *Hi* to start over.");
      return { handled: true, session };
    }

    // Find most recent unpaid invoice to get business_id
    const { data: invoiceEntry } = await supabase
      .from('invoices')
      .select('business_id')
      .or(`customer_phone.eq.${sanitizeFilterValue(phoneP)},customer_phone.eq.${sanitizeFilterValue(phoneN)}`)
      .in('status', ['sent', 'viewed', 'overdue'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    const resolvedBusinessId = session?.business_id || invoiceEntry?.business_id || null;
    if (!resolvedBusinessId) {
      await sendText(from, "You don't have any outstanding invoices.");
      return { handled: true, session };
    }

    await supabase.from('bot_sessions').delete()
      .eq('whatsapp_number', from).eq('is_active', false);

    const { data: newSession } = await supabase.from('bot_sessions').insert({
      whatsapp_number: from, user_id: profile.id, business_id: resolvedBusinessId,
      current_step: 'invoice_list', session_data: { invoice_business_id: resolvedBusinessId }, is_active: true,
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    }).select().single();

    if (!newSession) { await sendText(from, 'Something went wrong. Try again.'); return { handled: true, session }; }

    const { data: biz } = await supabase
      .from('businesses')
      .select('id, name, slug, category, flow_type, subscription_tier, trial_ends_at, metadata, operating_hours, country_code, payment_gateway')
      .eq('id', resolvedBusinessId)
      .single();

    await flowExecutor.execute(from, '', newSession as unknown as BotSession, biz as BusinessRecord | null);
    return { handled: true, session: newSession as BotSession };
  }

  // ── My Giving / Donation History ──
  if (isGivingQuery(text)) {
    const profile = await getProfile();
    if (!profile?.id) {
      await sendText(from, "We don't have an account for this number yet. Send *Hi* to start over.");
      return { handled: true, session };
    }

    // Fetch giving history: bookings linked to services with service_type='giving' + campaign donations
    const [{ data: givingBookings }, { data: donations }] = await Promise.all([
      supabase.from('bookings')
        .select('total_amount, created_at, services:service_id(name, service_type), businesses:business_id(name)')
        .or(`guest_phone.eq.${sanitizeFilterValue(phoneP)},guest_phone.eq.${sanitizeFilterValue(phoneN)}`)
        .eq('deposit_status', 'paid')
        .order('created_at', { ascending: false }).limit(100),
      supabase.from('campaign_donations')
        .select('amount, status, campaign_id, created_at, reference_code')
        .or(`donor_phone.eq.${sanitizeFilterValue(phoneP)},donor_phone.eq.${sanitizeFilterValue(phoneN)}`)
        .eq('status', 'success')
        .order('created_at', { ascending: false }).limit(10),
    ]);

    // Combine and show
    const allGiving: Array<{ amount: number; date: string; label: string; _ts: number }> = [];

    if (givingBookings) {
      for (const b of givingBookings) {
        const svc = b.services as unknown as { name: string; service_type?: string } | null;
        if (svc?.service_type !== 'giving') continue;
        const biz = b.businesses as unknown as { name: string } | null;
        allGiving.push({
          amount: Number(b.total_amount || 0),
          date: new Date(b.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
          label: svc.name || biz?.name || 'Offering',
          _ts: new Date(b.created_at).getTime(),
        });
      }
    }

    if (donations) {
      for (const d of donations) {
        allGiving.push({
          amount: Number(d.amount),
          date: new Date(d.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
          label: `Campaign (${d.reference_code})`,
          _ts: new Date(d.created_at).getTime(),
        });
      }
    }

    // Sort by date descending (using raw timestamp, not formatted string)
    allGiving.sort((a, b) => b._ts - a._ts);

    if (allGiving.length === 0) {
      await sendText(from, "You don't have any giving history yet. Send *Hi* to start over.");
      return { handled: true, session };
    }

    const total = allGiving.reduce((sum, g) => sum + g.amount, 0);
    const lines = [
      `🙏 *Your Giving History*`,
      '',
      ...allGiving.slice(0, 10).map(g =>
        `📅 ${g.date} — *${g.label}* — ${g.amount.toLocaleString()}`
      ),
      '',
      `💰 *Total Given: ${total.toLocaleString()}*`,
      `📊 ${allGiving.length} contribution${allGiving.length !== 1 ? 's' : ''}`,
      '',
      'Type *receipt* to get your giving receipt',
      'Type *Hi* to give again',
    ];
    await sendText(from, lines.join('\n'));
    return { handled: true, session };
  }

  // ── My Contracts / E-Signatures ──
  if (isContractQuery(text)) {
    // Query single-signer and multi-signer contracts in parallel (independent tables)
    const [{ data: singleContracts }, { data: multiSignerEntries }] = await Promise.all([
      supabase
        .from('contracts')
        .select('id, title, status, signed_at, created_at, token, signing_mode, businesses:business_id(name)')
        .or(`signer_phone.eq.${sanitizeFilterValue(phoneP)},signer_phone.eq.${sanitizeFilterValue(phoneN)}`)
        .order('created_at', { ascending: false })
        .limit(10),
      supabase
        .from('contract_signers')
        .select('id, token, status, signed_at, created_at, contracts:contract_id(id, title, signing_mode, businesses:business_id(name))')
        .or(`signer_phone.eq.${sanitizeFilterValue(phoneP)},signer_phone.eq.${sanitizeFilterValue(phoneN)}`)
        .order('created_at', { ascending: false })
        .limit(10),
    ]);

    // Normalize into a unified list
    const allContracts: Array<{
      title: string; status: string; signed_at: string | null;
      created_at: string; token: string; bizName: string;
    }> = [];

    if (singleContracts) {
      for (const c of singleContracts) {
        if (c.signing_mode !== 'single' && c.signing_mode !== null) continue;
        const biz = c.businesses as any;
        allContracts.push({
          title: c.title, status: c.status, signed_at: c.signed_at,
          created_at: c.created_at, token: c.token, bizName: biz?.name || 'Business',
        });
      }
    }

    if (multiSignerEntries) {
      for (const s of multiSignerEntries) {
        const contract = s.contracts as any;
        if (!contract) continue;
        const biz = contract.businesses as any;
        allContracts.push({
          title: contract.title, status: s.status, signed_at: s.signed_at,
          created_at: s.created_at, token: s.token, bizName: biz?.name || 'Business',
        });
      }
    }

    // Deduplicate by token
    const seen = new Set<string>();
    const unique = allContracts.filter(c => {
      if (seen.has(c.token)) return false;
      seen.add(c.token);
      return true;
    });

    if (unique.length === 0) {
      await sendText(from, "You don't have any contracts. Send *Hi* to start over.");
      return { handled: true, session };
    }

    const pending = unique.filter(c => c.status === 'pending' || c.status === 'waiting');
    const signed = unique.filter(c => c.status === 'signed');
    const other = unique.filter(c => c.status !== 'pending' && c.status !== 'waiting' && c.status !== 'signed');

    const cLines = ['📋 *Your Contracts*', ''];

    if (pending.length > 0) {
      cLines.push('⏳ *Pending Signature:*');
      for (const c of pending) {
        const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com';
        cLines.push(`• ${c.title} from ${c.bizName}`);
        cLines.push(`  Sign here: ${appUrl}/sign/${c.token}`);
      }
      cLines.push('');
    }

    if (signed.length > 0) {
      cLines.push('✅ *Signed:*');
      for (const c of signed) {
        const signedDate = c.signed_at ? new Date(c.signed_at).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
        cLines.push(`• ${c.title} from ${c.bizName} — signed ${signedDate}`);
      }
      cLines.push('');
    }

    if (other.length > 0) {
      const statusEmoji: Record<string, string> = { expired: '⌛', revoked: '🚫', declined: '❌' };
      for (const c of other) {
        const emoji = statusEmoji[c.status] || '📋';
        cLines.push(`${emoji} ${c.title} from ${c.bizName} — ${c.status}`);
      }
      cLines.push('');
    }

    cLines.push('💡 *What you can do:*');
    cLines.push('• Tap a signing link above to sign pending contracts');
    cLines.push('• Type *Hi* to start a new conversation');

    await sendText(from, cLines.join('\n'));
    return { handled: true, session };
  }

  // ── My Quotes / Price Requests ──
  if (isQuoteQuery(text)) {
    const { data: quotes } = await supabase
      .from('quote_requests')
      .select('id, status, estimated_subtotal, quoted_amount, created_at, businesses:business_id(name)')
      .or(`customer_phone.eq.${sanitizeFilterValue(phoneP)},customer_phone.eq.${sanitizeFilterValue(phoneN)}`)
      .order('created_at', { ascending: false })
      .limit(10);

    if (!quotes || quotes.length === 0) {
      await sendText(from, "You don't have any price requests. Send *Hi* to start over.");
      return { handled: true, session };
    }

    const statusEmoji: Record<string, string> = {
      pending: '⏳', quoted: '💰', accepted: '✅',
      rejected: '❌', expired: '⌛', cancelled: '🚫',
    };

    const qLines = ['📋 *Your Price Requests*', ''];

    for (const q of quotes) {
      const biz = q.businesses as any;
      const emoji = statusEmoji[q.status] || '📋';
      const date = new Date(q.created_at).toLocaleDateString('en-US', { day: 'numeric', month: 'short' });
      let detail = `${emoji} ${biz?.name || 'Business'} — ${date}`;
      if (q.status === 'quoted' && q.quoted_amount) {
        detail += ` — Quoted: ${q.quoted_amount.toLocaleString()}`;
      } else if (q.status === 'pending') {
        detail += ' — Awaiting response';
      } else {
        detail += ` — ${q.status}`;
      }
      qLines.push(detail);
    }

    qLines.push('');
    qLines.push('💡 *What you can do:*');
    qLines.push('• Type *Hi* to make a new request');

    await sendText(from, qLines.join('\n'));
    return { handled: true, session };
  }

  // ── My Account — global shortcut from any step ──
  if (isMyAccountQuery(text)) {
    if (session) {
      await supabase.from('bot_sessions').update({ is_active: false }).eq('id', session.id);
    }
    const profile = await getProfile();
    if (!profile?.id) {
      await sendText(from, "We don't have an account for this number yet. Send *Hi* to start over.");
      return { handled: true, session };
    }

    const resolvedBusinessId = session?.business_id || null;

    await supabase.from('bot_sessions').delete()
      .eq('whatsapp_number', from).eq('is_active', false);

    const { data: newSession } = await supabase.from('bot_sessions').insert({
      whatsapp_number: from, user_id: profile.id, business_id: resolvedBusinessId,
      current_step: 'my_account_menu', session_data: { active_capability: 'my_account' }, is_active: true,
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    }).select().single();

    if (!newSession) { await sendText(from, 'Something went wrong. Try again.'); return { handled: true, session }; }

    // Load business for flow context (may be null for cross-business account view)
    let biz = null;
    if (resolvedBusinessId) {
      const { data } = await supabase
        .from('businesses')
        .select('id, name, slug, category, flow_type, subscription_tier, trial_ends_at, metadata, operating_hours, country_code, payment_gateway')
        .eq('id', resolvedBusinessId)
        .single();
      biz = data;
    }

    await flowExecutor.execute(from, '', newSession as unknown as BotSession, biz as BusinessRecord | null);
    return { handled: true, session: newSession as BotSession };
  }

  // ── Queue check-in — global shortcut ──
  if (isQueueQuery(text) && session?.business_id) {
    const caps = await getEnabledCapabilities(supabase, session.business_id);
    if (caps.includes('queue')) {
      await supabase.from('bot_sessions').update({ is_active: false }).eq('id', session.id);
      const profile = await getProfile();

      await supabase.from('bot_sessions').delete()
        .eq('whatsapp_number', from).eq('is_active', false);

      const { data: newSession } = await supabase.from('bot_sessions').insert({
        whatsapp_number: from, user_id: profile?.id || null, business_id: session.business_id,
        current_step: 'queue_start', session_data: { active_capability: 'queue', capabilities: caps }, is_active: true,
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      }).select().single();

      if (newSession) {
        const { data: biz } = await supabase
          .from('businesses')
          .select('id, name, slug, category, flow_type, subscription_tier, trial_ends_at, metadata, operating_hours, country_code, payment_gateway')
          .eq('id', session.business_id).single();

        await flowExecutor.execute(from, '', newSession as unknown as BotSession, biz as BusinessRecord | null);
        return { handled: true, session: newSession as BotSession };
      }
    }
  }

  return { handled: false, session };
}
