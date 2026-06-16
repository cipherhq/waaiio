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

  // Try events first
  const { data: event } = await supabase
    .from('events')
    .select('id, name, date, time, venue, description, image_url, invite_message, business_id, businesses(name, owner_id)')
    .eq('id', id)
    .eq('status', 'published')
    .single();

  if (event) {
    const biz = event.businesses as unknown as { name: string; owner_id?: string } | null;
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
      },
    });
  }

  // Try parties
  const { data: party } = await supabase
    .from('parties')
    .select('id, name, date, time, venue, description, image_url, invite_message, dress_code, business_id, businesses(name, owner_id)')
    .eq('id', id)
    .single();

  if (party) {
    const biz = party.businesses as unknown as { name: string; owner_id?: string } | null;
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
      },
    });
  }

  return NextResponse.json({ error: 'Event not found' }, { status: 404 });
}
