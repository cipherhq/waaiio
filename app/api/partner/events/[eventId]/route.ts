import { NextResponse, type NextRequest } from 'next/server';
import { authenticatePartner } from '@/lib/partner/auth';
import { dispatchWebhook } from '@/lib/webhooks/dispatcher';
import { logger } from '@/lib/logger';

/**
 * GET    /api/partner/events/:id — Get event detail
 * PUT    /api/partner/events/:id — Update event
 * DELETE /api/partner/events/:id — Cancel event
 */

async function getEvent(supabase: ReturnType<typeof import('@/lib/supabase/service').createServiceClient>, eventId: string, businessId: string, keyId: string) {
  const { data } = await supabase
    .from('events')
    .select('id, slug, name, description, date, time, end_date, end_time, venue, total_tickets, tickets_sold, price, status, image_url, max_per_order, created_at, updated_at')
    .eq('id', eventId)
    .eq('business_id', businessId)
    .eq('api_key_id', keyId)
    .single();
  return data;
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ eventId: string }> }) {
  try {
    const auth = await authenticatePartner(request);
    if (auth instanceof NextResponse) return auth;
    const { business, keyId, supabase } = auth;
    const { eventId } = await params;

    const event = await getEvent(supabase, eventId, business.id, keyId);
    if (!event) {
      return NextResponse.json({ error: 'Event not found' }, { status: 404 });
    }

    // Get ticket types
    const { data: ticketTypes } = await supabase
      .from('event_ticket_types')
      .select('id, name, price, total_tickets, tickets_sold, sort_order, is_active')
      .eq('event_id', eventId)
      .order('sort_order');

    const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com';

    return NextResponse.json({
      ...event,
      available: event.total_tickets - event.tickets_sold,
      ticket_types: (ticketTypes || []).map(tt => ({
        ...tt,
        available: tt.total_tickets - tt.tickets_sold,
      })),
      web_url: `${appUrl}/e/${event.slug}`,
    });
  } catch (error) {
    logger.error('[PARTNER] Get event error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ eventId: string }> }) {
  try {
    const auth = await authenticatePartner(request);
    if (auth instanceof NextResponse) return auth;
    const { business, keyId, supabase } = auth;
    const { eventId } = await params;

    // Verify ownership
    const existing = await getEvent(supabase, eventId, business.id, keyId);
    if (!existing) {
      return NextResponse.json({ error: 'Event not found' }, { status: 404 });
    }

    if (existing.status === 'cancelled') {
      return NextResponse.json({ error: 'Cannot update a cancelled event' }, { status: 400 });
    }

    const body = await request.json();
    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };

    if (body.name !== undefined) {
      const name = String(body.name).trim();
      if (!name || name.length > 300) return NextResponse.json({ error: 'name must be 1-300 characters' }, { status: 400 });
      updates.name = name;
    }
    if (body.description !== undefined) updates.description = String(body.description).trim() || null;
    if (body.date !== undefined) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(body.date)) return NextResponse.json({ error: 'date must be YYYY-MM-DD' }, { status: 400 });
      updates.date = body.date;
    }
    if (body.time !== undefined) updates.time = body.time ? String(body.time).padStart(5, '0') : null;
    if (body.end_date !== undefined) updates.end_date = body.end_date || null;
    if (body.end_time !== undefined) updates.end_time = body.end_time ? String(body.end_time).padStart(5, '0') : null;
    if (body.venue !== undefined) updates.venue = String(body.venue).trim();
    if (body.image_url !== undefined) updates.image_url = body.image_url || null;
    if (body.max_per_order !== undefined) updates.max_per_order = Math.min(Math.max(Number(body.max_per_order), 1), 50);

    // Handle total_tickets update (cannot reduce below sold)
    if (body.total_tickets !== undefined) {
      const newTotal = Number(body.total_tickets);
      if (newTotal < existing.tickets_sold) {
        return NextResponse.json({
          error: `Cannot reduce total_tickets below tickets_sold (${existing.tickets_sold})`,
        }, { status: 400 });
      }
      updates.total_tickets = newTotal;
    }

    // Handle ticket types upsert
    if (Array.isArray(body.ticket_types)) {
      for (const tt of body.ticket_types) {
        if (tt.id) {
          // Update existing type
          const typeUpdates: Record<string, unknown> = {};
          if (tt.name !== undefined) typeUpdates.name = String(tt.name).trim();
          if (tt.price !== undefined) typeUpdates.price = Number(tt.price);
          if (tt.total_tickets !== undefined) typeUpdates.total_tickets = Number(tt.total_tickets);
          if (tt.is_active !== undefined) typeUpdates.is_active = Boolean(tt.is_active);
          if (tt.sort_order !== undefined) typeUpdates.sort_order = Number(tt.sort_order);

          await supabase.from('event_ticket_types').update(typeUpdates).eq('id', tt.id).eq('event_id', eventId);
        } else {
          // Insert new type
          await supabase.from('event_ticket_types').insert({
            event_id: eventId,
            name: String(tt.name || 'General').trim(),
            price: Number(tt.price || 0),
            total_tickets: Number(tt.total_tickets || 100),
            sort_order: Number(tt.sort_order || 0),
            is_active: true,
          });
        }
      }

      // Recalculate total_tickets from types
      const { data: allTypes } = await supabase
        .from('event_ticket_types')
        .select('total_tickets')
        .eq('event_id', eventId)
        .eq('is_active', true);

      if (allTypes && allTypes.length > 0) {
        updates.total_tickets = allTypes.reduce((sum, t) => sum + t.total_tickets, 0);
      }
    }

    const { error: updateErr } = await supabase
      .from('events')
      .update(updates)
      .eq('id', eventId);

    if (updateErr) {
      logger.error('[PARTNER] Update event error:', updateErr);
      return NextResponse.json({ error: 'Failed to update event' }, { status: 500 });
    }

    // Dispatch webhook
    dispatchWebhook(supabase, business.id, 'event.updated', {
      event_id: eventId,
      updates: Object.keys(updates).filter(k => k !== 'updated_at'),
    }).catch(err => logger.error('[PARTNER] Webhook dispatch error:', err));

    // Return updated event
    const updated = await getEvent(supabase, eventId, business.id, keyId);
    const { data: types } = await supabase
      .from('event_ticket_types')
      .select('id, name, price, total_tickets, tickets_sold, sort_order, is_active')
      .eq('event_id', eventId)
      .order('sort_order');

    const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com';

    return NextResponse.json({
      ...updated,
      available: updated ? updated.total_tickets - updated.tickets_sold : 0,
      ticket_types: types || [],
      web_url: updated ? `${appUrl}/e/${updated.slug}` : null,
    });
  } catch (error) {
    logger.error('[PARTNER] Update event error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ eventId: string }> }) {
  try {
    const auth = await authenticatePartner(request);
    if (auth instanceof NextResponse) return auth;
    const { business, keyId, supabase } = auth;
    const { eventId } = await params;

    const existing = await getEvent(supabase, eventId, business.id, keyId);
    if (!existing) {
      return NextResponse.json({ error: 'Event not found' }, { status: 404 });
    }

    if (existing.status === 'cancelled') {
      return NextResponse.json({ error: 'Event is already cancelled' }, { status: 400 });
    }

    // Soft cancel — set status, keep data for ticket records
    await supabase
      .from('events')
      .update({ status: 'cancelled', updated_at: new Date().toISOString() })
      .eq('id', eventId);

    // Cancel valid tickets
    const { data: cancelledTickets } = await supabase
      .from('event_tickets')
      .update({ status: 'cancelled' })
      .eq('event_id', eventId)
      .eq('status', 'valid')
      .select('id');

    // Dispatch webhook
    dispatchWebhook(supabase, business.id, 'event.cancelled', {
      event_id: eventId,
      name: existing.name,
      tickets_cancelled: cancelledTickets?.length || 0,
    }).catch(err => logger.error('[PARTNER] Webhook dispatch error:', err));

    return NextResponse.json({
      success: true,
      event_id: eventId,
      status: 'cancelled',
      tickets_cancelled: cancelledTickets?.length || 0,
    });
  } catch (error) {
    logger.error('[PARTNER] Cancel event error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
