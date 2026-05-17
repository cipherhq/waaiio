import type { SupabaseClient } from '@supabase/supabase-js';
import { formatCurrency, type CountryCode } from '@/lib/constants';
import { logger } from '@/lib/logger';
import { stripPlus } from '@/lib/utils/phone';
import { getCustomerName } from '@/lib/bot/flows/shared/user';

interface PaymentForConfirmation {
  id: string;
  amount: number;
  booking_id: string | null;
  invoice_id: string | null;
  campaign_id: string | null;
}

/**
 * Send proactive WhatsApp confirmation after a successful payment.
 * Shared across all 5 gateway webhooks + payment-success page.
 *
 * Handles:
 * 1. Find customer phone + business info from booking/invoice/order
 * 2. Resolve the WhatsApp channel (prefer inbound channel from session)
 * 3. Send confirmation message with emojis
 * 4. Run post-completion (loyalty, feedback, referral)
 * 5. Send tickets for ticketing bookings
 * 6. Reset session to select_capability (keep user with business)
 */
export async function sendProactiveConfirmation(
  supabase: SupabaseClient,
  payment: PaymentForConfirmation,
  logPrefix = '[WEBHOOK]',
): Promise<void> {
  let customerPhone: string | null = null;
  let businessId: string | null = null;
  let businessName = 'Business';
  let serviceName = 'Payment';
  let referenceCode = '';
  let countryCode: CountryCode = 'US';

  // ── 1. Resolve customer + business from booking ──
  if (payment.booking_id) {
    const { data: booking } = await supabase
      .from('bookings')
      .select('guest_phone, reference_code, business_id, businesses(name, country_code), services(name)')
      .eq('id', payment.booking_id)
      .single();

    if (booking) {
      customerPhone = booking.guest_phone;
      businessId = booking.business_id;
      referenceCode = booking.reference_code || '';
      const biz = booking.businesses as unknown as { name: string; country_code?: string } | null;
      const svc = booking.services as unknown as { name: string } | null;
      if (biz?.name) businessName = biz.name;
      if (biz?.country_code) countryCode = biz.country_code as CountryCode;
      if (svc?.name) serviceName = svc.name;
    }
  }

  // ── 2. Try invoice ──
  if (!customerPhone && payment.invoice_id) {
    const { data: invoice } = await supabase
      .from('invoices')
      .select('customer_phone, reference_code, business_id, businesses:business_id(name, country_code)')
      .eq('id', payment.invoice_id)
      .single();

    if (invoice) {
      customerPhone = invoice.customer_phone;
      businessId = invoice.business_id;
      referenceCode = invoice.reference_code || '';
      const biz = invoice.businesses as unknown as { name: string; country_code?: string } | null;
      if (biz?.name) businessName = biz.name;
      if (biz?.country_code) countryCode = biz.country_code as CountryCode;
      serviceName = 'Invoice';
    }
  }

  // ── 3. Fallback: orders via payment metadata ──
  if (!customerPhone) {
    const { data: paymentFull } = await supabase
      .from('payments')
      .select('user_id, metadata')
      .eq('id', payment.id)
      .single();

    const meta = (paymentFull?.metadata || {}) as Record<string, unknown>;
    if (meta.order_id) {
      const { data: order } = await supabase
        .from('orders')
        .select('delivery_phone, reference_code, business_id, businesses(name, country_code)')
        .eq('id', meta.order_id as string)
        .maybeSingle();
      if (order) {
        customerPhone = order.delivery_phone;
        businessId = order.business_id;
        referenceCode = order.reference_code || '';
        const biz = order.businesses as unknown as { name: string; country_code?: string } | null;
        if (biz?.name) businessName = biz.name;
        if (biz?.country_code) countryCode = biz.country_code as CountryCode;
        serviceName = 'Order';
      }
    }

    if (!customerPhone && paymentFull?.user_id) {
      const { data: profile } = await supabase
        .from('profiles')
        .select('phone')
        .eq('id', paymentFull.user_id)
        .single();
      customerPhone = profile?.phone || null;
    }
  }

  if (!customerPhone || !businessId) {
    logger.warn(`${logPrefix} Proactive confirmation skipped — no phone or business`);
    return;
  }

  logger.info(`${logPrefix} Sending proactive confirmation to ${customerPhone} for ${businessName}`);

  // ── 4. Build confirmation message ──
  const lines = [
    `✅ *Payment Confirmed!*`,
    '',
    `🏢 ${businessName}`,
    `📋 ${serviceName}`,
    `💰 Amount: ${formatCurrency(payment.amount, countryCode)}`,
    referenceCode ? `🔑 Ref: *${referenceCode}*` : '',
    '',
    'Thank you for your payment!',
    '',
    'Type *receipt* to get your receipt',
    'Type *my bookings* to view your bookings',
  ].filter(Boolean);

  // ── 5. Resolve channel + send ──
  try {
    const { ChannelResolver } = await import('@/lib/channels/channel-resolver');
    const resolver = new ChannelResolver(supabase);

    // Prefer the channel the customer was chatting on
    let resolved = null;
    const { data: activeSession } = await supabase
      .from('bot_sessions').select('session_data')
      .eq('whatsapp_number', customerPhone).eq('business_id', businessId).eq('is_active', true).maybeSingle();
    const inboundChId = (activeSession?.session_data as Record<string, unknown>)?._inbound_channel_id as string | undefined;
    if (inboundChId) resolved = await resolver.resolveByChannelId(inboundChId);
    if (!resolved) resolved = await resolver.resolveByBusinessId(businessId);
    if (!resolved) return;

    const phone = stripPlus(customerPhone);
    await resolved.sender.sendText({ to: phone, text: lines.join('\n') });

    // ── 6. Post-completion (loyalty, feedback, referral) ──
    try {
      const { handlePostCompletion } = await import('@/lib/bot/flows/shared/post-completion');
      const customerName = await getCustomerName(supabase, customerPhone);
      await handlePostCompletion({
        supabase, businessId, customerPhone, customerName,
        serviceType: payment.booking_id ? 'booking' : 'order',
        referenceId: payment.booking_id || undefined,
        sender: resolved.sender,
        amountPaid: payment.amount,
        serviceName, referenceCode,
      });
    } catch (pcErr) {
      logger.error(`${logPrefix} Post-completion error:`, pcErr);
    }

    // ── 7. Owner notification ──
    try {
      if (payment.booking_id) {
        const { notifyOwnerNewBooking } = await import('@/lib/bot/flows/shared/notify-owner');
        const { data: booking } = await supabase.from('bookings')
          .select('date, time, party_size, guest_name')
          .eq('id', payment.booking_id).single();

        if (booking) {
          await notifyOwnerNewBooking({
            supabase, sender: resolved.sender, businessId, businessName, countryCode,
            referenceCode, customerName: booking.guest_name || 'Customer',
            date: booking.date, time: booking.time,
            quantity: booking.party_size || 1, quantityLabel: 'guest(s)',
            amount: payment.amount,
          });
        }
      }
    } catch (notifyErr) {
      logger.error(`${logPrefix} Owner notification error:`, notifyErr);
    }

    // ── 8. Send tickets for ticketing bookings ──
    try {
      if (payment.booking_id) {
        const { data: ticketBooking } = await supabase
          .from('bookings')
          .select('flow_type, date, time, party_size, guest_name, guest_phone, notes')
          .eq('id', payment.booking_id)
          .single();

        if (ticketBooking?.flow_type === 'ticketing') {
          const { data: event } = await supabase
            .from('events')
            .select('id, name, date, time, venue')
            .eq('business_id', businessId)
            .eq('date', ticketBooking.date)
            .limit(1)
            .maybeSingle();

          const eventName = event?.name || ticketBooking.notes?.replace('Tickets for: ', '') || 'Event';
          const dateLabel = new Date(ticketBooking.date + 'T00:00').toLocaleDateString('en-US', {
            weekday: 'long', day: 'numeric', month: 'long',
          });

          const { sendTicketsAfterPurchase } = await import('@/lib/bot/flows/shared/send-tickets');
          await sendTicketsAfterPurchase({
            supabase, sender: resolved.sender, businessId,
            bookingId: payment.booking_id,
            eventId: event?.id || '',
            eventName, eventDate: dateLabel,
            eventTime: event?.time || ticketBooking.time || undefined,
            venue: event?.venue || '',
            guestName: ticketBooking.guest_name || 'Guest',
            guestPhone: ticketBooking.guest_phone || customerPhone,
            referenceCode,
            quantity: ticketBooking.party_size || 1,
            amount: payment.amount, countryCode,
          });
        }
      }
    } catch (ticketErr) {
      logger.error(`${logPrefix} Ticket send error:`, ticketErr);
    }

    // ── 9. Reset session so user stays with this business ──
    await supabase
      .from('bot_sessions')
      .update({ current_step: 'select_capability', session_data: {}, is_active: true })
      .eq('whatsapp_number', customerPhone)
      .eq('business_id', businessId);
  } catch (err) {
    logger.error(`${logPrefix} Send confirmation error:`, err);
  }
}
