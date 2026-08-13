import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { generateTimeSlots } from '@/lib/constants';
import { rateLimitResponseAsync, getRateLimitKey } from '@/lib/rate-limit';

/**
 * GET /api/bookings/public/slots?businessId=X&serviceId=Y&date=YYYY-MM-DD
 * GET /api/bookings/public/slots?businessId=X&appointmentId=Y&date=YYYY-MM-DD
 *
 * Returns available time slots for a given business, service/appointment, and date.
 *
 * Availability rules match the canonical book_slot_atomic authority:
 * - Capacity: count ALL active bookings at each time (cross-service)
 * - Buffer: bidirectional overlap — a candidate is blocked if its
 *   [time, time+duration) range (with buffer margin) overlaps any
 *   existing booking's [time, time+duration) range (with buffer margin)
 */
export async function GET(request: NextRequest) {
  const rateLimit = await rateLimitResponseAsync(getRateLimitKey(request, 'bookings-public-slots'), 60, 60_000);
  if (rateLimit) return rateLimit;

  try {
    const { searchParams } = request.nextUrl;
    const businessId = searchParams.get('businessId');
    const serviceId = searchParams.get('serviceId');
    const appointmentId = searchParams.get('appointmentId');
    const date = searchParams.get('date');

    if (!businessId || !date) {
      return NextResponse.json(
        { error: 'Missing required params: businessId, serviceId or appointmentId, date' },
        { status: 400 },
      );
    }
    if (!serviceId && !appointmentId) {
      return NextResponse.json(
        { error: 'Exactly one of serviceId or appointmentId is required' },
        { status: 400 },
      );
    }
    if (serviceId && appointmentId) {
      return NextResponse.json(
        { error: 'Provide serviceId or appointmentId, not both' },
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

    // Fetch bookable item details — service or appointment
    let itemDuration: number;
    let itemBuffer: number;
    let itemMaxCapacity: number | null;
    let itemMetadata: Record<string, unknown> | null;
    // Appointment-specific availability overrides
    let itemAvailableDays: string[] | null = null;
    let itemAvailableFrom: string | null = null;
    let itemAvailableTo: string | null = null;

    if (appointmentId) {
      const { data: appt, error: apptError } = await supabase
        .from('appointments')
        .select('duration_minutes, buffer_minutes, max_capacity, metadata, available_days, available_from, available_to')
        .eq('id', appointmentId)
        .eq('business_id', businessId)
        .eq('is_active', true)
        .single();

      if (apptError || !appt) {
        return NextResponse.json({ error: 'Appointment type not found' }, { status: 404 });
      }
      itemDuration = appt.duration_minutes || 30;
      itemBuffer = appt.buffer_minutes || 0;
      itemMaxCapacity = appt.max_capacity;
      itemMetadata = appt.metadata as Record<string, unknown> | null;
      itemAvailableDays = appt.available_days;
      itemAvailableFrom = appt.available_from;
      itemAvailableTo = appt.available_to;
    } else {
      const { data: service, error: svcError } = await supabase
        .from('services')
        .select('duration_minutes, buffer_minutes, max_capacity, metadata')
        .eq('id', serviceId!)
        .eq('business_id', businessId)
        .eq('is_active', true)
        .single();

      if (svcError || !service) {
        return NextResponse.json({ error: 'Service not found' }, { status: 404 });
      }
      itemDuration = service.duration_minutes || 30;
      itemBuffer = service.buffer_minutes || 0;
      itemMaxCapacity = service.max_capacity;
      itemMetadata = service.metadata as Record<string, unknown> | null;
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

    // Check appointment-specific available_days restriction
    if (itemAvailableDays && itemAvailableDays.length > 0) {
      if (!itemAvailableDays.includes(selectedDay)) {
        return NextResponse.json({ slots: [] });
      }
    }

    // Use appointment-specific hours if set, otherwise business operating hours
    const openTime = itemAvailableFrom || dayHours?.open || '08:00';
    const closeTime = itemAvailableTo || dayHours?.close || '22:00';

    // Determine slot interval from item duration or business metadata
    const bizMeta = (business.metadata || {}) as Record<string, unknown>;
    const slotInterval =
      (bizMeta.slot_interval_minutes as number) || itemDuration || 60;

    // Generate all possible slots
    const allSlots = generateTimeSlots(openTime, closeTime, slotInterval);

    // For drop-off services, skip time selection (all slots available with high capacity)
    const isDropoff = itemMetadata?.is_dropoff === true;
    const maxCapacity = isDropoff ? 9999 : (itemMaxCapacity || 1);

    // Candidate slot duration and buffer
    const candidateDuration = itemDuration;
    const candidateBuffer = itemBuffer;

    // Fetch ALL existing bookings for this business+date (cross-service, matching book_slot_atomic)
    // book_slot_atomic does NOT filter by service_id — capacity is business-wide per time slot
    const { data: existingBookings } = await supabase
      .from('bookings')
      .select('time, staff_id, services(duration_minutes, buffer_minutes)')
      .eq('business_id', businessId)
      .eq('date', date)
      .in('status', ['confirmed', 'pending', 'in_progress']);

    // For each candidate slot, check availability using the same rules as book_slot_atomic:
    //
    // 1. CAPACITY: count bookings at exact same time (no staff filter for public booking)
    //    Matches: WHERE time = p_time AND (p_staff_id IS NULL OR staff_id = p_staff_id)
    //    Public booking has no staff_id → counts ALL bookings at that time
    //
    // 2. BUFFER OVERLAP: bidirectional check for bookings at DIFFERENT times
    //    candidateTime < (existingTime + existingDuration + buffer)
    //    AND (candidateTime + candidateDuration) > (existingTime - buffer)
    //    Matches book_slot_atomic lines 153-155
    const now = new Date();
    const isToday = date === today;
    const nowMinutes = now.getHours() * 60 + now.getMinutes();

    const availableSlots = allSlots
      .map((slotTime) => {
        const [sH, sM] = slotTime.split(':').map(Number);
        const slotMinutes = sH * 60 + sM;

        // 1. Exact-time capacity count (matching book_slot_atomic capacity check)
        let exactCount = 0;
        for (const b of existingBookings || []) {
          if (!b.time) continue;
          const bTimeStr = typeof b.time === 'string' ? b.time.slice(0, 5) : '';
          if (bTimeStr === slotTime) {
            exactCount++;
          }
        }

        if (exactCount >= maxCapacity) {
          return { time: slotTime, available: 0 };
        }

        // 2. Buffer overlap check (matching book_slot_atomic buffer check)
        if (candidateBuffer > 0) {
          let bufferBlocked = false;
          for (const b of existingBookings || []) {
            if (!b.time) continue;
            const bTimeStr = typeof b.time === 'string' ? b.time.slice(0, 5) : '';
            if (bTimeStr === slotTime) continue; // same-time handled by capacity above

            const [bH, bM] = bTimeStr.split(':').map(Number);
            const existingMinutes = bH * 60 + bM;

            const svc = b.services as unknown as {
              duration_minutes?: number;
              buffer_minutes?: number;
            } | null;
            const existingDuration = svc?.duration_minutes || candidateDuration;

            // Bidirectional overlap with buffer:
            // candidate < (existing + existingDuration + buffer)
            // AND (candidate + candidateDuration) > (existing - buffer)
            if (
              slotMinutes < existingMinutes + existingDuration + candidateBuffer &&
              slotMinutes + candidateDuration > existingMinutes - candidateBuffer
            ) {
              bufferBlocked = true;
              break;
            }
          }
          if (bufferBlocked) {
            return { time: slotTime, available: 0 };
          }
        }

        return { time: slotTime, available: maxCapacity - exactCount };
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
