import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { requireCapability } from '@/lib/capabilities/api-guard';
import { rateLimitResponseAsync, getRateLimitKey } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';

// ── GET: List class sessions with attendee counts ──

export async function GET(request: NextRequest) {
  try {
    const rateLimit = await rateLimitResponseAsync(getRateLimitKey(request, 'class-sessions-get'), 30, 60_000);
    if (rateLimit) return rateLimit;

    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const serviceId = request.nextUrl.searchParams.get('serviceId');
    const businessId = request.nextUrl.searchParams.get('businessId');
    const from = request.nextUrl.searchParams.get('from');
    const to = request.nextUrl.searchParams.get('to');

    if (!businessId) {
      return NextResponse.json({ error: 'businessId is required' }, { status: 400 });
    }

    const service = createServiceClient();
    const guard = await requireCapability(supabase, service, {
      businessId, userId: user.id, capability: 'class_booking' as never, action: 'read_history',
    });
    if (!guard.allowed) return NextResponse.json(guard.denial, { status: guard.status });

    let query = service
      .from('class_sessions')
      .select('*, services!inner(id, name, business_id, duration_minutes, price), business_staff(id, name)')
      .eq('business_id', businessId)
      .order('date', { ascending: true })
      .order('start_time', { ascending: true });

    if (serviceId) query = query.eq('service_id', serviceId);
    if (from) query = query.gte('date', from);
    if (to) query = query.lte('date', to);

    const { data: sessions, error: sessionsError } = await query;

    if (sessionsError) {
      logger.withContext({ op: 'class-sessions.get', businessId }).error(`Failed to fetch sessions: ${sessionsError.message}`);
      return NextResponse.json({ error: 'Failed to fetch sessions' }, { status: 500 });
    }

    if (!sessions || sessions.length === 0) {
      return NextResponse.json({ data: [] });
    }

    // Fetch attendee counts for all sessions
    const sessionIds = sessions.map(s => s.id);
    const { data: attendeeCounts } = await service
      .from('bookings')
      .select('class_session_id, party_size')
      .in('class_session_id', sessionIds)
      .in('status', ['confirmed', 'pending', 'in_progress']);

    const countMap = new Map<string, number>();
    for (const booking of attendeeCounts || []) {
      const current = countMap.get(booking.class_session_id) || 0;
      countMap.set(booking.class_session_id, current + (booking.party_size || 1));
    }

    const enriched = sessions.map(session => ({
      ...session,
      attendee_count: countMap.get(session.id) || 0,
    }));

    return NextResponse.json({ data: enriched });
  } catch (err) {
    logger.withContext({ op: 'class-sessions.get' }).error(`Unexpected error: ${err}`);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
