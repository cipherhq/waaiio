/**
 * Slice 6 Gate 1 — Nigerian Pidgin (pcm) E2E journey tests (#524)
 *
 * Exercises email, PDF, proactive, and rendering surfaces with Pidgin
 * localization. Produces machine-readable evidence for human QA.
 *
 * Does NOT change CERTIFIED_LANGUAGES. Tests use the existing Pidgin
 * bundles/labels infrastructure built in Slices 3–5B.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock proactive localization ──
const mockResolveProactive = vi.fn();
vi.mock('@/lib/payments/proactive-localization', () => ({
  resolveProactiveLocalization: (...a: unknown[]) => mockResolveProactive(...a),
}));

const mockResolveEmail = vi.fn();
vi.mock('@/lib/email/localize-email', async () => {
  const actual = await vi.importActual('@/lib/email/localize-email');
  return { ...actual as object, resolveEmailLocalization: (...a: unknown[]) => mockResolveEmail(...a) };
});

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const pcmL10n = {
  language: 'pcm', translationContext: {} as any, translate: async (t: string) => t,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveProactive.mockResolvedValue(pcmL10n);
  mockResolveEmail.mockResolvedValue(pcmL10n);
});

// ═══════════════════════════════════════════════════════════════
// J26 — Receipt PDF with Pidgin bundle
// ═══════════════════════════════════════════════════════════════

describe('J26 — Receipt PDF (Pidgin)', () => {
  it('generates valid PDF with Pidgin chrome labels', async () => {
    const { generateReceiptPdf } = await import('../pdf/receipt-generator');
    const { getPdfLocalizationBundle } = await import('../pdf/localize-pdf');
    const pcmBundle = getPdfLocalizationBundle('pcm');

    const buffer = await generateReceiptPdf({
      businessName: 'FacesByKoph',
      referenceCode: 'WA-BK-PCM-0001',
      date: '2026-12-01T10:30:00Z',
      serviceName: 'Premium Haircut',
      amount: 5000,
      paymentStatus: 'paid',
      customerName: 'Emeka Johnson',
      customerPhone: '+2341234567890',
      countryCode: 'NG',
      labels: pcmBundle.receipt,
    });

    expect(buffer).toBeInstanceOf(Buffer);
    expect(buffer.slice(0, 5).toString()).toBe('%PDF-');
    expect(buffer.length).toBeGreaterThan(500);

    // Machine-readable evidence: Pidgin receipt labels
    expect(pcmBundle.receipt.title).toBe('RECEIPT');
    expect(pcmBundle.receipt.footer).toBe('Waaiio power am');
    expect(pcmBundle.receipt.statusLabels.paid).toBe('Don pay');
  });

  it('resolvePdfLabels returns Pidgin receipt bundle', async () => {
    const { resolvePdfLabels } = await import('../pdf/localize-pdf');
    const labels = await resolvePdfLabels({} as any, '+234', 'biz-1', 'receipt', 'proactive');
    expect(labels).toBeDefined();
    expect(labels!.footer).toBe('Waaiio power am');
  });
});

// ═══════════════════════════════════════════════════════════════
// J27 — Ticket PDF with Pidgin bundle
// ═══════════════════════════════════════════════════════════════

describe('J27 — Ticket PDF (Pidgin)', () => {
  it('generates valid PDF with Pidgin ticket chrome', async () => {
    const { generateTicketsPdf } = await import('../pdf/ticket-generator');
    const { getPdfLocalizationBundle } = await import('../pdf/localize-pdf');
    const pcmBundle = getPdfLocalizationBundle('pcm');

    const buffer = await generateTicketsPdf({
      eventName: 'Afrobeats Festival Lagos',
      eventDate: 'Dec 1, 2026',
      venue: 'Eko Convention Centre',
      guestName: 'Emeka Johnson',
      referenceCode: 'WA-TK-PCM-5678',
      tickets: [{ ticketCode: 'TK-PCM-ABC', ticketNumber: 1, totalTickets: 2 },
                { ticketCode: 'TK-PCM-DEF', ticketNumber: 2, totalTickets: 2 }],
      verifyBaseUrl: 'https://waaiio.com/tickets/verify',
      labels: pcmBundle.ticket,
    });

    expect(buffer).toBeInstanceOf(Buffer);
    expect(buffer.slice(0, 5).toString()).toBe('%PDF-');
    expect(buffer.length).toBeGreaterThan(500);

    // Pidgin ticket chrome evidence
    expect(pcmBundle.ticket.lblAttendee).toBe('PERSON');
    expect(pcmBundle.ticket.lblVenue).toBe('PLACE');
    expect(pcmBundle.ticket.scanVerify).toBe('Scan am to verify');
    expect(pcmBundle.ticket.footer).toBe('Waaiio power am');
  });
});

// ═══════════════════════════════════════════════════════════════
// J28 — Invoice PDF with Pidgin bundle
// ═══════════════════════════════════════════════════════════════

describe('J28 — Invoice PDF (Pidgin)', () => {
  it('generates valid PDF with Pidgin invoice chrome', async () => {
    const { generateInvoicePdf } = await import('../pdf/invoice-pdf-generator');
    const { getPdfLocalizationBundle } = await import('../pdf/localize-pdf');
    const pcmBundle = getPdfLocalizationBundle('pcm');

    const buffer = await generateInvoicePdf({
      businessName: 'TestBiz Salon',
      referenceCode: 'INV-PCM-001',
      issueDate: '2026-12-01',
      dueDate: '2026-12-31',
      customerName: 'Emeka Johnson',
      customerPhone: '+2341234567890',
      items: [{ description: 'VIP Haircut', quantity: 1, unitPrice: 8000, amount: 8000 }],
      subtotal: 8000, taxRate: 0, taxAmount: 0, discountType: 'none', discountValue: 0, discountAmount: 0,
      totalAmount: 8000, amountPaid: 0, status: 'pending', countryCode: 'NG',
      labels: pcmBundle.invoice,
    });

    expect(buffer).toBeInstanceOf(Buffer);
    expect(buffer.slice(0, 5).toString()).toBe('%PDF-');

    // Pidgin invoice chrome evidence
    expect(pcmBundle.invoice.title).toBe('INVOICE');
    expect(pcmBundle.invoice.lblPaid).toBe('DON PAY');
    expect(pcmBundle.invoice.lblBillTo).toBe('BILL GO');
    expect(pcmBundle.invoice.footer).toBe('Waaiio power am');
  });
});

// ═══════════════════════════════════════════════════════════════
// J29/J30 — History + Annual Statement PDFs
// ═══════════════════════════════════════════════════════════════

describe('J29/J30 — History + Annual Statement PDFs (Pidgin)', () => {
  it('J29: generates valid history PDF with Pidgin chrome', async () => {
    const { generateHistoryPdf } = await import('../pdf/receipt-generator');
    const { getPdfLocalizationBundle } = await import('../pdf/localize-pdf');
    const pcmBundle = getPdfLocalizationBundle('pcm');

    const buffer = await generateHistoryPdf({
      customerName: 'Emeka Johnson',
      customerPhone: '+2341234567890',
      countryCode: 'NG',
      rows: [
        { date: '2026-12-01T00:00:00Z', serviceName: 'Haircut', businessName: 'TestBiz', referenceCode: 'WA-BK-1', amount: 5000, status: 'paid' },
      ],
      labels: pcmBundle.history,
    });

    expect(buffer).toBeInstanceOf(Buffer);
    expect(buffer.slice(0, 5).toString()).toBe('%PDF-');
    expect(pcmBundle.history.statusLabels.paid).toBe('Don pay');
  });

  it('J30: generates valid annual statement PDF with Pidgin chrome', async () => {
    const { generateAnnualStatementPdf } = await import('../pdf/receipt-generator');
    const { getPdfLocalizationBundle } = await import('../pdf/localize-pdf');
    const pcmBundle = getPdfLocalizationBundle('pcm');

    const buffer = await generateAnnualStatementPdf({
      customerName: 'Emeka Johnson',
      customerPhone: '+2341234567890',
      countryCode: 'NG',
      year: 2026,
      rows: [
        { date: '2026-01-15T00:00:00Z', serviceName: 'Service', businessName: 'Biz', referenceCode: 'REF-1', amount: 1000, status: 'paid' },
      ],
      labels: pcmBundle.annual,
    });

    expect(buffer).toBeInstanceOf(Buffer);
    expect(buffer.slice(0, 5).toString()).toBe('%PDF-');
    expect(pcmBundle.annual.statusLabels.paid).toBe('Don pay');
  });
});

// ═══════════════════════════════════════════════════════════════
// J21 — Booking confirmation email with Pidgin labels
// ═══════════════════════════════════════════════════════════════

describe('J21 — Booking confirmation email (Pidgin)', () => {
  it('renders email with Pidgin wrapper labels preserving authoritative values', async () => {
    const { DEFAULT_BOOKING_LABELS, DEFAULT_WRAPPER_LABELS } = await import('../email/localize-email');
    const { bookingConfirmationEmail } = await import('../email/templates');

    // Directly pass Pidgin wrapper labels (simulating successful translation)
    const pidginWrapper = { ...DEFAULT_WRAPPER_LABELS, htmlLang: 'pcm', footer: 'Waaiio power am. All rights reserved.' };

    const email = bookingConfirmationEmail({
      firstName: 'Emeka', businessName: 'TestBiz', date: '2026-12-01', time: '10:00 AM',
      quantity: 1, referenceCode: 'WA-BK-PCM-001', amount: 5000,
      quantityLabel: 'Guests', confirmationEmoji: '✅',
      labels: DEFAULT_BOOKING_LABELS, // Using English labels (Pidgin translation is LLM-dependent)
      wrapperLabels: pidginWrapper,
    });

    // Email rendered with Pidgin lang tag
    expect(email.html).toContain('lang="pcm"');
    // Authoritative values preserved exactly
    expect(email.html).toContain('WA-BK-PCM-001');
    expect(email.html).toContain('TestBiz');
    expect(email.html).toContain('5,000');
    expect(email.html.length).toBeGreaterThan(100);
  });

  it('translateLabels failure → complete English (atomic fallback)', async () => {
    const { translateLabels, DEFAULT_BOOKING_LABELS, localizeWrapperLabels } = await import('../email/localize-email');
    const l10n = {
      language: 'pcm', translationContext: {} as any,
      translate: vi.fn().mockRejectedValue(new Error('LLM timeout')),
    };

    const labels = await translateLabels(DEFAULT_BOOKING_LABELS, l10n);
    const wrapperLabels = await localizeWrapperLabels(l10n);

    expect(labels.heading).toBe(DEFAULT_BOOKING_LABELS.heading);
    expect(wrapperLabels.htmlLang).toBe('en');
    expect(wrapperLabels.footer).toContain('All rights reserved');
  });
});

// ═══════════════════════════════════════════════════════════════
// J22 — Ticket confirmation email
// ═══════════════════════════════════════════════════════════════

describe('J22 — Ticket confirmation email (Pidgin)', () => {
  it('renders ticket email preserving authoritative values', async () => {
    const { ticketConfirmationEmail } = await import('../email/templates');
    const { DEFAULT_TICKET_LABELS, DEFAULT_WRAPPER_LABELS } = await import('../email/localize-email');

    // Use English defaults (simulating Pidgin not-yet-activated scenario)
    const email = ticketConfirmationEmail({
      firstName: 'Emeka', businessName: 'ShowHub', eventName: 'Afrobeats Fest',
      eventDate: 'Dec 1, 2026', venue: 'Eko Centre', quantity: 2,
      referenceCode: 'WA-TK-PCM-9999', formattedAmount: '₦10,000',
      ticketCodes: ['TK-PCM-111', 'TK-PCM-222'], whitelabel: false,
      labels: DEFAULT_TICKET_LABELS,
      wrapperLabels: { ...DEFAULT_WRAPPER_LABELS, htmlLang: 'pcm' },
    });

    // Authoritative values exact
    expect(email.html).toContain('WA-TK-PCM-9999');
    expect(email.html).toContain('TK-PCM-111');
    expect(email.html).toContain('TK-PCM-222');
    expect(email.html).toContain('₦10,000');
    expect(email.html).toContain('ShowHub');
    expect(email.html).toContain('lang="pcm"');
  });
});

// ═══════════════════════════════════════════════════════════════
// J24 — Invoice email
// ═══════════════════════════════════════════════════════════════

describe('J24 — Invoice email (Pidgin)', () => {
  it('renders invoice email preserving authoritative values', async () => {
    const { invoiceEmail } = await import('../email/templates');
    const { DEFAULT_INVOICE_LABELS, DEFAULT_WRAPPER_LABELS } = await import('../email/localize-email');

    const email = invoiceEmail({
      businessName: 'TestBiz Salon',
      referenceCode: 'INV-PCM-002',
      totalAmount: '₦15,000',
      dueDate: 'Dec 31, 2026',
      customerName: 'Emeka Johnson',
      items: [{ description: 'VIP Treatment', quantity: 1, unitPrice: 15000, amount: 15000 }],
      invoiceUrl: 'https://waaiio.com/invoice/token123',
      currency: 'NGN',
      labels: DEFAULT_INVOICE_LABELS,
      wrapperLabels: { ...DEFAULT_WRAPPER_LABELS, htmlLang: 'pcm' },
    });

    expect(email.html).toContain('INV-PCM-002');
    expect(email.html).toContain('₦15,000');
    expect(email.html).toContain('https://waaiio.com/invoice/token123');
    expect(email.html).toContain('TestBiz Salon');
    expect(email.html).toContain('lang="pcm"');
  });
});

// ═══════════════════════════════════════════════════════════════
// Authoritative value integrity — across all surfaces
// ═══════════════════════════════════════════════════════════════

describe('Authoritative values — Pidgin bundles contain zero business data', () => {
  it('Pidgin PDF bundles contain only Waaiio-owned chrome', async () => {
    const { getPdfLocalizationBundle } = await import('../pdf/localize-pdf');
    const pcm = getPdfLocalizationBundle('pcm');

    for (const [docType, labels] of Object.entries(pcm)) {
      const str = JSON.stringify(labels);
      expect(str).not.toContain('WA-BK');
      expect(str).not.toContain('WA-TK');
      expect(str).not.toContain('INV-');
      expect(str).not.toContain('₦');
      expect(str).not.toContain('5000');
      expect(str).not.toContain('waaiio.com/invoice');
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// Rendered evidence summary for human QA
// ═══════════════════════════════════════════════════════════════

describe('Human QA evidence — Pidgin label inventory', () => {
  it('captures full Pidgin label set for human review', async () => {
    const { getPdfLocalizationBundle } = await import('../pdf/localize-pdf');
    const pcm = getPdfLocalizationBundle('pcm');

    // Receipt chrome
    expect(pcm.receipt.title).toBe('RECEIPT');
    expect(pcm.receipt.lblReference).toBe('Reference');
    expect(pcm.receipt.lblService).toBe('Service');
    expect(pcm.receipt.lblCustomer).toBe('Customer');
    expect(pcm.receipt.footer).toBe('Waaiio power am');
    expect(pcm.receipt.statusLabels.paid).toBe('Don pay');
    expect(pcm.receipt.statusLabels.pending).toBe('Dey wait');

    // Ticket chrome
    expect(pcm.ticket.lblDate).toBe('DATE');
    expect(pcm.ticket.lblVenue).toBe('PLACE');
    expect(pcm.ticket.lblAttendee).toBe('PERSON');
    expect(pcm.ticket.scanVerify).toBe('Scan am to verify');

    // Invoice chrome
    expect(pcm.invoice.lblPaid).toBe('DON PAY');
    expect(pcm.invoice.lblBillTo).toBe('BILL GO');
    expect(pcm.invoice.lblBalanceDue).toBe('Balance wey remain');

    // History/annual
    expect(pcm.history.statusLabels.completed).toBe('Don complete');
    expect(pcm.annual.taxDisclaimer).toContain('This statement na for your records');
  });
});
