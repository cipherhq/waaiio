import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { logger } from '@/lib/logger';

/**
 * POST /api/events/cancel
 * Cancels an event, invalidates all tickets, and notifies ticket holders.
 * Called from the dashboard when an event status is set to 'cancelled'.
 */
export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const { event_id } = body as { event_id: string };

    if (!event_id) {
      return NextResponse.json({ error: 'event_id required' }, { status: 400 });
    }

    // Verify ownership: event belongs to a business owned by this user
    const { data: event } = await supabase
      .from('events')
      .select('id, name, date, time, business_id, status, businesses!inner(owner_id)')
      .eq('id', event_id)
      .single();

    if (!event) {
      return NextResponse.json({ error: 'Event not found' }, { status: 404 });
    }

    const businessOwner = (event.businesses as unknown as { owner_id: string })?.owner_id;
    if (businessOwner !== user.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    if (event.status === 'cancelled') {
      return NextResponse.json({ message: 'Event already cancelled' });
    }

    // Use service client for admin operations (notification sending)
    const serviceSupabase = createServiceClient();

    // 1. Set event status to cancelled
    await serviceSupabase
      .from('events')
      .update({ status: 'cancelled' })
      .eq('id', event_id);

    // 2. Get all valid tickets for this event
    const { data: tickets } = await serviceSupabase
      .from('event_tickets')
      .select('id, guest_phone, guest_name, guest_email, payment_id, status')
      .eq('event_id', event_id)
      .eq('status', 'valid');

    if (!tickets || tickets.length === 0) {
      return NextResponse.json({ success: true, cancelled_tickets: 0 });
    }

    // 3. Cancel all valid tickets
    await serviceSupabase
      .from('event_tickets')
      .update({ status: 'cancelled' })
      .eq('event_id', event_id)
      .eq('status', 'valid');

    // 4. Send WhatsApp notifications to ticket holders
    const eventDate = event.date
      ? new Date(event.date).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
      : 'TBD';
    const cancelMessage = `Event "${event.name}" on ${eventDate} has been cancelled. A refund will be processed if applicable. We apologize for any inconvenience.`;

    let notifiedCount = 0;
    const phonesNotified = new Set<string>();

    try {
      const { ChannelResolver } = await import('@/lib/channels/channel-resolver');
      const resolver = new ChannelResolver(serviceSupabase);
      const resolved = await resolver.resolveByBusinessId(event.business_id);

      if (resolved) {
        for (const ticket of tickets) {
          if (ticket.guest_phone && !phonesNotified.has(ticket.guest_phone)) {
            phonesNotified.add(ticket.guest_phone);
            try {
              await resolved.sender.sendText({ to: ticket.guest_phone, text: cancelMessage });
              notifiedCount++;
            } catch (sendErr) {
              logger.error(`[EVENT-CANCEL] Failed to notify ${ticket.guest_phone}:`, sendErr);
            }
          }
        }
      }
    } catch (channelErr) {
      logger.error('[EVENT-CANCEL] Channel resolution failed:', channelErr);
    }

    // 5. Create refund notification for paid tickets
    const paidTickets = tickets.filter(t => t.payment_id);
    if (paidTickets.length > 0) {
      // Create an alert for the business owner about pending refunds
      try {
        const { createAlert } = await import('@/lib/alerts/create-alert');
        await createAlert(serviceSupabase, {
          businessId: event.business_id,
          type: 'event_cancelled',
          severity: 'warning',
          title: 'Event Cancelled - Refunds Required',
          message: `Event "${event.name}" was cancelled. ${paidTickets.length} paid ticket(s) may require refunds.`,
          metadata: {
            eventId: event_id,
            paidTicketCount: paidTickets.length,
            paymentIds: paidTickets.map(t => t.payment_id).filter(Boolean),
          },
        });
      } catch (alertErr) {
        logger.error('[EVENT-CANCEL] Failed to create refund alert:', alertErr);
      }
    }

    return NextResponse.json({
      success: true,
      cancelled_tickets: tickets.length,
      notified: notifiedCount,
      refunds_pending: paidTickets.length,
    });
  } catch (error) {
    logger.error('[EVENT-CANCEL] Error:', (error as Error).message);
    return NextResponse.json({ error: 'Something went wrong on our end' }, { status: 500 });
  }
}
