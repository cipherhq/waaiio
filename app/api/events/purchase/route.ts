import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { initializePayment } from '@/lib/bot/flows/shared/payment';
import { rateLimitResponseAsync, getRateLimitKey } from '@/lib/rate-limit';
import { verifyOtpToken } from '@/lib/otp-token';

export async function POST(request: NextRequest) {
  // Rate limit: 10/min per IP
  const rlKey = getRateLimitKey(request, 'event-purchase');
  const rlResponse = await rateLimitResponseAsync(rlKey, 10, 60_000);
  if (rlResponse) return rlResponse;

  let body: {
    eventSlug?: string;
    ticketTypeId?: string;
    quantity?: number;
    guestName?: string;
    guestEmail?: string;
    guestPhone?: string;
    otpToken?: string;
  };

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const { eventSlug, ticketTypeId, quantity, guestName, guestEmail, guestPhone, otpToken } = body;

  // ── Field-level validation ──
  const vErrors: Record<string, string> = {};

  if (!eventSlug || typeof eventSlug !== 'string' || !eventSlug.trim()) {
    vErrors.eventSlug = 'Event slug is required';
  }
  if (!guestName || typeof guestName !== 'string' || !guestName.trim()) {
    vErrors.guestName = 'Guest name is required';
  } else if (guestName.trim().length > 200) {
    vErrors.guestName = 'Guest name must be 200 characters or less';
  }
  if (!guestEmail || typeof guestEmail !== 'string') {
    vErrors.guestEmail = 'Email is required';
  } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(guestEmail)) {
    vErrors.guestEmail = 'Invalid email address';
  }
  if (quantity === undefined || quantity === null) {
    vErrors.quantity = 'Quantity is required';
  } else if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity < 1 || quantity > 20) {
    vErrors.quantity = 'Quantity must be an integer between 1 and 20';
  }
  if (ticketTypeId !== undefined && ticketTypeId !== null) {
    if (typeof ticketTypeId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ticketTypeId)) {
      vErrors.ticketTypeId = 'Ticket type ID must be a valid UUID';
    }
  }
  if (guestPhone !== undefined && guestPhone !== null && typeof guestPhone !== 'string') {
    vErrors.guestPhone = 'Phone must be a string';
  }

  if (Object.keys(vErrors).length > 0) {
    return NextResponse.json(
      { error: 'Validation failed', fields: vErrors },
      { status: 400 },
    );
  }

  // After validation, these are guaranteed to be present
  const validatedEmail = guestEmail as string;
  const validatedQuantity = quantity as number;
  const validatedName = guestName as string;
  const validatedSlug = eventSlug as string;

  // Verify server-side OTP token (proves email was verified)
  if (!otpToken) {
    return NextResponse.json({ error: 'Email verification required' }, { status: 403 });
  }
  const verifiedEmail = verifyOtpToken(otpToken);
  if (!verifiedEmail || verifiedEmail !== validatedEmail.toLowerCase().trim()) {
    return NextResponse.json({ error: 'Email verification expired or invalid' }, { status: 403 });
  }

  const supabase = createServiceClient();

  // 1. Fetch event + business
  const { data: event, error: eventError } = await supabase
    .from('events')
    .select(`
      id, name, price, total_tickets, tickets_sold, status, max_per_order, date, time,
      businesses!inner (
        id, name, slug, country_code, payment_gateway
      )
    `)
    .eq('slug', validatedSlug)
    .eq('status', 'published')
    .gte('date', new Date().toISOString().split('T')[0])
    .single();

  if (eventError || !event) {
    return NextResponse.json({ error: 'Event not found or not published' }, { status: 404 });
  }

  const business = event.businesses as unknown as {
    id: string;
    name: string;
    slug: string;
    country_code: string;
    payment_gateway: string | null;
  };

  // Check max_per_order
  const maxAllowed = event.max_per_order || 10;
  if (validatedQuantity > maxAllowed) {
    return NextResponse.json(
      { error: `Maximum ${maxAllowed} tickets per order` },
      { status: 400 },
    );
  }

  // Determine price from ticket type or event
  let unitPrice = event.price;
  if (ticketTypeId) {
    const { data: tt } = await supabase
      .from('event_ticket_types')
      .select('id, price, total_tickets, tickets_sold, is_active')
      .eq('id', ticketTypeId)
      .single();

    if (!tt || !tt.is_active) {
      return NextResponse.json({ error: 'Ticket type not found or unavailable' }, { status: 404 });
    }

    const ttAvailable = tt.total_tickets - tt.tickets_sold;
    if (ttAvailable < validatedQuantity) {
      return NextResponse.json({ error: 'Sold out' }, { status: 409 });
    }

    unitPrice = tt.price;
  } else {
    // Check general availability
    const available = event.total_tickets - event.tickets_sold;
    if (available < validatedQuantity) {
      return NextResponse.json({ error: 'Sold out' }, { status: 409 });
    }
  }

  const totalAmount = unitPrice * validatedQuantity;

  // 2. Find or create user by email (email is verified via OTP)
  let userId: string;
  const emailLower = validatedEmail.toLowerCase();
  const phoneClean = guestPhone ? `+${guestPhone.replace(/[^0-9]/g, '')}` : null;

  // Look up by email first (most reliable — verified via OTP)
  const { data: byEmail } = await supabase
    .from('profiles')
    .select('id')
    .eq('email', emailLower)
    .limit(1)
    .maybeSingle();

  // If not found by email, try phone
  const { data: byPhone } = !byEmail && phoneClean
    ? await supabase.from('profiles').select('id').eq('phone', phoneClean).limit(1).maybeSingle()
    : { data: null };

  if (byEmail) {
    userId = byEmail.id;
  } else if (byPhone) {
    userId = byPhone.id;
    // Update their email since we verified it
    await supabase.from('profiles').update({ email: emailLower }).eq('id', byPhone.id);
  } else {
    // Create new auth user
    const nameParts = validatedName.trim().split(/\s+/);
    const firstName = nameParts[0] || validatedName;
    const lastName = nameParts.slice(1).join(' ') || '';

    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email: emailLower,
      email_confirm: true,
      user_metadata: { first_name: firstName, last_name: lastName },
    });

    if (authError || !authData?.user) {
      // Race condition — user may have been created between our check and now
      const { data: retry } = await supabase.from('profiles').select('id').eq('email', emailLower).maybeSingle();
      if (retry) {
        userId = retry.id;
      } else {
        console.error('[EVENT-PURCHASE] Failed to create user:', authError?.message);
        return NextResponse.json({ error: 'Failed to create account. Please try again.' }, { status: 500 });
      }
    } else {
      userId = authData.user.id;
      await supabase.from('profiles').update({
        first_name: firstName, last_name: lastName, email: emailLower,
      }).eq('id', authData.user.id);
    }
  }

  // 3. Call atomic purchase function
  const { data: result, error: rpcError } = await supabase
    .rpc('purchase_tickets_atomic', {
      p_business_id: business.id,
      p_event_id: event.id,
      p_ticket_type_id: ticketTypeId || null,
      p_quantity: validatedQuantity,
      p_user_id: userId,
      p_guest_name: validatedName,
      p_guest_phone: guestPhone || '',
      p_guest_email: validatedEmail.toLowerCase(),
      p_total_amount: totalAmount,
      p_channel: 'web',
    });

  if (rpcError) {
    console.error('[EVENT-PURCHASE] RPC error:', rpcError.message);
    return NextResponse.json({ error: 'Something went wrong' }, { status: 500 });
  }

  const row = Array.isArray(result) ? result[0] : result;

  if (!row?.tickets_available) {
    return NextResponse.json({ error: 'Sold out' }, { status: 409 });
  }

  const bookingId = row.booking_id;
  const referenceCode = row.reference_code;

  // 4. If free event, return success immediately
  if (totalAmount <= 0) {
    return NextResponse.json({
      success: true,
      bookingId,
      referenceCode,
      free: true,
    });
  }

  // 5. Paid event: initialize payment
  const paymentResult = await initializePayment(supabase, {
    bookingId,
    userId,
    amount: totalAmount,
    referenceCode,
    businessName: business.name,
    phone: guestPhone || '',
    userEmail: validatedEmail.toLowerCase(),
    countryCode: business.country_code || 'US',
    businessId: business.id,
  });

  if (!paymentResult) {
    console.error('[EVENT-PURCHASE] Payment initialization failed for booking:', bookingId);
    return NextResponse.json({ error: 'Payment initialization failed' }, { status: 500 });
  }

  return NextResponse.json({
    success: true,
    bookingId,
    referenceCode,
    url: paymentResult.url,
    reference: paymentResult.reference,
  });
}
