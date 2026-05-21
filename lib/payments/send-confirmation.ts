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
    'Thank you for your payment!',
    '',
    'Type *receipt* to get your receipt',
    'Type *my bookings* to view your bookings',
  ].filter(Boolean);

  // Show "save card" tip only for Paystack + first payment or new card (not on every confirmation)
  let showSaveCardTip = false;
  if (businessId) {
    const { data: paymentGw } = await supabase.from('payments').select('gateway, metadata').eq('id', payment.id).single();
    if (paymentGw?.gateway === 'paystack') {
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

    // ── 6. Post-completion (loyalty, feedback, referral) — requires WhatsApp sender ──
    if (resolved && customerPhone) {
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
          .select('flow_type, date, time, party_size, guest_name, guest_phone, guest_email, notes')
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
            supabase,
            sender: resolved?.sender,  // undefined for web-only purchases (email-only delivery)
            businessId,
            bookingId: payment.booking_id,
            eventId: event?.id || '',
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
    }

    // ── 8b. Send email confirmation for web channel bookings without WhatsApp ──
    if (!resolved || !customerPhone) {
      try {
        let guestEmail: string | null = null;
        let bookingDate = '';
        let bookingTime = '';
        let bookingQty = 1;
        let guestFirstName = 'there';
        if (payment.booking_id) {
          const { data: emailBooking } = await supabase
            .from('bookings')
            .select('guest_email, guest_name, date, time, party_size')
            .eq('id', payment.booking_id)
            .single();
          guestEmail = emailBooking?.guest_email || null;
          guestFirstName = emailBooking?.guest_name?.split(' ')[0] || 'there';
          bookingDate = emailBooking?.date || '';
          bookingTime = emailBooking?.time || '';
          bookingQty = emailBooking?.party_size || 1;
        }
        if (guestEmail) {
          const { sendEmail } = await import('@/lib/email/client');
          const { bookingConfirmationEmail } = await import('@/lib/email/templates');
          const emailContent = bookingConfirmationEmail({
            firstName: guestFirstName,
            businessName,
            date: bookingDate,
            time: bookingTime,
            quantity: bookingQty,
            referenceCode,
            amount: payment.amount,
            formattedAmount: formatCurrency(payment.amount, countryCode),
            quantityLabel: 'Guest(s)',
            confirmationEmoji: '✅',
          });
          await sendEmail({ to: guestEmail, ...emailContent });
          logger.info(`${logPrefix} Email-only confirmation sent to ${guestEmail}`);
        }
      } catch (emailErr) {
        logger.error(`${logPrefix} Web channel email confirmation error:`, emailErr);
      }
    }

    // ── 9. Reset session so user stays with this business (only for WhatsApp sessions) ──
    if (customerPhone) {
      await supabase
        .from('bot_sessions')
        .update({ current_step: 'select_capability', session_data: {}, is_active: true })
        .eq('whatsapp_number', customerPhone)
        .eq('business_id', businessId);
    }
  } catch (err) {
    logger.error(`${logPrefix} Send confirmation error:`, err);
  }
}
