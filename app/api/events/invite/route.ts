import { NextResponse, type NextRequest } from 'next/server';
import { authenticateRequest } from '@/lib/api-auth';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
import { sendWithTemplate } from '@/lib/channels/send-with-template';
import { logger } from '@/lib/logger';

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
  const { eventId, partyId, phones, names, emails, businessId } = body as {
    eventId?: string;
    partyId?: string;
    phones: string[];
    names?: string[];
    emails?: string[];
    businessId: string;
  };

  if ((!eventId && !partyId) || !phones?.length || !businessId) {
    return NextResponse.json({ error: 'eventId or partyId, phones, and businessId are required' }, { status: 400 });
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

  // Get event or party details
  let inviteTarget: {
    name: string;
    date: string;
    time: string | null;
    venue: string | null;
    invite_message: string | null;
    allow_plus_ones: boolean;
    max_plus_ones: number | null;
    ask_dietary: boolean;
    dress_code?: string | null;
  } | null = null;

  if (partyId) {
    const { data: party, error: partyError } = await service
      .from('parties')
      .select('id, name, date, time, venue, invite_message, allow_plus_ones, max_plus_ones, ask_dietary, dress_code')
      .eq('id', partyId)
      .eq('business_id', businessId)
      .single();

    if (partyError || !party) {
      return NextResponse.json({ error: 'Party not found' }, { status: 404 });
    }
    inviteTarget = party;
  } else if (eventId) {
    const { data: event, error: eventError } = await service
      .from('events')
      .select('id, name, date, time, venue, description, invite_message, allow_plus_ones, max_plus_ones, ask_dietary')
      .eq('id', eventId)
      .eq('business_id', businessId)
      .single();

    if (eventError || !event) {
      return NextResponse.json({ error: 'Event not found' }, { status: 404 });
    }
    inviteTarget = event;
  }

  if (!inviteTarget) {
    return NextResponse.json({ error: 'Event or party not found' }, { status: 404 });
  }

  // Get business details + owner name for the message
  const { data: business } = await service
    .from('businesses')
    .select('name, country_code, owner_id')
    .eq('id', businessId)
    .single();

  // Get host name (business owner's name)
  let hostName = business?.name || '';
  if (business?.owner_id) {
    const { data: owner } = await service
      .from('profiles')
      .select('first_name, last_name')
      .eq('id', business.owner_id)
      .single();
    if (owner?.first_name) {
      hostName = `${owner.first_name}${owner.last_name ? ` ${owner.last_name}` : ''}`;
    }
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com';
  const results: Array<{ phone: string; status: string; error?: string; note?: string }> = [];

  // Resolve WhatsApp channel for this business
  const resolver = new ChannelResolver(service);
  const resolved = await resolver.resolveByBusinessId(businessId);

  for (let i = 0; i < Math.min(phones.length, 50); i++) {
    const rawPhone = phones[i];
    const phone = rawPhone.replace(/\D/g, '');
    const guestName = names?.[i]?.trim() || null;
    if (!phone || phone.length < 7) {
      results.push({ phone: rawPhone, status: 'skipped', error: 'Invalid phone number' });
      continue;
    }

    try {
      // Build insert payload — either event_id or party_id
      const upsertPayload: Record<string, unknown> = {
        business_id: businessId,
        guest_phone: phone,
        ...(guestName ? { guest_name: guestName } : {}),
      };
      if (partyId) {
        upsertPayload.party_id = partyId;
        upsertPayload.event_id = null;
      } else {
        upsertPayload.event_id = eventId;
        upsertPayload.party_id = null;
      }

      // Check for existing invite first
      const findQuery = service
        .from('event_invites')
        .select('id, invite_token, status')
        .eq('guest_phone', phone)
        .eq('business_id', businessId);
      if (partyId) findQuery.eq('party_id', partyId);
      else findQuery.eq('event_id', eventId!);
      const { data: existing } = await findQuery.maybeSingle();

      let invite = existing;
      const isResend = !!existing;
      const alreadyResponded = existing && existing.status !== 'pending';

      if (!invite) {
        // Insert new invite
        const { data: newInvite, error: insertError } = await service
          .from('event_invites')
          .insert(upsertPayload)
          .select('id, invite_token, status')
          .single();

        if (insertError || !newInvite) {
          results.push({ phone, status: 'error', error: insertError?.message || 'Failed to create invite' });
          continue;
        }
        invite = newInvite;
      }

      // Format the date
      const dateStr = formatInviteDate(inviteTarget.date);
      const timeStr = formatInviteTime(inviteTarget.time);

      const inviteLink = `${appUrl}/rsvp/${invite.invite_token}`;

      const messageParts = [
        `🎉 *You're Invited!*`,
        '',
        hostName ? `*${hostName}* invites you to:` : '',
        `*${inviteTarget.name}*`,
        inviteTarget.date ? `📅 ${dateStr}${timeStr ? ` at ${timeStr}` : ''}` : '',
        inviteTarget.venue ? `📍 ${inviteTarget.venue}` : '',
        inviteTarget.dress_code ? `👔 Dress code: ${inviteTarget.dress_code}` : '',
        inviteTarget.invite_message ? `\n${inviteTarget.invite_message}` : '',
        '',
        `RSVP: ${inviteLink}`,
      ];
      const message = messageParts.filter(Boolean).join('\n');

      // Send WhatsApp message via template (works for numbers that never messaged before)
      if (resolved) {
        try {
          const dateTimeLabel = `${dateStr}${timeStr ? ` at ${timeStr}` : ''}`;
          const venueLabel = inviteTarget.venue ? ` at ${inviteTarget.venue}` : '';
          const hostPrefix = hostName ? `${hostName} invites you to ` : '';
          const eventDetails = `${hostPrefix}${inviteTarget.name} on ${dateTimeLabel}${venueLabel}`;

          // Try buttons first (richer UX), fall back to template for new numbers
          let sent = false;
          try {
            await resolved.sender.sendButtons({
              to: phone,
              body: message,
              buttons: [
                { id: `rsvp_yes_${invite.id}`, title: "Yes, I'll be there!" },
                { id: `rsvp_maybe_${invite.id}`, title: 'Maybe' },
                { id: `rsvp_no_${invite.id}`, title: "Can't make it" },
              ],
            });
            sent = true;
          } catch (btnErr) {
            // Buttons failed (likely outside 24h window) — use template
            logger.info(`[INVITE] Buttons failed for ${phone}, falling back to template:`, (btnErr as Error).message);
            const templateResult = await sendWithTemplate({
              sender: resolved.sender,
              to: phone,
              templateName: 'waaiio_event_invite',
              templateParams: [eventDetails, inviteLink],
              templateOnly: true,
            });
            sent = templateResult.sent;
            if (!sent) {
              logger.error(`[INVITE] Template also failed for ${phone} — message not delivered`);
            } else {
              logger.info(`[INVITE] Template sent successfully to ${phone}, messageId: ${templateResult.messageId}`);
            }
          }

          if (sent) {
            if (alreadyResponded) {
              results.push({ phone, status: 'resent', note: `Guest already responded: ${existing!.status}` });
            } else if (isResend) {
              results.push({ phone, status: 'resent' });
            } else {
              results.push({ phone, status: 'sent' });
            }
          } else {
            results.push({ phone, status: 'created', error: 'Invite created but message could not be delivered' });
          }
        } catch (sendErr) {
          logger.error(`[INVITE] Failed to send to ${phone}:`, sendErr);
          results.push({ phone, status: 'created', error: 'Invite created but message failed to send' });
        }
      } else {
        results.push({ phone, status: 'created', error: 'No WhatsApp channel configured' });
      }
    } catch (err) {
      logger.error(`[INVITE] Error for ${phone}:`, err);
      results.push({ phone, status: 'error', error: 'Unexpected error' });
    }
  }

  // Send email invites if provided
  if (emails && emails.length > 0 && inviteTarget) {
    try {
      const { sendEmail } = await import('@/lib/email/client');
      const dateStr = formatInviteDate(inviteTarget.date);
      const timeStr = formatInviteTime(inviteTarget.time);

      for (const email of emails.slice(0, 50)) {
        if (!email || !email.includes('@')) continue;

        // Find the invite for the first phone (link email to same invite)
        const firstPhone = phones[0]?.replace(/\D/g, '') || '';
        const findQ = service.from('event_invites').select('invite_token').eq('business_id', businessId).eq('guest_phone', firstPhone);
        if (partyId) findQ.eq('party_id', partyId);
        else findQ.eq('event_id', eventId!);
        const { data: invForEmail } = await findQ.maybeSingle();

        const rsvpLink = invForEmail ? `${appUrl}/rsvp/${invForEmail.invite_token}` : appUrl;

        await sendEmail({
          to: email,
          subject: `You're invited: ${inviteTarget.name}`,
          html: `
            <div style="font-family: sans-serif; max-width: 500px; margin: 0 auto;">
              <h2 style="color: #6C2BD9;">You're Invited! 🎉</h2>
              <h3>${inviteTarget.name}</h3>
              <p>📅 ${dateStr}${timeStr ? ` at ${timeStr}` : ''}</p>
              ${inviteTarget.venue ? `<p>📍 ${inviteTarget.venue}</p>` : ''}
              ${(inviteTarget as any).dress_code ? `<p>👔 Dress code: ${(inviteTarget as any).dress_code}</p>` : ''}
              ${inviteTarget.invite_message ? `<p>${inviteTarget.invite_message}</p>` : ''}
              <div style="margin: 24px 0;">
                <a href="${rsvpLink}" style="background: #6C2BD9; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: bold;">RSVP Now</a>
              </div>
              <p style="color: #999; font-size: 12px;">From ${business?.name || 'Waaiio'} · Powered by Waaiio</p>
            </div>
          `,
        }).catch(err => logger.error(`[INVITE] Email failed for ${email}:`, err));
      }
    } catch (err) {
      logger.error('[INVITE] Email sending error:', err);
    }
  }

  return NextResponse.json({ success: true, results });
}

function formatInviteDate(dateStr: string | null): string {
  if (!dateStr) return '';
  try {
    return new Date(dateStr + 'T00:00').toLocaleDateString('en-GB', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    });
  } catch { return dateStr; }
}

function formatInviteTime(timeStr: string | null): string {
  if (!timeStr) return '';
  try {
    const [h, m] = timeStr.split(':');
    const dt = new Date();
    dt.setHours(parseInt(h, 10), parseInt(m, 10));
    return dt.toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit' });
  } catch { return timeStr; }
}

// Send reminders to pending/maybe guests
export async function PUT(request: NextRequest) {
  const body = await request.json();
  const { eventId, partyId, businessId } = body as { eventId?: string; partyId?: string; businessId: string };

  if ((!eventId && !partyId) || !businessId) {
    return NextResponse.json({ error: 'eventId or partyId, and businessId are required' }, { status: 400 });
  }

  const auth = await authenticateRequest(request, {
    requireBusinessOwnership: true,
    body: { businessId },
  });
  if (auth instanceof NextResponse) return auth;
  const { service } = auth;

  // Get event or party details
  let targetName = '';
  let targetDate = '';
  let targetVenue = '';

  if (partyId) {
    const { data: party } = await service
      .from('parties')
      .select('id, name, date, time, venue')
      .eq('id', partyId)
      .eq('business_id', businessId)
      .single();

    if (!party) {
      return NextResponse.json({ error: 'Party not found' }, { status: 404 });
    }
    targetName = party.name;
    targetDate = party.date;
    targetVenue = party.venue || '';
  } else if (eventId) {
    const { data: event } = await service
      .from('events')
      .select('id, name, date, time, venue')
      .eq('id', eventId)
      .eq('business_id', businessId)
      .single();

    if (!event) {
      return NextResponse.json({ error: 'Event not found' }, { status: 404 });
    }
    targetName = event.name;
    targetDate = event.date;
    targetVenue = event.venue || '';
  }

  // Get host name for template
  let reminderHostName = '';
  const { data: reminderBiz } = await service
    .from('businesses')
    .select('name, owner_id')
    .eq('id', businessId)
    .single();
  if (reminderBiz?.owner_id) {
    const { data: reminderOwner } = await service
      .from('profiles')
      .select('first_name, last_name')
      .eq('id', reminderBiz.owner_id)
      .single();
    if (reminderOwner?.first_name) {
      reminderHostName = `${reminderOwner.first_name}${reminderOwner.last_name ? ` ${reminderOwner.last_name}` : ''}`;
    }
  }
  if (!reminderHostName) reminderHostName = reminderBiz?.name || '';

  // Get pending + maybe invites
  const inviteQuery = service
    .from('event_invites')
    .select('id, guest_phone, guest_name, status, invite_token')
    .in('status', ['pending', 'maybe']);

  if (partyId) inviteQuery.eq('party_id', partyId);
  else inviteQuery.eq('event_id', eventId!);

  const { data: invites } = await inviteQuery;

  if (!invites || invites.length === 0) {
    return NextResponse.json({ success: true, sent: 0, message: 'No pending guests to remind' });
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com';
  const resolver = new ChannelResolver(service);
  const resolved = await resolver.resolveByBusinessId(businessId);

  let sent = 0;

  // Format the date
  let dateStr = targetDate || '';
  try {
    dateStr = new Date(targetDate + 'T00:00').toLocaleDateString('en-GB', {
      weekday: 'long', day: 'numeric', month: 'long',
    });
  } catch { /* keep raw */ }

  for (const invite of invites) {
    const link = `${appUrl}/rsvp/${invite.invite_token}`;
    const greeting = invite.guest_name ? `Hi ${invite.guest_name}! ` : '';
    const statusNote = invite.status === 'maybe'
      ? `You said *maybe* to *${targetName}*. Have you decided?`
      : `You haven't responded to the invite for *${targetName}* yet.`;

    const message = [
      `⏰ *Reminder*`,
      '',
      `${greeting}${statusNote}`,
      '',
      dateStr ? `📅 ${dateStr}` : '',
      targetVenue ? `📍 ${targetVenue}` : '',
      '',
      `RSVP here 👇`,
      link,
      '',
      `Reply: *yes*, *no*, or *maybe*`,
    ].filter(Boolean).join('\n');

    if (resolved) {
      try {
        // Try direct text first (works within 24h window)
        let messageSent = false;
        try {
          await resolved.sender.sendText({ to: invite.guest_phone, text: message });
          messageSent = true;
        } catch {
          // Outside 24h window — fall back to template
          const rHostPrefix = reminderHostName ? `${reminderHostName} invites you to ` : '';
          const eventDetails = `${rHostPrefix}${targetName}${dateStr ? ` on ${dateStr}` : ''}${targetVenue ? ` at ${targetVenue}` : ''}`;
          const templateResult = await sendWithTemplate({
            sender: resolved.sender,
            to: invite.guest_phone,
            templateName: 'waaiio_event_invite',
            templateParams: [eventDetails, link],
            templateOnly: true,
          });
          messageSent = templateResult.sent;
        }

        if (messageSent) {
          await service
            .from('event_invites')
            .update({ reminder_sent: true })
            .eq('id', invite.id);
          sent++;
        }
      } catch (err) {
        logger.error(`[INVITE] Reminder failed for ${invite.guest_phone}:`, err);
      }
    }
  }

  return NextResponse.json({ success: true, sent, total: invites.length });
}
