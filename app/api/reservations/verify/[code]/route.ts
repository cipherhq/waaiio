import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { rateLimitResponse, getRateLimitKey } from '@/lib/rate-limit';

/**
 * GET /api/reservations/verify/[code]
 * Returns reservation details + validity status.
 * Optional ?business_id= param to verify reservation belongs to the scanning business.
 * Without business_id, guest phone is masked for privacy.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ code: string }> },
) {
  const rateLimit = rateLimitResponse(getRateLimitKey(req, 'reservation-verify'), 30, 60_000);
  if (rateLimit) return rateLimit;

  const { code } = await params;
  const businessId = req.nextUrl.searchParams.get('business_id');
  const supabase = createServiceClient();

  const { data: reservation, error } = await supabase
    .from('reservations')
    .select(`
      id,
      reference_code,
      guest_name,
      guest_phone,
      guest_email,
      check_in,
      check_out,
      nights,
      guests,
      status,
      checked_in_at,
      checked_in_by,
      checked_out_at,
      total_amount,
      nightly_rate,
      special_requests,
      business_id,
      property:properties!property_id (
        id,
        name,
        address
      )
    `)
    .eq('reference_code', code.toUpperCase())
    .single();

  if (error || !reservation) {
    return NextResponse.json(
      { valid: false, error: 'Reservation not found' },
      { status: 404 },
    );
  }

  const property = reservation.property as any;

  // If business_id provided, verify reservation belongs to this business
  if (businessId && reservation.business_id !== businessId) {
    return NextResponse.json(
      { valid: false, error: 'This reservation is not for your property' },
      { status: 403 },
    );
  }

  // Mask guest phone if no business_id (public/self-checkin view)
  const guestPhone = businessId ? (reservation.guest_phone || '') : undefined;

  // Fetch business name
  const { data: biz } = await supabase
    .from('businesses')
    .select('name')
    .eq('id', reservation.business_id)
    .single();

  return NextResponse.json({
    valid: reservation.status === 'confirmed' || reservation.status === 'checked_in',
    reservation: {
      reference_code: reservation.reference_code,
      guest_name: reservation.guest_name || '',
      guest_phone: guestPhone,
      guest_email: businessId ? (reservation.guest_email || '') : undefined,
      property_name: property?.name || '',
      property_address: property?.address || '',
      property_id: property?.id || '',
      business_name: biz?.name || '',
      check_in: reservation.check_in,
      check_out: reservation.check_out,
      nights: reservation.nights,
      guests: reservation.guests,
      status: reservation.status,
      checked_in_at: reservation.checked_in_at,
      checked_in_by: reservation.checked_in_by,
      checked_out_at: reservation.checked_out_at,
      total_amount: reservation.total_amount,
      special_requests: businessId ? reservation.special_requests : undefined,
    },
  });
}

/**
 * POST /api/reservations/verify/[code]
 * Check in or check out a guest.
 * Body: { scanned_by?, business_id?, action?: 'checkin' | 'checkout' }
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ code: string }> },
) {
  // Rate limit: 5 check-in attempts per minute per IP
  const rateLimit = rateLimitResponse(getRateLimitKey(req, 'reservation-checkin'), 5, 60_000);
  if (rateLimit) return rateLimit;

  const { code } = await params;
  const supabase = createServiceClient();

  // Read body
  let scannedBy: string | null = null;
  let businessId: string | null = null;
  let action: 'checkin' | 'checkout' = 'checkin';
  try {
    const body = await req.json();
    scannedBy = body.scanned_by || null;
    businessId = body.business_id || null;
    action = body.action === 'checkout' ? 'checkout' : 'checkin';
  } catch {
    // No body is fine
  }

  // Fetch reservation
  const { data: reservation, error } = await supabase
    .from('reservations')
    .select('id, status, check_in, check_out, checked_in_at, checked_out_at, checked_in_by, guest_name, business_id')
    .eq('reference_code', code.toUpperCase())
    .single();

  if (error || !reservation) {
    return NextResponse.json(
      { success: false, error: 'Reservation not found' },
      { status: 404 },
    );
  }

  // Verify business ownership if provided
  if (businessId && reservation.business_id !== businessId) {
    return NextResponse.json(
      { success: false, error: 'This reservation is not for your property' },
      { status: 403 },
    );
  }

  // ─── CHECKOUT FLOW ───
  if (action === 'checkout') {
    if (!['checked_in', 'in_progress'].includes(reservation.status)) {
      return NextResponse.json(
        { success: false, error: 'Guest is not currently checked in' },
        { status: 400 },
      );
    }

    if (reservation.checked_out_at) {
      return NextResponse.json(
        { success: false, error: 'Guest has already checked out' },
        { status: 409 },
      );
    }

    const { error: updateError } = await supabase
      .from('reservations')
      .update({
        status: 'completed',
        checked_out_at: new Date().toISOString(),
      })
      .eq('id', reservation.id);

    if (updateError) {
      return NextResponse.json(
        { success: false, error: 'Failed to check out. Please try again.' },
        { status: 500 },
      );
    }

    return NextResponse.json({ success: true, action: 'checkout' });
  }

  // ─── CHECKIN FLOW ───

  // Must be confirmed to check in
  if (reservation.status !== 'confirmed') {
    if (['checked_in', 'in_progress'].includes(reservation.status)) {
      return NextResponse.json(
        {
          success: false,
          error: `This guest was already checked in${reservation.checked_in_at ? ` at ${new Date(reservation.checked_in_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}` : ''}${reservation.checked_in_by ? ` by ${reservation.checked_in_by}` : ''}`,
          checked_in_at: reservation.checked_in_at,
          checked_in_by: reservation.checked_in_by,
        },
        { status: 409 },
      );
    }

    if (reservation.status === 'cancelled') {
      return NextResponse.json(
        { success: false, error: 'This reservation has been cancelled' },
        { status: 410 },
      );
    }

    if (reservation.status === 'pending') {
      return NextResponse.json(
        { success: false, error: 'This reservation has not been confirmed yet. Please confirm it first.' },
        { status: 400 },
      );
    }

    return NextResponse.json(
      { success: false, error: `Cannot check in — reservation status is "${reservation.status}"` },
      { status: 400 },
    );
  }

  // Duplicate check-in prevention
  if (reservation.checked_in_at) {
    return NextResponse.json(
      {
        success: false,
        error: `This guest was already checked in${reservation.checked_in_at ? ` at ${new Date(reservation.checked_in_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}` : ''}`,
        checked_in_at: reservation.checked_in_at,
        checked_in_by: reservation.checked_in_by,
      },
      { status: 409 },
    );
  }

  // Date check: allow check-in on check_in date or 1 day before (early buffer)
  if (reservation.check_in) {
    const checkInDate = new Date(reservation.check_in + 'T00:00:00');
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    // 1 day early buffer
    const earliestCheckin = new Date(checkInDate.getTime() - 24 * 60 * 60 * 1000);

    if (today < earliestCheckin) {
      return NextResponse.json(
        {
          success: false,
          error: `Check-in is not available yet. It opens on ${new Date(earliestCheckin.getTime()).toLocaleDateString('en-US', { weekday: 'long', day: 'numeric', month: 'long' })}.`,
        },
        { status: 403 },
      );
    }
  }

  // Mark as checked in
  const { error: updateError } = await supabase
    .from('reservations')
    .update({
      status: 'checked_in',
      checked_in_at: new Date().toISOString(),
      checked_in_by: scannedBy || 'self',
    })
    .eq('id', reservation.id);

  if (updateError) {
    return NextResponse.json(
      { success: false, error: 'Failed to check in. Please try again.' },
      { status: 500 },
    );
  }

  return NextResponse.json({ success: true, action: 'checkin' });
}
