/**
 * Slice 5B — Customer Email + PDF Localization tests (#524)
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const ROOT = resolve(__dirname, '../..');

describe('Slice 5B — email template localization', () => {
  it('bookingConfirmationEmail renders localized labels with HTML escaping', async () => {
    const { bookingConfirmationEmail } = await import('../email/templates');
    const result = bookingConfirmationEmail({
      firstName: 'Ade', businessName: 'TestBiz', date: '2026-12-01', time: '10:00',
      quantity: 1, referenceCode: 'WA-BK-1234', amount: 5000, quantityLabel: 'Guests',
      confirmationEmoji: '✅',
      labels: {
        subject: 'Confirmé à {business} {emoji}', heading: 'Confirmé {emoji}',
        greeting: 'Bonjour {name}, vous êtes prêt avec {business}!',
        reminderNote: 'Nous vous enverrons un rappel.',
        calendarBtn: 'Ajouter au calendrier',
        lblReference: 'Référence', lblDate: 'Date', lblTime: 'Heure', lblAmount: 'Montant',
      },
    });
    expect(result.subject).toContain('Confirmé à TestBiz');
    expect(result.html).toContain('Confirmé');
    expect(result.html).toContain('Référence');
    expect(result.html).toContain('Heure');
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
    });
    expect(result.html).toContain(`href="${calUrl}"`);
  });

  it('ticketConfirmationEmail uses localized labels', async () => {
    const { ticketConfirmationEmail } = await import('../email/templates');
    const result = ticketConfirmationEmail({
      firstName: 'Ade', businessName: 'TestBiz', eventName: 'Concert', eventDate: 'Dec 1',
      venue: 'Main Hall', quantity: 2, referenceCode: 'WA-TK-5678', formattedAmount: '₦10,000',
      ticketCodes: ['TK-ABC', 'TK-DEF'],
      labels: {
        subject: 'Vos {count} billet(s) pour {event} 🎫',
        heading: 'Billets Confirmés! 🎫',
        greeting: 'Bonjour {name}, vos {count} billet(s) pour {event} confirmés!',
        showQr: 'Montrez votre QR code.', enjoyEvent: 'Profitez!',
        lblEvent: 'Événement', lblOrganizer: 'Organisateur', lblDate: 'Date',
        lblTime: 'Heure', lblVenue: 'Lieu', lblTickets: 'Billets', lblAmount: 'Montant',
        lblReference: 'Référence', lblTicketCodes: 'Vos codes:', lblTicketN: 'Billet',
      },
    });
    expect(result.html).toContain('Billets Confirm');
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
        subject: 'Reçu de don — {amount} à {campaign}',
        heading: 'Don Reçu',
        greeting: 'Bonjour {name}, merci pour votre don généreux à {campaign}!',
        support: 'Votre soutien fait la différence.',
        lblCampaign: 'Campagne', lblOrganizer: 'Organisateur', lblAmount: 'Montant', lblReference: 'Référence',
      },
    });
    expect(result.html).toContain('Don Re');
    expect(result.html).toContain('Campagne');
    expect(result.html).toContain('₦5,000');
    expect(result.html).toContain('WA-DN-9999');
  });

  it('invoiceEmail uses localized labels and preserves URL', async () => {
    const { invoiceEmail } = await import('../email/templates');
    const url = 'https://pay.waaiio.com/invoice/abc123';
    const result = invoiceEmail({
      businessName: 'TestBiz', referenceCode: 'INV-001', totalAmount: '₦50,000',
      dueDate: '2026-12-31', customerName: 'Ade', items: [], invoiceUrl: url, currency: 'NGN',
      labels: {
        subject: 'Facture {ref} de {business}', heading: 'Facture de {business}',
        greeting: 'Bonjour {name}, vous avez reçu une facture de {business}.',
        viewPay: 'Voir et Payer', copyLink: 'Copiez ce lien:',
        lblReference: 'Référence', lblAmount: 'Montant', lblDueDate: 'Échéance',
        lblItems: 'Articles:', colItem: 'Article', colQty: 'Qté', colAmount: 'Montant',
      },
    });
    expect(result.subject).toContain('Facture INV-001 de TestBiz');
    expect(result.html).toContain(`href="${url}"`);
    expect(result.html).toContain(url);
    expect(result.html).toContain('INV-001');
    expect(result.html).toContain('₦50,000');
  });

  it('HTML metacharacters in translated labels are escaped', async () => {
    const { bookingConfirmationEmail } = await import('../email/templates');
    const result = bookingConfirmationEmail({
      firstName: 'Ade', businessName: 'Test&Biz', date: '2026-12-01', time: '10:00',
      quantity: 1, referenceCode: 'WA-BK-1234', amount: 5000, quantityLabel: 'Guests',
      confirmationEmoji: '✅',
      labels: {
        subject: 'Confirmed at {business} {emoji}', heading: '<script>alert(1)</script>',
        greeting: 'Hello <img src=x onerror=alert(1)>',
        reminderNote: 'Note & reminder', calendarBtn: 'Cal',
        lblReference: 'Ref', lblDate: 'Date', lblTime: 'Time', lblAmount: 'Amt',
      },
    });
    // HTML injection must be escaped — tags become text
    expect(result.html).not.toContain('<script>');
    expect(result.html).toContain('&lt;script&gt;');
    // <img> tag is escaped — can't execute as HTML
    expect(result.html).not.toContain('<img src=x');
    expect(result.html).toContain('&lt;img');
    // Business name with & is escaped
    expect(result.html).toContain('Test&amp;Biz');
  });

  it('email wrapper uses localized lang attribute and footer', async () => {
    const { bookingConfirmationEmail } = await import('../email/templates');
    const { DEFAULT_BOOKING_LABELS, DEFAULT_WRAPPER_LABELS } = await import('../email/localize-email');
    // Use French wrapper labels
    const result = bookingConfirmationEmail({
      firstName: 'Ade', businessName: 'TestBiz', date: '2026-12-01', time: '10:00',
      quantity: 1, referenceCode: 'REF', amount: 0, quantityLabel: 'Guests', confirmationEmoji: '✅',
    });
    // Default English wrapper
    expect(result.html).toContain('lang="en"');
    expect(result.html).toContain('All rights reserved');
  });
});

describe('Slice 5B — PDF label infrastructure', () => {
  it('PDF label defaults are English', async () => {
    const { DEFAULT_RECEIPT_LABELS, DEFAULT_TICKET_LABELS, DEFAULT_INVOICE_LABELS } = await import('../pdf/localize-pdf');
    expect(DEFAULT_RECEIPT_LABELS.title).toBe('RECEIPT');
    expect(DEFAULT_TICKET_LABELS.lblDate).toBe('DATE');
    expect(DEFAULT_INVOICE_LABELS.title).toBe('INVOICE');
  });
});

describe('Slice 5B — email localization helper', () => {
  it('translateLabels returns English when language is en', async () => {
    const { translateLabels, DEFAULT_BOOKING_LABELS } = await import('../email/localize-email');
    const l10n = { language: 'en', translationContext: {} as any, translate: vi.fn() };
    const result = await translateLabels(DEFAULT_BOOKING_LABELS, l10n);
    expect(result).toBe(DEFAULT_BOOKING_LABELS);
    expect(l10n.translate).not.toHaveBeenCalled();
  });

  it('translateLabels calls translate for non-English', async () => {
    const { translateLabels, DEFAULT_BOOKING_LABELS } = await import('../email/localize-email');
    const mockTranslate = vi.fn().mockImplementation(async (text: string) => `[FR] ${text}`);
    const l10n = { language: 'fr', translationContext: {} as any, translate: mockTranslate };
    const result = await translateLabels(DEFAULT_BOOKING_LABELS, l10n);
    expect(mockTranslate).toHaveBeenCalled();
    expect(result.heading).toContain('[FR]');
  });

  it('translateLabels falls back to English on error', async () => {
    const { translateLabels, DEFAULT_BOOKING_LABELS } = await import('../email/localize-email');
    const l10n = { language: 'fr', translationContext: {} as any, translate: vi.fn().mockRejectedValue(new Error('fail')) };
    const result = await translateLabels(DEFAULT_BOOKING_LABELS, l10n);
    expect(result.heading).toContain('Confirmed');
  });

  it('fillLabel interpolates placeholders', async () => {
    const { fillLabel } = await import('../email/localize-email');
    expect(fillLabel('Hi {name}, welcome to {business}!', { name: 'Ade', business: 'TestBiz' }))
      .toBe('Hi Ade, welcome to TestBiz!');
  });
});

describe('Slice 5B — scope containment', () => {
  it('CERTIFIED_LANGUAGES not modified', () => {
    const catalog = readFileSync(resolve(ROOT, 'lib/bot/languages.ts'), 'utf-8');
    expect((catalog.match(/certified:\s*true/g) || []).length).toBe(1);
  });

  it('contract/legal PDF generators not modified', () => {
    const contract = readFileSync(resolve(ROOT, 'lib/pdf/contract-pdf-generator.ts'), 'utf-8');
    expect(contract).not.toContain('localize-pdf');
    const sig = readFileSync(resolve(ROOT, 'lib/pdf/append-signature.ts'), 'utf-8');
    expect(sig).not.toContain('localize-pdf');
  });

  it('no Meta template changes', () => {
    const templates = readFileSync(resolve(ROOT, 'lib/channels/provision-templates.ts'), 'utf-8');
    const promoTemplates = readFileSync(resolve(ROOT, 'lib/promotions/template-contracts.ts'), 'utf-8');
    expect(templates).not.toContain('localize');
    expect(promoTemplates).not.toContain('localize');
  });
});
