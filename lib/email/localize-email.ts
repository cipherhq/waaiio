/**
 * Email Localization — Slice 5B (#524)
 *
 * Translates Waaiio-owned email presentation labels before HTML rendering.
 * NEVER translates completed HTML. Translation happens at the string layer.
 *
 * Protected values (amounts, references, URLs, merchant names) are passed
 * through translateBotResponse's protectedValues mechanism.
 *
 * Reuses the existing Slice 5A proactive localization infrastructure.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveProactiveLocalization, type ProactiveLocalization } from '@/lib/payments/proactive-localization';
import { logger } from '@/lib/logger';

/** Pre-translated labels for booking confirmation email */
export interface BookingEmailLabels {
  subjectPrefix: string;   // "Confirmed at"
  heading: string;         // "Confirmed"
  greeting: string;        // "you're all set with"
  reminderNote: string;    // "We'll send you a reminder beforehand. See you soon!"
  calendarBtn: string;     // "Add to Calendar"
  // Field labels
  lblReference: string;
  lblDate: string;
  lblTime: string;
  lblAmount: string;
}

/** Pre-translated labels for ticket confirmation email */
export interface TicketEmailLabels {
  heading: string;         // "Ticket Confirmed!"
  greetingPrefix: string;  // "your {N} tickets for"
  confirmed: string;       // "is confirmed" / "are confirmed"
  showQr: string;          // "Show your QR code or ticket code at the entrance..."
  enjoyEvent: string;      // "Enjoy the event!"
  lblEvent: string;
  lblOrganizer: string;
  lblDate: string;
  lblTime: string;
  lblVenue: string;
  lblTickets: string;
  lblAmount: string;
  lblReference: string;
  lblTicketCodes: string;  // "Your Ticket Codes:"
  ticketLabel: string;     // "ticket" / "tickets"
}

/** Pre-translated labels for donation receipt email */
export interface DonationEmailLabels {
  heading: string;         // "Donation Received"
  thankYou: string;        // "thank you for your generous donation to"
  support: string;         // "Your support makes a difference. Thank you!"
  lblCampaign: string;
  lblOrganizer: string;
  lblAmount: string;
  lblReference: string;
}

/** Pre-translated labels for invoice email */
export interface InvoiceEmailLabels {
  subjectPrefix: string;   // "Invoice"
  subjectFrom: string;     // "from"
  heading: string;         // "Invoice from"
  greeting: string;        // "you have received an invoice from"
  viewPay: string;         // "View & Pay Invoice"
  copyLink: string;        // "You can also copy and paste this link into your browser:"
  lblReference: string;
  lblAmount: string;
  lblDueDate: string;
  lblItems: string;        // "Items:"
  colItem: string;         // "Item"
  colQty: string;          // "Qty"
  colAmount: string;       // "Amount"
}

/** English defaults — used when no translation is needed */
export const DEFAULT_BOOKING_LABELS: BookingEmailLabels = {
  subjectPrefix: 'Confirmed at', heading: 'Confirmed', greeting: "you're all set with",
  reminderNote: "We'll send you a reminder beforehand. See you soon!",
  calendarBtn: 'Add to Calendar',
  lblReference: 'Reference', lblDate: 'Date', lblTime: 'Time', lblAmount: 'Amount',
};

export const DEFAULT_TICKET_LABELS: TicketEmailLabels = {
  heading: 'Ticket Confirmed!', greetingPrefix: 'your', confirmed: 'confirmed',
  showQr: 'Show your QR code or ticket code at the entrance. Your tickets are also available on WhatsApp.',
  enjoyEvent: 'Enjoy the event!',
  lblEvent: 'Event', lblOrganizer: 'Organizer', lblDate: 'Date', lblTime: 'Time',
  lblVenue: 'Venue', lblTickets: 'Tickets', lblAmount: 'Amount', lblReference: 'Reference',
  lblTicketCodes: 'Your Ticket Codes:', ticketLabel: 'ticket',
};

export const DEFAULT_DONATION_LABELS: DonationEmailLabels = {
  heading: 'Donation Received', thankYou: 'thank you for your generous donation to',
  support: 'Your support makes a difference. Thank you!',
  lblCampaign: 'Campaign', lblOrganizer: 'Organizer', lblAmount: 'Amount', lblReference: 'Reference',
};

export const DEFAULT_INVOICE_LABELS: InvoiceEmailLabels = {
  subjectPrefix: 'Invoice', subjectFrom: 'from', heading: 'Invoice from',
  greeting: 'you have received an invoice from',
  viewPay: 'View & Pay Invoice', copyLink: 'You can also copy and paste this link into your browser:',
  lblReference: 'Reference', lblAmount: 'Amount', lblDueDate: 'Due Date',
  lblItems: 'Items:', colItem: 'Item', colQty: 'Qty', colAmount: 'Amount',
};

/**
 * Resolve localization context for email/PDF rendering.
 * Reuses Slice 5A proactive localization — same language authority.
 */
export async function resolveEmailLocalization(
  supabase: SupabaseClient,
  customerPhone: string,
  businessId: string,
): Promise<ProactiveLocalization> {
  return resolveProactiveLocalization(supabase, customerPhone, businessId);
}

/**
 * Translate a set of Waaiio-owned label strings.
 * Each label is translated individually with the provided protectedValues.
 * Returns the original labels on any failure (fail-closed to English).
 */
export async function translateLabels<T extends Record<string, string>>(
  labels: T,
  l10n: ProactiveLocalization,
  protectedValues?: string[],
): Promise<T> {
  if (l10n.language === 'en') return labels;
  try {
    const translated = { ...labels };
    for (const key of Object.keys(translated) as (keyof T)[]) {
      const value = translated[key] as string;
      if (value && value.length >= 3) {
        translated[key] = await l10n.translate(value, protectedValues) as T[keyof T];
      }
    }
    return translated;
  } catch (err) {
    logger.warn('[EMAIL-L10N] Label translation failed (non-fatal), using English:', err);
    return labels;
  }
}
