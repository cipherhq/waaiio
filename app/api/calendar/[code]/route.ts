import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { generateIcsContent, buildCalendarEvent } from '@/lib/calendar/generate-links';

/**
 * GET /api/calendar/[code]
 * Returns an .ics calendar file for a booking or reservation reference code.
 * Public endpoint — no auth required (reference codes are unguessable).
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ code: string }> },
) {
  const { code } = await params;

  if (!code || code.length < 4) {
    return NextResponse.json({ error: 'Invalid reference code' }, { status: 400 });
  }

  const supabase = createServiceClient();

  // Try bookings first
  const { data: booking } = await supabase
    .from('bookings')
    .select('reference_code, date, time, guest_name, business_id, businesses(name, address), services(name, duration)')
    .eq('reference_code', code)
    .single();

  if (booking) {
    const biz = booking.businesses as unknown as { name: string; address?: string } | null;
    const svc = booking.services as unknown as { name: string; duration?: number } | null;

    const event = buildCalendarEvent({
      businessName: biz?.name || 'Business',
      businessAddress: biz?.address || undefined,
      serviceName: svc?.name || undefined,
      referenceCode: booking.reference_code,
      date: booking.date,
      time: booking.time,
      durationMinutes: svc?.duration || 60,
    });

    if (!event) {
      return NextResponse.json({ error: 'Booking has no scheduled date/time' }, { status: 404 });
    }

    const ics = generateIcsContent(event);
    return new NextResponse(ics, {
      status: 200,
      headers: {
        'Content-Type': 'text/calendar; charset=utf-8',
        'Content-Disposition': `attachment; filename="booking-${code}.ics"`,
        'Cache-Control': 'public, max-age=3600',
      },
    });
  }

  // Try reservations
  const { data: reservation } = await supabase
    .from('reservations')
    .select('reference_code, check_in, guest_name, business_id, businesses:business_id(name, address)')
    .eq('reference_code', code)
    .single();

  if (reservation) {
    const biz = reservation.businesses as unknown as { name: string; address?: string } | null;

    const event = buildCalendarEvent({
      businessName: biz?.name || 'Business',
      businessAddress: biz?.address || undefined,
      serviceName: 'Reservation',
      referenceCode: reservation.reference_code,
      date: reservation.check_in,
      time: '14:00', // Default check-in time
      durationMinutes: 120,
    });

    if (!event) {
      return NextResponse.json({ error: 'Reservation has no scheduled date' }, { status: 404 });
    }

    const ics = generateIcsContent(event);
    return new NextResponse(ics, {
      status: 200,
      headers: {
        'Content-Type': 'text/calendar; charset=utf-8',
        'Content-Disposition': `attachment; filename="reservation-${code}.ics"`,
        'Cache-Control': 'public, max-age=3600',
      },
    });
  }

  return NextResponse.json({ error: 'Booking not found' }, { status: 404 });
}
