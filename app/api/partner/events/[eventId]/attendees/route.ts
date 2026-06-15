import { NextResponse, type NextRequest } from 'next/server';
import { authenticatePartner } from '@/lib/partner/auth';
import { logger } from '@/lib/logger';

/**
 * GET /api/partner/events/:id/attendees — List ticket holders
 * Query: ?status=valid|used|cancelled&page=1&limit=50
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ eventId: string }> }) {
  try {
    const auth = await authenticatePartner(request);
    if (auth instanceof NextResponse) return auth;
    const { business, keyId, supabase } = auth;
    const { eventId } = await params;

    // Verify event ownership
    const { data: event } = await supabase
      .from('events')
      .select('id, name, total_tickets, tickets_sold')
      .eq('id', eventId)
      .eq('business_id', business.id)
      .eq('api_key_id', keyId)
      .single();

    if (!event) {
      return NextResponse.json({ error: 'Event not found' }, { status: 404 });
    }

    const { searchParams } = new URL(request.url);
    const status = searchParams.get('status') || null;
    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(searchParams.get('limit') || '50', 10)));
    const offset = (page - 1) * limit;

    let query = supabase
      .from('event_tickets')
      .select('id, ticket_code, ticket_number, guest_name, guest_phone, ticket_type_name, status, scanned_at, scanned_by, created_at', { count: 'exact' })
      .eq('event_id', eventId)
      .order('created_at', { ascending: true })
      .range(offset, offset + limit - 1);

    if (status && ['valid', 'used', 'cancelled'].includes(status)) {
      query = query.eq('status', status);
    }

    const { data: tickets, count, error } = await query;

    if (error) {
      logger.error('[PARTNER] List attendees error:', error);
      return NextResponse.json({ error: 'Failed to fetch attendees' }, { status: 500 });
    }

    // Counts
    const { count: checkedIn } = await supabase
      .from('event_tickets')
      .select('id', { count: 'exact', head: true })
      .eq('event_id', eventId)
      .eq('status', 'used');

    return NextResponse.json({
      event_id: eventId,
      event_name: event.name,
      attendees: tickets || [],
      total: count || 0,
      checked_in: checkedIn || 0,
      tickets_sold: event.tickets_sold,
      page,
      limit,
    });
  } catch (error) {
    logger.error('[PARTNER] List attendees error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
