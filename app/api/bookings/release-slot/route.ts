import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { logger } from '@/lib/logger';

/**
 * POST /api/bookings/release-slot
 *
 * Server-side wrapper for `release_booking_slot` RPC.
 * The browser must NOT call the SECURITY DEFINER function directly.
 * This route authenticates the user, verifies business ownership,
 * loads the booking data from the DB (trusted), and calls the RPC
 * via the service client.
 */
export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    let body: { bookingId?: string; table?: 'bookings' | 'reservations' };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }

    const { bookingId, table } = body;
    if (!bookingId || typeof bookingId !== 'string') {
      return NextResponse.json({ error: 'Missing bookingId' }, { status: 400 });
    }

    const service = createServiceClient();

    // Load the booking from the trusted DB and verify ownership
    if (table === 'reservations') {
      // Reservations use check_in as date and don't have a time/staff_id for slot release
      // Slot release is only relevant for bookings (appointments/scheduling)
      return NextResponse.json({ error: 'Slot release not applicable to reservations' }, { status: 400 });
    }

    const { data: booking, error: fetchError } = await service
      .from('bookings')
      .select('id, business_id, date, time, staff_id, businesses(owner_id)')
      .eq('id', bookingId)
      .single();

    if (fetchError || !booking) {
      return NextResponse.json({ error: 'Booking not found' }, { status: 404 });
    }

    const biz = booking.businesses as unknown as { owner_id: string } | null;
    if (!biz || biz.owner_id !== user.id) {
      return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
    }

    // Validate required slot data exists
    if (!booking.date || !booking.time) {
      // No slot to release — not an error, just a no-op
      return NextResponse.json({ success: true, released: false });
    }

    // Call the SECURITY DEFINER RPC with trusted data via service client
    const { error: rpcError } = await service.rpc('release_booking_slot', {
      p_business_id: booking.business_id,
      p_date: booking.date,
      p_start_time: booking.time,
      p_staff_id: booking.staff_id || null,
    });

    if (rpcError) {
      logger.error('[RELEASE-SLOT] RPC error:', rpcError);
      return NextResponse.json({ error: 'Failed to release slot' }, { status: 500 });
    }

    return NextResponse.json({ success: true, released: true });
  } catch (error) {
    logger.error('[RELEASE-SLOT] Error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
