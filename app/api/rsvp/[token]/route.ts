import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';

const VALID_STATUSES = ['accepted', 'maybe', 'declined'] as const;

/**
 * GET /api/rsvp/[token] — Fetch invite by token (anonymous, token IS the auth)
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;

  if (!token || token.length < 10) {
    return NextResponse.json({ error: 'Invalid token' }, { status: 400 });
  }

  const supabase = createServiceClient();

  const { data, error } = await supabase
    .from('event_invites')
    .select(`
      id, invite_token, guest_phone, guest_name, status, plus_ones, dietary_notes,
      events (
        id, name, description, date, time, venue, image_url,
        allow_plus_ones, max_plus_ones, ask_dietary, invite_message,
        businesses!inner ( name, slug )
      ),
      parties (
        id, name, description, date, time, venue, image_url,
        allow_plus_ones, max_plus_ones, ask_dietary, invite_message, dress_code,
        businesses!inner ( name, slug )
      )
    `)
    .eq('invite_token', token)
    .single();

  if (error || !data) {
    return NextResponse.json({ error: 'Invite not found' }, { status: 404 });
  }

  // Must have either event or party data
  if (!data.events && !data.parties) {
    return NextResponse.json({ error: 'Invite not found' }, { status: 404 });
  }

  return NextResponse.json({ invite: data });
}

/**
 * POST /api/rsvp/[token] — Update RSVP status (anonymous, token IS the auth)
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;

  if (!token || token.length < 10) {
    return NextResponse.json({ error: 'Invalid token' }, { status: 400 });
  }

  let body: { status: string; plus_ones?: number; dietary_notes?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  if (!body.status || !VALID_STATUSES.includes(body.status as typeof VALID_STATUSES[number])) {
    return NextResponse.json(
      { error: 'Invalid status. Must be accepted, maybe, or declined.' },
      { status: 400 },
    );
  }

  const supabase = createServiceClient();

  // Verify invite exists and fetch it
  const { data: invite, error: fetchError } = await supabase
    .from('event_invites')
    .select('id, status')
    .eq('invite_token', token)
    .single();

  if (fetchError || !invite) {
    return NextResponse.json({ error: 'Invite not found' }, { status: 404 });
  }

  const updateData: Record<string, unknown> = {
    status: body.status,
    plus_ones: body.status === 'accepted' ? (body.plus_ones ?? 0) : 0,
    responded_at: new Date().toISOString(),
  };

  if (body.dietary_notes?.trim()) {
    updateData.dietary_notes = body.dietary_notes.trim();
  }

  const { error: updateError } = await supabase
    .from('event_invites')
    .update(updateData)
    .eq('id', invite.id);

  if (updateError) {
    return NextResponse.json({ error: 'Failed to update RSVP' }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
