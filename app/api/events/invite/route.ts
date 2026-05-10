import { NextResponse, type NextRequest } from 'next/server';
import { authenticateRequest } from '@/lib/api-auth';
import { ChannelResolver } from '@/lib/channels/channel-resolver';

const RATE_LIMIT_MAP = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_MAX = 50;
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute

function checkRateLimit(userId: string): boolean {
  const now = Date.now();
  const entry = RATE_LIMIT_MAP.get(userId);
  if (!entry || now > entry.resetAt) {
    RATE_LIMIT_MAP.set(userId, { count: 1, resetAt: now + RATE_LIMIT_WINDOW });
    return true;
  }
  if (entry.count >= RATE_LIMIT_MAX) return false;
  entry.count++;
  return true;
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { eventId, phones, businessId } = body as {
    eventId: string;
    phones: string[];
    businessId: string;
  };

  if (!eventId || !phones?.length || !businessId) {
    return NextResponse.json({ error: 'eventId, phones, and businessId are required' }, { status: 400 });
  }

  const auth = await authenticateRequest(request, {
    requireBusinessOwnership: true,
    body: { businessId },
  });
  if (auth instanceof NextResponse) return auth;
  const { user, service } = auth;

  if (!checkRateLimit(user.id)) {
    return NextResponse.json({ error: 'Rate limit exceeded. Max 50 invites per minute.' }, { status: 429 });
  }

  // Get event details
  const { data: event, error: eventError } = await service
    .from('events')
    .select('id, name, date, time, venue, description, invite_message, allow_plus_ones, max_plus_ones, ask_dietary')
    .eq('id', eventId)
    .eq('business_id', businessId)
    .single();

  if (eventError || !event) {
    return NextResponse.json({ error: 'Event not found' }, { status: 404 });
  }

  // Get business details for the message
  const { data: business } = await service
    .from('businesses')
    .select('name, country_code')
    .eq('id', businessId)
    .single();

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://waaiio.com';
  const results: Array<{ phone: string; status: string; error?: string }> = [];

  // Resolve WhatsApp channel for this business
  const resolver = new ChannelResolver(service);
  const resolved = await resolver.resolveByBusinessId(businessId);

  for (const rawPhone of phones.slice(0, 50)) {
    const phone = rawPhone.replace(/\D/g, '');
    if (!phone || phone.length < 7) {
      results.push({ phone: rawPhone, status: 'skipped', error: 'Invalid phone number' });
      continue;
    }

    try {
      // Upsert invite record
      const { data: invite, error: upsertError } = await service
        .from('event_invites')
        .upsert(
          {
            business_id: businessId,
            event_id: eventId,
            guest_phone: phone,
          },
          { onConflict: 'event_id,guest_phone' }
        )
        .select('id, invite_token, status')
        .single();

      if (upsertError || !invite) {
        results.push({ phone, status: 'error', error: upsertError?.message || 'Failed to create invite' });
        continue;
      }

      // Format the date
      let dateStr = event.date || '';
      try {
        dateStr = new Date(event.date + 'T00:00').toLocaleDateString('en-GB', {
          weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
        });
      } catch { /* keep raw */ }

      let timeStr = event.time || '';
      if (timeStr) {
        try {
          const [h, m] = timeStr.split(':');
          const dt = new Date();
          dt.setHours(parseInt(h, 10), parseInt(m, 10));
          timeStr = dt.toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit' });
        } catch { /* keep raw */ }
      }

      const inviteLink = `${appUrl}/rsvp/${invite.invite_token}`;

      const message = [
        `🎉 *You're Invited!*`,
        '',
        `*${event.name}*`,
        dateStr ? `📅 ${dateStr}${timeStr ? ` at ${timeStr}` : ''}` : '',
        event.venue ? `📍 ${event.venue}` : '',
        event.invite_message ? `\n${event.invite_message}` : '',
        '',
        `RSVP here 👇`,
        inviteLink,
        '',
        `Or reply: *yes*, *no*, or *maybe*`,
      ].filter(Boolean).join('\n');

      // Send WhatsApp message
      if (resolved) {
        try {
          await resolved.sender.sendText({ to: phone, text: message });
          results.push({ phone, status: 'sent' });
        } catch (sendErr) {
          console.error(`[INVITE] Failed to send to ${phone}:`, sendErr);
          results.push({ phone, status: 'created', error: 'Invite created but message failed to send' });
        }
      } else {
        results.push({ phone, status: 'created', error: 'No WhatsApp channel configured' });
      }
    } catch (err) {
      console.error(`[INVITE] Error for ${phone}:`, err);
      results.push({ phone, status: 'error', error: 'Unexpected error' });
    }
  }

  return NextResponse.json({ success: true, results });
}

// Send reminders to pending/maybe guests
export async function PUT(request: NextRequest) {
  const body = await request.json();
  const { eventId, businessId } = body as { eventId: string; businessId: string };

  if (!eventId || !businessId) {
    return NextResponse.json({ error: 'eventId and businessId are required' }, { status: 400 });
  }

  const auth = await authenticateRequest(request, {
    requireBusinessOwnership: true,
    body: { businessId },
  });
  if (auth instanceof NextResponse) return auth;
  const { service } = auth;

  // Get event details
  const { data: event } = await service
    .from('events')
    .select('id, name, date, time, venue')
    .eq('id', eventId)
    .eq('business_id', businessId)
    .single();

  if (!event) {
    return NextResponse.json({ error: 'Event not found' }, { status: 404 });
  }

  // Get pending + maybe invites
  const { data: invites } = await service
    .from('event_invites')
    .select('id, guest_phone, guest_name, status, invite_token')
    .eq('event_id', eventId)
    .in('status', ['pending', 'maybe']);

  if (!invites || invites.length === 0) {
    return NextResponse.json({ success: true, sent: 0, message: 'No pending guests to remind' });
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://waaiio.com';
  const resolver = new ChannelResolver(service);
  const resolved = await resolver.resolveByBusinessId(businessId);

  let sent = 0;

  // Format the date
  let dateStr = event.date || '';
  try {
    dateStr = new Date(event.date + 'T00:00').toLocaleDateString('en-GB', {
      weekday: 'long', day: 'numeric', month: 'long',
    });
  } catch { /* keep raw */ }

  for (const invite of invites) {
    const link = `${appUrl}/rsvp/${invite.invite_token}`;
    const greeting = invite.guest_name ? `Hi ${invite.guest_name}! ` : '';
    const statusNote = invite.status === 'maybe'
      ? `You said *maybe* to *${event.name}*. Have you decided?`
      : `You haven't responded to the invite for *${event.name}* yet.`;

    const message = [
      `⏰ *Reminder*`,
      '',
      `${greeting}${statusNote}`,
      '',
      dateStr ? `📅 ${dateStr}` : '',
      event.venue ? `📍 ${event.venue}` : '',
      '',
      `RSVP here 👇`,
      link,
      '',
      `Reply: *yes*, *no*, or *maybe*`,
    ].filter(Boolean).join('\n');

    if (resolved) {
      try {
        await resolved.sender.sendText({ to: invite.guest_phone, text: message });
        await service
          .from('event_invites')
          .update({ reminder_sent: true })
          .eq('id', invite.id);
        sent++;
      } catch (err) {
        console.error(`[INVITE] Reminder failed for ${invite.guest_phone}:`, err);
      }
    }
  }

  return NextResponse.json({ success: true, sent, total: invites.length });
}
