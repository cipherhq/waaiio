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
}

/** Generate a short unique ticket code like "TK-A3F8X2" */
function generateTicketCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous I/O/0/1
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
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

  const verifyBaseUrl = `${process.env.NEXT_PUBLIC_APP_URL || 'https://waaiio.com'}/tickets`;
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
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://waaiio.com';

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
      const caption = `🎟️ Ticket ${ticket.ticketNumber}/${ticket.totalTickets} — *${ticket.ticketCode}*\n📅 ${eventDate}${eventTime ? ' · ' + eventTime : ''}\n📍 ${venue}\nShow this at the entrance\n\n🔗 ${verifyUrl}`;

      try {
        // Try compositing QR onto flyer
        if (flyerBuffer) {
          const sharp = (await import('sharp')).default;
          const qrPng = await QRCode.toBuffer(verifyUrl, { type: 'png', width: 200, margin: 1, color: { dark: '#000000', light: '#FFFFFF' } });

          // Resize flyer to standard width, then composite QR in bottom-right with white padding
          const flyer = sharp(flyerBuffer).resize(800, null, { withoutEnlargement: true });
          const flyerMeta = await flyer.metadata();
          const flyerH = flyerMeta.height || 800;

          // White background behind QR for visibility
          const qrWithBg = await sharp(Buffer.from(
            `<svg width="220" height="220"><rect width="220" height="220" rx="12" fill="white"/></svg>`
          )).composite([{ input: qrPng, top: 10, left: 10 }]).png().toBuffer();

          const composited = await flyer
            .composite([{ input: qrWithBg, top: flyerH - 230, left: 570, }])
            .jpeg({ quality: 90 })
            .toBuffer();

          // Upload to storage for a public URL
          const storagePath = `tickets/${businessId}/${ticket.ticketCode}.jpg`;
          const { error: uploadErr } = await supabase.storage
            .from('business-documents')
            .upload(storagePath, composited, { contentType: 'image/jpeg', upsert: true });

          if (!uploadErr) {
            const { data: urlData } = supabase.storage.from('business-documents').getPublicUrl(storagePath);
            await sender.sendImage({ to: phone, imageUrl: urlData.publicUrl, caption });
            logger.info('[TICKETS] Flyer+QR image sent for', ticket.ticketCode);
            continue; // Success — skip fallbacks
          }
        }

        // Fallback: QR code only (no flyer or compositing failed)
        const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&format=png&data=${encodeURIComponent(verifyUrl)}`;
        await sender.sendImage({ to: phone, imageUrl: qrImageUrl, caption });
        logger.info('[TICKETS] QR-only sent for', ticket.ticketCode);
      } catch (err) {
        logger.error('[TICKETS] Ticket image failed for', ticket.ticketCode, ':', err);
        // Text fallback
        await sender.sendText({ to: phone, text: caption }).catch(() => {});
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
