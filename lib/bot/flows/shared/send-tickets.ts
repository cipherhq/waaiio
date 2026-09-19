import type { SupabaseClient } from '@supabase/supabase-js';
import type { MessageSender } from '@/lib/channels/message-sender';
import { generateTicketsPdf } from '@/lib/pdf/ticket-generator';
import { logger } from '@/lib/logger';
import { sendEmail } from '@/lib/email/client';
import { ticketConfirmationEmail } from '@/lib/email/templates';
import { formatCurrency, type CountryCode } from '@/lib/constants';
import { sanitizeFilterValue } from '@/lib/utils/sanitize';
import { dispatchWebhook } from '@/lib/webhooks/dispatcher';

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
  // Presentation-only fields for enhanced ticket PDF
  flyerUrl?: string;       // event flyer image URL (events.image_url)
  ticketTypeName?: string; // e.g. "VIP", "General Admission"
  ticketPrice?: number;    // per-ticket price for display
  currencyCode?: string;   // authoritative ISO 4217 code from payments.currency
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
/**
 * Result from canonical ticket-row creation.
 * Callers must check `rowsCreated` to determine if ticket state is complete.
 */
export interface TicketCreationResult {
  success: boolean;
  tickets: Array<{ ticketCode: string; ticketNumber: number; totalTickets: number }>;
  error?: string;
}

export interface TicketDeliveryContext extends SendTicketsOptions {
  tickets: TicketCreationResult['tickets'];
}

/**
 * Pure canonical ticket-row convergence. NO delivery side effects.
 * Creates/repairs the exact {1..N} ticket row set for a booking.
 */
export async function ensureCanonicalTicketRows(opts: {
  supabase: SupabaseClient;
  businessId: string;
  bookingId: string;
  eventId: string;
  guestName: string;
  guestPhone: string;
  quantity: number;
}): Promise<TicketCreationResult> {
  const { supabase, businessId, bookingId, eventId, guestName, guestPhone, quantity } = opts;
  const expectedNumbers = new Set(Array.from({ length: quantity }, (_, i) => i + 1));
  const phone = guestPhone.startsWith('+') ? guestPhone : `+${guestPhone}`;

  const { data: existingTickets, error: existingError } = await supabase
    .from('event_tickets')
    .select('ticket_code, ticket_number')
    .eq('booking_id', bookingId);

  if (existingError) {
    logger.error('[TICKETS] Failed to check existing tickets:', existingError.message);
    return { success: false, tickets: [], error: 'existing_ticket_lookup_failed' };
  }

  const existingNumbers = new Set((existingTickets || []).map(t => t.ticket_number));
  const missingNumbers = [...expectedNumbers].filter(n => !existingNumbers.has(n));

  if (missingNumbers.length > 0) {
    const rows = missingNumbers.map(n => ({
      business_id: businessId,
      booking_id: bookingId,
      event_id: eventId,
      ticket_code: generateTicketCode(),
      ticket_number: n,
      guest_name: guestName,
      guest_phone: phone,
      status: 'valid',
    }));

    const { error: insertError } = await supabase
      .from('event_tickets')
      .insert(rows);

    if (insertError) {
      if (insertError.code === '23505') {
        logger.info('[TICKETS] UNIQUE conflict — concurrent worker created rows for booking', bookingId);
      } else {
        logger.error('[TICKETS] Failed to insert event_tickets:', insertError.message, insertError.code);
        return { success: false, tickets: [], error: 'insert_failed' };
      }
    } else {
      logger.info('[TICKETS] Inserted', rows.length, 'missing event_tickets for booking', bookingId);
    }
  } else {
    logger.info('[TICKETS] All', quantity, 'tickets already exist for booking', bookingId);
  }

  // Authoritative final re-read of canonical ticket state
  const { data: finalTickets, error: finalError } = await supabase
    .from('event_tickets')
    .select('ticket_code, ticket_number')
    .eq('booking_id', bookingId)
    .order('ticket_number', { ascending: true });

  if (finalError) {
    logger.error('[TICKETS] Final ticket re-read failed:', finalError.message);
    return { success: false, tickets: [], error: 'final_reread_failed' };
  }

  const finalNumbers = new Set((finalTickets || []).map(t => t.ticket_number));
  const allPresent = [...expectedNumbers].every(n => finalNumbers.has(n));
  const exactCount = (finalTickets?.length ?? 0) === quantity;
  const allInRange = (finalTickets || []).every(t => expectedNumbers.has(t.ticket_number));
  if (!allPresent || !exactCount || !allInRange) {
    logger.error('[TICKETS] Canonical ticket set invalid: expected', [...expectedNumbers], 'got', [...finalNumbers], 'count', finalTickets?.length);
    return { success: false, tickets: [], error: 'canonical_set_incomplete' };
  }

  return {
    success: true,
    tickets: finalTickets!.map(t => ({ ticketCode: t.ticket_code, ticketNumber: t.ticket_number, totalTickets: quantity })),
  };
}

export async function sendTicketsAfterPurchase(opts: SendTicketsOptions): Promise<TicketCreationResult> {
  const {
    supabase, sender, businessId, bookingId, eventId,
    eventName, eventDate, eventTime, venue,
    guestName, guestPhone, referenceCode, quantity,
  } = opts;
  const t = opts.translate ?? ((text: string) => Promise.resolve(text));

  logger.info('[TICKETS] Starting sendTicketsAfterPurchase | booking:', bookingId, '| event:', eventName, '| qty:', quantity);

  // Canonical row creation (pure business state — no delivery)
  const rowResult = await ensureCanonicalTicketRows({
    supabase, businessId, bookingId, eventId, guestName, guestPhone, quantity,
  });

  if (!rowResult.success) return rowResult;

  const tickets = rowResult.tickets;
  if (opts.sender) {
    await deliverTicketsWhatsApp({ ...opts, tickets });
  } else {
    logger.info('[TICKETS] No WhatsApp sender — skipping WhatsApp delivery for booking:', opts.bookingId);
  }
  try {
    await deliverTicketsEmail({ ...opts, tickets });
  } catch (emailErr) {
    // Email remains supplemental to the WhatsApp-first ticket contract.
    logger.error('[TICKETS] Email send error:', emailErr);
  }
  await dispatchTicketPurchaseWebhooks({ ...opts, tickets });

  return { success: true, tickets };
}

/**
 * Deliver the canonical ticket set over WhatsApp. This is deliberately separate
 * from row creation so a caller can place the provider operation inside its own
 * emission fence. QR ticket images remain the primary delivery contract; the PDF
 * is an additional convenience asset.
 */
export async function deliverTicketsWhatsApp(opts: TicketDeliveryContext): Promise<void> {
  const {
    supabase, sender, businessId, bookingId,
    eventName, eventDate, eventTime, venue,
    guestName, guestPhone, referenceCode, quantity, tickets,
  } = opts;
  if (!sender) throw new Error('ticket_whatsapp_sender_unavailable');
  const t = opts.translate ?? ((text: string) => Promise.resolve(text));
  const phone = guestPhone.startsWith('+') ? guestPhone : `+${guestPhone}`;

  const verifyBaseUrl = `${process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com'}/tickets`;
  const ticketLabel = quantity === 1 ? 'ticket' : 'tickets';

  // Fetch subscription tier for white-label branding
  let subscriptionTier: string | undefined;
  try {
    const { data: bizTier } = await supabase.from('businesses').select('subscription_tier').eq('id', businessId).single();
    subscriptionTier = bizTier?.subscription_tier || 'free';
  } catch (err) { logger.warn('[TICKETS] Failed to fetch subscription tier, defaulting to free:', err); subscriptionTier = 'free'; }

  // 3. Try to generate and send PDF (optional — may fail on serverless due to PDFKit fonts)
  try {
    const pdfBuffer = await generateTicketsPdf({
      eventName, eventDate, eventTime, venue, guestName, referenceCode, tickets, verifyBaseUrl, subscriptionTier,
      flyerUrl: opts.flyerUrl,
      ticketType: opts.ticketTypeName,
      price: opts.ticketPrice,
      countryCode: opts.countryCode,
      currencyCode: opts.currencyCode,
    });

    const storagePath = `tickets/${businessId}/${bookingId}.pdf`;
    const { error: uploadError } = await supabase.storage
      .from('documents')
      .upload(storagePath, pdfBuffer, { contentType: 'application/pdf', upsert: true });

    if (!uploadError) {
      logger.info('[TICKETS] PDF uploaded to storage:', storagePath);

      const { data: signedUrlData, error: signedUrlError } = await supabase.storage
        .from('documents')
        .createSignedUrl(storagePath, 86400);

      if (!signedUrlError && signedUrlData?.signedUrl) {
        await sender.sendDocument({
          to: phone,
          documentUrl: signedUrlData.signedUrl,
          filename: `${eventName.replace(/[^a-zA-Z0-9 ]/g, '').slice(0, 40)} - Tickets.pdf`,
          caption: `Your ${quantity} ${ticketLabel} for ${eventName}`,
        });
        logger.info('[TICKETS] PDF sent to', phone);
      }
    } else {
      logger.error('[TICKETS] PDF upload failed:', uploadError.message);
    }
  } catch (pdfErr) {
    logger.error('[TICKETS] PDF generation failed (continuing to QR):', pdfErr);
  }

  // 4. Send ticket images via WhatsApp (Edge-generated image with QR code)
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com';
  for (const ticket of tickets) {
    const verifyUrl = `${appUrl}/tickets/${ticket.ticketCode}`;
    const caption = `🎟️ *${eventName}*\n\n👤 ${guestName || 'Guest'}\n🎫 Ticket ${ticket.ticketNumber}/${ticket.totalTickets} — *${ticket.ticketCode}*\n📅 ${eventDate}${eventTime ? ' · ' + eventTime : ''}\n📍 ${venue}\n🔑 Ref: *${referenceCode}*\n\nShow this at the entrance\n🔗 ${verifyUrl}`;
    const imageUrl = `${appUrl}/api/tickets/image?code=${encodeURIComponent(ticket.ticketCode)}`;

    try {
      await sender.sendImage({ to: phone, imageUrl, caption });
      logger.info('[TICKETS] Ticket image sent for', ticket.ticketCode);
    } catch (err) {
      logger.error('[TICKETS] Ticket image send failed for', ticket.ticketCode, ':', err);
      // A successful text fallback still preserves a usable ticket/verification URL.
      await sender.sendText({ to: phone, text: await t(caption) });
    }
  }
  logger.info('[TICKETS] WhatsApp ticket delivery complete for', phone, '| booking:', bookingId);
}

/** Send the canonical ticket set by email when an address is available. */
export async function deliverTicketsEmail(opts: TicketDeliveryContext): Promise<void> {
  const {
    supabase, businessId, bookingId, eventName, eventDate, eventTime, venue,
    guestName, guestPhone, referenceCode, quantity, tickets,
  } = opts;
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

  if (!email) throw new Error('ticket_email_unavailable');

  const { data: biz, error: bizError } = await supabase
    .from('businesses')
    .select('name, subscription_tier')
    .eq('id', businessId)
    .single();
  if (bizError) throw new Error(`ticket_email_business_lookup_failed:${bizError.message}`);

  const { isWhiteLabel: isWl } = await import('@/lib/whitelabel');
  const emailContent = ticketConfirmationEmail({
    firstName: guestName.split(' ')[0] || 'there',
    businessName: biz?.name || 'Event',
    eventName,
    eventDate,
    eventTime,
    venue,
    quantity,
    referenceCode,
    formattedAmount: opts.amount ? formatCurrency(opts.amount, opts.countryCode || 'US') : 'Paid',
    ticketCodes: tickets.map(t => t.ticketCode),
    whitelabel: isWl(biz?.subscription_tier),
  });
  const result = await sendEmail({ to: email, ...emailContent });
  if (!result.success) throw new Error('ticket_email_send_failed');
  logger.info('[TICKETS] Email sent to', email, '| booking:', bookingId);
}

async function dispatchTicketPurchaseWebhooks(opts: TicketDeliveryContext): Promise<void> {
  const { supabase, businessId, bookingId, eventId, eventName, guestName, guestPhone, referenceCode, quantity, tickets } = opts;
  dispatchWebhook(supabase, businessId, 'ticket.purchased', {
    event_id: eventId,
    event_name: eventName,
    booking_id: bookingId,
    reference_code: referenceCode,
    guest_name: guestName,
    guest_phone: guestPhone,
    quantity,
    ticket_codes: tickets.map(t => t.ticketCode),
  }).catch(err => logger.error('[TICKETS] Webhook dispatch error:', err));

  // 10. Check if event is sold out → dispatch event.sold_out
  const { data: evt } = await supabase
    .from('events')
    .select('total_tickets, tickets_sold')
    .eq('id', eventId)
    .single();

  if (evt && evt.tickets_sold >= evt.total_tickets) {
    dispatchWebhook(supabase, businessId, 'event.sold_out', {
      event_id: eventId,
      event_name: eventName,
      total_tickets: evt.total_tickets,
    }).catch(err => logger.error('[TICKETS] Sold-out webhook error:', err));
  }

}
