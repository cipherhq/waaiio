import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';

/**
 * GET /api/tickets/verify/[code]
 * Returns ticket details + validity status.
 */
export async function GET(
  _req: NextRequest,
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
        venue
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
    },
  });
}

/**
 * POST /api/tickets/verify/[code]
 * Mark ticket as scanned/used.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ code: string }> },
) {
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

  // Fetch current ticket
  const { data: ticket, error } = await supabase
    .from('event_tickets')
    .select('id, status, scanned_at')
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
        error: 'Ticket already used',
        scanned_at: ticket.scanned_at,
      },
      { status: 409 },
    );
  }

  if (ticket.status === 'cancelled') {
    return NextResponse.json(
      { success: false, error: 'Ticket has been cancelled' },
      { status: 410 },
    );
  }

  // Mark as used
  const { error: updateError } = await supabase
    .from('event_tickets')
    .update({
      status: 'used',
      scanned_at: new Date().toISOString(),
      scanned_by: scannedBy,
    })
    .eq('id', ticket.id);

  if (updateError) {
    return NextResponse.json(
      { success: false, error: 'Failed to update ticket' },
      { status: 500 },
    );
  }

  return NextResponse.json({ success: true });
}
