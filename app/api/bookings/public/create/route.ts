import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { initializePayment } from '@/lib/bot/flows/shared/payment';
import { rateLimitResponseAsync, getRateLimitKey } from '@/lib/rate-limit';
import { verifyOtpToken } from '@/lib/otp-token';

/**
 * POST /api/bookings/public/create
 * Create a public booking (no auth required — guest booking).
 * Rate limited: 10/min per IP.
 */
export async function POST(request: NextRequest) {
  // Rate limit: 10 per minute per IP
  const rateLimited = await rateLimitResponseAsync(getRateLimitKey(request, 'public-booking'), 10, 60_000);
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
      otpToken,
    } = body as {
      businessSlug: string;
      serviceId: string;
      date: string;
      time: string;
      guestName: string;
      guestEmail: string;
      guestPhone?: string;
      quantity?: number;
      otpToken?: string;
    };

    // ── Field-level validation ──
    const vErrors: Record<string, string> = {};

    if (!businessSlug || typeof businessSlug !== 'string') vErrors.businessSlug = 'Business slug is required';
    if (!serviceId || typeof serviceId !== 'string') {
      vErrors.serviceId = 'Service ID is required';
    } else if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(serviceId)) {
      vErrors.serviceId = 'Service ID must be a valid UUID';
    }
    if (!date || typeof date !== 'string') vErrors.date = 'Date is required';
    if (!time || typeof time !== 'string') vErrors.time = 'Time is required';
    if (!guestName || typeof guestName !== 'string' || !guestName.trim()) {
      vErrors.guestName = 'Guest name is required';
    } else if (guestName.trim().length > 200) {
      vErrors.guestName = 'Guest name must be 200 characters or less';
    }
    if (!guestEmail || typeof guestEmail !== 'string') vErrors.guestEmail = 'Email is required';
    if (guestPhone !== undefined && guestPhone !== null && typeof guestPhone !== 'string') {
      vErrors.guestPhone = 'Phone must be a string';
    }
    if (quantity !== undefined && quantity !== null) {
      if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity < 1) {
        vErrors.quantity = 'Quantity must be a positive integer';
      } else if (quantity > 50) {
        vErrors.quantity = 'Quantity cannot exceed 50';
      }
    }

    if (Object.keys(vErrors).length > 0) {
      return NextResponse.json(
        { error: 'Validation failed', fields: vErrors },
        { status: 400 },
      );
    }

    // Verify server-side OTP token (proves email was verified)
    if (!otpToken) {
      return NextResponse.json({ error: 'Email verification required' }, { status: 403 });
    }
    const verifiedEmail = verifyOtpToken(otpToken);
    if (!verifiedEmail || verifiedEmail !== guestEmail.toLowerCase().trim()) {
      return NextResponse.json({ error: 'Email verification expired or invalid' }, { status: 403 });
    }

    // Validate date format
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return NextResponse.json({ error: 'Invalid date format' }, { status: 400 });
    }

    // Validate time format (00:00 - 23:59)
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
      return NextResponse.json({ error: 'Invalid time format' }, { status: 400 });
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
      .select('id, name, slug, country_code, operating_hours, payment_gateway, subscription_tier, metadata, owner_id, timezone')
      .eq('slug', businessSlug)
      .eq('is_active', true)
      .eq('status', 'active')
      .single();

    if (bizError || !business) {
      return NextResponse.json({ error: 'Business not found' }, { status: 404 });
    }

    // Date must not be in the past (timezone-aware)
    const businessTimezone = (business as Record<string, unknown>).timezone as string || 'UTC';
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: businessTimezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    if (date < today) {
      return NextResponse.json({ error: 'Cannot book in the past' }, { status: 400 });
    }

    // Capability check: scheduling or appointment must be enabled
    const { data: schedCap } = await supabase
      .from('business_capabilities')
      .select('id')
      .eq('business_id', business.id)
      .eq('capability', 'scheduling')
      .eq('is_enabled', true)
      .maybeSingle();
    if (!schedCap) {
      const { data: apptCap } = await supabase
        .from('business_capabilities')
        .select('id')
        .eq('business_id', business.id)
        .eq('capability', 'appointment')
        .eq('is_enabled', true)
        .maybeSingle();
      if (!apptCap) {
        return NextResponse.json({ error: 'This business does not accept online bookings' }, { status: 403 });
      }
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

    // If booking today, ensure time is not in the past (in business timezone)
    if (date === today) {
      const nowParts = new Intl.DateTimeFormat('en-GB', {
        timeZone: businessTimezone, hour: '2-digit', minute: '2-digit', hour12: false,
      }).format(new Date());
      const [nowH, nowM] = nowParts.split(':').map(Number);
      const nowMinutes = nowH * 60 + nowM;
      if (timeMinutes <= nowMinutes) {
        return NextResponse.json({ error: 'Cannot book a past time slot' }, { status: 400 });
      }
    }

    // Find or create user by email (verified via OTP)
    let userId: string;
    const emailLower = guestEmail.toLowerCase();
    const phoneClean = guestPhone ? `+${guestPhone.replace(/[^0-9]/g, '')}` : null;

    const { data: byEmail } = await supabase.from('profiles').select('id').eq('email', emailLower).limit(1).maybeSingle();
    const { data: byPhone } = !byEmail && phoneClean
      ? await supabase.from('profiles').select('id').eq('phone', phoneClean).limit(1).maybeSingle()
      : { data: null };

    if (byEmail) {
      userId = byEmail.id;
    } else if (byPhone) {
      userId = byPhone.id;
      await supabase.from('profiles').update({ email: emailLower }).eq('id', byPhone.id);
    } else {
      const nameParts = guestName.trim().split(/\s+/);
      const firstName = nameParts[0] || guestName;
      const lastName = nameParts.slice(1).join(' ') || '';
      const { data: authData, error: authError } = await supabase.auth.admin.createUser({
        email: emailLower, email_confirm: true,
        user_metadata: { first_name: firstName, last_name: lastName },
      });
      if (authError || !authData?.user) {
        const { data: retry } = await supabase.from('profiles').select('id').eq('email', emailLower).maybeSingle();
        if (retry) { userId = retry.id; }
        else { return NextResponse.json({ error: 'Failed to create account' }, { status: 500 }); }
      } else {
        userId = authData.user.id;
        await supabase.from('profiles').update({ first_name: firstName, last_name: lastName, email: emailLower }).eq('id', authData.user.id);
      }
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
        p_appointment_id: null,
        p_buffer_minutes: service.buffer_minutes || 0,
        p_duration: service.duration_minutes || 30,
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
