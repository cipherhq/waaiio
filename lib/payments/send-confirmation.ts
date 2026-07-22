import type { SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import * as Sentry from '@sentry/nextjs';
import { formatCurrency, type CountryCode } from '@/lib/constants';
import { logger } from '@/lib/logger';
import { stripPlus } from '@/lib/utils/phone';
import { getCustomerName } from '@/lib/bot/flows/shared/user';
import { getCalendarLinksText } from '@/lib/calendar/generate-links';
import { sanitizeFilterValue } from '@/lib/utils/sanitize';

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
  // Uses a two-phase claim: confirmation_claimed_at + confirmation_claim_token for lease,
  // confirmation_sent_at set AFTER successful delivery.
  // Stale-claim recovery: if a previous claim set confirmation_claimed_at but crashed before
  // setting confirmation_sent_at, the claim becomes stale after 5 minutes and can be re-claimed.
  const STALE_CLAIM_MS = 5 * 60 * 1000; // 5 minutes
  const claimToken = randomUUID();

  // Step 1: Atomic claim — set confirmation_claimed_at + token where not already claimed
  const { data: claimed, error: claimErr } = await supabase
    .from('payments')
    .update({
      confirmation_claimed_at: new Date().toISOString(),
      confirmation_claim_token: claimToken,
    })
    .eq('id', payment.id)
    .is('confirmation_claimed_at', null)
    .is('confirmation_sent_at', null)
    .select('id')
    .maybeSingle();

  if (claimErr) {
    logger.error(`${logPrefix} Confirmation claim DB error:`, claimErr.message);
    throw new Error(`Confirmation claim failed: ${claimErr.message}`);
  }

  if (!claimed) {
    // Check for stale claim or already sent
    const { data: existingPayment, error: readErr } = await supabase
      .from('payments')
      .select('confirmation_claimed_at, confirmation_sent_at')
      .eq('id', payment.id)
      .single();

    if (readErr) {
      throw new Error(`Confirmation read failed: ${readErr.message}`);
    }

    // Already fully sent
    if (existingPayment?.confirmation_sent_at) {
      logger.info(`${logPrefix} Confirmation already sent for payment ${payment.id}`);
      return;
    }

    // Stale claim recovery
    if (existingPayment?.confirmation_claimed_at) {
      const age = Date.now() - new Date(existingPayment.confirmation_claimed_at).getTime();
      if (age > STALE_CLAIM_MS) {
        logger.warn(`${logPrefix} Stale claim recovery for payment ${payment.id}`);
        // Atomic compare-and-swap: only reclaim if the token matches what we read
        const { data: reclaimed, error: reclaimErr } = await supabase
          .from('payments')
          .update({
            confirmation_claimed_at: new Date().toISOString(),
            confirmation_claim_token: claimToken,
          })
          .eq('id', payment.id)
          .eq('confirmation_claimed_at', existingPayment.confirmation_claimed_at)
          .is('confirmation_sent_at', null)
          .select('id')
          .maybeSingle();
        if (reclaimErr) {
          throw new Error(`Confirmation reclaim failed: ${reclaimErr.message}`);
        }
        if (!reclaimed) return; // Another worker beat us
      } else {
        return; // Another worker holds a fresh claim
      }
    } else {
      logger.info(`${logPrefix} Confirmation already sent for payment ${payment.id} — skipping`);
      return;
    }
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
  let balanceRemaining = 0;
  let balanceBookingId: string | null = null;
  let balanceReservationId: string | null = null;

  // ── 1. Resolve customer + business from booking ──
  if (payment.booking_id) {
    const { data: booking } = await supabase
      .from('bookings')
      .select('guest_phone, reference_code, business_id, date, time, flow_type, total_amount, deposit_amount, businesses(name, country_code, address, payment_gateway), services(name, duration)')
      .eq('id', payment.booking_id)
      .single();

    if (booking) {
      customerPhone = booking.guest_phone;
      businessId = booking.business_id;
      referenceCode = booking.reference_code || '';
      const biz = booking.businesses as unknown as { name: string; country_code?: string; address?: string; payment_gateway?: string } | null;
      const svc = booking.services as unknown as { name: string; duration?: number } | null;
      if (biz?.name) businessName = biz.name;
      if (biz?.country_code) countryCode = biz.country_code as CountryCode;
      if (svc?.name) serviceName = svc.name;
      if (booking.date && booking.time && booking.flow_type !== 'ordering') {
        bookingDate = booking.date;
        bookingTime = booking.time;
        bookingAddress = biz?.address || undefined;
        bookingDuration = svc?.duration || undefined;
      }
      // Check for remaining balance (deposit scenario)
      const total = Number(booking.total_amount || 0);
      const deposit = Number(booking.deposit_amount || 0);
      if (total > 0 && deposit > 0 && total > deposit) {
        balanceRemaining = total - deposit;
        balanceBookingId = payment.booking_id!;
      }
    }
  }

  // ── 1b. Try reservation ──
  if (!customerPhone && payment.reservation_id) {
    const { data: reservation } = await supabase
      .from('reservations')
      .select('guest_phone, reference_code, business_id, guest_name, check_in, check_out, total_amount, deposit_amount, businesses:business_id(name, country_code, payment_gateway)')
      .eq('id', payment.reservation_id)
      .single();

    if (reservation) {
      customerPhone = reservation.guest_phone;
      businessId = reservation.business_id;
      referenceCode = reservation.reference_code || '';
      const biz = reservation.businesses as unknown as { name: string; country_code?: string; payment_gateway?: string } | null;
      if (biz?.name) businessName = biz.name;
      if (biz?.country_code) countryCode = biz.country_code as CountryCode;
      const checkIn = new Date(reservation.check_in + 'T00:00').toLocaleDateString('en-US', { day: 'numeric', month: 'short' });
      const checkOut = new Date(reservation.check_out + 'T00:00').toLocaleDateString('en-US', { day: 'numeric', month: 'short' });
      serviceName = `Reservation ${checkIn} - ${checkOut}`;
      // Check for remaining balance
      const total = Number(reservation.total_amount || 0);
      const deposit = Number(reservation.deposit_amount || 0);
      if (total > 0 && deposit > 0 && total > deposit) {
        balanceRemaining = total - deposit;
        balanceReservationId = payment.reservation_id!;
      }
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

  // ── 3b. Try campaign donation for phone + business resolution ──
  if (!customerPhone && payment.campaign_id) {
    const { data: donation } = await supabase
      .from('campaign_donations')
      .select('donor_phone, campaigns(business_id, businesses(name, country_code))')
      .eq('payment_id', payment.id)
      .maybeSingle();
    if (donation?.donor_phone) {
      customerPhone = donation.donor_phone;
    }
    if (donation) {
      const campaign = donation.campaigns as unknown as { business_id: string; businesses: { name: string; country_code?: string } | null } | null;
      if (campaign?.business_id && !businessId) {
        businessId = campaign.business_id;
        if (campaign.businesses?.name) businessName = campaign.businesses.name;
        if (campaign.businesses?.country_code) countryCode = campaign.businesses.country_code as CountryCode;
      }
    }
  }

  // Always resolve business from campaign if not yet resolved (independent of phone)
  if (payment.campaign_id && !businessId) {
    const { data: campDonation } = await supabase
      .from('campaign_donations')
      .select('campaigns(business_id, businesses(name, country_code))')
      .eq('payment_id', payment.id)
      .maybeSingle();
    if (campDonation) {
      const camp = campDonation.campaigns as any;
      if (camp?.business_id) businessId = camp.business_id;
      if (camp?.businesses?.name) businessName = camp.businesses.name;
      if (camp?.businesses?.country_code) countryCode = camp.businesses.country_code as CountryCode;
    }
  }

  if (!businessId) {
    // No business found — clear claim for retry
    await supabase.from('payments').update({
      confirmation_claimed_at: null,
      confirmation_claim_token: null,
    }).eq('id', payment.id).eq('confirmation_claim_token', claimToken);
    logger.warn(`${logPrefix} Proactive confirmation skipped — no business — claim released`);
    return;
  }

  // Fetch subscription tier for white-label checks on emails
  let isWl = false;
  try {
    const { data: bizTier } = await supabase.from('businesses').select('subscription_tier').eq('id', businessId).single();
    const { isWhiteLabel } = await import('@/lib/whitelabel');
    isWl = isWhiteLabel(bizTier?.subscription_tier);
  } catch { /* non-critical */ }

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
      // No recipient found — clear claim for retry
      await supabase.from('payments').update({
        confirmation_claimed_at: null,
        confirmation_claim_token: null,
      }).eq('id', payment.id).eq('confirmation_claim_token', claimToken);
      logger.warn(`${logPrefix} No recipient found for payment ${payment.id} — claim released`);
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
  ].filter(Boolean);

  // Add balance info if deposit was partial
  if (balanceRemaining > 0) {
    lines.push('', `💳 Remaining balance: *${formatCurrency(balanceRemaining, countryCode)}*`);

    // Generate payment link for the balance (non-blocking, best-effort)
    try {
      // Find user profile for payment initialization
      const phoneForLookup = customerPhone || '';
      const phoneP = phoneForLookup.startsWith('+') ? phoneForLookup : `+${phoneForLookup}`;
      const phoneN = phoneForLookup.startsWith('+') ? phoneForLookup.slice(1) : phoneForLookup;
      const { data: profile } = await supabase
        .from('profiles')
        .select('id')
        .or(`phone.eq.${sanitizeFilterValue(phoneP)},phone.eq.${sanitizeFilterValue(phoneN)}`)
        .limit(1)
        .maybeSingle();

      if (profile && businessId) {
        const { initializePayment } = await import('@/lib/bot/flows/shared/payment');
        const result = await initializePayment(supabase, {
          bookingId: balanceBookingId || undefined,
          reservationId: balanceReservationId || undefined,
          userId: profile.id,
          amount: balanceRemaining,
          referenceCode,
          businessName,
          phone: phoneForLookup,
          countryCode,
          businessId,
        });
        if (result?.url) {
          lines.push(`💰 Pay now: ${result.url}`);
        }
      }
    } catch {
      // Non-critical — balance info still shown without link
    }
  }

  lines.push('', 'Type *receipt* to get your receipt', 'Type *my bookings* to view your bookings');

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

  let deliverySucceeded = false;

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
      deliverySucceeded = true;
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

      // ── 7b. Invoice payment owner notification ──
      if (payment.invoice_id && resolved) {
        const { notifyOwnerNewInvoicePayment } = await import('@/lib/bot/flows/shared/notify-owner');
        const { data: invoice } = await supabase.from('invoices')
          .select('reference_code, customer_name, customer_phone')
          .eq('id', payment.invoice_id).single();

        if (invoice) {
          notifyOwnerNewInvoicePayment({
            supabase, sender: resolved.sender, businessId, businessName, countryCode,
            referenceCode: invoice.reference_code || referenceCode,
            customerName: invoice.customer_name || 'Customer',
            amount: payment.amount,
            invoiceNumber: invoice.reference_code || referenceCode,
          }).catch(err => logger.error(`${logPrefix} Invoice owner notify error:`, err));
        }
      }

      // ── 7c. Campaign donation owner notification ──
      if (payment.campaign_id && resolved) {
        const { notifyOwnerNewDonation } = await import('@/lib/bot/flows/shared/notify-owner');
        const { data: donation } = await supabase.from('campaign_donations')
          .select('donor_name, reference_code, campaigns(title)')
          .eq('payment_id', payment.id)
          .maybeSingle();

        const campaignTitle = (donation?.campaigns as unknown as { title: string } | null)?.title || 'Campaign';
        notifyOwnerNewDonation({
          supabase, sender: resolved.sender, businessId, businessName, countryCode,
          referenceCode: donation?.reference_code || referenceCode,
          donorName: donation?.donor_name || null,
          amount: payment.amount,
          campaignTitle,
        }).catch(err => logger.error(`${logPrefix} Donation owner notify error:`, err));
      }

      // ── 7d. Order owner notification ──
      if (payment.order_id && resolved) {
        const { notifyOwnerNewOrder } = await import('@/lib/bot/flows/shared/notify-owner');
        const { data: order } = await supabase.from('orders')
          .select('reference_code, delivery_name, delivery_address, order_items(product_name, variant_label, quantity, unit_price)')
          .eq('id', payment.order_id).single();

        if (order) {
          const items = ((order.order_items || []) as Array<{ product_name: string; variant_label?: string; quantity: number; unit_price: number }>).map(i => ({
            name: i.variant_label ? `${i.product_name} (${i.variant_label})` : i.product_name,
            quantity: i.quantity,
            price: i.unit_price * i.quantity,
          }));
          notifyOwnerNewOrder({
            supabase, sender: resolved.sender, businessId, businessName, countryCode,
            referenceCode: order.reference_code || referenceCode,
            customerName: order.delivery_name || 'Customer',
            items,
            totalAmount: payment.amount,
            deliveryAddress: order.delivery_address || undefined,
          }).catch(err => logger.error(`${logPrefix} Order owner notify error:`, err));
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
          const ticketResult = await sendTicketsAfterPurchase({
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
          if (ticketResult.success) {
            deliverySucceeded = true;
          }
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
            whitelabel: isWl,
          });
          await sendEmail({ to: guestEmail, ...emailContent });
          deliverySucceeded = true;
          logger.info(`${logPrefix} Email confirmation sent to ${guestEmail}`);
        }
      } catch (emailErr) {
        logger.error(`${logPrefix} Email confirmation error:`, emailErr);
      }
    }

    // ── 8c. Send email receipt for campaign donations ──
    if (payment.campaign_id) {
      try {
        const { data: donation } = await supabase
          .from('campaign_donations')
          .select('donor_name, donor_phone, reference_code, campaigns(title)')
          .eq('payment_id', payment.id)
          .maybeSingle();

        if (donation?.donor_phone) {
          // Look up donor email from profiles via phone
          const phoneP = donation.donor_phone.startsWith('+') ? donation.donor_phone : `+${donation.donor_phone}`;
          const phoneN = donation.donor_phone.startsWith('+') ? donation.donor_phone.slice(1) : donation.donor_phone;
          const { data: donorProfile } = await supabase
            .from('profiles')
            .select('email')
            .or(`phone.eq.${sanitizeFilterValue(phoneP)},phone.eq.${sanitizeFilterValue(phoneN)}`)
            .limit(1)
            .maybeSingle();

          const donorEmail = donorProfile?.email || null;
          if (donorEmail) {
            const campaignTitle = (donation.campaigns as unknown as { title: string } | null)?.title || 'Campaign';
            const { sendEmail } = await import('@/lib/email/client');
            const { donationReceiptEmail } = await import('@/lib/email/templates');
            const emailContent = donationReceiptEmail({
              donorName: donation.donor_name || 'Donor',
              businessName,
              campaignTitle,
              formattedAmount: formatCurrency(payment.amount, countryCode),
              referenceCode: donation.reference_code || referenceCode,
              whitelabel: isWl,
            });
            await sendEmail({ to: donorEmail, ...emailContent });
            deliverySucceeded = true;
            logger.info(`${logPrefix} Donation receipt email sent to ${donorEmail}`);
          }
        }
      } catch (donationEmailErr) {
        logger.error(`${logPrefix} Donation receipt email error:`, donationEmailErr);
      }
    }

    // ── 9. Deactivate the payment-waiting session (webhook confirmed — user doesn't need to tap "I've Paid") ──
    if (customerPhone) {
      await supabase
        .from('bot_sessions')
        .update({ is_active: false, current_step: 'complete' })
        .or(`whatsapp_number.eq.${stripPlus(customerPhone)},whatsapp_number.eq.+${stripPlus(customerPhone)}`)
        .eq('business_id', businessId)
        .eq('is_active', true)
        .in('current_step', ['payment', 'await_payment', 'await_ticket_payment', 'await_order_payment', 'create_booking']);
    }

    // Step 3: Mark as sent AFTER delivery succeeds (guarded by claim token)
    if (deliverySucceeded) {
      const { data: confirmed, error: confirmErr } = await supabase
        .from('payments')
        .update({ confirmation_sent_at: new Date().toISOString() })
        .eq('id', payment.id)
        .eq('confirmation_claim_token', claimToken)
        .select('id')
        .maybeSingle();

      if (confirmErr || !confirmed) {
        logger.error(`${logPrefix} Final mark failed — claim may be stale`);
        throw new Error('Confirmation final mark failed');
      }
    } else {
      // No delivery succeeded — clear claim for retry
      await supabase.from('payments').update({
        confirmation_claimed_at: null,
        confirmation_claim_token: null,
      }).eq('id', payment.id).eq('confirmation_claim_token', claimToken);
      logger.warn(`${logPrefix} No delivery succeeded for payment ${payment.id} — claim released`);
    }
  } catch (err) {
    // Clear claim on failure (retryable) — guarded by claim token
    const { error: clearErr } = await supabase.from('payments').update({
      confirmation_claimed_at: null,
      confirmation_claim_token: null,
    }).eq('id', payment.id).eq('confirmation_claim_token', claimToken);
    if (clearErr) {
      logger.error(`${logPrefix} Failed to clear confirmation claim:`, clearErr.message);
    }
    logger.error(`${logPrefix} Send confirmation error (claim cleared for retry):`, err);
    Sentry.captureException(err, { tags: { component: 'send-confirmation', operation: 'send-confirmation' } });
    throw err; // propagate so caller knows delivery failed
  }
}

/**
 * Retry confirmation for successful payments that have no confirmation_sent_at.
 * Called by cron or webhook handlers to recover from delivery failures.
 * Includes both unclaimed confirmations and stale claims (claimed but not sent within 5 minutes).
 */
export async function retryUndeliveredConfirmations(
  supabase: SupabaseClient,
  limit = 10,
): Promise<number> {
  const staleThresholdMs = 5 * 60 * 1000;
  const staleThreshold = new Date(Date.now() - staleThresholdMs).toISOString();
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  // Unclaimed confirmations (no claim, no sent)
  const { data: unclaimed } = await supabase
    .from('payments')
    .select('id, amount, booking_id, invoice_id, campaign_id, order_id, reservation_id')
    .eq('status', 'success')
    .is('confirmation_sent_at', null)
    .is('confirmation_claimed_at', null)
    .gte('paid_at', oneDayAgo)
    .order('paid_at', { ascending: true })
    .limit(limit);

  // Stale claims (claimed but not sent, older than threshold)
  const { data: stale } = await supabase
    .from('payments')
    .select('id, amount, booking_id, invoice_id, campaign_id, order_id, reservation_id')
    .eq('status', 'success')
    .is('confirmation_sent_at', null)
    .not('confirmation_claimed_at', 'is', null)
    .lt('confirmation_claimed_at', staleThreshold)
    .order('paid_at', { ascending: true })
    .limit(limit);

  const all = [...(unclaimed || []), ...(stale || [])].slice(0, limit);
  let retried = 0;
  for (const payment of all) {
    try {
      await sendProactiveConfirmation(supabase, payment, '[RETRY]');
      retried++;
    } catch {
      // Individual failures are logged inside sendProactiveConfirmation
    }
  }
  return retried;
}
