import { NextResponse, type NextRequest } from 'next/server';
import { authenticatePartner } from '@/lib/partner/auth';
import { dispatchWebhook } from '@/lib/webhooks/dispatcher';
import { logger } from '@/lib/logger';

/**
 * POST /api/partner/events/:id/checkin — Mark ticket as used
 * Body: { ticket_code: "TK-A3F8X2" }
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ eventId: string }> }) {
  try {
    const auth = await authenticatePartner(request);
    if (auth instanceof NextResponse) return auth;
    const { business, keyId, supabase } = auth;
    const { eventId } = await params;

    // Verify event ownership
    const { data: event } = await supabase
      .from('events')
      .select('id, name')
      .eq('id', eventId)
      .eq('business_id', business.id)
      .eq('api_key_id', keyId)
      .single();

    if (!event) {
      return NextResponse.json({ error: 'Event not found' }, { status: 404 });
    }

    const body = await request.json();
    const ticketCode = typeof body.ticket_code === 'string' ? body.ticket_code.trim().toUpperCase() : '';

    if (!ticketCode) {
      return NextResponse.json({ error: 'ticket_code is required' }, { status: 400 });
    }

    // Find ticket
    const { data: ticket } = await supabase
      .from('event_tickets')
      .select('id, ticket_code, guest_name, guest_phone, ticket_type_name, status, scanned_at')
      .eq('ticket_code', ticketCode)
      .eq('event_id', eventId)
      .single();

    if (!ticket) {
      return NextResponse.json({ error: 'Ticket not found for this event' }, { status: 404 });
    }

    if (ticket.status === 'used') {
      return NextResponse.json({
        error: 'Ticket already checked in',
        checked_in_at: ticket.scanned_at,
      }, { status: 409 });
    }

    if (ticket.status === 'cancelled') {
      return NextResponse.json({ error: 'Ticket has been cancelled' }, { status: 400 });
    }

    // Mark as used
    const now = new Date().toISOString();
    await supabase
      .from('event_tickets')
      .update({ status: 'used', scanned_at: now, scanned_by: `partner_api:${keyId}` })
      .eq('id', ticket.id);

    // Dispatch webhook
    dispatchWebhook(supabase, business.id, 'ticket.checked_in', {
      event_id: eventId,
      event_name: event.name,
      ticket_code: ticket.ticket_code,
      guest_name: ticket.guest_name,
      guest_phone: ticket.guest_phone,
      ticket_type: ticket.ticket_type_name,
      checked_in_at: now,
    }).catch(err => logger.error('[PARTNER] Webhook dispatch error:', err));

    return NextResponse.json({
      success: true,
      ticket_code: ticket.ticket_code,
      guest_name: ticket.guest_name,
      ticket_type: ticket.ticket_type_name,
      checked_in_at: now,
    });
  } catch (error) {
    logger.error('[PARTNER] Check-in error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
