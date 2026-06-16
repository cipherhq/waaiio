import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
import { rateLimitResponse, getRateLimitKey } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';

/**
 * POST /api/invite/optin
 * Public endpoint — guest opts in to receive a WhatsApp invite.
 * Creates an event_invite record and sends the invite via WhatsApp.
 */
export async function POST(request: NextRequest) {
  const rateLimit = rateLimitResponse(getRateLimitKey(request, 'invite-optin'), 10, 60_000);
  if (rateLimit) return rateLimit;

  try {
    const { eventId, partyId, name, phone } = await request.json();

    if ((!eventId && !partyId) || !phone) {
      return NextResponse.json({ error: 'eventId or partyId, and phone are required' }, { status: 400 });
    }

    const cleanPhone = String(phone).replace(/\D/g, '');
    if (cleanPhone.length < 7) {
      return NextResponse.json({ error: 'Invalid phone number' }, { status: 400 });
    }

    const guestName = typeof name === 'string' ? name.trim().slice(0, 200) : null;
    const supabase = createServiceClient();

    // Fetch event/party details
    let target: { id: string; name: string; date: string; time: string | null; venue: string | null; business_id: string; invite_message: string | null; dress_code?: string | null } | null = null;

    if (partyId) {
      const { data } = await supabase
        .from('parties')
        .select('id, name, date, time, venue, business_id, invite_message, dress_code')
        .eq('id', partyId)
        .single();
      target = data;
    } else {
      const { data } = await supabase
        .from('events')
        .select('id, name, date, time, venue, business_id, invite_message')
        .eq('id', eventId)
        .eq('status', 'published')
        .single();
      if (data) target = { ...data, dress_code: null };
    }

    if (!target) {
      return NextResponse.json({ error: 'Event not found' }, { status: 404 });
    }

    // Check if already invited
    const findQuery = supabase
      .from('event_invites')
      .select('id, invite_token, status')
      .eq('guest_phone', cleanPhone)
      .eq('business_id', target.business_id);

    if (partyId) findQuery.eq('party_id', partyId);
    else findQuery.eq('event_id', eventId);

    const { data: existing } = await findQuery.maybeSingle();

    if (existing) {
      return NextResponse.json({
        success: true,
        already_invited: true,
        status: existing.status,
        rsvp_url: `${process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com'}/rsvp/${existing.invite_token}`,
      });
    }

    // Create invite
    const insertPayload: Record<string, unknown> = {
      business_id: target.business_id,
      guest_phone: cleanPhone,
      ...(guestName ? { guest_name: guestName } : {}),
      ...(partyId ? { party_id: partyId, event_id: null } : { event_id: eventId, party_id: null }),
      metadata: { source: 'web_optin' },
    };

    const { data: invite, error: insertErr } = await supabase
      .from('event_invites')
      .insert(insertPayload)
      .select('id, invite_token')
      .single();

    if (insertErr || !invite) {
      logger.error('[INVITE-OPTIN] Insert error:', insertErr);
      return NextResponse.json({ error: 'Failed to create invite' }, { status: 500 });
    }

    const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com';
    const inviteLink = `${appUrl}/rsvp/${invite.invite_token}`;

    // Get host name
    const { data: biz } = await supabase
      .from('businesses')
      .select('name, owner_id')
      .eq('id', target.business_id)
      .single();

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

    // Format date
    let dateLabel = target.date;
    try {
      dateLabel = new Date(target.date + 'T00:00').toLocaleDateString('en-GB', {
        weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
      });
    } catch { /* keep raw */ }

    let timeLabel = '';
    if (target.time) {
      try {
        const [h, m] = target.time.split(':');
        const dt = new Date();
        dt.setHours(parseInt(h, 10), parseInt(m, 10));
        timeLabel = dt.toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit' });
      } catch { timeLabel = target.time; }
    }

    // Send WhatsApp invite (opt-in — they submitted their number)
    let whatsappSent = false;
    try {
      const resolver = new ChannelResolver(supabase);
      const resolved = await resolver.resolveByBusinessId(target.business_id);

      if (resolved) {
        const messageParts = [
          `🎉 *You're Invited!*`,
          '',
          hostName ? `*${hostName}* invites you to:` : '',
          `*${target.name}*`,
          `📅 ${dateLabel}${timeLabel ? ` at ${timeLabel}` : ''}`,
          target.venue ? `📍 ${target.venue}` : '',
          target.dress_code ? `👔 Dress code: ${target.dress_code}` : '',
          target.invite_message ? `\n${target.invite_message}` : '',
          '',
          `RSVP: ${inviteLink}`,
        ];
        const message = messageParts.filter(Boolean).join('\n');

        await resolved.sender.sendButtons({
          to: cleanPhone,
          body: message,
          buttons: [
            { id: `rsvp_yes_${invite.id}`, title: "Yes, I'll be there!" },
            { id: `rsvp_maybe_${invite.id}`, title: 'Maybe' },
            { id: `rsvp_no_${invite.id}`, title: "Can't make it" },
          ],
        });
        whatsappSent = true;
      }
    } catch (err) {
      logger.error('[INVITE-OPTIN] WhatsApp send error:', err);
    }

    return NextResponse.json({
      success: true,
      whatsapp_sent: whatsappSent,
      rsvp_url: inviteLink,
    });
  } catch (error) {
    logger.error('[INVITE-OPTIN] Error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
