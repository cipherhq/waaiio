/**
 * Slice 5B — Customer Email + PDF Localization tests (#524)
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const ROOT = resolve(__dirname, '../..');

// ═══════════════════════════════════════════════════════════════
// Email template localization
// ═══════════════════════════════════════════════════════════════

describe('Slice 5B — email template localization', () => {
  it('bookingConfirmationEmail uses labels when provided', async () => {
    const { bookingConfirmationEmail } = await import('../email/templates');
    const result = bookingConfirmationEmail({
      firstName: 'Ade', businessName: 'TestBiz', date: '2026-12-01', time: '10:00',
      quantity: 1, referenceCode: 'WA-BK-1234', amount: 5000, quantityLabel: 'Guests',
      confirmationEmoji: '✅',
      labels: {
        subjectPrefix: 'Confirmé à', heading: 'Confirmé', greeting: 'vous êtes prêt avec',
        reminderNote: 'Nous vous enverrons un rappel.', calendarBtn: 'Ajouter au calendrier',
        lblReference: 'Référence', lblDate: 'Date', lblTime: 'Heure', lblAmount: 'Montant',
      },
    });
    // Subject uses localized prefix
    expect(result.subject).toContain('Confirmé à');
    expect(result.subject).toContain('TestBiz');
    // HTML uses localized labels
    expect(result.html).toContain('Confirmé');
    expect(result.html).toContain('Référence');
    expect(result.html).toContain('Heure');
    // Protected values preserved
    expect(result.html).toContain('WA-BK-1234');
    expect(result.html).toContain('TestBiz');
  });

  it('bookingConfirmationEmail defaults to English when no labels', async () => {
    const { bookingConfirmationEmail } = await import('../email/templates');
    const result = bookingConfirmationEmail({
      firstName: 'Ade', businessName: 'TestBiz', date: '2026-12-01', time: '10:00',
      quantity: 1, referenceCode: 'WA-BK-1234', amount: 5000, quantityLabel: 'Guests',
      confirmationEmoji: '✅',
    });
    expect(result.subject).toContain('Confirmed at');
    expect(result.html).toContain('Reference');
  });

  it('bookingConfirmationEmail preserves href URLs exactly', async () => {
    const { bookingConfirmationEmail } = await import('../email/templates');
    const calUrl = 'https://calendar.google.com/test?x=1&y=2';
    const result = bookingConfirmationEmail({
      firstName: 'Ade', businessName: 'TestBiz', date: '2026-12-01', time: '10:00',
      quantity: 1, referenceCode: 'WA-BK-1234', amount: 5000, quantityLabel: 'Guests',
      confirmationEmoji: '✅', googleCalendarUrl: calUrl,
      labels: { subjectPrefix: 'Confirmé à', heading: 'Confirmé', greeting: 'prêt', reminderNote: 'Rappel', calendarBtn: 'Calendrier', lblReference: 'Réf', lblDate: 'Date', lblTime: 'Heure', lblAmount: 'Montant' },
    });
    // Calendar URL in href must be exact
    expect(result.html).toContain(`href="${calUrl}"`);
  });

  it('ticketConfirmationEmail uses localized labels', async () => {
    const { ticketConfirmationEmail } = await import('../email/templates');
    const result = ticketConfirmationEmail({
      firstName: 'Ade', businessName: 'TestBiz', eventName: 'Concert', eventDate: 'Dec 1',
      venue: 'Main Hall', quantity: 2, referenceCode: 'WA-TK-5678', formattedAmount: '₦10,000',
      ticketCodes: ['TK-ABC', 'TK-DEF'],
      labels: {
        heading: 'Billets Confirmés!', greetingPrefix: 'vos', confirmed: 'confirmés',
        showQr: 'Montrez votre QR code.', enjoyEvent: 'Profitez!',
        lblEvent: 'Événement', lblOrganizer: 'Organisateur', lblDate: 'Date',
        lblTime: 'Heure', lblVenue: 'Lieu', lblTickets: 'Billets', lblAmount: 'Montant',
        lblReference: 'Référence', lblTicketCodes: 'Vos codes:', ticketLabel: 'billet',
      },
    });
    expect(result.html).toContain('Billets Confirmés!');
    expect(result.html).toContain('Événement');
    expect(result.html).toContain('TK-ABC');
    expect(result.html).toContain('₦10,000');
    expect(result.html).toContain('WA-TK-5678');
  });

  it('donationReceiptEmail uses localized labels', async () => {
    const { donationReceiptEmail } = await import('../email/templates');
    const result = donationReceiptEmail({
      donorName: 'Ade Johnson', businessName: 'TestChurch', campaignTitle: 'Building Fund',
      formattedAmount: '₦5,000', referenceCode: 'WA-DN-9999',
      labels: {
        heading: 'Don Reçu', thankYou: 'merci pour votre don généreux à',
        support: 'Votre soutien fait la différence.', lblCampaign: 'Campagne',
        lblOrganizer: 'Organisateur', lblAmount: 'Montant', lblReference: 'Référence',
      },
    });
    expect(result.html).toContain('Don Reçu');
    expect(result.html).toContain('Campagne');
    expect(result.html).toContain('₦5,000');
    expect(result.html).toContain('WA-DN-9999');
  });

  it('invoiceEmail uses localized labels', async () => {
    const { invoiceEmail } = await import('../email/templates');
    const url = 'https://pay.waaiio.com/invoice/abc123';
    const result = invoiceEmail({
      businessName: 'TestBiz', referenceCode: 'INV-001', totalAmount: '₦50,000',
      dueDate: '2026-12-31', customerName: 'Ade', items: [], invoiceUrl: url, currency: 'NGN',
      labels: {
        subjectPrefix: 'Facture', subjectFrom: 'de', heading: 'Facture de',
        greeting: 'vous avez reçu une facture de', viewPay: 'Voir et Payer',
        copyLink: 'Copiez ce lien:', lblReference: 'Référence', lblAmount: 'Montant',
        lblDueDate: 'Échéance', lblItems: 'Articles:', colItem: 'Article',
        colQty: 'Qté', colAmount: 'Montant',
      },
    });
    expect(result.subject).toContain('Facture');
    expect(result.html).toContain('Facture de');
    expect(result.html).toContain('Voir et Payer');
    // Protected URL
    expect(result.html).toContain(`href="${url}"`);
    expect(result.html).toContain(url);
    // Protected values
    expect(result.html).toContain('INV-001');
    expect(result.html).toContain('₦50,000');
  });
});

// ═══════════════════════════════════════════════════════════════
// PDF localization labels
// ═══════════════════════════════════════════════════════════════

describe('Slice 5B — PDF label infrastructure', () => {
  it('receipt PDF generator accepts labels parameter', () => {
    const source = readFileSync(resolve(ROOT, 'lib/pdf/receipt-generator.ts'), 'utf-8');
    expect(source).toContain("labels?: import('./localize-pdf').ReceiptPdfLabels");
    expect(source).toContain('DEFAULT_RECEIPT_LABELS');
    expect(source).toContain('L.title');
    expect(source).toContain('L.lblReference');
  });

  it('PDF label defaults are English', async () => {
    const { DEFAULT_RECEIPT_LABELS, DEFAULT_TICKET_LABELS, DEFAULT_INVOICE_LABELS } = await import('../pdf/localize-pdf');
    expect(DEFAULT_RECEIPT_LABELS.title).toBe('RECEIPT');
    expect(DEFAULT_TICKET_LABELS.lblDate).toBe('DATE');
    expect(DEFAULT_INVOICE_LABELS.title).toBe('INVOICE');
  });
});

// ═══════════════════════════════════════════════════════════════
// Email localization helper
// ═══════════════════════════════════════════════════════════════

describe('Slice 5B — email localization helper', () => {
  it('translateLabels returns English when language is en', async () => {
    const { translateLabels, DEFAULT_BOOKING_LABELS } = await import('../email/localize-email');
    const l10n = { language: 'en', translationContext: {} as any, translate: vi.fn() };
    const result = await translateLabels(DEFAULT_BOOKING_LABELS, l10n);
    expect(result).toBe(DEFAULT_BOOKING_LABELS); // Same reference — no translation
    expect(l10n.translate).not.toHaveBeenCalled();
  });

  it('translateLabels calls translate for non-English', async () => {
    const { translateLabels, DEFAULT_BOOKING_LABELS } = await import('../email/localize-email');
    const mockTranslate = vi.fn().mockImplementation(async (text: string) => `[FR] ${text}`);
    const l10n = { language: 'fr', translationContext: {} as any, translate: mockTranslate };
    const result = await translateLabels(DEFAULT_BOOKING_LABELS, l10n);
    expect(mockTranslate).toHaveBeenCalled();
    expect(result.heading).toContain('[FR]');
    expect(result.lblReference).toContain('[FR]');
  });

  it('translateLabels falls back to English on error', async () => {
    const { translateLabels, DEFAULT_BOOKING_LABELS } = await import('../email/localize-email');
    const mockTranslate = vi.fn().mockRejectedValue(new Error('LLM fail'));
    const l10n = { language: 'fr', translationContext: {} as any, translate: mockTranslate };
    const result = await translateLabels(DEFAULT_BOOKING_LABELS, l10n);
    expect(result.heading).toBe('Confirmed'); // English fallback
  });
});

// ═══════════════════════════════════════════════════════════════
// Scope containment
// ═══════════════════════════════════════════════════════════════

describe('Slice 5B — scope containment', () => {
  it('CERTIFIED_LANGUAGES not modified', () => {
    const catalog = readFileSync(resolve(ROOT, 'lib/bot/languages.ts'), 'utf-8');
    expect((catalog.match(/certified:\s*true/g) || []).length).toBe(1);
  });

  it('contract/legal PDF generators not modified', () => {
    const contract = readFileSync(resolve(ROOT, 'lib/pdf/contract-pdf-generator.ts'), 'utf-8');
    expect(contract).not.toContain('localize-pdf');
    expect(contract).not.toContain('labels?');
    const sig = readFileSync(resolve(ROOT, 'lib/pdf/append-signature.ts'), 'utf-8');
    expect(sig).not.toContain('localize-pdf');
  });

  it('no Meta template changes', () => {
    const templates = readFileSync(resolve(ROOT, 'lib/channels/provision-templates.ts'), 'utf-8');
    const promoTemplates = readFileSync(resolve(ROOT, 'lib/promotions/template-contracts.ts'), 'utf-8');
    // These should not import localize-email or localize-pdf
    expect(templates).not.toContain('localize');
    expect(promoTemplates).not.toContain('localize');
  });
});
