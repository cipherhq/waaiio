import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { rateLimitResponse, getRateLimitKey } from '@/lib/rate-limit';

/**
 * GET /api/tickets/verify/[code]
 * Returns ticket details + validity status.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ code: string }> },
) {
  const { code } = await params;
  const supabase = createServiceClient();

  const { data: ticket, error } = await supabase
    .from('event_tickets')
    .select(`
      id,
      ticket_code,
      ticket_number,
      guest_name,
      guest_phone,
      status,
      scanned_at,
      scanned_by,
      created_at,
      booking_id,
      event:events!event_id (
        name,
        date,
        time,
        venue,
        image_url,
        self_checkin_enabled
      ),
      booking:bookings!booking_id (
        quantity,
        reference_code
      )
    `)
    .eq('ticket_code', code.toUpperCase())
    .single();

  if (error || !ticket) {
    return NextResponse.json(
      { valid: false, error: 'Ticket not found' },
      { status: 404 },
    );
  }

  const event = ticket.event as any;
  const booking = ticket.booking as any;

  return NextResponse.json({
    valid: ticket.status === 'valid',
    ticket: {
      ticket_code: ticket.ticket_code,
      event_name: event?.name || '',
      event_date: event?.date || '',
      event_time: event?.time || null,
      venue: event?.venue || '',
      guest_name: ticket.guest_name || '',
      ticket_number: ticket.ticket_number,
      total_tickets: booking?.quantity || 1,
      reference_code: booking?.reference_code || '',
      status: ticket.status,
      scanned_at: ticket.scanned_at,
      scanned_by: ticket.scanned_by,
      self_checkin_enabled: event?.self_checkin_enabled || false,
      image_url: event?.image_url || null,
    },
  });
}

/**
 * POST /api/tickets/verify/[code]
 * Check in / mark ticket as used.
 * Enforces: event-day only, duplicate protection, rate limiting.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ code: string }> },
) {
  // Rate limit: 5 check-in attempts per minute per IP
  const rateLimit = rateLimitResponse(getRateLimitKey(req, 'ticket-checkin'), 5, 60_000);
  if (rateLimit) return rateLimit;

  const { code } = await params;
  const supabase = createServiceClient();

  // Read optional scanned_by from body
  let scannedBy: string | null = null;
  try {
    const body = await req.json();
    scannedBy = body.scanned_by || null;
  } catch {
    // No body is fine
  }

  // Fetch ticket with event info
  const { data: ticket, error } = await supabase
    .from('event_tickets')
    .select('id, status, scanned_at, scanned_by, guest_name, event:events!event_id(date, time, self_checkin_enabled)')
    .eq('ticket_code', code.toUpperCase())
    .single();

  if (error || !ticket) {
    return NextResponse.json(
      { success: false, error: 'Ticket not found' },
      { status: 404 },
    );
  }

  if (ticket.status === 'used') {
    return NextResponse.json(
      {
        success: false,
        error: `This ticket was already checked in${ticket.scanned_at ? ` at ${new Date(ticket.scanned_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}` : ''}${ticket.scanned_by ? ` by ${ticket.scanned_by}` : ''}`,
        scanned_at: ticket.scanned_at,
        scanned_by: ticket.scanned_by,
      },
      { status: 409 },
    );
  }

  if (ticket.status === 'cancelled') {
    return NextResponse.json(
      { success: false, error: 'This ticket has been cancelled' },
      { status: 410 },
    );
  }

  // Event-day check: only allow check-in on event day (with 1hr buffer before)
  const event = ticket.event as any;
  if (event?.date) {
    const eventDate = new Date(event.date + 'T00:00:00');
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const eventDay = new Date(eventDate.getFullYear(), eventDate.getMonth(), eventDate.getDate());

    // Allow check-in: event day, or 1 hour before if event has a time
    const bufferMs = 60 * 60 * 1000; // 1 hour
    let earliestCheckin = eventDay;
    if (event.time) {
      const [h, m] = event.time.split(':').map(Number);
      earliestCheckin = new Date(eventDay.getTime() + h * 3600000 + m * 60000 - bufferMs);
    }

    const latestCheckin = new Date(eventDay.getTime() + 24 * 60 * 60 * 1000); // end of event day

    if (now < earliestCheckin) {
      return NextResponse.json(
        { success: false, error: `Check-in is not open yet. It opens on ${eventDate.toLocaleDateString('en-US', { weekday: 'long', day: 'numeric', month: 'long' })}.` },
        { status: 403 },
      );
    }

    if (now > latestCheckin) {
      return NextResponse.json(
        { success: false, error: 'Check-in for this event has closed.' },
        { status: 403 },
      );
    }
  }

  // Mark as used
  const { error: updateError } = await supabase
    .from('event_tickets')
    .update({
      status: 'used',
      scanned_at: new Date().toISOString(),
      scanned_by: scannedBy || 'self',
    })
    .eq('id', ticket.id);

  if (updateError) {
    return NextResponse.json(
      { success: false, error: 'Failed to check in. Please try again.' },
      { status: 500 },
    );
  }

  return NextResponse.json({ success: true });
}
