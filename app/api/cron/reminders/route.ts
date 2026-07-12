import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { sendEmail } from '@/lib/email/client';
import { bookingReminderEmail, businessNotificationEmail } from '@/lib/email/templates';
import { verifyCronAuth } from '@/lib/cron-auth';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
import { sendOrEmail, findCustomerEmail } from '@/lib/channels/send-or-email';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const authError = verifyCronAuth(request);
  if (authError) return authError;

  const supabase = createServiceClient();
  const resolver = new ChannelResolver(supabase);
  let remindersSent = 0;
  let whatsappSent = 0;

  // Get all businesses with their reminder config and tier
  const { data: businesses } = await supabase
    .from('businesses')
    .select('id, metadata, subscription_tier')
    .limit(500);

  // Conversation limit imports
  const { checkConversationLimit, trackOutboundMessage } = await import('@/lib/bot/conversation-guard');

  // Build a set of all reminder hours across businesses (default [24, 2])
  const bizMap = new Map<string, number[]>();
  const allHours = new Set<number>();
  for (const biz of businesses || []) {
    const meta = (biz.metadata || {}) as Record<string, unknown>;
    const hours = (meta.reminder_hours as number[]) || [24, 2];
    bizMap.set(biz.id, hours);
    for (const h of hours) allHours.add(h);
  }

  const now = new Date();

  // ── BOOKING REMINDERS ──
  for (const hoursAhead of allHours) {
    const targetTime = new Date(now.getTime() + hoursAhead * 60 * 60 * 1000);
    const targetDate = targetTime.toISOString().split('T')[0];

    // Dedup: use reminder flag columns to skip already-sent reminders
    let bookingsQuery = supabase
      .from('bookings')
      .select(`
        id, date, time, guest_name, guest_phone, guest_email,
        reference_code, status, user_id, business_id,
        businesses!inner(name),
        services(name)
      `)
      .eq('date', targetDate)
      .in('status', ['confirmed', 'pending']);

    if (hoursAhead === 24) bookingsQuery = bookingsQuery.eq('reminder_24h_sent', false);
    else if (hoursAhead === 2) bookingsQuery = bookingsQuery.eq('reminder_2h_sent', false);

    const { data: bookings } = await bookingsQuery;

    for (const booking of bookings || []) {
      const bizHours = bizMap.get(booking.business_id) || [24, 2];
      if (!bizHours.includes(hoursAhead)) continue;

      // TIME CHECK: verify booking time is within ±30 min of target
      if (booking.time) {
        const bookingDateTime = new Date(`${booking.date}T${booking.time}`);
        const diffHours = (bookingDateTime.getTime() - now.getTime()) / (1000 * 60 * 60);
        if (Math.abs(diffHours - hoursAhead) > 0.5) continue;
      }

      const limit = await checkConversationLimit(supabase, booking.business_id);
      if (!limit.allowed) continue;

      let email = (booking as any).guest_email;
      if (!email && booking.user_id) {
        const { data: profile } = await supabase.from('profiles').select('email').eq('id', booking.user_id).single();
        email = profile?.email;
      }

      const businessName = (booking as any).businesses?.name || 'Your business';
      const serviceName = (booking as any).services?.name || 'your appointment';
      const customerName = booking.guest_name || 'there';

      // Send WhatsApp reminder + email (dual delivery)
      if (booking.guest_phone) {
        const timeLabel = booking.time || '';
        const hoursLabel = hoursAhead >= 24 ? 'tomorrow' : `in ${hoursAhead} hours`;
        const waMsg = `Hi ${customerName}! Just a reminder — your ${serviceName} at *${businessName}* is ${hoursLabel}${timeLabel ? ` at ${timeLabel}` : ''}.\n\nRef: *${booking.reference_code || ''}*\n\nSee you there! 🙏`;

        // Look up email if not already available
        if (!email) {
          email = await findCustomerEmail(supabase, booking.guest_phone, booking.business_id);
        }

        const resolved = await resolver.resolveByBusinessId(booking.business_id);
        if (resolved) {
          const emailPayload = email
            ? (() => {
                const { subject, html } = bookingReminderEmail(businessName, customerName, serviceName, booking.date, booking.time || '', booking.reference_code || '');
                return { address: email!, subject, html };
              })()
            : null;

          const result = await sendOrEmail({
            supabase,
            sender: resolved.sender,
            to: booking.guest_phone.replace(/^\+/, ''),
            text: waMsg,
            email: emailPayload,
            businessName,
            alwaysEmail: true,
          });
          if (result.whatsapp === 'sent') whatsappSent++;
          if (result.email === 'sent') remindersSent++;

          // Mark reminder as sent to prevent duplicates
          const flagUpdate: Record<string, boolean> = {};
          if (hoursAhead === 24) flagUpdate.reminder_24h_sent = true;
          else if (hoursAhead === 2) flagUpdate.reminder_2h_sent = true;
          if (Object.keys(flagUpdate).length > 0) {
            await supabase.from('bookings').update(flagUpdate).eq('id', booking.id);
          }
        }
      } else if (email) {
        // No phone — email only
        const { subject, html } = bookingReminderEmail(businessName, customerName, serviceName, booking.date, booking.time || '', booking.reference_code || '');
        await sendEmail({ to: email, subject, html }).catch(err => logger.error('[REMINDERS] Email error:', err));
        remindersSent++;
      }
    }
  }

  // ── RESERVATION REMINDERS (check-in tomorrow) ──
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const { data: reservations } = await supabase
    .from('reservations')
    .select('id, check_in, guest_name, guest_email, guest_phone, reference_code, business_id, businesses!inner(name)')
    .eq('check_in', tomorrow)
    .in('status', ['confirmed', 'pending']);

  for (const res of reservations || []) {
    let email = (res as any).guest_email;
    const bizName = (res as any).businesses?.name || 'Your stay';
    const guestName = res.guest_name || 'Guest';

    // Look up email if not already available
    if (!email && res.guest_phone) {
      email = await findCustomerEmail(supabase, res.guest_phone, res.business_id);
    }

    if (res.guest_phone) {
      const waMsg = `Hi ${guestName}! Just a reminder — your check-in at *${bizName}* is tomorrow.\n\nRef: *${res.reference_code || ''}*\n\nSee you there! 🙏`;

      const resolved = await resolver.resolveByBusinessId(res.business_id);
      if (resolved) {
        const emailPayload = email
          ? (() => {
              const { subject, html } = bookingReminderEmail(bizName, guestName, 'your stay', res.check_in, '', res.reference_code || '');
              return { address: email!, subject, html };
            })()
          : null;

        const result = await sendOrEmail({
          supabase,
          sender: resolved.sender,
          to: res.guest_phone.replace(/^\+/, ''),
          text: waMsg,
          email: emailPayload,
          businessName: bizName,
          alwaysEmail: true,
        });
        if (result.whatsapp === 'sent') whatsappSent++;
        if (result.email === 'sent') remindersSent++;
      }
    } else if (email) {
      // No phone — email only
      const { subject, html } = bookingReminderEmail(bizName, guestName, 'your stay', res.check_in, '', res.reference_code || '');
      await sendEmail({ to: email, subject, html }).catch(() => {});
      remindersSent++;
    }
  }

  // ── EVENT REMINDERS (event tomorrow) ──
  const { data: tomorrowEvents } = await supabase
    .from('events')
    .select('id, name, date, time, venue, business_id, businesses!inner(name)')
    .eq('date', tomorrow)
    .eq('status', 'published');

  for (const event of tomorrowEvents || []) {
    const { data: tickets } = await supabase
      .from('event_tickets')
      .select('id, guest_name, guest_phone, guest_email, reminder_sent')
      .eq('event_id', event.id)
      .eq('status', 'valid')
      .eq('reminder_sent', false);

    const bizName = (event as any).businesses?.name || 'Events';
    const timeLabel = event.time ? ` at ${event.time}` : '';
    const dateLabel = new Date(event.date + 'T00:00').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });

    for (const ticket of tickets || []) {
      if (!ticket.guest_phone) continue;

      const limit = await checkConversationLimit(supabase, event.business_id);
      if (!limit.allowed) continue;

      const guestName = ticket.guest_name || 'there';
      const waMsg = `Hi ${guestName}! Just a reminder — *${event.name}* is tomorrow${timeLabel}${event.venue ? ` at ${event.venue}` : ''}.\n\nHosted by *${bizName}*\n\nSee you there! 🎉`;

      const resolved = await resolver.resolveByBusinessId(event.business_id);
      if (resolved) {
        const emailPayload = ticket.guest_email
          ? (() => {
              const { subject, html } = bookingReminderEmail(bizName, guestName, event.name, event.date, event.time || '', '');
              return { address: ticket.guest_email!, subject, html };
            })()
          : null;

        const result = await sendOrEmail({
          supabase,
          sender: resolved.sender,
          to: ticket.guest_phone.replace(/^\+/, ''),
          text: waMsg,
          email: emailPayload,
          businessName: bizName,
          alwaysEmail: true,
        });
        if (result.whatsapp === 'sent') whatsappSent++;
        if (result.email === 'sent') remindersSent++;

        // Mark reminder as sent to prevent duplicates
        await supabase.from('event_tickets').update({ reminder_sent: true }).eq('id', ticket.id);
      }
    }
  }

  // ── OVERDUE INVOICE REMINDERS ──
  // ── Party followup reminders ──
  // Send followup_message to confirmed guests X days before party date
  const { data: parties } = await supabase
    .from('parties')
    .select('id, name, date, time, venue, followup_message, followup_days_before, business_id')
    .not('followup_message', 'is', null)
    .gte('date', new Date().toISOString().split('T')[0]);

  for (const party of parties || []) {
    if (!party.followup_message) continue;
    const daysBefore = party.followup_days_before ?? 1;
    const partyDate = new Date(party.date + 'T00:00');
    const reminderDate = new Date(partyDate);
    reminderDate.setDate(reminderDate.getDate() - daysBefore);
    const today = new Date().toISOString().split('T')[0];

    if (reminderDate.toISOString().split('T')[0] !== today) continue;

    // Get confirmed guests
    const { data: guests } = await supabase
      .from('event_invites')
      .select('guest_phone, guest_name')
      .eq('party_id', party.id)
      .eq('business_id', party.business_id)
      .in('status', ['accepted', 'maybe'])
      .eq('reminder_sent', false);

    for (const guest of guests || []) {
      if (!guest.guest_phone) continue;

      const dateLabel = partyDate.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
      let timeLabel = '';
      if (party.time) {
        try {
          const [h, m] = party.time.split(':');
          const dt = new Date();
          dt.setHours(parseInt(h, 10), parseInt(m, 10));
          timeLabel = ` at ${dt.toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit' })}`;
        } catch { timeLabel = ` at ${party.time}`; }
      }

      const message = [
        `⏰ *Reminder*`,
        '',
        `${guest.guest_name ? `Hi ${guest.guest_name}! ` : ''}${party.followup_message}`,
        '',
        `📅 ${party.name}`,
        `${dateLabel}${timeLabel}`,
        party.venue ? `📍 ${party.venue}` : '',
      ].filter(Boolean).join('\n');

      const resolved = await resolver.resolveByBusinessId(party.business_id);
      if (resolved) {
        // Look up guest email for dual delivery
        const guestEmail = await findCustomerEmail(supabase, guest.guest_phone, party.business_id);
        const emailPayload = guestEmail
          ? (() => {
              const { subject, html } = businessNotificationEmail({
                businessName: party.name,
                title: 'Event Reminder',
                message: party.followup_message,
                details: {
                  'Date': dateLabel,
                  ...(party.venue ? { 'Venue': party.venue } : {}),
                },
              });
              return { address: guestEmail, subject, html };
            })()
          : null;

        const result = await sendOrEmail({
          supabase,
          sender: resolved.sender,
          to: guest.guest_phone.replace(/^\+/, ''),
          text: message,
          email: emailPayload,
          businessName: party.name,
          alwaysEmail: true,
        });

        if (result.whatsapp === 'sent' || result.email === 'sent') {
          whatsappSent++;
          // Mark reminder sent
          await supabase
            .from('event_invites')
            .update({ reminder_sent: true })
            .eq('party_id', party.id)
            .eq('guest_phone', guest.guest_phone);
        }
      }
    }
  }

  // ── Overdue invoice reminders ──
  const { data: overdueInvoices } = await supabase
    .from('invoices')
    .select('id, customer_email, customer_name, total_amount, due_date, business_id, businesses!inner(name)')
    .eq('status', 'overdue');

  for (const inv of overdueInvoices || []) {
    if (inv.customer_email) {
      const bizName = (inv as any).businesses?.name || 'Business';
      await sendEmail({
        to: inv.customer_email,
        subject: `Reminder: Invoice overdue — ${bizName}`,
        html: `<p>Hi ${inv.customer_name || 'there'},</p><p>Your invoice from <strong>${bizName}</strong> for <strong>${inv.total_amount}</strong> was due on ${inv.due_date}.</p><p>Please complete your payment at your earliest convenience.</p>`,
      }).catch(() => {});
      remindersSent++;
    }
  }

  return NextResponse.json({ ok: true, emailsSent: remindersSent, whatsappSent });
}
