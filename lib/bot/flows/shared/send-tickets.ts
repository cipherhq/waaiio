import type { SupabaseClient } from '@supabase/supabase-js';
import type { MessageSender } from '@/lib/channels/message-sender';
import { generateTicketsPdf } from '@/lib/pdf/ticket-generator';
import { resolveProactiveLocalization } from '@/lib/payments/proactive-localization';
import { fillFlowCopy } from '@/lib/bot/flows/flow-localization';
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

/** Durable Event emission result; never convert ambiguity into a fallback send. */
export class EventTicketEmissionError extends Error {
  constructor(public readonly reason: string) { super(reason); }
}

async function emitTicketArtifact(
  opts: TicketDeliveryContext,
  channel: 'whatsapp' | 'email',
  key: string,
  send: () => Promise<{ messageId?: string; id?: string; success?: boolean; error?: unknown } | undefined>,
): Promise<void> {
  const { data: permit, error } = await opts.supabase.rpc('authorize_event_ticket_emission', {
    p_booking_id: opts.bookingId, p_channel: channel, p_emission_key: key,
  });
  if (error || !permit) throw new EventTicketEmissionError('ticket_emission_authority_unavailable');
  if (permit.authorized !== true) {
    if (permit.state === 'accepted') return;
    throw new EventTicketEmissionError(permit.reason || 'ticket_emission_not_authorized');
  }
  let result: Awaited<ReturnType<typeof send>>;
  try {
    result = await send();
  } catch (err) {
    // Conservatively unknown unless the provider gave an explicit client rejection.
    const status = typeof err === 'object' && err !== null
      ? Number((err as { httpStatus?: number; statusCode?: number }).httpStatus ||
        (err as { statusCode?: number }).statusCode || 0) : 0;
    const definite = status >= 400 && status < 500 && status !== 408;
    await opts.supabase.rpc('finalize_event_ticket_emission', {
      p_emission_id: permit.emission_id, p_state: definite ? 'failed' : 'ambiguous',
      p_provider_message_id: null,
    });
    throw new EventTicketEmissionError(definite ? 'ticket_provider_rejected' : 'ticket_emission_ambiguous');
  }
  const providerId = result?.messageId || result?.id;
  const returnedStatus = result?.error && typeof result.error === 'object'
    ? Number((result.error as { statusCode?: number }).statusCode || 0) : 0;
  const rejected = result?.success === false && returnedStatus >= 400 && returnedStatus < 500 && returnedStatus !== 408;
  const state = providerId && result?.success !== false ? 'accepted' : rejected ? 'failed' : 'ambiguous';
  const { data: final, error: finalError } = await opts.supabase.rpc('finalize_event_ticket_emission', {
    p_emission_id: permit.emission_id, p_state: state, p_provider_message_id: providerId || null,
  });
  if (finalError || final?.finalized !== true) throw new EventTicketEmissionError('ticket_emission_finalize_unresolved');
  if (state !== 'accepted') throw new EventTicketEmissionError(rejected ? 'ticket_provider_rejected' : 'ticket_emission_ambiguous');
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
  const { supabase, bookingId, eventId, quantity } = opts;
  const { data, error } = await supabase.rpc('converge_event_ticket_booking', {
    p_booking_id: bookingId, p_event_id: eventId, p_ticket_type_id: null, p_quantity: quantity,
  });
  if (error || !data) return { success: false, tickets: [], error: 'ticket_convergence_failed' };
  if (data.outcome === 'cancelled_followup_recorded') {
    return { success: false, tickets: [], error: 'event_cancelled_followup_recorded' };
  }
  if (data.success !== true || data.outcome !== 'issued' || !Array.isArray(data.tickets) ||
      data.tickets.length !== quantity) {
    return { success: false, tickets: [], error: data.reason || 'canonical_set_incomplete' };
  }
  const numbers = new Set(data.tickets.map((ticket: { ticketNumber: number }) => ticket.ticketNumber));
  if (numbers.size !== quantity || !Array.from({ length: quantity }, (_, i) => i + 1).every(n => numbers.has(n))) {
    return { success: false, tickets: [], error: 'canonical_set_incomplete' };
  }
  return { success: true, tickets: data.tickets };
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
    if (emailErr instanceof EventTicketEmissionError && emailErr.reason === 'event_cancelled') {
      return { success: false, tickets: [], error: 'event_cancelled_followup_recorded' };
    }
    // Email remains supplemental to the WhatsApp-first ticket contract.
    logger.error('[TICKETS] Email send error:', emailErr);
  }
  try {
    await dispatchTicketPurchaseWebhooks({ ...opts, tickets });
  } catch (error) {
    if (error instanceof EventTicketEmissionError && error.reason === 'event_cancelled') {
      return { success: false, tickets: [], error: 'event_cancelled_followup_recorded' };
    }
    throw error;
  }

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

  // Resolve customer language for localized captions
  let ticketCopyLang = 'en';
  try {
    const ticketL10n = await resolveProactiveLocalization(supabase, guestPhone, businessId);
    ticketCopyLang = ticketL10n.language;
  } catch { /* fall back to English */ }

  // Fetch subscription tier for white-label branding
  let subscriptionTier: string | undefined;
  try {
    const { data: bizTier } = await supabase.from('businesses').select('subscription_tier').eq('id', businessId).single();
    subscriptionTier = bizTier?.subscription_tier || 'free';
  } catch (err) { logger.warn('[TICKETS] Failed to fetch subscription tier, defaulting to free:', err); subscriptionTier = 'free'; }

  // 3. Try to generate and send PDF (optional — may fail on serverless due to PDFKit fonts)
  try {
    // Slice 5B: Resolve deterministic ticket PDF labels
    let ticketPdfLabels: import('@/lib/pdf/localize-pdf').TicketPdfLabels | undefined;
    if (opts.translate) {
      const { resolvePdfLabels } = await import('@/lib/pdf/localize-pdf');
      ticketPdfLabels = await resolvePdfLabels(opts.supabase, guestPhone, businessId, 'ticket', 'proactive');
    }
    const pdfBuffer = await generateTicketsPdf({
      eventName, eventDate, eventTime, venue, guestName, referenceCode, tickets, verifyBaseUrl, subscriptionTier,
      flyerUrl: opts.flyerUrl,
      ticketType: opts.ticketTypeName,
      price: opts.ticketPrice,
      countryCode: opts.countryCode,
      currencyCode: opts.currencyCode,
      labels: ticketPdfLabels,
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
        await emitTicketArtifact(opts, 'whatsapp', 'document', () => sender.sendDocument({
          to: phone,
          documentUrl: signedUrlData.signedUrl,
          filename: `${eventName.replace(/[^a-zA-Z0-9 ]/g, '').slice(0, 40)} - Tickets.pdf`,
          caption: fillFlowCopy(ticketCopyLang, 'notification.ticket_pdf_caption', { quantity: String(quantity), ticketLabel, eventName }),
          messageCategory: 'service', noRetry: true,
        }));
        logger.info('[TICKETS] PDF sent to', phone);
      }
    } else {
      logger.error('[TICKETS] PDF upload failed:', uploadError.message);
    }
  } catch (pdfErr) {
    if (pdfErr instanceof EventTicketEmissionError && pdfErr.reason !== 'ticket_provider_rejected') throw pdfErr;
    logger.error('[TICKETS] PDF generation failed (continuing to QR):', pdfErr);
  }

  // 4. Send ticket images via WhatsApp (Edge-generated image with QR code)
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com';
  for (const ticket of tickets) {
    const verifyUrl = `${appUrl}/tickets/${ticket.ticketCode}`;
    const caption = `🎟️ *${eventName}*\n\n👤 ${guestName || 'Guest'}\n🎫 Ticket ${ticket.ticketNumber}/${ticket.totalTickets} — *${ticket.ticketCode}*\n📅 ${eventDate}${eventTime ? ' · ' + eventTime : ''}\n📍 ${venue}\n🔑 Ref: *${referenceCode}*\n\nShow this at the entrance\n🔗 ${verifyUrl}`;
    const imageUrl = `${appUrl}/api/tickets/image?code=${encodeURIComponent(ticket.ticketCode)}`;

    try {
      await emitTicketArtifact(opts, 'whatsapp', `image:${ticket.ticketCode}`, () => sender.sendImage({ to: phone, imageUrl, caption, messageCategory: 'service', noRetry: true }));
      logger.info('[TICKETS] Ticket image sent for', ticket.ticketCode);
    } catch (err) {
      if (!(err instanceof EventTicketEmissionError) || err.reason !== 'ticket_provider_rejected') throw err;
      logger.error('[TICKETS] Ticket image send failed for', ticket.ticketCode, ':', err);
      // A successful text fallback still preserves a usable ticket/verification URL.
      const fallbackText = await t(caption);
      await emitTicketArtifact(opts, 'whatsapp', `text:${ticket.ticketCode}`, () => sender.sendText({ to: phone, text: fallbackText, messageCategory: 'service', noRetry: true }));
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
  // Slice 5B: Translate ticket email labels if non-English customer
  let ticketEmailLabels: import('@/lib/email/localize-email').TicketEmailLabels | undefined;
  let ticketWrapperLabels: import('@/lib/email/localize-email').EmailWrapperLabels | undefined;
  if (opts.translate) {
    try {
      const { resolveProactiveLocalization } = await import('@/lib/payments/proactive-localization');
      const { translateLabels, DEFAULT_TICKET_LABELS, DEFAULT_WRAPPER_LABELS } = await import('@/lib/email/localize-email');
      const l10n = await resolveProactiveLocalization(opts.supabase, guestPhone, businessId);
      if (l10n.language !== 'en') {
        ticketEmailLabels = await translateLabels(DEFAULT_TICKET_LABELS, l10n, [eventName, venue, referenceCode]) as unknown as typeof DEFAULT_TICKET_LABELS;
        const { localizeWrapperLabels } = await import('@/lib/email/localize-email');
        ticketWrapperLabels = await localizeWrapperLabels(l10n);
      }
    } catch { /* fail closed to English */ }
  }
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
    labels: ticketEmailLabels,
    wrapperLabels: ticketWrapperLabels,
  });
  await emitTicketArtifact(opts, 'email', 'ticket', () => sendEmail({ to: email!, ...emailContent, noRetry: true }));
  logger.info('[TICKETS] Email sent to', email, '| booking:', bookingId);
}

/** Dispatcher returns void, so completion is not evidence of provider acceptance. */
async function dispatchAuthorizedTicketWebhook(
  opts: TicketDeliveryContext,
  eventType: 'ticket.purchased' | 'event.sold_out',
  payload: Record<string, unknown>,
): Promise<void> {
  const { data: permit, error } = await opts.supabase.rpc('authorize_event_ticket_emission', {
    p_booking_id: opts.bookingId, p_channel: 'webhook', p_emission_key: eventType,
  });
  if (error || !permit) throw new EventTicketEmissionError('ticket_emission_authority_unavailable');
  if (permit.authorized !== true) {
    // Any prior attempt is durable: the dispatcher provides no safe replay proof.
    if (permit.reason === 'already_authorized') return;
    throw new EventTicketEmissionError(permit.reason || 'ticket_emission_not_authorized');
  }
  try {
    await dispatchWebhook(opts.supabase, opts.businessId, eventType, payload);
  } catch (error) {
    logger.error('[TICKETS] Webhook dispatch outcome unresolved:', error);
  }
  // The dispatcher owns endpoint-specific delivery records. Never invent an ID.
  const { error: finalError } = await opts.supabase.rpc('finalize_event_ticket_emission', {
    p_emission_id: permit.emission_id, p_state: 'ambiguous', p_provider_message_id: null,
  });
  if (finalError) logger.warn('[TICKETS] Webhook attempt remains unresolved');
}

async function dispatchTicketPurchaseWebhooks(opts: TicketDeliveryContext): Promise<void> {
  const { supabase, businessId, bookingId, eventId, eventName, guestName, guestPhone, referenceCode, quantity, tickets } = opts;
  await dispatchAuthorizedTicketWebhook(opts, 'ticket.purchased', {
    event_id: eventId,
    event_name: eventName,
    booking_id: bookingId,
    reference_code: referenceCode,
    guest_name: guestName,
    guest_phone: guestPhone,
    quantity,
    ticket_codes: tickets.map(t => t.ticketCode),
  });

  // 10. Check if event is sold out → dispatch event.sold_out
  const { data: evt } = await supabase
    .from('events')
    .select('total_tickets, tickets_sold')
    .eq('id', eventId)
    .single();

  if (evt && evt.tickets_sold >= evt.total_tickets) {
    await dispatchAuthorizedTicketWebhook(opts, 'event.sold_out', {
      event_id: eventId,
      event_name: eventName,
      total_tickets: evt.total_tickets,
    });
  }

}
