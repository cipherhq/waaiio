import type { SupabaseClient } from '@supabase/supabase-js';
import type { MessageSender } from '@/lib/channels/message-sender';
import type { FlowExecutor } from '../flows/executor';
import type { BotSession, BusinessRecord } from '../bot-types';
import { logger } from '@/lib/logger';
import { safeLogErrorContext } from '@/lib/errors';
import { sanitizeFilterValue } from '@/lib/utils/sanitize';
import { handleTransactionDocument } from './transaction-docs';
import { routeToMyAccountMenu } from './my-account-menu';

/**
 * Show and navigate the user's bookings, tickets, and reservations.
 */
export async function handleMyBookings(
  supabase: SupabaseClient,
  messageSender: MessageSender,
  sendText: (to: string, text: string) => Promise<void>,
  flowExecutor: FlowExecutor,
  session: BotSession,
  from: string,
  input: string,
): Promise<void> {
  if (!input) {
    // Fetch upcoming bookings
    const { data: upcoming } = await supabase
      .from('bookings')
      .select('id, date, time, party_size, reference_code, businesses (name)')
      .eq('user_id', session.user_id!)
      .in('status', ['confirmed', 'pending'])
      .gte('date', new Date().toISOString().split('T')[0])
      .order('date', { ascending: true })
      .limit(5);

    // Fetch event tickets (match both +234... and 234... phone formats)
    const phoneWithPlus = from.startsWith('+') ? from : `+${from}`;
    const phoneWithoutPlus = from.startsWith('+') ? from.slice(1) : from;
    const { data: tickets } = await supabase
      .from('event_tickets')
      .select('id, ticket_code, guest_name, status, created_at, event:events!event_id(name, date, time, venue)')
      .or(`guest_phone.eq.${sanitizeFilterValue(phoneWithPlus)},guest_phone.eq.${sanitizeFilterValue(phoneWithoutPlus)}`)
      .eq('status', 'valid')
      .order('created_at', { ascending: false })
      .limit(5);

    // Fetch upcoming reservations (stays)
    const phoneP = from.startsWith('+') ? from : `+${from}`;
    const phoneN = from.startsWith('+') ? from.slice(1) : from;
    const { data: reservations } = await supabase
      .from('reservations')
      .select('id, check_in, check_out, reference_code, guest_name, status, property_id, businesses:business_id(name)')
      .or(`guest_phone.eq.${sanitizeFilterValue(phoneP)},guest_phone.eq.${sanitizeFilterValue(phoneN)}`)
      .in('status', ['confirmed', 'pending', 'checked_in'])
      .gte('check_out', new Date().toISOString().split('T')[0])
      .order('check_in', { ascending: true })
      .limit(5);

    const items: { title: string; description: string; postbackText: string }[] = [];

    if (upcoming) {
      for (const r of upcoming) {
        const biz = r.businesses as unknown as { name: string } | null;
        const dateLabel = new Date(r.date + 'T00:00').toLocaleDateString('en-US', {
          weekday: 'short', day: 'numeric', month: 'short',
        });
        items.push({
          title: biz?.name || 'Business',
          description: `${dateLabel} at ${r.time} • ${r.party_size} guests`,
          postbackText: `booking_${r.id}`,
        });
      }
    }

    if (tickets) {
      for (const t of tickets) {
        const evt = t.event as unknown as { name: string; date: string; time?: string; venue?: string } | null;
        const dateLabel = evt?.date
          ? new Date(evt.date + 'T00:00').toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short' })
          : '';
        items.push({
          title: evt?.name || 'Event',
          description: `${dateLabel} • Ticket: ${t.ticket_code}`,
          postbackText: `ticket_${t.id}`,
        });
      }
    }

    if (reservations && reservations.length > 0) {
      for (const r of reservations) {
        const biz = r.businesses as unknown as { name: string } | null;
        const checkIn = new Date(r.check_in + 'T00:00').toLocaleDateString('en-US', { day: 'numeric', month: 'short' });
        const checkOut = new Date(r.check_out + 'T00:00').toLocaleDateString('en-US', { day: 'numeric', month: 'short' });
        items.push({
          title: biz?.name || 'Stay',
          description: `${checkIn} → ${checkOut} • Ref: ${r.reference_code}`,
          postbackText: `reservation_${r.id}`,
        });
      }
    }

    if (items.length === 0) {
      await messageSender.sendButtons({
        to: from,
        body: "You don't have any upcoming bookings, tickets, or stays.",
        buttons: [{ id: 'back_to_account', title: '← Back' }],
      });
      return;
    }

    items.push({ title: '← Back to Menu', description: 'Return to main menu', postbackText: 'back_to_account' });

    await messageSender.sendList({
      to: from,
      title: 'Bookings, Tickets & Stays',
      body: 'Select a booking, ticket, or stay to view:\n\nType *menu* to go back.',
      buttonLabel: 'View All',
      items,
    });
    return;
  }

  if (input.startsWith('booking_')) {
    const bookingId = input.replace('booking_', '');
    session.session_data.selected_booking_id = bookingId;
    await supabase.from('bot_sessions').update({
      current_step: 'modify_booking',
      session_data: session.session_data,
    }).eq('id', session.id);
    await handleModifyBooking(supabase, messageSender, sendText, flowExecutor, session, from, '');
    return;
  }

  if (input.startsWith('ticket_')) {
    const ticketId = input.replace('ticket_', '');
    await handleViewTicket(supabase, messageSender, sendText, session, from, ticketId);
    return;
  }

  if (input.startsWith('reservation_')) {
    const reservationId = input.replace('reservation_', '');
    await handleViewReservation(supabase, messageSender, sendText, session, from, reservationId);
    return;
  }

  // Back button from detail views — re-show bookings list
  if (input === 'back_bookings') {
    await handleMyBookings(supabase, messageSender, sendText, flowExecutor, session, from, '');
    return;
  }

  // Receipt button from detail views
  if (input === 'get_receipt') {
    await handleTransactionDocument(supabase, messageSender, sendText, from, session.user_id!, 'receipt');
    return;
  }

  // Back to My Account menu
  if (input === 'back_to_account') {
    await routeToMyAccountMenu(supabase, flowExecutor, session, from);
    return;
  }

  // Cancel reservation from detail view
  if (input === 'cancel_reservation') {
    const reservationId = session.session_data.selected_reservation_id as string;
    if (reservationId) {
      // Cancel the reservation
      await supabase
        .from('reservations')
        .update({ status: 'cancelled', cancelled_at: new Date().toISOString(), cancelled_by: 'guest' })
        .eq('id', reservationId)
        .in('status', ['pending', 'confirmed']);

      // Check if deposit was paid — if so, notify business owner for refund approval
      const { data: cancelledRes } = await supabase
        .from('reservations')
        .select('deposit_status, business_id, reference_code, deposit_amount, total_amount')
        .eq('id', reservationId)
        .single();

      if (cancelledRes?.deposit_status === 'paid') {
        // Find the payment record and create a refund request notification for the business owner
        const { data: relatedPayment } = await supabase
          .from('payments')
          .select('id')
          .eq('reservation_id', reservationId)
          .eq('status', 'success')
          .maybeSingle();

        if (relatedPayment && cancelledRes.business_id) {
          // Create a notification so business owner can approve refund from dashboard
          await supabase.from('notifications').insert({
            business_id: cancelledRes.business_id,
            type: 'refund_requested',
            channel: 'system',
            body: `Guest cancelled reservation ${cancelledRes.reference_code} (deposit paid). Review in Properties to issue refund.`,
            metadata: {
              reservation_id: reservationId,
              payment_id: relatedPayment.id,
              amount: cancelledRes.deposit_amount || cancelledRes.total_amount,
            },
          });
        }

        await sendText(from, [
          '❌ *Reservation Cancelled*',
          '',
          'Your reservation has been cancelled.',
          'Since you had already paid, the business has been notified to process your refund.',
          '',
          'Send *Hi* to start over.',
        ].join('\n'));
      } else {
        await sendText(from, [
          '❌ *Reservation Cancelled*',
          '',
          'Your reservation has been cancelled successfully.',
          '',
          'Send *Hi* to start over.',
        ].join('\n'));
      }

      await supabase.from('bot_sessions').update({ is_active: false }).eq('id', session.id);
      return;
    }
  }

  // Unrecognized input — re-show the bookings list
  await handleMyBookings(supabase, messageSender, sendText, flowExecutor, session, from, '');
}

export async function handleViewTicket(
  supabase: SupabaseClient,
  messageSender: MessageSender,
  sendText: (to: string, text: string) => Promise<void>,
  _session: BotSession,
  from: string,
  ticketId: string,
): Promise<void> {
  const { data: ticket } = await supabase
    .from('event_tickets')
    .select('id, ticket_code, guest_name, status, scanned_at, created_at, event:events!event_id(name, date, time, venue)')
    .eq('id', ticketId)
    .single();

  if (!ticket) {
    await sendText(from, 'Ticket not found. Send *my bookings* to try again.');
    return;
  }

  const evt = ticket.event as unknown as { name: string; date: string; time?: string; venue?: string } | null;
  const dateLabel = evt?.date
    ? new Date(evt.date + 'T00:00').toLocaleDateString('en-US', { weekday: 'long', day: 'numeric', month: 'long' })
    : 'TBD';

  const statusLabel = ticket.status === 'used' ? 'Used' : ticket.status === 'cancelled' ? 'Cancelled' : 'Valid';

  await sendText(from, [
    `🎫 *Event Ticket*`,
    '',
    `🎪 *${evt?.name || 'Event'}*`,
    `📅 ${dateLabel}${evt?.time ? ` at ${evt.time}` : ''}`,
    evt?.venue ? `📍 ${evt.venue}` : '',
    `🎟️ Ticket: *${ticket.ticket_code}*`,
    `👤 ${ticket.guest_name || 'Guest'}`,
    `Status: ${statusLabel}`,
  ].filter(Boolean).join('\n'));

  await messageSender.sendButtons({
    to: from,
    body: 'What would you like to do?',
    buttons: [
      { id: 'back_bookings', title: 'Back to Bookings' },
      { id: 'back_to_account', title: 'My Account' },
    ],
  });
}

export async function handleViewReservation(
  supabase: SupabaseClient,
  messageSender: MessageSender,
  sendText: (to: string, text: string) => Promise<void>,
  _session: BotSession,
  from: string,
  reservationId: string,
): Promise<void> {
  const { data: reservation } = await supabase
    .from('reservations')
    .select('id, check_in, check_out, reference_code, guest_name, guests, total_amount, status, businesses:business_id(name, country_code)')
    .eq('id', reservationId)
    .single();

  if (!reservation) {
    await sendText(from, 'Reservation not found. Send *my bookings* to try again.');
    return;
  }

  const biz = reservation.businesses as unknown as { name: string; country_code?: string } | null;
  const checkIn = new Date(reservation.check_in + 'T00:00').toLocaleDateString('en-US', { weekday: 'long', day: 'numeric', month: 'long' });
  const checkOut = new Date(reservation.check_out + 'T00:00').toLocaleDateString('en-US', { weekday: 'long', day: 'numeric', month: 'long' });
  const statusMap: Record<string, string> = {
    confirmed: '✅ Confirmed',
    pending: '⏳ Pending',
    checked_in: '🏠 Checked In',
    checked_out: '✅ Checked Out',
    cancelled: '❌ Cancelled',
  };
  const statusLabel = statusMap[reservation.status] || reservation.status;

  const currencySymbol = biz?.country_code === 'US' ? '$' : biz?.country_code === 'GB' ? '£' : '₦';

  await sendText(from, [
    `🏨 *Reservation Details*`,
    '',
    `🏠 *${biz?.name || 'Property'}*`,
    `📅 Check-in: ${checkIn}`,
    `📅 Check-out: ${checkOut}`,
    reservation.guests ? `👥 ${reservation.guests} guest(s)` : '',
    reservation.total_amount ? `💰 ${currencySymbol}${Number(reservation.total_amount).toLocaleString()}` : '',
    `👤 ${reservation.guest_name || 'Guest'}`,
    `🔑 Ref: *${reservation.reference_code}*`,
    `Status: ${statusLabel}`,
  ].filter(Boolean).join('\n'));

  // Store selected reservation ID for follow-up actions
  await supabase.from('bot_sessions')
    .update({ session_data: { ..._session.session_data, selected_reservation_id: reservationId } })
    .eq('id', _session.id);

  // Show cancel option only for cancellable reservations
  const canCancel = ['pending', 'confirmed'].includes(reservation.status);
  const buttons: Array<{ id: string; title: string }> = canCancel
    ? [
        { id: 'cancel_reservation', title: 'Cancel Reservation' },
        { id: 'back_bookings', title: 'Back to Bookings' },
      ]
    : [
        { id: 'back_bookings', title: 'Back to Bookings' },
        { id: 'back_to_account', title: 'My Account' },
      ];

  await messageSender.sendButtons({
    to: from,
    body: 'What would you like to do?',
    buttons,
  });
}

export async function handleModifyBooking(
  supabase: SupabaseClient,
  messageSender: MessageSender,
  sendText: (to: string, text: string) => Promise<void>,
  flowExecutor: FlowExecutor,
  session: BotSession,
  from: string,
  input: string,
): Promise<void> {
  const bookingId = session.session_data.selected_booking_id as string;

  if (!bookingId) {
    await sendText(from, 'Something went wrong. Send *my bookings* to try again.');
    await supabase.from('bot_sessions').update({ is_active: false }).eq('id', session.id);
    return;
  }

  if (!input) {
    const { data: booking } = await supabase
      .from('bookings')
      .select('id, date, time, party_size, reference_code, business_id, businesses (name)')
      .eq('id', bookingId)
      .single();

    if (!booking) {
      await sendText(from, 'Booking not found. Send *my bookings* to try again.');
      await supabase.from('bot_sessions').update({ is_active: false }).eq('id', session.id);
      return;
    }

    const biz = booking.businesses as unknown as { name: string } | null;
    const dateLabel = new Date(booking.date + 'T00:00').toLocaleDateString('en-US', {
      weekday: 'long', day: 'numeric', month: 'long',
    });

    await sendText(from, [
      `📋 *${biz?.name || 'Business'}*`,
      `📅 ${dateLabel} at ${booking.time}`,
      `👥 ${booking.party_size} guests`,
      `🔑 Ref: *${booking.reference_code}*`,
    ].join('\n'));

    await messageSender.sendButtons({
      to: from,
      body: 'What would you like to do?',
      buttons: [
        { id: 'reschedule_booking', title: 'Reschedule' },
        { id: 'cancel_booking', title: 'Cancel Booking' },
        { id: 'back_bookings', title: 'Back' },
      ],
    });
    return;
  }

  const response = input.toLowerCase();

  if (response === 'cancel' || response === 'exit' || response === 'quit') {
    await sendText(from, 'Action cancelled. Send *Hi* to start over. 🙏');
    await supabase.from('bot_sessions').update({ is_active: false }).eq('id', session.id);
    return;
  }

  if (response === 'back_bookings') {
    await supabase.from('bot_sessions').update({ current_step: 'my_bookings' }).eq('id', session.id);
    await handleMyBookings(supabase, messageSender, sendText, flowExecutor, session, from, '');
    return;
  }

  if (response === 'cancel_booking') {
    // Fetch booking details before cancelling (for staff notification)
    const { data: cancelledBooking } = await supabase
      .from('bookings')
      .select('id, staff_id, guest_name, date, time, reference_code, business_id, service_id, status, services:service_id(name)')
      .eq('id', bookingId)
      .single();

    // Only allow cancelling bookings that are pending or confirmed
    if (cancelledBooking && !['pending', 'confirmed'].includes(cancelledBooking.status)) {
      await sendText(from, 'This booking can no longer be cancelled.');
      await supabase.from('bot_sessions').update({ is_active: false }).eq('id', session.id);
      return;
    }

    await supabase
      .from('bookings')
      .update({ status: 'cancelled', cancelled_at: new Date().toISOString(), cancelled_by: 'diner' })
      .eq('id', bookingId)
      .in('status', ['pending', 'confirmed']);

    // Notify assigned staff member about cancellation
    if (cancelledBooking?.staff_id && cancelledBooking.business_id) {
      import('../flows/shared/notify-staff').then(({ notifyStaffBookingCancelled }) => {
        const dateLabel = new Date(cancelledBooking.date + 'T00:00').toLocaleDateString('en-US', {
          weekday: 'long', day: 'numeric', month: 'long',
        });
        notifyStaffBookingCancelled({
          supabase,
          sender: messageSender,
          businessId: cancelledBooking.business_id,
          staffId: cancelledBooking.staff_id!,
          customerName: cancelledBooking.guest_name || 'Customer',
          serviceName: ((cancelledBooking as any).services as { name: string } | null)?.name || '',
          date: dateLabel,
          time: cancelledBooking.time || '',
          referenceCode: cancelledBooking.reference_code || '',
        }).catch(err => logger.withContext({ op: 'my-bookings.staff-cancel-notify', ...safeLogErrorContext(err) }).error('[BOT] Staff cancel notify error'));
      }).catch(err => logger.withContext({ op: 'my-bookings.notify-staff-import', ...safeLogErrorContext(err) }).error('[MY-BOOKINGS] Failed to import notify-staff module'));
    }

    await sendText(from, '❌ Booking cancelled.\n\nSend *Hi* to start over or *my bookings* to manage others.');
    await supabase.from('bot_sessions').update({ is_active: false }).eq('id', session.id);
    return;
  }

  if (response === 'reschedule_booking') {
    // Fetch booking details to populate session for rescheduling
    const { data: booking } = await supabase
      .from('bookings')
      .select('id, business_id, service_id, party_size, services (id, name, price, deposit_amount)')
      .eq('id', bookingId)
      .single();

    if (!booking || !booking.business_id) {
      await sendText(from, 'Could not load booking details. Send *my bookings* to try again.');
      await supabase.from('bot_sessions').update({ is_active: false }).eq('id', session.id);
      return;
    }

    const { data: biz } = await supabase
      .from('businesses')
      .select('id, name, slug, category, flow_type, subscription_tier, trial_ends_at, metadata, operating_hours, country_code, payment_gateway')
      .eq('id', booking.business_id)
      .single();

    if (!biz) {
      await sendText(from, 'Something went wrong on our end. Send *Hi* to start over.');
      await supabase.from('bot_sessions').update({ is_active: false }).eq('id', session.id);
      return;
    }

    const svc = booking.services as unknown as { id: string; name: string; price: number; deposit_amount: number } | null;

    // Update session to restart scheduling from date selection
    const sessionData: Record<string, unknown> = {
      ...session.session_data,
      _reschedule_booking_id: bookingId,
      active_capability: 'scheduling',
      party_size: booking.party_size || 1,
    };
    if (svc) {
      sessionData.service_id = svc.id;
      sessionData.service_name = svc.name;
      sessionData.service_price = svc.price || 0;
      sessionData.service_deposit = svc.deposit_amount || 0;
      sessionData.skip_service = true;
    }

    // Clean up old inactive sessions for this phone+business to avoid
    // UNIQUE constraint violation on idx_bot_sessions_phone_business
    // (the index covers all rows, not just active ones)
    await supabase.from('bot_sessions')
      .delete()
      .eq('whatsapp_number', from)
      .eq('business_id', biz.id)
      .eq('is_active', false);

    await supabase.from('bot_sessions').update({
      current_step: 'select_date',
      session_data: sessionData,
      business_id: biz.id,
    }).eq('id', session.id);

    session.session_data = sessionData;
    session.current_step = 'select_date';
    session.business_id = biz.id;

    await sendText(from, "Let's pick a new date and time for your booking.");
    await flowExecutor.execute(from, '', session as unknown as BotSession, biz as BusinessRecord | null);
    return;
  }

  await sendText(from, 'Please tap one of the options above.');
}
