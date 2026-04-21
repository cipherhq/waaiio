import type { SupabaseClient } from '@supabase/supabase-js';
import type { MessageSender } from '@/lib/channels/message-sender';
import { generateTicketsPdf } from '@/lib/pdf/ticket-generator';
import { logger } from '@/lib/logger';

export interface SendTicketsOptions {
  supabase: SupabaseClient;
  sender: MessageSender;
  businessId: string;
  bookingId: string;
  eventId: string;
  eventName: string;
  eventDate: string;   // formatted date label
  eventTime?: string;  // formatted time label
  venue: string;
  guestName: string;
  guestPhone: string;
  referenceCode: string;
  quantity: number;
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

  // 1. Generate unique ticket codes
  const tickets: Array<{ ticketCode: string; ticketNumber: number; totalTickets: number }> = [];
  for (let i = 0; i < quantity; i++) {
    tickets.push({
      ticketCode: generateTicketCode(),
      ticketNumber: i + 1,
      totalTickets: quantity,
    });
  }

  // 2. Insert into event_tickets
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

  // 3. Generate PDF
  const verifyBaseUrl = `${process.env.NEXT_PUBLIC_APP_URL || 'https://waaiio.com'}/tickets`;

  const pdfBuffer = await generateTicketsPdf({
    eventName,
    eventDate,
    eventTime,
    venue,
    guestName,
    referenceCode,
    tickets,
    verifyBaseUrl,
  });

  // 4. Upload to Supabase Storage
  const storagePath = `tickets/${businessId}/${bookingId}.pdf`;

  const { error: uploadError } = await supabase.storage
    .from('documents')
    .upload(storagePath, pdfBuffer, {
      contentType: 'application/pdf',
      upsert: true,
    });

  if (uploadError) {
    logger.error('[TICKETS] Failed to upload PDF to storage:', uploadError.message, '| path:', storagePath);
    return;
  }

  // 5. Create signed URL (24-hour expiry)
  const { data: signedUrlData, error: signedUrlError } = await supabase.storage
    .from('documents')
    .createSignedUrl(storagePath, 86400); // 24 hours

  if (signedUrlError || !signedUrlData?.signedUrl) {
    logger.error('[TICKETS] Failed to create signed URL:', signedUrlError?.message, '| path:', storagePath);
    return;
  }

  // 6. Send via WhatsApp
  const phone = guestPhone.startsWith('+') ? guestPhone : `+${guestPhone}`;
  const ticketLabel = quantity === 1 ? 'ticket' : 'tickets';

  await sender.sendDocument({
    to: phone,
    documentUrl: signedUrlData.signedUrl,
    filename: `${eventName.replace(/[^a-zA-Z0-9 ]/g, '').slice(0, 40)} - Tickets.pdf`,
    caption: `Your ${quantity} ${ticketLabel} for ${eventName}`,
  });

  logger.info('[TICKETS] PDF sent successfully to', phone, '| booking:', bookingId);
}
