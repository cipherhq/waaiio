/**
 * Email Localization — Slice 5B (#524)
 *
 * Complete Waaiio-owned email presentation labels for customer transactional emails.
 * Labels are translated BEFORE HTML rendering — NEVER on completed HTML.
 *
 * Every label value MUST be HTML-escaped via esc() at the render boundary.
 * Protected authoritative values (amounts, references, URLs, names) are
 * passed as separate data parameters and escaped independently.
 *
 * Reuses the existing Slice 5A proactive localization infrastructure.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveProactiveLocalization, type ProactiveLocalization } from '@/lib/payments/proactive-localization';
import { logger } from '@/lib/logger';

// ═══════════════════════════════════════════════════════════════
// Booking Confirmation Email Labels
// ═══════════════════════════════════════════════════════════════

export interface BookingEmailLabels {
  subject: string;         // "Confirmed at {business} {emoji}"
  heading: string;         // "Confirmed {emoji}"
  greeting: string;        // "Hi {name}, you're all set with {business}!"
  reminderNote: string;    // "We'll send you a reminder beforehand. See you soon!"
  calendarBtn: string;     // "Add to Calendar"
  lblReference: string;
  lblDate: string;
  lblTime: string;
  lblAmount: string;
}

// ═══════════════════════════════════════════════════════════════
// Ticket Confirmation Email Labels
// ═══════════════════════════════════════════════════════════════

export interface TicketEmailLabels {
  subject: string;         // "Your tickets for {event} 🎫"
  heading: string;         // "Ticket Confirmed! 🎫"
  greeting: string;        // "Hi {name}, your {N} ticket(s) for {event} confirmed!"
  showQr: string;          // "Show your QR code or ticket code at the entrance..."
  enjoyEvent: string;      // "Enjoy the event! 🎉"
  lblEvent: string;
  lblOrganizer: string;
  lblDate: string;
  lblTime: string;
  lblVenue: string;
  lblTickets: string;
  lblAmount: string;
  lblReference: string;
  lblTicketCodes: string;  // "Your Ticket Codes:"
  lblTicketN: string;      // "Ticket" (for "Ticket 1", "Ticket 2")
}

// ═══════════════════════════════════════════════════════════════
// Donation Receipt Email Labels
// ═══════════════════════════════════════════════════════════════

export interface DonationEmailLabels {
  subject: string;         // "Donation receipt — {amount} to {campaign}"
  heading: string;         // "Donation Received"
  greeting: string;        // "Hi {name}, thank you for your generous donation to {campaign}!"
  support: string;         // "Your support makes a difference. Thank you!"
  lblCampaign: string;
  lblOrganizer: string;
  lblAmount: string;
  lblReference: string;
}

// ═══════════════════════════════════════════════════════════════
// Invoice Email Labels
// ═══════════════════════════════════════════════════════════════

export interface InvoiceEmailLabels {
  subject: string;         // "Invoice {ref} from {business}"
  heading: string;         // "Invoice from {business}"
  greeting: string;        // "Hi {name}, you have received an invoice from {business}."
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

// ═══════════════════════════════════════════════════════════════
// Booking Reminder Email Labels
// ═══════════════════════════════════════════════════════════════

export interface BookingReminderEmailLabels {
  subject: string;         // "Reminder: {service} at {business} tomorrow"
  heading: string;         // "Reminder"
  greeting: string;        // "Hi {name}, this is a friendly reminder about {business} tomorrow."
  details: string;         // "Here are your booking details:"
  seeYou: string;          // "See you tomorrow!"
  lblService: string;
  lblDate: string;
  lblTime: string;
  lblReference: string;
}

// ═══════════════════════════════════════════════════════════════
// Payment Received Email Labels (customer-facing when sent to customer)
// ═══════════════════════════════════════════════════════════════

export interface PaymentReceivedEmailLabels {
  subject: string;         // "Payment received — {amount}"
  heading: string;         // "Payment Received"
  message: string;         // "A payment has been received."
  lblService: string;
  lblAmount: string;
}

// ═══════════════════════════════════════════════════════════════
// Email wrapper labels
// ═══════════════════════════════════════════════════════════════

export interface EmailWrapperLabels {
  footer: string;          // "All rights reserved."
  tagline: string;         // "Automate your business with WhatsApp"
  htmlLang: string;        // "en" | "fr" | etc.
}

// ═══════════════════════════════════════════════════════════════
// English defaults
// ═══════════════════════════════════════════════════════════════

export const DEFAULT_BOOKING_LABELS: BookingEmailLabels = {
  subject: 'Confirmed at {business} {emoji}',
  heading: 'Confirmed {emoji}',
  greeting: "Hi {name}, you're all set with {business}!",
  reminderNote: "We'll send you a reminder beforehand. See you soon!",
  calendarBtn: 'Add to Calendar',
  lblReference: 'Reference', lblDate: 'Date', lblTime: 'Time', lblAmount: 'Amount',
};

export const DEFAULT_TICKET_LABELS: TicketEmailLabels = {
  subject: 'Your ticket(s) for {event} 🎫',
  heading: 'Ticket Confirmed! 🎫',
  greeting: 'Hi {name}, your {count} ticket(s) for {event} confirmed!',
  showQr: 'Show your QR code or ticket code at the entrance. Your tickets are also available on WhatsApp.',
  enjoyEvent: 'Enjoy the event! 🎉',
  lblEvent: 'Event', lblOrganizer: 'Organizer', lblDate: 'Date', lblTime: 'Time',
  lblVenue: 'Venue', lblTickets: 'Tickets', lblAmount: 'Amount', lblReference: 'Reference',
  lblTicketCodes: 'Your Ticket Codes:', lblTicketN: 'Ticket',
};

export const DEFAULT_DONATION_LABELS: DonationEmailLabels = {
  subject: 'Donation receipt — {amount} to {campaign}',
  heading: 'Donation Received',
  greeting: 'Hi {name}, thank you for your generous donation to {campaign}!',
  support: 'Your support makes a difference. Thank you!',
  lblCampaign: 'Campaign', lblOrganizer: 'Organizer', lblAmount: 'Amount', lblReference: 'Reference',
};

export const DEFAULT_INVOICE_LABELS: InvoiceEmailLabels = {
  subject: 'Invoice {ref} from {business}',
  heading: 'Invoice from {business}',
  greeting: 'Hi {name}, you have received an invoice from {business}.',
  viewPay: 'View & Pay Invoice', copyLink: 'You can also copy and paste this link into your browser:',
  lblReference: 'Reference', lblAmount: 'Amount', lblDueDate: 'Due Date',
  lblItems: 'Items:', colItem: 'Item', colQty: 'Qty', colAmount: 'Amount',
};

export const DEFAULT_REMINDER_LABELS: BookingReminderEmailLabels = {
  subject: 'Reminder: {service} at {business} tomorrow',
  heading: 'Reminder',
  greeting: 'Hi {name}, this is a friendly reminder about {business} tomorrow.',
  details: 'Here are your booking details:', seeYou: 'See you tomorrow!',
  lblService: 'Service', lblDate: 'Date', lblTime: 'Time', lblReference: 'Reference',
};

export const DEFAULT_PAYMENT_RECEIVED_LABELS: PaymentReceivedEmailLabels = {
  subject: 'Payment received — {amount}',
  heading: 'Payment Received',
  message: 'A new payment has been received.',
  lblService: 'Service', lblAmount: 'Amount',
};

export const DEFAULT_WRAPPER_LABELS: EmailWrapperLabels = {
  footer: 'All rights reserved.',
  tagline: 'Automate your business with WhatsApp',
  htmlLang: 'en',
};

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

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
export async function translateLabels<T extends { [K in keyof T]: string }>(
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

/**
 * Localize the email wrapper labels. Sets htmlLang deterministically
 * from the language code, and translates footer/tagline through the
 * approved translation path. Fail-closed to English defaults.
 */
export async function localizeWrapperLabels(
  l10n: ProactiveLocalization,
): Promise<EmailWrapperLabels> {
  if (l10n.language === 'en') return DEFAULT_WRAPPER_LABELS;
  try {
    const footer = await l10n.translate(DEFAULT_WRAPPER_LABELS.footer);
    const tagline = await l10n.translate(DEFAULT_WRAPPER_LABELS.tagline);
    return { htmlLang: l10n.language, footer, tagline };
  } catch {
    return { ...DEFAULT_WRAPPER_LABELS, htmlLang: l10n.language };
  }
}

/**
 * Interpolate placeholder tokens in label strings.
 * Placeholders are {name}, {business}, {amount}, etc.
 * Values are NOT HTML-escaped here — the caller must escape at the render boundary.
 */
export function fillLabel(template: string, values: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(values)) {
    result = result.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
  }
  return result;
}
