import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { generateGoogleCalendarUrl, buildCalendarEvent } from '@/lib/calendar/generate-links';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ ref: string }> },
) {
  const { ref } = await params;
  const supabase = createServiceClient();

  const { data: booking } = await supabase
    .from('bookings')
    .select('reference_code, date, time, business_id, businesses(name, address), services(name, duration_minutes)')
    .eq('reference_code', ref)
    .single();

  if (booking) {
    const biz = booking.businesses as unknown as { name: string; address?: string } | null;
    const svc = booking.services as unknown as { name: string; duration_minutes?: number } | null;

    const event = buildCalendarEvent({
      businessName: biz?.name || 'Business',
      businessAddress: biz?.address || undefined,
      serviceName: svc?.name || undefined,
      referenceCode: booking.reference_code,
      date: booking.date,
      time: booking.time,
      durationMinutes: svc?.duration_minutes || 60,
    });

    if (event) {
      const googleUrl = generateGoogleCalendarUrl(event);
      return NextResponse.redirect(googleUrl);
    }
  }

  // Fallback — redirect to homepage
  return NextResponse.redirect(new URL('/', _request.url));
}
