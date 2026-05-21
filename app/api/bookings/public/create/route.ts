import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { initializePayment } from '@/lib/bot/flows/shared/payment';
import { rateLimitResponse, getRateLimitKey } from '@/lib/rate-limit';

/**
 * POST /api/bookings/public/create
 * Create a public booking (no auth required — guest booking).
 * Rate limited: 10/min per IP.
 */
export async function POST(request: NextRequest) {
  // Rate limit: 10 per minute per IP
  const rateLimited = rateLimitResponse(getRateLimitKey(request, 'public-booking'), 10, 60_000);
  if (rateLimited) return rateLimited;

  try {
    const body = await request.json();
    const {
      businessSlug,
      serviceId,
      date,
      time,
      guestName,
      guestEmail,
      guestPhone,
      quantity,
    } = body as {
      businessSlug: string;
      serviceId: string;
      date: string;
      time: string;
      guestName: string;
      guestEmail: string;
      guestPhone?: string;
      quantity?: number;
    };

    // Basic validation
    if (!businessSlug || !serviceId || !date || !time || !guestName || !guestEmail) {
      return NextResponse.json(
        { error: 'Missing required fields' },
        { status: 400 },
      );
    }

    // Validate date format
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return NextResponse.json({ error: 'Invalid date format' }, { status: 400 });
    }

    // Validate time format
    if (!/^\d{2}:\d{2}$/.test(time)) {
      return NextResponse.json({ error: 'Invalid time format' }, { status: 400 });
    }

    // Date must not be in the past
    const today = new Date().toISOString().split('T')[0];
    if (date < today) {
      return NextResponse.json({ error: 'Cannot book in the past' }, { status: 400 });
    }

    // Sanitize email
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(guestEmail)) {
      return NextResponse.json({ error: 'Invalid email address' }, { status: 400 });
    }

    const partySize = Math.max(1, Math.min(quantity || 1, 50));

    const supabase = createServiceClient();

    // Fetch business
    const { data: business, error: bizError } = await supabase
      .from('businesses')
      .select('id, name, slug, country_code, operating_hours, payment_gateway, subscription_tier, metadata, owner_id')
      .eq('slug', businessSlug)
      .single();

    if (bizError || !business) {
      return NextResponse.json({ error: 'Business not found' }, { status: 404 });
    }

    // Fetch service
    const { data: service, error: svcError } = await supabase
      .from('services')
      .select('id, name, price, deposit_amount, duration_minutes, buffer_minutes, max_capacity, metadata')
      .eq('id', serviceId)
      .eq('business_id', business.id)
      .eq('is_active', true)
      .single();

    if (svcError || !service) {
      return NextResponse.json({ error: 'Service not found' }, { status: 404 });
    }

    // Validate time is within operating hours
    const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const selectedDay = dayNames[new Date(date + 'T00:00').getDay()];
    const opHours = (business.operating_hours || {}) as Record<
      string,
      { open?: string; close?: string; closed?: boolean }
    >;
    const dayHours = opHours[selectedDay];

    if (dayHours?.closed) {
      return NextResponse.json({ error: 'Business is closed on this day' }, { status: 400 });
    }

    const openTime = dayHours?.open || '08:00';
    const closeTime = dayHours?.close || '22:00';
    const [tH, tM] = time.split(':').map(Number);
    const timeMinutes = tH * 60 + tM;
    const [oH, oM] = openTime.split(':').map(Number);
    const [cH, cM] = closeTime.split(':').map(Number);

    if (timeMinutes < oH * 60 + oM || timeMinutes >= cH * 60 + cM) {
      return NextResponse.json({ error: 'Time is outside operating hours' }, { status: 400 });
    }

    // If booking today, ensure time is not in the past
    if (date === today) {
      const now = new Date();
      const nowMinutes = now.getHours() * 60 + now.getMinutes();
      if (timeMinutes <= nowMinutes) {
        return NextResponse.json({ error: 'Cannot book a past time slot' }, { status: 400 });
      }
    }

    // Find or create user by email for the guest
    let userId = business.owner_id; // Fallback: attribute to business owner

    const { data: existingUser } = await supabase
      .from('users')
      .select('id')
      .eq('email', guestEmail.toLowerCase())
      .maybeSingle();

    if (existingUser) {
      userId = existingUser.id;
    }

    // Determine pricing
    const svcMeta = (service.metadata || {}) as Record<string, unknown>;
    const isDropoff = svcMeta.is_dropoff === true;
    const maxCapacity = isDropoff ? 9999 : (service.max_capacity || 1);
    const depositAmount = service.deposit_amount || service.price || 0;
    const totalDeposit = depositAmount * partySize;

    // Use atomic booking RPC to prevent race conditions
    const { data: slotResult, error: slotError } = await supabase
      .rpc('book_slot_atomic' as string, {
        p_business_id: business.id,
        p_user_id: userId,
        p_service_id: serviceId,
        p_staff_id: null,
        p_date: date,
        p_time: isDropoff ? '00:00' : time,
        p_party_size: partySize,
        p_max_capacity: maxCapacity,
        p_flow_type: 'scheduling',
        p_deposit_amount: totalDeposit,
        p_deposit_status: totalDeposit > 0 ? 'pending' : 'none',
        p_status: totalDeposit > 0 ? 'pending' : 'confirmed',
        p_guest_name: guestName.trim(),
        p_guest_phone: guestPhone ? (guestPhone.startsWith('+') ? guestPhone : `+${guestPhone}`) : null,
        p_guest_email: guestEmail.toLowerCase(),
        p_special_requests: null,
        p_venue_address: null,
        p_end_date: null,
        p_addons_snapshot: null,
        p_promo_code_id: null,
        p_total_amount: totalDeposit,
        p_staff_name: null,
        p_channel: 'web',
      })
      .single() as {
        data: { booking_id: string; reference_code: string; slot_available: boolean } | null;
        error: unknown;
      };

    if (slotError || !slotResult) {
      console.error('[PUBLIC_BOOKING] Failed to create booking:', slotError);
      return NextResponse.json({ error: 'Failed to create booking' }, { status: 500 });
    }

    if (!slotResult.slot_available) {
      return NextResponse.json(
        { error: 'This time slot is no longer available. Please choose another.' },
        { status: 409 },
      );
    }

    // If deposit > 0, initialize payment
    if (totalDeposit > 0) {
      const paymentResult = await initializePayment(supabase, {
        bookingId: slotResult.booking_id,
        userId,
        amount: totalDeposit,
        referenceCode: slotResult.reference_code,
        businessName: business.name,
        phone: guestPhone || '',
        userEmail: guestEmail.toLowerCase(),
        countryCode: business.country_code || 'NG',
        gatewayOverride: business.payment_gateway || null,
        businessId: business.id,
      });

      if (paymentResult) {
        return NextResponse.json({
          success: true,
          bookingId: slotResult.booking_id,
          referenceCode: slotResult.reference_code,
          paymentUrl: paymentResult.url,
          paymentReference: paymentResult.reference,
        });
      }

      // Payment init failed — booking still exists as pending
      return NextResponse.json(
        { error: 'Payment initialization failed. Please try again.' },
        { status: 500 },
      );
    }

    // Free service — booking is confirmed
    return NextResponse.json({
      success: true,
      bookingId: slotResult.booking_id,
      referenceCode: slotResult.reference_code,
    });
  } catch {
    return NextResponse.json({ error: 'Something went wrong' }, { status: 500 });
  }
}
