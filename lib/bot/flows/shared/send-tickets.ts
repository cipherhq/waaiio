import type { SupabaseClient } from '@supabase/supabase-js';
import type { MessageSender } from '@/lib/channels/message-sender';
import { generateTicketsPdf } from '@/lib/pdf/ticket-generator';
import QRCode from 'qrcode';
import { logger } from '@/lib/logger';
import { sendEmail } from '@/lib/email/client';
import { ticketConfirmationEmail } from '@/lib/email/templates';
import { formatCurrency, type CountryCode } from '@/lib/constants';
import { sanitizeFilterValue } from '@/lib/utils/sanitize';

export interface SendTicketsOptions {
  supabase: SupabaseClient;
  sender?: MessageSender;
  businessId: string;
  bookingId: string;
  eventId: string;
  eventName: string;
  eventDate: string;   // formatted date label
  eventTime?: string;  // formatted time label
  venue: string;
  guestName: string;
  guestPhone: string;
  guestEmail?: string;
  referenceCode: string;
  quantity: number;
  amount?: number;
  countryCode?: CountryCode;
  /** Optional translation function for customer-facing messages (from ctx.t) */
  translate?: (text: string) => Promise<string>;
}

/** Generate a short unique ticket code like "TK-A3F8X2" */
function generateTicketCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous I/O/0/1
  const randomBytes = crypto.getRandomValues(new Uint8Array(6));
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[randomBytes[i] % chars.length];
  }
  return `TK-${code}`;
}

/**
 * After a ticket purchase:
 * 1. Generate unique ticket codes
 * 2. Insert rows into event_tickets
 * 3. Generate PDF with QR codes
 * 4. Upload to Supabase Storage
 * 5. Send PDF via WhatsApp
 */
export async function sendTicketsAfterPurchase(opts: SendTicketsOptions): Promise<void> {
  const {
    supabase, sender, businessId, bookingId, eventId,
    eventName, eventDate, eventTime, venue,
    guestName, guestPhone, referenceCode, quantity,
  } = opts;
  const t = opts.translate ?? ((text: string) => Promise.resolve(text));

  logger.info('[TICKETS] Starting sendTicketsAfterPurchase | booking:', bookingId, '| event:', eventName, '| qty:', quantity);

  // 1. Generate unique ticket codes
  const tickets: Array<{ ticketCode: string; ticketNumber: number; totalTickets: number }> = [];
  for (let i = 0; i < quantity; i++) {
    tickets.push({
      ticketCode: generateTicketCode(),
      ticketNumber: i + 1,
      totalTickets: quantity,
    });
  }

  // 2. Check if tickets already exist (dedup — webhook + "I've Paid" race)
  const { data: existingTickets } = await supabase
    .from('event_tickets')
    .select('ticket_code')
    .eq('booking_id', bookingId);

  if (existingTickets && existingTickets.length > 0) {
    logger.info('[TICKETS] Tickets already exist for booking', bookingId, '— skipping insert, using existing');
    // Use existing ticket codes instead of generating new ones
    tickets.length = 0;
    existingTickets.forEach((t, i) => {
      tickets.push({
        ticketCode: t.ticket_code,
        ticketNumber: i + 1,
        totalTickets: existingTickets.length,
      });
    });
  } else {
    // Insert new tickets
    const rows = tickets.map(t => ({
      business_id: businessId,
      booking_id: bookingId,
      event_id: eventId,
      ticket_code: t.ticketCode,
      ticket_number: t.ticketNumber,
      guest_name: guestName,
      guest_phone: guestPhone.startsWith('+') ? guestPhone : `+${guestPhone}`,
      status: 'valid',
    }));

    const { error: insertError } = await supabase
      .from('event_tickets')
      .insert(rows);

    if (insertError) {
      logger.error('[TICKETS] Failed to insert event_tickets:', insertError.message, insertError.code);
      return;
    }
    logger.info('[TICKETS] Inserted', tickets.length, 'event_tickets');
  }

  const verifyBaseUrl = `${process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com'}/tickets`;
  const phone = guestPhone.startsWith('+') ? guestPhone : `+${guestPhone}`;
  const ticketLabel = quantity === 1 ? 'ticket' : 'tickets';

  // 3. Try to generate and send PDF (optional — may fail on serverless due to PDFKit fonts)
  try {
    const pdfBuffer = await generateTicketsPdf({
      eventName, eventDate, eventTime, venue, guestName, referenceCode, tickets, verifyBaseUrl,
    });

    const storagePath = `tickets/${businessId}/${bookingId}.pdf`;
    const { error: uploadError } = await supabase.storage
      .from('documents')
      .upload(storagePath, pdfBuffer, { contentType: 'application/pdf', upsert: true });

    if (!uploadError) {
      logger.info('[TICKETS] PDF uploaded to storage:', storagePath);

      // Only send via WhatsApp if sender is available (not web-only purchases)
      if (sender) {
        const { data: signedUrlData } = await supabase.storage
          .from('documents')
          .createSignedUrl(storagePath, 86400);

        if (signedUrlData?.signedUrl) {
          await sender.sendDocument({
            to: phone,
            documentUrl: signedUrlData.signedUrl,
            filename: `${eventName.replace(/[^a-zA-Z0-9 ]/g, '').slice(0, 40)} - Tickets.pdf`,
            caption: `Your ${quantity} ${ticketLabel} for ${eventName}`,
          });
          logger.info('[TICKETS] PDF sent to', phone);
        }
      }
    } else {
      logger.error('[TICKETS] PDF upload failed:', uploadError.message);
    }
  } catch (pdfErr) {
    logger.error('[TICKETS] PDF generation failed (continuing to QR):', pdfErr);
  }

  // 4. Send ticket images via WhatsApp (flyer + QR composited)
  if (sender) {
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com';

    // Fetch event flyer once (reuse for all tickets)
    let flyerBuffer: Buffer | null = null;
    if (eventId) {
      try {
        const { data: evt } = await supabase.from('events').select('image_url').eq('id', eventId).single();
        if (evt?.image_url) {
          let flyerUrl = evt.image_url;
          if (flyerUrl.toLowerCase().endsWith('.webp')) {
            flyerUrl = `${appUrl}/api/images/convert?url=${encodeURIComponent(flyerUrl)}`;
          }
          const res = await fetch(flyerUrl);
          if (res.ok) flyerBuffer = Buffer.from(await res.arrayBuffer());
        }
      } catch {
        logger.error('[TICKETS] Flyer fetch failed (will send QR only)');
      }
    }

    for (const ticket of tickets) {
      const verifyUrl = `${appUrl}/tickets/${ticket.ticketCode}`;
      const caption = `🎟️ *${eventName}*\n\n👤 ${guestName || 'Guest'}\n🎫 Ticket ${ticket.ticketNumber}/${ticket.totalTickets} — *${ticket.ticketCode}*\n📅 ${eventDate}${eventTime ? ' · ' + eventTime : ''}\n📍 ${venue}\n🔑 Ref: *${referenceCode}*\n\nShow this at the entrance\n🔗 ${verifyUrl}`;

      try {
        const sharp = (await import('sharp')).default;
        const qrPng = await QRCode.toBuffer(verifyUrl, { type: 'png', width: 250, margin: 1, color: { dark: '#000000', light: '#FFFFFF' } });

        let composited: Buffer;

        // Helper: escape XML special characters for SVG text
        const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        // Truncate text for SVG (avoid overflow)
        const trunc = (s: string, max: number) => s.length > max ? s.slice(0, max - 1) + '…' : s;

        const displayName = trunc(esc(guestName || 'Guest'), 30);
        const displayEvent = trunc(esc(eventName), 40);
        const displayDate = esc(eventDate + (eventTime ? ` · ${eventTime}` : ''));
        const displayVenue = trunc(esc(venue || ''), 35);
        const displayCode = esc(ticket.ticketCode);
        const displayRef = esc(`Ref: ${referenceCode}`);
        const displayTicketNum = esc(`Ticket ${ticket.ticketNumber}/${ticket.totalTickets}`);

        if (flyerBuffer) {
          // Flyer exists: composite QR + details bar at bottom
          const flyer = sharp(flyerBuffer).resize(800, null, { withoutEnlargement: true });
          const flyerMeta = await flyer.metadata();
          const flyerH = flyerMeta.height || 800;
          const flyerW = flyerMeta.width || 800;

          // White background behind QR for visibility
          const qrSize = 180;
          const qrBgSvg = `<svg width="${qrSize}" height="${qrSize}" xmlns="http://www.w3.org/2000/svg"><rect width="${qrSize}" height="${qrSize}" rx="12" fill="white" opacity="0.95"/></svg>`;
          const qrWithBg = await sharp(Buffer.from(qrBgSvg))
            .composite([{ input: qrPng, top: 10, left: 10 }])
            .resize(qrSize, qrSize)
            .png().toBuffer();

          // Create a dark semi-transparent bar at the bottom with event/guest details
          const barHeight = 120;
          const textPadLeft = 20;
          const barSvg = `<svg width="${flyerW}" height="${barHeight}" xmlns="http://www.w3.org/2000/svg">
            <rect width="${flyerW}" height="${barHeight}" fill="black" opacity="0.8"/>
            <text x="${textPadLeft}" y="28" font-family="sans-serif" font-size="18" font-weight="bold" fill="white">${displayEvent}</text>
            <text x="${textPadLeft}" y="52" font-family="sans-serif" font-size="14" fill="#e0e0e0">${displayDate}</text>
            <text x="${textPadLeft}" y="74" font-family="sans-serif" font-size="13" fill="#c0c0c0">${displayVenue ? '📍 ' + displayVenue : ''}</text>
            <text x="${textPadLeft}" y="98" font-family="sans-serif" font-size="13" fill="#a0a0ff">👤 ${displayName}  ·  🎫 ${displayCode}  ·  ${displayTicketNum}</text>
          </svg>`;
          const darkBar = await sharp(Buffer.from(barSvg)).png().toBuffer();

          // Composite: flyer + info bar at bottom + QR in bottom-right
          composited = await flyer
            .composite([
              { input: darkBar, top: flyerH - barHeight, left: 0 },
              { input: qrWithBg, top: flyerH - barHeight - qrSize + 10, left: flyerW - qrSize - 15 },
            ])
            .jpeg({ quality: 90 })
            .toBuffer();
        } else {
          // No flyer: generate a branded ticket card with event details + QR
          const cardWidth = 700;
          const cardHeight = 420;

          const bgSvg = `<svg width="${cardWidth}" height="${cardHeight}" xmlns="http://www.w3.org/2000/svg">
            <defs>
              <linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" style="stop-color:#6C2BD9"/>
                <stop offset="100%" style="stop-color:#4C1D95"/>
              </linearGradient>
            </defs>
            <rect width="${cardWidth}" height="${cardHeight}" rx="24" fill="url(#g)"/>
            <text x="36" y="55" font-family="sans-serif" font-size="11" fill="#c4a8ff" letter-spacing="2">TICKET</text>
            <text x="36" y="90" font-family="sans-serif" font-size="24" font-weight="bold" fill="white">${displayEvent}</text>
            <text x="36" y="125" font-family="sans-serif" font-size="15" fill="#e0d0ff">${displayDate}</text>
            <text x="36" y="155" font-family="sans-serif" font-size="14" fill="#c4a8ff">${displayVenue ? '📍 ' + displayVenue : ''}</text>
            <line x1="36" y1="185" x2="310" y2="185" stroke="#8b5cf6" stroke-width="1" opacity="0.5"/>
            <text x="36" y="215" font-family="sans-serif" font-size="12" fill="#c4a8ff">GUEST</text>
            <text x="36" y="240" font-family="sans-serif" font-size="18" font-weight="bold" fill="white">${displayName}</text>
            <text x="36" y="280" font-family="sans-serif" font-size="12" fill="#c4a8ff">TICKET CODE</text>
            <text x="36" y="305" font-family="sans-serif" font-size="18" font-weight="bold" fill="#fbbf24">${displayCode}</text>
            <text x="36" y="340" font-family="sans-serif" font-size="12" fill="#c4a8ff">${displayTicketNum}  ·  ${displayRef}</text>
            <rect x="420" y="50" width="240" height="240" rx="16" fill="white" opacity="0.95"/>
            <text x="490" y="320" font-family="sans-serif" font-size="11" fill="#c4a8ff">Scan to verify</text>
            <text x="36" y="${cardHeight - 16}" font-family="sans-serif" font-size="10" fill="#8b5cf6" opacity="0.7">Powered by Waaiio</text>
          </svg>`;

          composited = await sharp(Buffer.from(bgSvg))
            .composite([
              { input: qrPng, top: 60, left: 430 },
            ])
            .resize(cardWidth, cardHeight)
            .jpeg({ quality: 90 })
            .toBuffer();
        }

        // Upload to storage for a public URL
        const storagePath = `tickets/${businessId}/${ticket.ticketCode}.jpg`;
        const { error: uploadErr } = await supabase.storage
          .from('business-documents')
          .upload(storagePath, composited, { contentType: 'image/jpeg', upsert: true });

        if (!uploadErr) {
          const { data: urlData } = supabase.storage.from('business-documents').getPublicUrl(storagePath);
          await sender.sendImage({ to: phone, imageUrl: urlData.publicUrl, caption });
          logger.info('[TICKETS] Ticket image sent for', ticket.ticketCode);
        } else {
          logger.error('[TICKETS] Upload failed for', ticket.ticketCode, ':', uploadErr.message);
          // Text fallback on upload failure
          await sender.sendText({ to: phone, text: await t(caption) }).catch(() => {});
        }
      } catch (err) {
        logger.error('[TICKETS] Ticket image failed for', ticket.ticketCode, ':', err);
        // Text fallback
        await sender.sendText({ to: phone, text: await t(caption) }).catch(() => {});
      }
    }
    logger.info('[TICKETS] WhatsApp ticket delivery complete for', phone, '| booking:', bookingId);
  } else {
    logger.info('[TICKETS] No WhatsApp sender — skipping WhatsApp delivery for booking:', bookingId);
  }

  // 8. Send email confirmation if we have an email address
  let email = opts.guestEmail;
  if (!email) {
    // Try to find email from profile
    const phoneP = sanitizeFilterValue(guestPhone.startsWith('+') ? guestPhone : `+${guestPhone}`);
    const phoneN = sanitizeFilterValue(guestPhone.startsWith('+') ? guestPhone.slice(1) : guestPhone);
    const { data: profile } = await supabase
      .from('profiles')
      .select('email')
      .or(`phone.eq.${phoneP},phone.eq.${phoneN}`)
      .limit(1)
      .maybeSingle();
    email = profile?.email || undefined;
  }

  if (email) {
    try {
      const ticketCodes = tickets.map(t => t.ticketCode);
      const firstName = guestName.split(' ')[0] || 'there';
      const { data: biz } = await supabase
        .from('businesses')
        .select('name')
        .eq('id', businessId)
        .single();

      const emailContent = ticketConfirmationEmail({
        firstName,
        businessName: biz?.name || 'Event',
        eventName,
        eventDate,
        eventTime,
        venue,
        quantity,
        referenceCode,
        formattedAmount: opts.amount ? formatCurrency(opts.amount, opts.countryCode || 'US') : 'Paid',
        ticketCodes,
      });

      await sendEmail({ to: email, ...emailContent });
      logger.info('[TICKETS] Email sent to', email, '| booking:', bookingId);
    } catch (emailErr) {
      logger.error('[TICKETS] Email send error:', emailErr);
    }
  }
}
