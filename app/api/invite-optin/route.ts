import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
import { sendWithTemplate } from '@/lib/channels/send-with-template';
import { rateLimitResponseAsync, getRateLimitKey } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';

/**
 * POST /api/invite/optin
 * Public endpoint — guest opts in to receive a WhatsApp invite.
 * Creates an event_invite record and sends the invite via WhatsApp.
 */
export async function POST(request: NextRequest) {
  const rateLimit = await rateLimitResponseAsync(getRateLimitKey(request, 'invite-optin'), 10, 60_000);
  if (rateLimit) return rateLimit;

  try {
    const { eventId, partyId, name, phone, email: guestEmail } = await request.json();

    if ((!eventId && !partyId) || (!phone && !guestEmail)) {
      return NextResponse.json({ error: 'eventId or partyId, and phone or email are required' }, { status: 400 });
    }

    const cleanPhone = phone ? String(phone).replace(/\D/g, '') : '';
    if (cleanPhone && cleanPhone.length < 7) {
      return NextResponse.json({ error: 'Invalid phone number' }, { status: 400 });
    }
    if (!cleanPhone && !guestEmail) {
      return NextResponse.json({ error: 'Please provide a phone number or email' }, { status: 400 });
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

    // Check if already invited (only if we have a phone)
    if (cleanPhone) {
      const findQuery = supabase
        .from('event_invites')
        .select('id, invite_token, status')
        .eq('guest_phone', cleanPhone)
        .eq('business_id', target.business_id);

      if (partyId) findQuery.eq('party_id', partyId);
      else findQuery.eq('event_id', eventId);

      const { data: existing } = await findQuery.maybeSingle();

      if (existing && existing.status !== 'pending') {
        // Already responded — don't re-send
        return NextResponse.json({
          success: true,
          already_invited: true,
          status: existing.status,
          rsvp_url: `${process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com'}/rsvp/${existing.invite_token}`,
        });
      }
      if (existing && existing.status === 'pending') {
        // Pending — WhatsApp probably didn't send last time. Use existing invite but continue to send.
        // Skip creating a new invite, use the existing one
        const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com';
        const inviteLink = `${appUrl}/rsvp/${existing.invite_token}`;

        // Try to send WhatsApp now
        let whatsappSent = false;
        try {
          const resolver = new ChannelResolver(supabase);
          const resolved = await resolver.resolveByBusinessId(target.business_id);
          if (resolved) {
            // Get host name
            const { data: biz } = await supabase.from('businesses').select('name, owner_id, subscription_tier').eq('id', target.business_id).single();
            let hostName = biz?.name || '';
            if (biz?.owner_id) {
              const { data: owner } = await supabase.from('profiles').select('first_name, last_name').eq('id', biz.owner_id).single();
              if (owner?.first_name) hostName = `${owner.first_name}${owner.last_name ? ` ${owner.last_name}` : ''}`;
            }

            let dateLabel = target.date;
            try { dateLabel = new Date(target.date + 'T00:00').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }); } catch {}
            let timeLabel = '';
            if (target.time) { try { const [h, m] = target.time.split(':'); const dt = new Date(); dt.setHours(parseInt(h, 10), parseInt(m, 10)); timeLabel = dt.toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit' }); } catch { timeLabel = target.time; } }

            const message = [
              `🎉 *You're Invited!*`, '',
              hostName ? `*${hostName}* invites you to:` : '',
              `*${target.name}*`,
              `📅 ${dateLabel}${timeLabel ? ` at ${timeLabel}` : ''}`,
              target.venue ? `📍 ${target.venue}` : '',
              '', `RSVP: ${inviteLink}`,
            ].filter(Boolean).join('\n');

            try {
              await resolved.sender.sendButtons({
                to: cleanPhone,
                body: message,
                buttons: [
                  { id: `rsvp_yes_${existing.id}`, title: "Yes, I'll be there!" },
                  { id: `rsvp_maybe_${existing.id}`, title: 'Maybe' },
                  { id: `rsvp_no_${existing.id}`, title: "Can't make it" },
                ],
              });
              whatsappSent = true;
            } catch {
              // Buttons failed (cold number) — fall back to template
              const eventDetails = `${hostName ? `${hostName} invites you to ` : ''}${target.name} on ${dateLabel}${timeLabel ? ` at ${timeLabel}` : ''}${target.venue ? ` at ${target.venue}` : ''}`;
              const templateResult = await sendWithTemplate({
                sender: resolved.sender,
                to: cleanPhone,
                templateName: 'waaiio_event_invite',
                templateParams: [eventDetails, inviteLink],
                templateOnly: true,
              });
              whatsappSent = templateResult.sent;
            }
          }
        } catch (err) {
          logger.error('[INVITE-OPTIN] Re-send WhatsApp error:', err);
        }

        // Get WA number for CtWA
        let waNum = '';
        try {
          const r = new ChannelResolver(supabase);
          const res = await r.resolveByBusinessId(target.business_id);
          if (res?.channel?.phone_number) waNum = res.channel.phone_number.replace(/\D/g, '');
        } catch {}

        return NextResponse.json({
          success: true,
          already_invited: true,
          whatsapp_sent: whatsappSent,
          status: existing.status,
          rsvp_url: inviteLink,
          invite_token: existing.invite_token,
          wa_number: waNum,
        });
      }
    }

    // Create invite
    const insertPayload: Record<string, unknown> = {
      business_id: target.business_id,
      guest_phone: cleanPhone || `e${Date.now().toString(36)}`,
      ...(guestName ? { guest_name: guestName } : {}),
      ...(guestEmail ? { guest_email: guestEmail.trim() } : {}),
      ...(partyId ? { party_id: partyId, event_id: null } : { event_id: eventId, party_id: null }),
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
      .select('name, owner_id, subscription_tier')
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

        try {
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
        } catch {
          // Buttons failed (cold number) — fall back to template
          const hostPrefix = hostName ? `${hostName} invites you to ` : '';
          const eventDetails = `${hostPrefix}${target.name} on ${dateLabel}${timeLabel ? ` at ${timeLabel}` : ''}${target.venue ? ` at ${target.venue}` : ''}`;
          const templateResult = await sendWithTemplate({
            sender: resolved.sender,
            to: cleanPhone,
            templateName: 'waaiio_event_invite',
            templateParams: [eventDetails, inviteLink],
            templateOnly: true,
          });
          whatsappSent = templateResult.sent;
        }
      }
    } catch (err) {
      logger.error('[INVITE-OPTIN] WhatsApp send error:', err);
    }

    // Send email invite if email provided
    let emailSent = false;
    if (guestEmail && typeof guestEmail === 'string' && guestEmail.includes('@')) {
      try {
        const { sendEmail } = await import('@/lib/email/client');
        await sendEmail({
          to: guestEmail.trim(),
          subject: `${hostName || 'You\'re'} invited: ${target.name}`,
          html: `
            <div style="font-family: sans-serif; max-width: 500px; margin: 0 auto;">
              <h2 style="color: #6C2BD9;">You're Invited! 🎉</h2>
              ${hostName ? `<p style="color: #555;"><strong>${hostName}</strong> invites you to:</p>` : ''}
              <h3>${target.name}</h3>
              <p>📅 ${dateLabel}${timeLabel ? ` at ${timeLabel}` : ''}</p>
              ${target.venue ? `<p>📍 ${target.venue}</p>` : ''}
              ${target.dress_code ? `<p>👔 Dress code: ${target.dress_code}</p>` : ''}
              ${target.invite_message ? `<p style="color: #666; font-style: italic;">"${target.invite_message}"</p>` : ''}
              <div style="margin: 24px 0;">
                <a href="${inviteLink}" style="background: #6C2BD9; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: bold;">RSVP Now</a>
              </div>
              ${biz?.subscription_tier !== 'business' ? '<p style="color: #999; font-size: 12px;">Powered by Waaiio</p>' : ''}
            </div>
          `,
        });
        emailSent = true;
      } catch (emailErr) {
        logger.error('[INVITE-OPTIN] Email error:', emailErr);
      }
    }

    // Get the WhatsApp number for Click-to-WhatsApp RSVP
    let waNumber = '';
    try {
      const resolver2 = new ChannelResolver(supabase);
      const resolved2 = await resolver2.resolveByBusinessId(target.business_id);
      if (resolved2?.channel?.phone_number) {
        waNumber = resolved2.channel.phone_number.replace(/\D/g, '');
      }
    } catch { /* non-critical */ }

    return NextResponse.json({
      success: true,
      whatsapp_sent: whatsappSent,
      email_sent: emailSent,
      rsvp_url: inviteLink,
      invite_token: invite.invite_token,
      wa_number: waNumber,
    });
  } catch (error) {
    logger.error('[INVITE-OPTIN] Error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
