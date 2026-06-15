import { NextResponse, type NextRequest } from 'next/server';
import { authenticatePartner } from '@/lib/partner/auth';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
import { dispatchWebhook } from '@/lib/webhooks/dispatcher';
import { logger } from '@/lib/logger';

/**
 * POST /api/partner/events — Create an event
 * GET  /api/partner/events — List partner's events
 */

export async function POST(request: NextRequest) {
  try {
    const auth = await authenticatePartner(request);
    if (auth instanceof NextResponse) return auth;
    const { business, keyId, supabase } = auth;

    const body = await request.json();
    const errors: string[] = [];

    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const description = typeof body.description === 'string' ? body.description.trim() : '';
    const date = typeof body.date === 'string' ? body.date.trim() : '';
    const time = typeof body.time === 'string' ? body.time.trim() : null;
    const endDate = typeof body.end_date === 'string' ? body.end_date.trim() : null;
    const endTime = typeof body.end_time === 'string' ? body.end_time.trim() : null;
    const venue = typeof body.venue === 'string' ? body.venue.trim() : '';
    const imageUrl = typeof body.image_url === 'string' ? body.image_url.trim() : null;
    const maxPerOrder = typeof body.max_per_order === 'number' ? Math.min(Math.max(body.max_per_order, 1), 50) : null;
    const ticketTypes = Array.isArray(body.ticket_types) ? body.ticket_types : [];

    // Validate required fields
    if (!name) errors.push('name is required');
    if (name.length > 300) errors.push('name must be under 300 characters');
    if (!date) errors.push('date is required (YYYY-MM-DD)');
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) errors.push('date must be YYYY-MM-DD format');
    if (time && !/^\d{1,2}:\d{2}$/.test(time)) errors.push('time must be HH:MM format');
    if (!venue) errors.push('venue is required');

    // Reject past dates
    if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
      const today = new Date().toISOString().split('T')[0];
      if (date < today) errors.push('date cannot be in the past');
    }

    // Validate ticket types
    let totalTickets = typeof body.total_tickets === 'number' ? body.total_tickets : 0;
    let price = typeof body.price === 'number' ? body.price : 0;

    if (ticketTypes.length > 0) {
      for (let i = 0; i < ticketTypes.length; i++) {
        const tt = ticketTypes[i];
        if (!tt.name || typeof tt.name !== 'string') errors.push(`ticket_types[${i}].name is required`);
        if (typeof tt.price !== 'number' || tt.price < 0) errors.push(`ticket_types[${i}].price must be a non-negative number`);
        if (typeof tt.total_tickets !== 'number' || tt.total_tickets < 1) errors.push(`ticket_types[${i}].total_tickets must be at least 1`);
      }
      totalTickets = ticketTypes.reduce((sum: number, tt: { total_tickets: number }) => sum + (tt.total_tickets || 0), 0);
      price = Math.min(...ticketTypes.map((tt: { price: number }) => tt.price || 0));
    } else if (totalTickets < 1) {
      errors.push('total_tickets is required (or provide ticket_types array)');
    }

    if (errors.length > 0) {
      return NextResponse.json({ error: 'Validation failed', details: errors }, { status: 400 });
    }

    // Insert event
    const { data: event, error: insertErr } = await supabase
      .from('events')
      .insert({
        business_id: business.id,
        api_key_id: keyId,
        name,
        description: description || null,
        date,
        time: time ? time.padStart(5, '0') : null,
        end_date: endDate || null,
        end_time: endTime ? endTime.padStart(5, '0') : null,
        venue,
        image_url: imageUrl,
        total_tickets: totalTickets,
        price,
        max_per_order: maxPerOrder,
        status: 'published',
        metadata: { source: 'partner_api', api_key_id: keyId },
      })
      .select('id, slug, name, date, time, venue, total_tickets, tickets_sold, price, status')
      .single();

    if (insertErr || !event) {
      logger.error('[PARTNER] Event insert error:', insertErr);
      return NextResponse.json({ error: 'Failed to create event' }, { status: 500 });
    }

    // Insert ticket types
    const createdTypes: Array<{ id: string; name: string; price: number; total_tickets: number }> = [];
    if (ticketTypes.length > 0) {
      const typeRows = ticketTypes.map((tt: { name: string; price: number; total_tickets: number }, i: number) => ({
        event_id: event.id,
        name: tt.name.trim(),
        price: tt.price,
        total_tickets: tt.total_tickets,
        sort_order: i,
        is_active: true,
      }));

      const { data: types, error: typeErr } = await supabase
        .from('event_ticket_types')
        .insert(typeRows)
        .select('id, name, price, total_tickets');

      if (typeErr) {
        logger.error('[PARTNER] Ticket types insert error:', typeErr);
      } else if (types) {
        createdTypes.push(...types);
      }
    }

    // Build URLs
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com';
    const webUrl = `${appUrl}/e/${event.slug}`;

    let whatsappUrl: string | null = null;
    try {
      const resolver = new ChannelResolver(supabase);
      const resolved = await resolver.resolveByBusinessId(business.id);
      if (resolved?.channel?.phone_number) {
        const phone = resolved.channel.phone_number.replace(/\D/g, '');
        whatsappUrl = `https://wa.me/${phone}?text=${encodeURIComponent(`I want to buy tickets for ${name}`)}`;
      }
    } catch { /* non-critical */ }

    // Dispatch webhook
    dispatchWebhook(supabase, business.id, 'event.created', {
      event_id: event.id,
      slug: event.slug,
      name,
      date,
      venue,
      total_tickets: totalTickets,
      ticket_types: createdTypes,
      web_url: webUrl,
    }).catch(err => logger.error('[PARTNER] Webhook dispatch error:', err));

    return NextResponse.json({
      id: event.id,
      slug: event.slug,
      name: event.name,
      date: event.date,
      time: event.time,
      venue: event.venue,
      status: event.status,
      total_tickets: event.total_tickets,
      tickets_sold: event.tickets_sold,
      price: event.price,
      ticket_types: createdTypes,
      web_url: webUrl,
      whatsapp_url: whatsappUrl,
    }, { status: 201 });
  } catch (error) {
    logger.error('[PARTNER] Create event error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  try {
    const auth = await authenticatePartner(request);
    if (auth instanceof NextResponse) return auth;
    const { business, keyId, supabase } = auth;

    const { searchParams } = new URL(request.url);
    const status = searchParams.get('status') || null;
    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10));
    const limit = Math.min(50, Math.max(1, parseInt(searchParams.get('limit') || '20', 10)));
    const offset = (page - 1) * limit;

    let query = supabase
      .from('events')
      .select('id, slug, name, description, date, time, venue, total_tickets, tickets_sold, price, status, image_url, max_per_order, created_at', { count: 'exact' })
      .eq('business_id', business.id)
      .eq('api_key_id', keyId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (status) {
      query = query.eq('status', status);
    }

    const { data: events, count, error } = await query;

    if (error) {
      logger.error('[PARTNER] List events error:', error);
      return NextResponse.json({ error: 'Failed to fetch events' }, { status: 500 });
    }

    const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com';

    return NextResponse.json({
      events: (events || []).map(e => ({
        ...e,
        available: e.total_tickets - e.tickets_sold,
        web_url: `${appUrl}/e/${e.slug}`,
      })),
      total: count || 0,
      page,
      limit,
    });
  } catch (error) {
    logger.error('[PARTNER] List events error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
