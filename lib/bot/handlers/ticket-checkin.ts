import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '@/lib/logger';

/**
 * Handle a ticket check-in via WhatsApp (TK-XXXXXX code).
 */
export async function handleTicketCheckin(
  supabase: SupabaseClient,
  sendText: (to: string, text: string) => Promise<void>,
  from: string,
  ticketCode: string,
): Promise<void> {
  try {
    const { data: ticket } = await supabase
      .from('event_tickets')
      .select('id, status, scanned_at, scanned_by, guest_name, guest_phone, event:events!event_id(name, date, time, self_checkin_enabled, business_id)')
      .eq('ticket_code', ticketCode)
      .single();

    if (!ticket) {
      await sendText(from, `❌ Ticket *${ticketCode}* not found. Please check the code and try again.`);
      return;
    }

    const event = ticket.event as any;

    // Check self check-in is enabled
    if (!event?.self_checkin_enabled) {
      await sendText(from, `🎟️ Ticket *${ticketCode}* for *${event?.name || 'event'}* is valid.\n\nSelf check-in is not enabled for this event. Please check in at the entrance.`);
      return;
    }

    // Already used
    if (ticket.status === 'used') {
      const scannedTime = ticket.scanned_at
        ? new Date(ticket.scanned_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
        : '';
      await sendText(from, `⚠️ Ticket *${ticketCode}* was already checked in${scannedTime ? ` at ${scannedTime}` : ''}${ticket.scanned_by && ticket.scanned_by !== 'self' ? ` by ${ticket.scanned_by}` : ''}.`);
      return;
    }

    if (ticket.status === 'cancelled') {
      await sendText(from, `❌ Ticket *${ticketCode}* has been cancelled.`);
      return;
    }

    // Event day check
    if (event?.date) {
      const eventDate = new Date(event.date + 'T00:00:00');
      const now = new Date();
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const eventDay = new Date(eventDate.getFullYear(), eventDate.getMonth(), eventDate.getDate());
      const bufferMs = 60 * 60 * 1000;

      let earliestCheckin = eventDay;
      if (event.time) {
        const [h, m] = event.time.split(':').map(Number);
        earliestCheckin = new Date(eventDay.getTime() + h * 3600000 + m * 60000 - bufferMs);
      }

      const latestCheckin = new Date(eventDay.getTime() + 24 * 60 * 60 * 1000);

      if (now < earliestCheckin) {
        await sendText(from, `⏰ Check-in for *${event.name}* is not open yet.\n\nIt opens on ${eventDate.toLocaleDateString('en-US', { weekday: 'long', day: 'numeric', month: 'long' })}.`);
        return;
      }

      if (now > latestCheckin) {
        await sendText(from, `⏰ Check-in for *${event.name}* has closed.`);
        return;
      }
    }

    // Verify phone matches ticket owner (fraud prevention)
    const phone = from.startsWith('+') ? from : `+${from}`;
    const ticketPhone = ticket.guest_phone || '';
    if (ticketPhone && !ticketPhone.includes(from) && !phone.includes(ticketPhone.replace('+', ''))) {
      // Phone doesn't match — still allow but mark as different phone
      await supabase.from('event_tickets').update({
        status: 'used',
        scanned_at: new Date().toISOString(),
        scanned_by: `whatsapp:${from}`,
      }).eq('id', ticket.id);
    } else {
      await supabase.from('event_tickets').update({
        status: 'used',
        scanned_at: new Date().toISOString(),
        scanned_by: 'self',
      }).eq('id', ticket.id);
    }

    await sendText(from, [
      `✅ *Checked In!*`,
      '',
      `🎪 ${event?.name || 'Event'}`,
      `🎟️ Ticket: *${ticketCode}*`,
      `👤 ${ticket.guest_name || 'Guest'}`,
      '',
      `Welcome! Enjoy the event.`,
    ].join('\n'));
  } catch (err) {
    logger.error('[BOT] Ticket check-in error:', err);
    await sendText(from, 'Sorry, something went wrong verifying your ticket. Please try again or check in at the entrance.');
  }
}
