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

    // Fetch session with service and staff details
    const { data: session, error: sessionError } = await service
      .from('class_sessions')
      .select('*, services(id, name, business_id, duration_minutes, price), business_staff(id, name)')
      .eq('id', sessionId)
      .single();

    if (sessionError || !session) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }

    const businessId = (session.services as unknown as { business_id: string })?.business_id || session.business_id;

    const guard = await requireCapability(supabase, service, {
      businessId, userId: user.id, capability: 'class_booking' as never, action: 'read_history',
    });
    if (!guard.allowed) return NextResponse.json(guard.denial, { status: guard.status });

    // Fetch attendees
    const { data: attendees } = await service
      .from('bookings')
      .select('id, reference_code, guest_name, guest_phone, guest_email, party_size, status, created_at')
      .eq('class_session_id', sessionId)
      .in('status', ['confirmed', 'pending', 'in_progress'])
      .order('created_at', { ascending: true });

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

// ── PATCH: Update session (cancel, change instructor via staffId, change capacity) ──

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
    const { status, cancellationReason, staffId, capacity, clearStaff } = body;

    const service = createServiceClient();

    // Resolve business_id for capability check
    const { data: session } = await service
      .from('class_sessions')
      .select('business_id')
      .eq('id', sessionId)
      .single();

    if (!session) return NextResponse.json({ error: 'Session not found' }, { status: 404 });

    const guard = await requireCapability(supabase, service, {
      businessId: session.business_id, userId: user.id, capability: 'class_booking' as never, action: 'manage_existing',
    });
    if (!guard.allowed) return NextResponse.json(guard.denial, { status: guard.status });

    // Atomic session mutation via DB authority (uses same advisory lock as booking)
    const { data: result, error: rpcError } = await service
      .rpc('update_class_session_atomic', {
        p_session_id: sessionId,
        p_business_id: session.business_id,
        p_new_status: status || null,
        p_cancellation_reason: cancellationReason || null,
        p_new_capacity: capacity ?? null,
        p_new_staff_id: staffId || null,
        p_clear_staff: clearStaff || false,
      });

    if (rpcError) {
      logger.withContext({ op: 'class-session.patch', sessionId }).error(`Atomic update failed: ${rpcError.message}`);
      return NextResponse.json({ error: 'Failed to update session' }, { status: 500 });
    }

    if (!result?.success) {
      return NextResponse.json({ error: result?.reason || 'Failed to update session' }, { status: 400 });
    }

    return NextResponse.json({ data: result });
  } catch (err) {
    logger.withContext({ op: 'class-session.patch' }).error(`Unexpected error: ${err}`);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
