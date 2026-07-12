import type { SupabaseClient } from '@supabase/supabase-js';
import type { MessageSender } from '@/lib/channels/message-sender';
import type { BotSession } from '../bot-types';
import { logger } from '@/lib/logger';
import { sanitizeFilterValue } from '@/lib/utils/sanitize';
import { formatCurrency, type CountryCode } from '@/lib/constants';
import { createNotification } from '../flows/shared/notifications';
import { notifyOwnerGeneric } from '../flows/shared/notify-owner';
import { getPoweredByHtml } from '@/lib/whitelabel';

/**
 * Handle the refund request flow inline (no full flow executor needed).
 * Steps:
 *   refund_select — show recent payments, wait for selection
 *   refund_reason — ask for reason, then insert request
 */
export async function handleRefundRequest(
  supabase: SupabaseClient,
  messageSender: MessageSender,
  sendText: (to: string, text: string) => Promise<void>,
  session: BotSession,
  from: string,
  input: string,
): Promise<void> {
  const step = session.current_step;

  if (step === 'refund_select') {
    await handleRefundSelect(supabase, messageSender, sendText, session, from, input);
  } else if (step === 'refund_reason') {
    await handleRefundReason(supabase, messageSender, sendText, session, from, input);
  }
}

/**
 * Entry point: look up recent payments and show list.
 * Called when user first triggers "refund" keyword (input is empty).
 * Also called when user selects a payment from the list.
 */
async function handleRefundSelect(
  supabase: SupabaseClient,
  messageSender: MessageSender,
  sendText: (to: string, text: string) => Promise<void>,
  session: BotSession,
  from: string,
  input: string,
): Promise<void> {
  const phoneP = from.startsWith('+') ? from : `+${from}`;
  const phoneN = from.startsWith('+') ? from.slice(1) : from;

  // If input is empty, show the list of recent payments
  if (!input) {
    // Query payments via bookings that match the customer phone
    const { data: payments } = await supabase
      .from('payments')
      .select(`
        id, amount, currency, status, refund_amount, created_at, business_id, booking_id, order_id, invoice_id,
        bookings:booking_id (guest_phone, guest_name, service_id, event_id, services:service_id (name), events:event_id (name, refund_policy))
      `)
      .eq('status', 'success')
      .order('created_at', { ascending: false })
      .limit(20);

    if (!payments || payments.length === 0) {
      await sendText(from, "You don't have any recent payments eligible for refund.");
      await supabase.from('bot_sessions').update({ is_active: false }).eq('id', session.id);
      return;
    }

    // Filter to only payments where the booking guest_phone matches
    const eligible = payments.filter((p) => {
      const booking = p.bookings as unknown as {
        guest_phone?: string;
        guest_name?: string;
        service_id?: string;
        event_id?: string;
        services?: { name: string } | null;
        events?: { name: string; refund_policy?: string } | null;
      } | null;
      if (!booking?.guest_phone) return false;
      const bp = booking.guest_phone.replace(/\D/g, '');
      const pp = phoneP.replace(/\D/g, '');
      const pn = phoneN.replace(/\D/g, '');
      if (bp !== pp && bp !== pn) return false;

      // Skip if event has no_refund policy
      if (booking.events?.refund_policy === 'no_refund') return false;

      // Skip if already fully refunded
      const refunded = Number(p.refund_amount) || 0;
      if (refunded >= p.amount) return false;

      return true;
    }).slice(0, 5);

    if (eligible.length === 0) {
      await sendText(from, "You don't have any recent payments eligible for refund.");
      await supabase.from('bot_sessions').update({ is_active: false }).eq('id', session.id);
      return;
    }

    // Store eligible payment IDs in session data for validation
    const paymentMap: Record<string, { id: string; amount: number; currency: string; refundAmount: number; businessId: string; bookingId: string | null }> = {};
    const items: { title: string; description: string; postbackText: string }[] = [];

    for (let i = 0; i < eligible.length; i++) {
      const p = eligible[i];
      const booking = p.bookings as unknown as {
        guest_name?: string;
        services?: { name: string } | null;
        events?: { name: string } | null;
      } | null;
      const serviceName = booking?.events?.name || booking?.services?.name || 'Payment';
      const refundable = p.amount - (Number(p.refund_amount) || 0);
      const dateStr = new Date(p.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      const currency = (p.currency || 'NGN') as CountryCode;
      // formatCurrency expects amount in major units for display
      const amountDisplay = formatCurrency(refundable / 100, currency);

      const key = `refund_${i + 1}`;
      paymentMap[key] = {
        id: p.id,
        amount: refundable,
        currency: p.currency || 'NGN',
        refundAmount: Number(p.refund_amount) || 0,
        businessId: p.business_id,
        bookingId: p.booking_id || null,
      };

      items.push({
        title: serviceName.slice(0, 24),
        description: `${amountDisplay} • ${dateStr}`.slice(0, 72),
        postbackText: key,
      });
    }

    // Save payment map to session
    await supabase.from('bot_sessions').update({
      session_data: { ...session.session_data, refund_payments: paymentMap },
    }).eq('id', session.id);

    if (items.length === 1) {
      // Use buttons for single item
      await messageSender.sendButtons({
        to: from,
        body: 'Which payment would you like to request a refund for?',
        buttons: [{ id: 'refund_1', title: items[0].title }],
      });
    } else {
      await messageSender.sendList({
        to: from,
        title: 'Refund Request',
        body: 'Select the payment you want to request a refund for:',
        buttonLabel: 'View Payments',
        items,
      });
    }
    return;
  }

  // User selected a payment — validate and move to reason step
  const paymentMap = session.session_data.refund_payments as Record<string, { id: string; amount: number; currency: string; refundAmount: number; businessId: string; bookingId: string | null }> | undefined;
  if (!paymentMap || !paymentMap[input]) {
    await sendText(from, "I didn't recognize that selection. Please choose from the list above, or type *cancel* to exit.");
    return;
  }

  const selected = paymentMap[input];

  // Store selected payment and move to reason step
  await supabase.from('bot_sessions').update({
    current_step: 'refund_reason',
    session_data: {
      ...session.session_data,
      refund_selected: selected,
    },
  }).eq('id', session.id);

  await sendText(from, 'Please tell us the reason for your refund request:');
}

/**
 * Collect the reason and submit the refund request.
 */
async function handleRefundReason(
  supabase: SupabaseClient,
  messageSender: MessageSender,
  sendText: (to: string, text: string) => Promise<void>,
  session: BotSession,
  from: string,
  input: string,
): Promise<void> {
  if (!input || input.trim().length < 3) {
    await sendText(from, 'Please provide a reason for your refund request (at least a few words):');
    return;
  }

  const selected = session.session_data.refund_selected as {
    id: string;
    amount: number;
    currency: string;
    refundAmount: number;
    businessId: string;
    bookingId: string | null;
  } | undefined;

  if (!selected) {
    await sendText(from, 'Something went wrong. Please type *refund* to start over.');
    await supabase.from('bot_sessions').update({ is_active: false }).eq('id', session.id);
    return;
  }

  const reason = input.trim().slice(0, 500);
  const phoneP = from.startsWith('+') ? from : `+${from}`;
  const phoneN = from.startsWith('+') ? from.slice(1) : from;

  // Get customer name from booking
  let customerName: string | null = null;
  if (selected.bookingId) {
    const { data: booking } = await supabase
      .from('bookings')
      .select('guest_name')
      .eq('id', selected.bookingId)
      .maybeSingle();
    customerName = booking?.guest_name || null;
  }
  if (!customerName) {
    const { data: profile } = await supabase
      .from('profiles')
      .select('first_name, last_name')
      .or(`phone.eq.${sanitizeFilterValue(phoneP)},phone.eq.${sanitizeFilterValue(phoneN)}`)
      .limit(1)
      .maybeSingle();
    if (profile?.first_name) {
      customerName = `${profile.first_name}${profile.last_name ? ' ' + profile.last_name : ''}`;
    }
  }

  // Check for duplicate request (same payment_id, pending)
  const { data: existing } = await supabase
    .from('refund_requests')
    .select('id')
    .eq('payment_id', selected.id)
    .eq('status', 'pending')
    .limit(1)
    .maybeSingle();

  if (existing) {
    await sendText(from, 'You already have a pending refund request for this payment. The business will review it shortly.');
    await supabase.from('bot_sessions').update({ is_active: false }).eq('id', session.id);
    return;
  }

  // Insert refund request
  const { error: insertError } = await supabase.from('refund_requests').insert({
    business_id: selected.businessId,
    payment_id: selected.id,
    booking_id: selected.bookingId,
    customer_phone: phoneP,
    customer_name: customerName,
    amount: selected.amount,
    reason,
    status: 'pending',
  });

  if (insertError) {
    logger.error('[REFUND-REQUEST] Failed to insert refund request:', insertError);
    await sendText(from, 'Something went wrong on our end. Please try again later.');
    await supabase.from('bot_sessions').update({ is_active: false }).eq('id', session.id);
    return;
  }

  // Create notification for business owner
  await createNotification(supabase, {
    businessId: selected.businessId,
    bookingId: selected.bookingId || undefined,
    recipientPhone: phoneP,
    type: 'refund_request',
    channel: 'system',
    subject: 'New Refund Request',
    body: `${customerName || phoneP} has requested a refund of ${formatCurrency(selected.amount / 100, selected.currency as CountryCode)}.`,
    metadata: { payment_id: selected.id, reason },
  });

  // Notify business owner via email/WhatsApp
  notifyOwnerGeneric({
    supabase,
    sender: messageSender,
    businessId: selected.businessId,
    subject: 'New Refund Request',
    emailHtml: `<p><strong>${customerName || phoneP}</strong> has requested a refund of ${formatCurrency(selected.amount / 100, selected.currency as CountryCode)}.</p><p><strong>Reason:</strong> ${reason}</p><p>Review this request in your dashboard.</p>${getPoweredByHtml(null)}`,
    whatsappText: `💰 *New Refund Request*\n\nFrom: ${customerName || phoneP}\nAmount: ${formatCurrency(selected.amount / 100, selected.currency as CountryCode)}\nReason: ${reason}\n\nReview in your dashboard.`,
  }).catch(err => logger.error('[REFUND-REQUEST] Failed to notify owner:', err));

  // Confirm to customer
  await sendText(from, 'Your refund request has been submitted. The business will review it shortly.');

  // Deactivate session
  await supabase.from('bot_sessions').update({ is_active: false }).eq('id', session.id);
}
