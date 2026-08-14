import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { requireCapability } from '@/lib/capabilities/api-guard';
import { rateLimitResponseAsync, getRateLimitKey } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';

// ── GET: Get session detail with attendees list ──

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const rateLimit = await rateLimitResponseAsync(getRateLimitKey(request, 'class-session-detail'), 30, 60_000);
    if (rateLimit) return rateLimit;

    const { id: sessionId } = await params;

    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const service = createServiceClient();

    // Fetch the session with its service to verify ownership
    const { data: session, error: sessionError } = await service
      .from('class_sessions')
      .select('*, services!inner(id, name, business_id, duration, price)')
      .eq('id', sessionId)
      .single();

    if (sessionError || !session) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }

    const businessId = ((session as unknown as { services: { business_id: string }[] }).services[0]?.business_id);

    // Capability guard: class_booking / read_history
    const guard = await requireCapability(supabase, service, {
      businessId, userId: user.id, capability: 'class_booking' as never, action: 'read_history',
    });
    if (!guard.allowed) return NextResponse.json(guard.denial, { status: guard.status });

    // Fetch attendees (bookings linked to this session)
    const { data: attendees, error: attendeesError } = await service
      .from('bookings')
      .select('id, reference_code, guest_name, guest_phone, guest_email, party_size, status, created_at')
      .eq('class_session_id', sessionId)
      .in('status', ['confirmed', 'pending', 'in_progress'])
      .order('created_at', { ascending: true });

    if (attendeesError) {
      logger.withContext({ op: 'class-session-detail.get', sessionId }).error(`Failed to fetch attendees: ${attendeesError.message}`);
      return NextResponse.json({ error: 'Failed to fetch attendees' }, { status: 500 });
    }

    const totalAttendees = (attendees || []).reduce((sum, b) => sum + (b.party_size || 1), 0);

    return NextResponse.json({
      data: {
        ...session,
        attendees: attendees || [],
        attendee_count: totalAttendees,
      },
    });
  } catch (err) {
    logger.withContext({ op: 'class-session-detail.get' }).error(`Unexpected error: ${err}`);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// ── PATCH: Update a session (cancel, change instructor, change capacity) ──

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const rateLimit = await rateLimitResponseAsync(getRateLimitKey(request, 'class-session-patch'), 10, 60_000);
    if (rateLimit) return rateLimit;

    const { id: sessionId } = await params;

    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await request.json();
    const { status, cancellationReason, instructorName, capacity } = body;

    const service = createServiceClient();

    // Fetch the session to verify ownership and current state
    const { data: session, error: sessionError } = await service
      .from('class_sessions')
      .select('*, services!inner(id, name, business_id)')
      .eq('id', sessionId)
      .single();

    if (sessionError || !session) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }

    const businessId = ((session as unknown as { services: { business_id: string }[] }).services[0]?.business_id);

    // Capability guard: class_booking / manage_existing
    const guard = await requireCapability(supabase, service, {
      businessId, userId: user.id, capability: 'class_booking' as never, action: 'manage_existing',
    });
    if (!guard.allowed) return NextResponse.json(guard.denial, { status: guard.status });

    // Build update payload
    const updates: Record<string, unknown> = {};

    // Handle cancellation
    if (status === 'cancelled') {
      if (session.status === 'completed') {
        return NextResponse.json({ error: 'Cannot cancel a completed session' }, { status: 400 });
      }
      updates.status = 'cancelled';
      if (cancellationReason) {
        updates.cancellation_reason = cancellationReason;
      }
    }

    // Handle instructor change
    if (instructorName !== undefined) {
      updates.instructor_name = instructorName;
    }

    // Handle capacity change
    if (capacity !== undefined) {
      // Verify capacity is not below current bookings
      const { data: bookings, error: bookingsError } = await service
        .from('bookings')
        .select('party_size')
        .eq('class_session_id', sessionId)
        .in('status', ['confirmed', 'pending', 'in_progress']);

      if (bookingsError) {
        logger.withContext({ op: 'class-session.patch', sessionId }).error(`Failed to check current bookings: ${bookingsError.message}`);
        return NextResponse.json({ error: 'Failed to verify current bookings' }, { status: 500 });
      }

      const currentAttendees = (bookings || []).reduce((sum, b) => sum + (b.party_size || 1), 0);
      if (capacity < currentAttendees) {
        return NextResponse.json({
          error: `Cannot reduce capacity to ${capacity}. There are already ${currentAttendees} attendees booked.`,
        }, { status: 400 });
      }

      updates.capacity = capacity;
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: 'No fields to update' }, { status: 400 });
    }

    const { data: updatedSession, error: updateError } = await service
      .from('class_sessions')
      .update(updates)
      .eq('id', sessionId)
      .select()
      .single();

    if (updateError) {
      logger.withContext({ op: 'class-session.patch', sessionId }).error(`Failed to update session: ${updateError.message}`);
      return NextResponse.json({ error: 'Failed to update session' }, { status: 500 });
    }

    return NextResponse.json({ data: updatedSession });
  } catch (err) {
    logger.withContext({ op: 'class-session.patch' }).error(`Unexpected error: ${err}`);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
