import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';

/**
 * GET /api/invite/:id
 * Public endpoint — returns event/party details for the invite opt-in page.
 * Tries events first, then parties.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = createServiceClient();

  // Detect if ID is a UUID or slug
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

  // Try events first (by ID or slug)
  let eventQuery = supabase
    .from('events')
    .select('id, name, date, time, venue, description, image_url, invite_message, business_id, businesses(name, owner_id, country_code)')
    .eq('status', 'published');
  eventQuery = isUuid ? eventQuery.eq('id', id) : eventQuery.eq('slug', id);
  const { data: event } = await eventQuery.single();

  if (event) {
    const biz = event.businesses as unknown as { name: string; owner_id?: string; country_code?: string } | null;
    let hostName = biz?.name || '';
    if (biz?.owner_id) {
      const { data: owner } = await supabase
        .from('profiles')
        .select('first_name, last_name')
        .eq('id', biz.owner_id)
        .single();
      if (owner?.first_name) {
        hostName = `${owner.first_name}${owner.last_name ? ` ${owner.last_name}` : ''}`;
      }
    }

    return NextResponse.json({
      event: {
        id: event.id,
        name: event.name,
        date: event.date,
        time: event.time,
        venue: event.venue,
        description: event.description,
        image_url: event.image_url,
        invite_message: event.invite_message,
        type: 'event',
        host_name: hostName,
        business_name: biz?.name || '',
        business_country: biz?.country_code || 'US',
      },
    });
  }

  // Try parties (by ID or slug)
  let partyQuery = supabase
    .from('parties')
    .select('id, name, date, time, venue, description, image_url, invite_message, dress_code, business_id, businesses(name, owner_id, country_code)');
  partyQuery = isUuid ? partyQuery.eq('id', id) : partyQuery.eq('slug', id);
  const { data: party } = await partyQuery.single();

  if (party) {
    const biz = party.businesses as unknown as { name: string; owner_id?: string; country_code?: string } | null;
    let hostName = biz?.name || '';
    if (biz?.owner_id) {
      const { data: owner } = await supabase
        .from('profiles')
        .select('first_name, last_name')
        .eq('id', biz.owner_id)
        .single();
      if (owner?.first_name) {
        hostName = `${owner.first_name}${owner.last_name ? ` ${owner.last_name}` : ''}`;
      }
    }

    return NextResponse.json({
      event: {
        id: party.id,
        name: party.name,
        date: party.date,
        time: party.time,
        venue: party.venue,
        description: party.description,
        image_url: party.image_url,
        invite_message: party.invite_message,
        dress_code: party.dress_code,
        type: 'party',
        host_name: hostName,
        business_name: biz?.name || '',
        business_country: biz?.country_code || 'US',
      },
    });
  }

  return NextResponse.json({ error: 'Event not found' }, { status: 404 });
}
