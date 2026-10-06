/**
 * Slice 6 Gate 1 — S6-C3: Pidgin human QA evidence via production seams (#524)
 *
 * Generates representative Pidgin outputs through the REAL Waaiio
 * localization/rendering seams with deterministic mocked translation.
 * Produces a committed snapshot fixture suitable for human linguistic review.
 *
 * Static deterministic labels (PDF bundles) are real.
 * LLM-translated text (WhatsApp, email labels) uses a deterministic
 * mock through the production translateBotResponse/translateLabels seams.
 *
 * Does NOT call production providers. Does NOT change CERTIFIED_LANGUAGES.
 */
import { describe, it, expect, vi } from 'vitest';
import { writeFileSync } from 'fs';
import { resolve } from 'path';

// ── Deterministic mock translator via production seam ──
// This mock runs through translateBotResponse's entitlement gate, then
// returns a deterministic Pidgin-like output for each English input.
const DETERMINISTIC_PIDGIN: Record<string, string> = {
  // Booking email labels
  'Booking Confirmed': 'Booking Don Confirm',
  'Your booking has been confirmed.': 'Your booking don confirm.',
  'Reference': 'Reference',
  'Date': 'Date',
  'Time': 'Time',
  'Amount': 'Amount',
  'Thank you for your booking!': 'We dey thank you for your booking!',
  // Ticket email labels
  'Your Tickets': 'Your Tickets',
  'ticket': 'ticket',
  // Invoice email labels
  'Invoice': 'Invoice',
  'Amount Due': 'Amount Wey You Go Pay',
  'Due Date': 'Due Date',
  'Pay Now': 'Pay Now',
  // Wrapper
  'All rights reserved.': 'All rights reserved.',
  'Powered by Waaiio': 'Waaiio power am',
  // WhatsApp text
  'Your booking is confirmed! Reference: {ref}. See you at {time}.': 'Your booking don confirm! Reference: {ref}. We go see for {time}.',
  'Please pay {amount} for {service}. Tap below to pay.': 'Abeg pay {amount} for {service}. Press below make you pay.',
  'Here are your tickets for {event}. Show this at the entrance.': 'See your tickets for {event}. Show am for gate.',
  'Welcome! What would you like to do today?': 'Welcome! Wetin you wan do today?',
  'Sorry, something went wrong. Please try again or type "menu" to start over.': 'Sorry, something no work well. Try again or type "menu" make you start over.',
};

const mockTranslate = vi.fn().mockImplementation(async (text: string) => {
  return DETERMINISTIC_PIDGIN[text] ?? `[PCM] ${text}`;
});

vi.mock('@/lib/bot/translate', async () => {
  const actual = await vi.importActual('@/lib/bot/translate');
  return {
    ...actual as object,
    translateBotResponse: (...a: unknown[]) => mockTranslate(a[0]),
  };
});

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ── QA evidence types ──

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
      htmlSnippet: string;
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

describe('C3 — Pidgin QA evidence through production seams', () => {
  it('generates representative Pidgin evidence artifact', async () => {
    const artifact: QAEvidenceArtifact = {
      language: 'pcm',
      generatedAt: new Date().toISOString(),
      generationMethod: 'Production seams with deterministic mock LLM translation. Static PDF labels are real deterministic bundles.',
      sections: { whatsapp: [], email: [], pdf: [] },
    };

    // ── 1. WhatsApp text via localizeText production seam ──
    const { localizeText } = await import('../bot/outbound-localizer');
    const tCtx = {
      entitlement: { allowedLanguages: ['en', 'pcm'], llmAllowed: true, translationAllowed: true },
      businessId: 'biz-qa-evidence',
      supabase: {},
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
        context: sample.context,
        english: sample.text,
        pidgin: translated,
        source: 'mock-llm-via-localizeText',
        authoritativeValues: sample.text.match(/\{[^}]+\}/g) ?? undefined,
      });
    }

    // ── 2. Email via translateLabels production seam ──
    const { translateLabels, DEFAULT_BOOKING_LABELS, DEFAULT_TICKET_LABELS, DEFAULT_INVOICE_LABELS, localizeWrapperLabels } = await import('../email/localize-email');
    const l10n = { language: 'pcm', translationContext: {} as any, translate: mockTranslate };

    // Booking email
    const bookingLabels = await translateLabels(DEFAULT_BOOKING_LABELS, l10n, ['FacesByKoph', 'WA-BK-QA-001']);
    const bookingWrapper = await localizeWrapperLabels(l10n);
    const { bookingConfirmationEmail } = await import('../email/templates');
    const bookingEmail = bookingConfirmationEmail({
      firstName: 'Emeka', businessName: 'FacesByKoph', date: '2026-12-01', time: '10:00 AM',
      quantity: 1, referenceCode: 'WA-BK-QA-001', amount: 5000,
      quantityLabel: 'Guests', confirmationEmoji: '✅',
      labels: bookingLabels, wrapperLabels: bookingWrapper,
    });
    artifact.sections.email.push({
      template: 'bookingConfirmationEmail',
      htmlLang: bookingWrapper.htmlLang,
      labelSource: 'mock-llm-via-translateLabels',
      authoritativeValuesPreserved: ['WA-BK-QA-001', 'FacesByKoph', '5,000'],
      subjectLine: bookingEmail.subject,
      htmlSnippet: bookingEmail.html.slice(0, 600),
    });

    // Ticket email
    const ticketLabels = await translateLabels(DEFAULT_TICKET_LABELS, l10n, ['ShowHub', 'WA-TK-QA-002']);
    const ticketWrapper = await localizeWrapperLabels(l10n);
    const { ticketConfirmationEmail } = await import('../email/templates');
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
      htmlSnippet: ticketEmail.html.slice(0, 600),
    });

    // Invoice email
    const invoiceLabels = await translateLabels(DEFAULT_INVOICE_LABELS, l10n, ['TestBiz Salon', 'INV-QA-003']);
    const invoiceWrapper = await localizeWrapperLabels(l10n);
    const { invoiceEmail } = await import('../email/templates');
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
      htmlSnippet: invEmail.html.slice(0, 600),
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

    // ── Validate the artifact ──
    expect(artifact.sections.whatsapp.length).toBe(5);
    expect(artifact.sections.email.length).toBe(3);
    expect(artifact.sections.pdf.length).toBe(3);

    // Authoritative values preserved in emails
    for (const email of artifact.sections.email) {
      const fullHtml = email.template === 'bookingConfirmationEmail'
        ? bookingEmail.html
        : email.template === 'ticketConfirmationEmail'
        ? ticketEmail.html : invEmail.html;
      for (const v of email.authoritativeValuesPreserved) {
        expect(fullHtml).toContain(v);
      }
    }

    // PDFs are valid
    for (const pdf of artifact.sections.pdf) {
      expect(pdf.generatedValidPdf).toBe(true);
      expect(pdf.pdfSizeBytes).toBeGreaterThan(500);
    }

    // WhatsApp samples went through production localizeText seam
    expect(mockTranslate).toHaveBeenCalled();

    // ── Write durable artifact for human QA review ──
    const artifactPath = resolve(__dirname, '../bot/__tests__/fixtures/pcm-qa-evidence-snapshot.json');
    writeFileSync(artifactPath, JSON.stringify(artifact, null, 2), 'utf-8');

    // Verify the written file is valid JSON
    const { readFileSync } = await import('fs');
    const written = JSON.parse(readFileSync(artifactPath, 'utf-8'));
    expect(written.language).toBe('pcm');
    expect(written.sections.whatsapp.length).toBe(5);
  });
});
