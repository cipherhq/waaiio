import type { SupabaseClient } from '@supabase/supabase-js';
import * as Sentry from '@sentry/nextjs';
import { formatCurrency, type CountryCode } from '@/lib/constants';
import { logger } from '@/lib/logger';
import { stripPlus } from '@/lib/utils/phone';
import { getCustomerName } from '@/lib/bot/flows/shared/user';
import { getCalendarLinksText } from '@/lib/calendar/generate-links';

interface PaymentForConfirmation {
  id: string;
  amount: number;
  booking_id: string | null;
  invoice_id: string | null;
  campaign_id: string | null;
  reservation_id?: string | null;
  order_id?: string | null;
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
  // Dedup: only the first caller sends confirmation.
  // Atomic: UPDATE ... WHERE confirmation_sent_at IS NULL — only one path can claim it.
  const { count } = await supabase
    .from('payments')
    .update({ confirmation_sent_at: new Date().toISOString() })
    .eq('id', payment.id)
    .is('confirmation_sent_at', null);

  if (!count || count === 0) {
    logger.info(`${logPrefix} Confirmation already sent for payment ${payment.id} — skipping`);
    return;
  }

  let customerPhone: string | null = null;
  let businessId: string | null = null;
  let businessName = 'Business';
  let serviceName = 'Payment';
  let referenceCode = '';
  let countryCode: CountryCode = 'US';
  let bookingDate: string | undefined;
  let bookingTime: string | undefined;
  let bookingAddress: string | undefined;
  let bookingDuration: number | undefined;

  // ── 1. Resolve customer + business from booking ──
  if (payment.booking_id) {
    const { data: booking } = await supabase
      .from('bookings')
      .select('guest_phone, reference_code, business_id, date, time, flow_type, businesses(name, country_code, address), services(name, duration)')
      .eq('id', payment.booking_id)
      .single();

    if (booking) {
      customerPhone = booking.guest_phone;
      businessId = booking.business_id;
      referenceCode = booking.reference_code || '';
      const biz = booking.businesses as unknown as { name: string; country_code?: string; address?: string } | null;
      const svc = booking.services as unknown as { name: string; duration?: number } | null;
      if (biz?.name) businessName = biz.name;
      if (biz?.country_code) countryCode = biz.country_code as CountryCode;
      if (svc?.name) serviceName = svc.name;
      // Store booking date/time for calendar links (only for scheduling/appointment bookings)
      if (booking.date && booking.time && booking.flow_type !== 'ordering') {
        bookingDate = booking.date;
        bookingTime = booking.time;
        bookingAddress = biz?.address || undefined;
        bookingDuration = svc?.duration || undefined;
      }
    }
  }

  // ── 1b. Try reservation ──
  if (!customerPhone && payment.reservation_id) {
    const { data: reservation } = await supabase
      .from('reservations')
      .select('guest_phone, reference_code, business_id, guest_name, check_in, check_out, businesses:business_id(name, country_code)')
      .eq('id', payment.reservation_id)
      .single();

    if (reservation) {
      customerPhone = reservation.guest_phone;
      businessId = reservation.business_id;
      referenceCode = reservation.reference_code || '';
      const biz = reservation.businesses as unknown as { name: string; country_code?: string } | null;
      if (biz?.name) businessName = biz.name;
      if (biz?.country_code) countryCode = biz.country_code as CountryCode;
      const checkIn = new Date(reservation.check_in + 'T00:00').toLocaleDateString('en-US', { day: 'numeric', month: 'short' });
      const checkOut = new Date(reservation.check_out + 'T00:00').toLocaleDateString('en-US', { day: 'numeric', month: 'short' });
      serviceName = `Reservation ${checkIn} - ${checkOut}`;
    }
  }

  // ── 2. Try invoice ──
  if (!customerPhone && payment.invoice_id) {
    const { data: invoice } = await supabase
      .from('invoices')
      .select('customer_phone, reference_code, description, business_id, businesses:business_id(name, country_code)')
      .eq('id', payment.invoice_id)
      .single();

    if (invoice) {
      customerPhone = invoice.customer_phone;
      businessId = invoice.business_id;
      referenceCode = invoice.reference_code || '';
      const biz = invoice.businesses as unknown as { name: string; country_code?: string } | null;
      if (biz?.name) businessName = biz.name;
      if (biz?.country_code) countryCode = biz.country_code as CountryCode;
      serviceName = invoice.description || `Invoice ${referenceCode}`;
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
        serviceName = `Order ${referenceCode}`;
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

  if (!businessId) {
    logger.warn(`${logPrefix} Proactive confirmation skipped — no business`);
    return;
  }

  // For web channel bookings, we may not have a phone but should still send email
  if (!customerPhone) {
    // Try to send email-only confirmation for web channel bookings
    let guestEmail: string | null = null;
    if (payment.booking_id) {
      const { data: emailBooking } = await supabase
        .from('bookings')
        .select('guest_email, channel')
        .eq('id', payment.booking_id)
        .single();
      guestEmail = emailBooking?.guest_email || null;
    }
    if (!guestEmail) {
      logger.warn(`${logPrefix} Proactive confirmation skipped — no phone or email`);
      return;
    }
    // We have email but no phone — send email-only below
    logger.info(`${logPrefix} No phone found, will attempt email-only confirmation to ${guestEmail}`);
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
    'Thank you for your payment! 🙏',
    '',
    'Type *receipt* to get your receipt',
    'Type *my bookings* to view your bookings',
  ].filter(Boolean);

  // Add calendar links for bookings with specific date+time (not orders, invoices, donations)
  if (bookingDate && bookingTime && referenceCode) {
    const calLinks = getCalendarLinksText({
      businessName,
      businessAddress: bookingAddress,
      serviceName,
      referenceCode,
      date: bookingDate,
      time: bookingTime,
      durationMinutes: bookingDuration || 60,
    });
    if (calLinks) {
      lines.push(calLinks);
    }
  }

  // Show "save card" tip only for Paystack + first payment or new card (not on every confirmation)
  let showSaveCardTip = false;
  if (businessId) {
    const { data: paymentGw } = await supabase.from('payments').select('gateway, metadata').eq('id', payment.id).single();
    if (paymentGw?.gateway === 'paystack' && customerPhone) {
      const phoneP = customerPhone.startsWith('+') ? customerPhone : `+${customerPhone}`;
      // Check if customer already has a saved card for this business
      const { data: existingSaved } = await supabase
        .from('saved_payment_methods')
        .select('id, card_last4')
        .eq('business_id', businessId)
        .eq('customer_phone', phoneP)
        .eq('is_active', true)
        .maybeSingle();

      if (!existingSaved) {
        // No saved card — check if this is their first payment or a new card
        const auth = (paymentGw.metadata as Record<string, unknown>)?._card_authorization as Record<string, unknown> | undefined;
        if (auth?.reusable) {
          showSaveCardTip = true;
        }
      }
    }
  }

  if (showSaveCardTip) {
    lines.push('');
    lines.push('💳 Type *save card* to save this card for faster checkout next time');
  }

  // ── 5. Resolve channel + send ──
  try {
    const { ChannelResolver } = await import('@/lib/channels/channel-resolver');
    const resolver = new ChannelResolver(supabase);

    // Prefer the channel the customer was chatting on
    // Check active, inactive, and ANY session for this phone (not just this business)
    let resolved = null;
    let inboundChId: string | undefined;

    // Only look up WhatsApp sessions if we have a customer phone
    if (customerPhone) {
      // 1. Try session for this phone + business (active or recently inactive)
      const { data: bizSession } = await supabase
        .from('bot_sessions').select('session_data')
        .eq('whatsapp_number', customerPhone).eq('business_id', businessId)
        .order('created_at', { ascending: false }).limit(1).maybeSingle();
      inboundChId = (bizSession?.session_data as Record<string, unknown>)?._inbound_channel_id as string | undefined;

      // 2. Fallback: any recent session for this phone (may be on a different business)
      if (!inboundChId) {
        const { data: anySession } = await supabase
          .from('bot_sessions').select('session_data')
          .eq('whatsapp_number', customerPhone)
          .not('session_data->_inbound_channel_id', 'is', null)
          .order('created_at', { ascending: false }).limit(1).maybeSingle();
        inboundChId = (anySession?.session_data as Record<string, unknown>)?._inbound_channel_id as string | undefined;
      }
    }

    if (inboundChId) resolved = await resolver.resolveByChannelId(inboundChId);
    if (!resolved) resolved = await resolver.resolveByBusinessId(businessId);

    // Send WhatsApp confirmation if channel is available and we have a phone
    if (resolved && customerPhone) {
      const phone = stripPlus(customerPhone);
      await resolved.sender.sendText({ to: phone, text: lines.join('\n') });
    } else {
      logger.info(`${logPrefix} No WhatsApp channel resolved — will attempt email-only confirmation`);
    }

    // ── 6. Post-completion (loyalty, feedback, referral, customer profile) ──
    if (customerPhone) {
      try {
        const { handlePostCompletion } = await import('@/lib/bot/flows/shared/post-completion');
        const customerName = await getCustomerName(supabase, customerPhone);
        await handlePostCompletion({
          supabase, businessId, customerPhone, customerName,
          serviceType: payment.booking_id ? 'booking' : 'order',
          referenceId: payment.booking_id || undefined,
          sender: resolved?.sender,
          amountPaid: payment.amount,
          serviceName, referenceCode,
        });
      } catch (pcErr) {
        logger.error(`${logPrefix} Post-completion error:`, pcErr);
        Sentry.captureException(pcErr, { tags: { component: 'send-confirmation', operation: 'post-completion' } });
      }
    }

    // ── 7. Owner notification ──
    try {
      if (payment.booking_id && resolved) {
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
      // Send email to business owner
      try {
        const { data: biz } = await supabase.from('businesses').select('owner_id').eq('id', businessId).single();
        if (biz?.owner_id) {
          const { data: ownerProfile } = await supabase.from('profiles').select('email').eq('id', biz.owner_id).single();
          if (ownerProfile?.email) {
            const { sendEmail } = await import('@/lib/email/client');
            const { paymentReceivedEmail } = await import('@/lib/email/templates');
            const emailContent = paymentReceivedEmail(businessName, formatCurrency(payment.amount, countryCode), serviceName);
            await sendEmail({ to: ownerProfile.email, ...emailContent });
          }
        }
      } catch (emailErr) {
        logger.error(`${logPrefix} Owner email error:`, emailErr);
      }
    } catch (notifyErr) {
      logger.error(`${logPrefix} Owner notification error:`, notifyErr);
    }

    // ── 8. Send tickets for ticketing bookings ──
    try {
      if (payment.booking_id) {
        const { data: ticketBooking } = await supabase
          .from('bookings')
          .select('flow_type, event_id, date, time, party_size, guest_name, guest_phone, guest_email, notes')
          .eq('id', payment.booking_id)
          .single();

        if (ticketBooking?.flow_type === 'ticketing' && ticketBooking.event_id) {
          const { data: event } = await supabase
            .from('events')
            .select('id, name, date, time, venue')
            .eq('id', ticketBooking.event_id)
            .single();

          const eventName = event?.name || ticketBooking.notes?.replace('Tickets for: ', '') || 'Event';
          const dateLabel = new Date((event?.date || ticketBooking.date) + 'T00:00').toLocaleDateString('en-US', {
            weekday: 'long', day: 'numeric', month: 'long',
          });

          const { sendTicketsAfterPurchase } = await import('@/lib/bot/flows/shared/send-tickets');
          await sendTicketsAfterPurchase({
            supabase,
            sender: resolved?.sender,  // undefined for web-only purchases (email-only delivery)
            businessId,
            bookingId: payment.booking_id,
            eventId: ticketBooking.event_id,
            eventName, eventDate: dateLabel,
            eventTime: event?.time || ticketBooking.time || undefined,
            venue: event?.venue || '',
            guestName: ticketBooking.guest_name || 'Guest',
            guestPhone: ticketBooking.guest_phone || customerPhone || '',
            guestEmail: ticketBooking.guest_email || undefined,
            referenceCode,
            quantity: ticketBooking.party_size || 1,
            amount: payment.amount, countryCode,
          });
        }
      }
    } catch (ticketErr) {
      logger.error(`${logPrefix} Ticket send error:`, ticketErr);
      Sentry.captureException(ticketErr, { tags: { component: 'send-confirmation', operation: 'ticket-send' } });
    }

    // ── 8b. Send email confirmation — always send if guest has email (WhatsApp + email) ──
    if (payment.booking_id) {
      try {
        const { data: emailBooking } = await supabase
          .from('bookings')
          .select('guest_email, guest_name, date, time, party_size')
          .eq('id', payment.booking_id)
          .single();
        const guestEmail = emailBooking?.guest_email || null;
        if (guestEmail) {
          const { sendEmail } = await import('@/lib/email/client');
          const { bookingConfirmationEmail } = await import('@/lib/email/templates');
          // Generate Google Calendar URL for the email button
          let googleCalUrl: string | undefined;
          if (emailBooking?.date && emailBooking?.time) {
            const { generateGoogleCalendarUrl, buildCalendarEvent } = await import('@/lib/calendar/generate-links');
            const calEvent = buildCalendarEvent({
              businessName,
              businessAddress: bookingAddress,
              serviceName,
              referenceCode,
              date: emailBooking.date,
              time: emailBooking.time,
              durationMinutes: bookingDuration || 60,
            });
            if (calEvent) {
              googleCalUrl = generateGoogleCalendarUrl(calEvent);
            }
          }
          const emailContent = bookingConfirmationEmail({
            firstName: emailBooking?.guest_name?.split(' ')[0] || 'there',
            businessName,
            date: emailBooking?.date || '',
            time: emailBooking?.time || '',
            quantity: emailBooking?.party_size || 1,
            referenceCode,
            amount: payment.amount,
            formattedAmount: formatCurrency(payment.amount, countryCode),
            quantityLabel: 'Guest(s)',
            confirmationEmoji: '✅',
            googleCalendarUrl: googleCalUrl,
          });
          await sendEmail({ to: guestEmail, ...emailContent });
          logger.info(`${logPrefix} Email confirmation sent to ${guestEmail}`);
        }
      } catch (emailErr) {
        logger.error(`${logPrefix} Email confirmation error:`, emailErr);
      }
    }

    // ── 9. Deactivate the payment-waiting session (webhook confirmed — user doesn't need to tap "I've Paid") ──
    if (customerPhone) {
      await supabase
        .from('bot_sessions')
        .update({ is_active: false, current_step: 'complete' })
        .eq('whatsapp_number', stripPlus(customerPhone))
        .eq('business_id', businessId)
        .eq('is_active', true)
        .in('current_step', ['payment', 'await_payment', 'await_ticket_payment', 'await_order_payment', 'create_booking']);
    }
  } catch (err) {
    logger.error(`${logPrefix} Send confirmation error:`, err);
    Sentry.captureException(err, { tags: { component: 'send-confirmation', operation: 'send-confirmation' } });
  }
}
