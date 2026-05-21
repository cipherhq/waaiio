import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { generateTimeSlots } from '@/lib/constants';

/**
 * GET /api/bookings/public/slots?businessId=X&serviceId=Y&date=YYYY-MM-DD
 * Returns available time slots for a given business, service, and date.
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = request.nextUrl;
    const businessId = searchParams.get('businessId');
    const serviceId = searchParams.get('serviceId');
    const date = searchParams.get('date');

    if (!businessId || !serviceId || !date) {
      return NextResponse.json(
        { error: 'Missing required params: businessId, serviceId, date' },
        { status: 400 },
      );
    }

    // Validate date format
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return NextResponse.json({ error: 'Invalid date format' }, { status: 400 });
    }

    // Don't allow dates in the past
    const today = new Date().toISOString().split('T')[0];
    if (date < today) {
      return NextResponse.json({ error: 'Date is in the past' }, { status: 400 });
    }

    const supabase = createServiceClient();

    // Fetch business operating hours
    const { data: business, error: bizError } = await supabase
      .from('businesses')
      .select('operating_hours, metadata')
      .eq('id', businessId)
      .single();

    if (bizError || !business) {
      return NextResponse.json({ error: 'Business not found' }, { status: 404 });
    }

    // Fetch service details
    const { data: service, error: svcError } = await supabase
      .from('services')
      .select('duration_minutes, buffer_minutes, max_capacity, metadata')
      .eq('id', serviceId)
      .eq('business_id', businessId)
      .eq('is_active', true)
      .single();

    if (svcError || !service) {
      return NextResponse.json({ error: 'Service not found' }, { status: 404 });
    }

    // Determine operating hours for the selected day
    const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const selectedDay = dayNames[new Date(date + 'T00:00').getDay()];
    const opHours = (business.operating_hours || {}) as Record<
      string,
      { open?: string; close?: string; closed?: boolean }
    >;
    const dayHours = opHours[selectedDay];

    // If closed on this day, return empty
    if (dayHours?.closed) {
      return NextResponse.json({ slots: [] });
    }

    const openTime = dayHours?.open || '08:00';
    const closeTime = dayHours?.close || '22:00';

    // Determine slot interval from service duration or business metadata
    const bizMeta = (business.metadata || {}) as Record<string, unknown>;
    const slotInterval =
      (bizMeta.slot_interval_minutes as number) || service.duration_minutes || 60;

    // Generate all possible slots
    const allSlots = generateTimeSlots(openTime, closeTime, slotInterval);

    // For drop-off services, skip time selection (all slots available with high capacity)
    const svcMeta = (service.metadata || {}) as Record<string, unknown>;
    const isDropoff = svcMeta.is_dropoff === true;
    const maxCapacity = isDropoff ? 9999 : (service.max_capacity || 1);

    // Fetch existing bookings for this date + service
    const { data: existingBookings } = await supabase
      .from('bookings')
      .select('time, services(duration_minutes, buffer_minutes)')
      .eq('business_id', businessId)
      .eq('service_id', serviceId)
      .eq('date', date)
      .in('status', ['confirmed', 'pending', 'in_progress']);

    // Count bookings per slot — accounting for duration + buffer overlap
    const slotCounts = new Map<string, number>();
    for (const b of existingBookings || []) {
      if (b.time) {
        const timeStr = typeof b.time === 'string' ? b.time.slice(0, 5) : '';
        const [bH, bM] = timeStr.split(':').map(Number);
        const bookingStart = bH * 60 + bM;
        const svc = b.services as unknown as {
          duration_minutes?: number;
          buffer_minutes?: number;
        } | null;
        const bookingDuration =
          (svc?.duration_minutes || service.duration_minutes || 30) +
          (svc?.buffer_minutes || service.buffer_minutes || 0);

        for (const slot of allSlots) {
          const [sH, sM] = slot.split(':').map(Number);
          const slotStart = sH * 60 + sM;
          if (slotStart >= bookingStart && slotStart < bookingStart + bookingDuration) {
            slotCounts.set(slot, (slotCounts.get(slot) || 0) + 1);
          }
        }
      }
    }

    // Filter out fully booked slots. Also filter past times if date is today.
    const now = new Date();
    const isToday = date === today;
    const nowMinutes = now.getHours() * 60 + now.getMinutes();

    const availableSlots = allSlots
      .map((t) => {
        const booked = slotCounts.get(t) || 0;
        const available = maxCapacity - booked;
        return { time: t, available: Math.max(0, available) };
      })
      .filter((s) => {
        if (s.available <= 0) return false;
        if (isToday) {
          const [h, m] = s.time.split(':').map(Number);
          if (h * 60 + m <= nowMinutes) return false;
        }
        return true;
      });

    const response = NextResponse.json({ slots: availableSlots });
    response.headers.set('Cache-Control', 'public, s-maxage=10, stale-while-revalidate=30');
    return response;
  } catch {
    return NextResponse.json({ error: 'Something went wrong' }, { status: 500 });
  }
}
