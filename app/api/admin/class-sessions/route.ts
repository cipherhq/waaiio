import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { requirePlatformAdmin } from '@/lib/admin-auth';

function corsHeaders(origin?: string | null) {
  const allowedOrigins = [
    process.env.ADMIN_ORIGIN || 'https://admin.waaiio.com',
    'http://localhost:8083',
  ];
  const allowed = origin && allowedOrigins.includes(origin) ? origin : allowedOrigins[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

export async function OPTIONS() {
  return NextResponse.json({}, { headers: corsHeaders() });
}

/**
 * GET /api/admin/class-sessions
 * Platform-wide class session listing for admin/support/operations.
 * Read-only. Uses service client after platform-role authorization.
 */
export async function GET(request: NextRequest) {
  const origin = request.headers.get('origin');
  const admin = await requirePlatformAdmin(request, {
    requiredRole: ['admin', 'support', 'operations'],
  });
  if (!admin) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403, headers: corsHeaders(origin) });
  }

  const supabase = createServiceClient();

  const sessionId = request.nextUrl.searchParams.get('sessionId');

  // Single session detail with attendees
  if (sessionId) {
    const { data: session } = await supabase
      .from('class_sessions')
      .select('id, business_id, service_id, date, start_time, end_time, capacity, status, staff_id, location_id, cancellation_reason, created_at')
      .eq('id', sessionId)
      .single();

    if (!session) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404, headers: corsHeaders(origin) });
    }

    // Enrich with names
    const [bizRes, svcRes, staffRes] = await Promise.all([
      supabase.from('businesses').select('name').eq('id', session.business_id).single(),
      supabase.from('services').select('name').eq('id', session.service_id).single(),
      session.staff_id ? supabase.from('business_staff').select('name').eq('id', session.staff_id).single() : { data: null },
    ]);

    // Attendees
    const { data: attendees } = await supabase
      .from('bookings')
      .select('id, reference_code, guest_name, guest_phone, guest_email, party_size, status, created_at')
      .eq('class_session_id', sessionId)
      .order('created_at', { ascending: true });

    const attendeeCount = (attendees || []).reduce((sum, b) => sum + (b.party_size || 1), 0);

    return NextResponse.json({
      data: {
        ...session,
        business_name: bizRes.data?.name,
        service_name: svcRes.data?.name,
        instructor_name: staffRes.data?.name || null,
        attendees: attendees || [],
        attendee_count: attendeeCount,
      },
    }, { headers: corsHeaders(origin) });
  }

  // List sessions with server-side pagination
  const status = request.nextUrl.searchParams.get('status');
  const page = Math.max(1, parseInt(request.nextUrl.searchParams.get('page') || '1'));
  const limit = Math.min(100, Math.max(1, parseInt(request.nextUrl.searchParams.get('limit') || '20')));
  const offset = (page - 1) * limit;

  // Count total for pagination
  let countQuery = supabase
    .from('class_sessions')
    .select('id', { count: 'exact', head: true });
  if (status) countQuery = countQuery.eq('status', status);
  const { count: total } = await countQuery;

  let query = supabase
    .from('class_sessions')
    .select('id, business_id, service_id, date, start_time, end_time, capacity, status, staff_id, cancellation_reason, created_at')
    .order('date', { ascending: false })
    .order('start_time', { ascending: false })
    .range(offset, offset + limit - 1);

  if (status) {
    query = query.eq('status', status);
  }

  const { data: sessions, error } = await query;

  if (error) {
    return NextResponse.json({ error: 'Failed to fetch sessions' }, { status: 500, headers: corsHeaders(origin) });
  }

  if (!sessions || sessions.length === 0) {
    return NextResponse.json({ data: [], page, limit, total: total || 0, totalPages: 0 }, { headers: corsHeaders(origin) });
  }

  // Enrich with business/service/staff names
  const bizIds = [...new Set(sessions.map(s => s.business_id))];
  const svcIds = [...new Set(sessions.map(s => s.service_id))];
  const staffIds = [...new Set(sessions.filter(s => s.staff_id).map(s => s.staff_id))];
  const sessionIds = sessions.map(s => s.id);

  const [bizRes, svcRes, staffRes, countRes] = await Promise.all([
    supabase.from('businesses').select('id, name').in('id', bizIds),
    supabase.from('services').select('id, name').in('id', svcIds),
    staffIds.length > 0 ? supabase.from('business_staff').select('id, name').in('id', staffIds) : { data: [] },
    supabase.from('bookings').select('class_session_id, party_size').in('class_session_id', sessionIds).in('status', ['confirmed', 'pending', 'in_progress']),
  ]);

  const bizMap = new Map((bizRes.data || []).map(b => [b.id, b.name]));
  const svcMap = new Map((svcRes.data || []).map(s => [s.id, s.name]));
  const staffMap = new Map(((staffRes.data || []) as Array<{ id: string; name: string }>).map(s => [s.id, s.name]));
  const countMap = new Map<string, number>();
  for (const b of countRes.data || []) {
    const cur = countMap.get(b.class_session_id) || 0;
    countMap.set(b.class_session_id, cur + (b.party_size || 1));
  }

  const enriched = sessions.map(s => ({
    ...s,
    business_name: bizMap.get(s.business_id) || 'Unknown',
    service_name: svcMap.get(s.service_id) || 'Unknown',
    instructor_name: s.staff_id ? staffMap.get(s.staff_id) || null : null,
    attendee_count: countMap.get(s.id) || 0,
  }));

  const totalCount = total || 0;
  return NextResponse.json({
    data: enriched,
    page,
    limit,
    total: totalCount,
    totalPages: Math.ceil(totalCount / limit),
  }, { headers: corsHeaders(origin) });
}
