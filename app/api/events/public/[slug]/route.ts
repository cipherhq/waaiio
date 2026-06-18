import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { rateLimitResponse, getRateLimitKey } from '@/lib/rate-limit';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const rateLimit = rateLimitResponse(getRateLimitKey(_request, 'events-public'), 60, 60_000);
  if (rateLimit) return rateLimit;

  const { slug } = await params;

  if (!slug || slug.length > 200) {
    return NextResponse.json({ error: 'Invalid slug' }, { status: 400 });
  }

  const supabase = createServiceClient();

  const { data: event, error } = await supabase
    .from('events')
    .select(`
      id, name, description, date, time, end_date, end_time,
      venue, total_tickets, tickets_sold, price, status,
      image_url, max_per_order, slug, metadata,
      businesses!inner (
        id, name, slug, logo_url, country_code, payment_gateway
      ),
      event_ticket_types (
        id, name, price, total_tickets, tickets_sold, sort_order, is_active
      )
    `)
    .eq('slug', slug)
    .eq('status', 'published')
    .single();

  if (error || !event) {
    return NextResponse.json({ error: 'Event not found' }, { status: 404 });
  }

  // Calculate availability
  const available = event.total_tickets - event.tickets_sold;

  // Filter and enrich ticket types
  const ticketTypes = (event.event_ticket_types || [])
    .filter((tt: { is_active: boolean }) => tt.is_active)
    .sort((a: { sort_order: number }, b: { sort_order: number }) => a.sort_order - b.sort_order)
    .map((tt: { id: string; name: string; price: number; total_tickets: number; tickets_sold: number; sort_order: number }) => ({
      id: tt.id,
      name: tt.name,
      price: tt.price,
      available: tt.total_tickets - tt.tickets_sold,
      sort_order: tt.sort_order,
    }));

  const response = NextResponse.json({
    id: event.id,
    name: event.name,
    description: event.description,
    date: event.date,
    time: event.time,
    end_date: event.end_date,
    end_time: event.end_time,
    venue: event.venue,
    price: event.price,
    image_url: event.image_url,
    max_per_order: event.max_per_order,
    slug: event.slug,
    available,
    total_tickets: event.total_tickets,
    tickets_sold: event.tickets_sold,
    business: event.businesses,
    ticket_types: ticketTypes,
  });

  response.headers.set(
    'Cache-Control',
    'public, s-maxage=10, stale-while-revalidate=30',
  );

  return response;
}
