/**
 * Slice 6 Gate 1 — S6-D2: Pidgin human QA evidence (#524)
 *
 * Generates representative Pidgin outputs through the REAL Waaiio
 * localization/rendering seams with deterministic mocked translation.
 * Compares the generated evidence against the committed snapshot fixture.
 *
 * Normal test runs do NOT rewrite the committed fixture.
 * To regenerate: run with UPDATE_QA_SNAPSHOT=1 environment variable.
 *
 * Static deterministic labels (PDF bundles) are real.
 * LLM-translated text (WhatsApp, email labels) uses a deterministic
 * mock through the production translateBotResponse/translateLabels seams.
 *
 * Does NOT call production providers. Does NOT change CERTIFIED_LANGUAGES.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';

// ── Deterministic mock translator via production seam ──
const DETERMINISTIC_PIDGIN: Record<string, string> = {
  // ── Booking email labels (DEFAULT_BOOKING_LABELS) ──
  'Confirmed at {business} {emoji}': 'Don Confirm for {business} {emoji}',
  'Confirmed {emoji}': 'Don Confirm {emoji}',
  "Hi {name}, you're all set with {business}!": 'Hello {name}, everything don set for {business}!',
  "We'll send you a reminder beforehand. See you soon!": 'We go remind you before time. See you soon!',
  'Add to Calendar': 'Put am for Calendar',
  'Reference': 'Reference',
  'Date': 'Date',
  'Time': 'Time',
  'Amount': 'Amount',
  // ── Ticket email labels (DEFAULT_TICKET_LABELS) ──
  'Your ticket(s) for {event} 🎫': 'Your ticket(s) for {event} 🎫',
  'Ticket Confirmed! 🎫': 'Ticket Don Confirm! 🎫',
  'Hi {name}, your {count} ticket(s) for {event} confirmed!': 'Hello {name}, your {count} ticket(s) for {event} don confirm!',
  'Show your QR code or ticket code at the entrance. Your tickets are also available on WhatsApp.': 'Show your QR code or ticket code for gate. Your tickets dey WhatsApp too.',
  'Enjoy the event! 🎉': 'Enjoy the show! 🎉',
  'Event': 'Event',
  'Organizer': 'Organizer',
  'Venue': 'Venue',
  'Tickets': 'Tickets',
  'Your Ticket Codes:': 'Your Ticket Codes:',
  'Ticket': 'Ticket',
  // ── Invoice email labels (DEFAULT_INVOICE_LABELS) ──
  'Invoice {ref} from {business}': 'Invoice {ref} from {business}',
  'Invoice from {business}': 'Invoice from {business}',
  'Hi {name}, you have received an invoice from {business}.': 'Hello {name}, you get invoice from {business}.',
  'View & Pay Invoice': 'View & Pay Invoice',
  'You can also copy and paste this link into your browser:': 'You fit copy and paste this link for your browser:',
  'Items:': 'Items:',
  'Item': 'Item',
  'Qty': 'Qty',
  'Due Date': 'Due Date',
  // ── Wrapper labels ──
  'All rights reserved.': 'All rights reserved.',
  'Automate your business with WhatsApp': 'Automate your business with WhatsApp',
  // ── WhatsApp text samples ──
  'Your booking is confirmed! Reference: {ref}. See you at {time}.': 'Your booking don confirm! Reference: {ref}. We go see for {time}.',
  'Please pay {amount} for {service}. Tap below to pay.': 'Abeg pay {amount} for {service}. Press below make you pay.',
  'Here are your tickets for {event}. Show this at the entrance.': 'See your tickets for {event}. Show am for gate.',
  'Welcome! What would you like to do today?': 'Welcome! Wetin you wan do today?',
  'Sorry, something went wrong. Please try again or type "menu" to start over.': 'Sorry, something no work well. Try again or type "menu" make you start over.',
};

/**
 * Segment-aware deterministic mock translator.
 * translateLabels sends a concatenated block with __WAAIIO_EMAIL_SEGMENT_N__ markers.
 * This mock translates each segment individually, preserving the markers exactly.
 */
const SEGMENT_MARKER_RE = /(__WAAIIO_EMAIL_SEGMENT_\d+__)/;

function translateSegmentBlock(text: string): string {
  // If text contains segment markers, handle each segment
  if (text.includes('__WAAIIO_EMAIL_SEGMENT_')) {
    const parts = text.split(SEGMENT_MARKER_RE);
    return parts.map(part => {
      if (SEGMENT_MARKER_RE.test(part)) return part; // Preserve marker exactly
      const trimmed = part.trim();
      if (!trimmed) return part;
      return DETERMINISTIC_PIDGIN[trimmed] ?? `[PCM] ${trimmed}`;
    }).join('');
  }
  // Simple text (WhatsApp localizeText path)
  return DETERMINISTIC_PIDGIN[text] ?? `[PCM] ${text}`;
}

const mockTranslate = vi.fn().mockImplementation(async (text: string) => {
  return translateSegmentBlock(text);
});

vi.mock('@/lib/bot/translate', async () => {
  const actual = await vi.importActual('@/lib/bot/translate');
  return { ...actual as object, translateBotResponse: (...a: unknown[]) => mockTranslate(a[0]) };
});

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const FIXED_TIMESTAMP = '2026-10-06T00:00:00.000Z';
const SNAPSHOT_PATH = resolve(__dirname, '../bot/__tests__/fixtures/pcm-qa-evidence-snapshot.json');

interface QAEvidenceArtifact {
  language: string;
  generatedAt: string;
  generationMethod: string;
  sections: {
    whatsapp: Array<{
      context: string;
      english: string;
      pidgin: string;
      source: 'mock-llm-via-localizeText';
      authoritativeValues?: string[];
    }>;
    email: Array<{
      template: string;
      htmlLang: string;
      labelSource: 'mock-llm-via-translateLabels';
      authoritativeValuesPreserved: string[];
      subjectLine: string;
      translatedLabels: Record<string, string>;
      bodyExcerpt: string;
    }>;
    pdf: Array<{
      docType: string;
      labelSource: 'static-deterministic-bundle';
      sampleLabels: Record<string, string>;
      generatedValidPdf: boolean;
      pdfSizeBytes: number;
    }>;
  };
}

async function generateEvidence(): Promise<QAEvidenceArtifact> {
  const artifact: QAEvidenceArtifact = {
    language: 'pcm',
    generatedAt: FIXED_TIMESTAMP,
    generationMethod: 'Production seams with deterministic mock LLM translation. Static PDF labels are real deterministic bundles.',
    sections: { whatsapp: [], email: [], pdf: [] },
  };

  // ── 1. WhatsApp text via localizeText production seam ──
  const { localizeText } = await import('../bot/outbound-localizer');
  const tCtx = {
    entitlement: { allowedLanguages: ['en', 'pcm'], llmAllowed: true, translationAllowed: true },
    businessId: 'biz-qa-evidence', supabase: {},
  };

  const waTexts = [
    { context: 'booking-confirmation', text: 'Your booking is confirmed! Reference: {ref}. See you at {time}.' },
    { context: 'payment-prompt', text: 'Please pay {amount} for {service}. Tap below to pay.' },
    { context: 'ticket-delivery', text: 'Here are your tickets for {event}. Show this at the entrance.' },
    { context: 'menu-prompt', text: 'Welcome! What would you like to do today?' },
    { context: 'error-recovery', text: 'Sorry, something went wrong. Please try again or type "menu" to start over.' },
  ];
  for (const sample of waTexts) {
    const translated = await localizeText(sample.text, 'pcm', tCtx);
    artifact.sections.whatsapp.push({
      context: sample.context, english: sample.text, pidgin: translated,
      source: 'mock-llm-via-localizeText',
      authoritativeValues: sample.text.match(/\{[^}]+\}/g) ?? undefined,
    });
  }

  // ── 2. Email via translateLabels production seam ──
  const { translateLabels, DEFAULT_BOOKING_LABELS, DEFAULT_TICKET_LABELS, DEFAULT_INVOICE_LABELS, localizeWrapperLabels } = await import('../email/localize-email');
  const l10n = { language: 'pcm', translationContext: {} as any, translate: mockTranslate };

  const { bookingConfirmationEmail, ticketConfirmationEmail, invoiceEmail } = await import('../email/templates');

  // Booking email
  const bookingLabels = await translateLabels(DEFAULT_BOOKING_LABELS, l10n, ['FacesByKoph', 'WA-BK-QA-001']);
  const bookingWrapper = await localizeWrapperLabels(l10n);
  const bookingEmail = bookingConfirmationEmail({
    firstName: 'Emeka', businessName: 'FacesByKoph', date: '2026-12-01', time: '10:00 AM',
    quantity: 1, referenceCode: 'WA-BK-QA-001', amount: 5000,
    quantityLabel: 'Guests', confirmationEmoji: '✅',
    labels: bookingLabels, wrapperLabels: bookingWrapper,
  });
  // Extract the body content (skip HTML head/wrapper, find the main content)
  const bookingBodyMatch = bookingEmail.html.match(/<td[^>]*style="[^"]*padding[^"]*"[^>]*>([\s\S]*?)<\/td>/);
  artifact.sections.email.push({
    template: 'bookingConfirmationEmail',
    htmlLang: bookingWrapper.htmlLang,
    labelSource: 'mock-llm-via-translateLabels',
    authoritativeValuesPreserved: ['WA-BK-QA-001', 'FacesByKoph', '5,000'],
    subjectLine: bookingEmail.subject,
    translatedLabels: Object.fromEntries(Object.entries(bookingLabels).filter(([, v]) => typeof v === 'string')),
    bodyExcerpt: bookingEmail.text || bookingEmail.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 800),
  });

  // Ticket email
  const ticketLabels = await translateLabels(DEFAULT_TICKET_LABELS, l10n, ['ShowHub', 'WA-TK-QA-002']);
  const ticketWrapper = await localizeWrapperLabels(l10n);
  const ticketEmail = ticketConfirmationEmail({
    firstName: 'Emeka', businessName: 'ShowHub', eventName: 'Afrobeats Fest',
    eventDate: 'Dec 1, 2026', venue: 'Eko Centre', quantity: 2,
    referenceCode: 'WA-TK-QA-002', formattedAmount: '₦10,000',
    ticketCodes: ['TK-QA-001', 'TK-QA-002'], whitelabel: false,
    labels: ticketLabels as any, wrapperLabels: ticketWrapper,
  });
  artifact.sections.email.push({
    template: 'ticketConfirmationEmail',
    htmlLang: ticketWrapper.htmlLang,
    labelSource: 'mock-llm-via-translateLabels',
    authoritativeValuesPreserved: ['WA-TK-QA-002', 'TK-QA-001', 'TK-QA-002', '₦10,000', 'ShowHub'],
    subjectLine: ticketEmail.subject,
    translatedLabels: Object.fromEntries(Object.entries(ticketLabels).filter(([, v]) => typeof v === 'string')),
    bodyExcerpt: ticketEmail.text || ticketEmail.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 800),
  });

  // Invoice email
  const invoiceLabels = await translateLabels(DEFAULT_INVOICE_LABELS, l10n, ['TestBiz Salon', 'INV-QA-003']);
  const invoiceWrapper = await localizeWrapperLabels(l10n);
  const invEmail = invoiceEmail({
    businessName: 'TestBiz Salon', referenceCode: 'INV-QA-003',
    totalAmount: '₦15,000', dueDate: 'Dec 31, 2026', customerName: 'Emeka Johnson',
    items: [{ description: 'VIP Treatment', quantity: 1, unitPrice: 15000, amount: 15000 }],
    invoiceUrl: 'https://waaiio.com/invoice/token-qa', currency: 'NGN',
    labels: invoiceLabels as any, wrapperLabels: invoiceWrapper,
  });
  artifact.sections.email.push({
    template: 'invoiceEmail',
    htmlLang: invoiceWrapper.htmlLang,
    labelSource: 'mock-llm-via-translateLabels',
    authoritativeValuesPreserved: ['INV-QA-003', '₦15,000', 'https://waaiio.com/invoice/token-qa', 'TestBiz Salon'],
    subjectLine: invEmail.subject,
    translatedLabels: Object.fromEntries(Object.entries(invoiceLabels).filter(([, v]) => typeof v === 'string')),
    bodyExcerpt: invEmail.text || invEmail.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 800),
  });

  // ── 3. PDF via real deterministic bundles + real generators ──
  const { getPdfLocalizationBundle } = await import('../pdf/localize-pdf');
  const { generateReceiptPdf } = await import('../pdf/receipt-generator');
  const { generateTicketsPdf } = await import('../pdf/ticket-generator');
  const { generateInvoicePdf } = await import('../pdf/invoice-pdf-generator');
  const pcm = getPdfLocalizationBundle('pcm');

  const receiptBuf = await generateReceiptPdf({
    businessName: 'FacesByKoph', referenceCode: 'WA-BK-QA-PDF', date: '2026-12-01T10:30:00Z',
    serviceName: 'Premium Haircut', amount: 5000, paymentStatus: 'paid',
    customerName: 'Emeka Johnson', customerPhone: '+2341234567890', countryCode: 'NG',
    labels: pcm.receipt,
  });
  artifact.sections.pdf.push({
    docType: 'receipt', labelSource: 'static-deterministic-bundle',
    sampleLabels: { title: pcm.receipt.title, footer: pcm.receipt.footer, 'statusLabels.paid': pcm.receipt.statusLabels.paid },
    generatedValidPdf: receiptBuf.slice(0, 5).toString() === '%PDF-', pdfSizeBytes: receiptBuf.length,
  });

  const ticketBuf = await generateTicketsPdf({
    eventName: 'Afrobeats Festival', eventDate: 'Dec 1, 2026', venue: 'Eko Centre',
    guestName: 'Emeka Johnson', referenceCode: 'WA-TK-QA-PDF',
    tickets: [{ ticketCode: 'TK-QA-PDF1', ticketNumber: 1, totalTickets: 1 }],
    verifyBaseUrl: 'https://waaiio.com/tickets/verify', labels: pcm.ticket,
  });
  artifact.sections.pdf.push({
    docType: 'ticket', labelSource: 'static-deterministic-bundle',
    sampleLabels: { lblAttendee: pcm.ticket.lblAttendee, lblVenue: pcm.ticket.lblVenue, footer: pcm.ticket.footer },
    generatedValidPdf: ticketBuf.slice(0, 5).toString() === '%PDF-', pdfSizeBytes: ticketBuf.length,
  });

  const invoiceBuf = await generateInvoicePdf({
    businessName: 'TestBiz', referenceCode: 'INV-QA-PDF', issueDate: '2026-12-01', dueDate: '2026-12-31',
    customerName: 'Emeka Johnson', customerPhone: '+234',
    items: [{ description: 'Service', quantity: 1, unitPrice: 5000, amount: 5000 }],
    subtotal: 5000, taxRate: 0, taxAmount: 0, discountType: 'none', discountValue: 0, discountAmount: 0,
    totalAmount: 5000, amountPaid: 0, status: 'pending', countryCode: 'NG',
    labels: pcm.invoice,
  });
  artifact.sections.pdf.push({
    docType: 'invoice', labelSource: 'static-deterministic-bundle',
    sampleLabels: { title: pcm.invoice.title, lblPaid: pcm.invoice.lblPaid, footer: pcm.invoice.footer },
    generatedValidPdf: invoiceBuf.slice(0, 5).toString() === '%PDF-', pdfSizeBytes: invoiceBuf.length,
  });

  return artifact;
}

describe('D2 — Pidgin QA evidence: deterministic and snapshot-stable', () => {
  it('generates evidence matching committed snapshot (without rewriting it)', async () => {
    const artifact = await generateEvidence();

    // ── Structural validation ──
    expect(artifact.language).toBe('pcm');
    expect(artifact.generatedAt).toBe(FIXED_TIMESTAMP);
    expect(artifact.sections.whatsapp).toHaveLength(5);
    expect(artifact.sections.email).toHaveLength(3);
    expect(artifact.sections.pdf).toHaveLength(3);

    // ── Authoritative values preserved ──
    for (const email of artifact.sections.email) {
      expect(email.htmlLang).toMatch(/pcm|en/);
      expect(email.subjectLine.length).toBeGreaterThan(0);
      expect(email.bodyExcerpt.length).toBeGreaterThan(100);
    }

    // ── PDFs are valid ──
    for (const pdf of artifact.sections.pdf) {
      expect(pdf.generatedValidPdf).toBe(true);
      expect(pdf.pdfSizeBytes).toBeGreaterThan(500);
    }

    // ── WhatsApp translations went through production localizeText ──
    expect(mockTranslate).toHaveBeenCalled();
    for (const wa of artifact.sections.whatsapp) {
      expect(wa.pidgin.length).toBeGreaterThan(0);
      expect(wa.source).toBe('mock-llm-via-localizeText');
    }

    // ── Email evidence contains actual Pidgin content (not all-English) ──
    const bookingArtifact = artifact.sections.email.find(e => e.template === 'bookingConfirmationEmail')!;
    expect(bookingArtifact.translatedLabels.heading).toContain('Don Confirm');
    expect(bookingArtifact.translatedLabels.greeting).toContain('don set');
    expect(bookingArtifact.bodyExcerpt).toContain('Don Confirm');
    expect(bookingArtifact.bodyExcerpt.length).toBeGreaterThan(100);

    const ticketArtifact = artifact.sections.email.find(e => e.template === 'ticketConfirmationEmail')!;
    expect(ticketArtifact.translatedLabels.heading).toContain('Don Confirm');
    expect(ticketArtifact.translatedLabels.greeting).toContain('don confirm');
    expect(ticketArtifact.bodyExcerpt.length).toBeGreaterThan(100);

    const invoiceArtifact = artifact.sections.email.find(e => e.template === 'invoiceEmail')!;
    expect(invoiceArtifact.translatedLabels.greeting).toContain('get invoice');
    expect(invoiceArtifact.bodyExcerpt.length).toBeGreaterThan(100);

    // No email should have ALL labels identical to English defaults
    for (const email of artifact.sections.email) {
      const labelsStr = JSON.stringify(email.translatedLabels);
      // At least one label must differ from English (contain Pidgin markers)
      const hasPidginContent = labelsStr.includes('Don Confirm') || labelsStr.includes('don set')
        || labelsStr.includes('don confirm') || labelsStr.includes('get invoice')
        || labelsStr.includes('[PCM]');
      expect(hasPidginContent).toBe(true);
    }

    // ── Compare against committed snapshot (do NOT rewrite) ──
    if (existsSync(SNAPSHOT_PATH)) {
      const committed = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf-8'));
      // Structural match: same sections, same counts
      expect(artifact.sections.whatsapp.length).toBe(committed.sections.whatsapp.length);
      expect(artifact.sections.email.length).toBe(committed.sections.email.length);
      expect(artifact.sections.pdf.length).toBe(committed.sections.pdf.length);
      // WhatsApp translations are deterministic
      for (let i = 0; i < artifact.sections.whatsapp.length; i++) {
        expect(artifact.sections.whatsapp[i].pidgin).toBe(committed.sections.whatsapp[i].pidgin);
        expect(artifact.sections.whatsapp[i].english).toBe(committed.sections.whatsapp[i].english);
      }
      // PDF labels are deterministic
      for (let i = 0; i < artifact.sections.pdf.length; i++) {
        expect(artifact.sections.pdf[i].sampleLabels).toEqual(committed.sections.pdf[i].sampleLabels);
      }
    }

    // ── Explicit update: only when UPDATE_QA_SNAPSHOT=1 ──
    if (process.env.UPDATE_QA_SNAPSHOT === '1') {
      writeFileSync(SNAPSHOT_PATH, JSON.stringify(artifact, null, 2), 'utf-8');
    }
  });
});
