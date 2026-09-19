/**
 * Ticket + Receipt redesign tests.
 *
 * Covers:
 * - Shared currency formatter (NGN, GHS, KES, USD, GBP, EUR, unknown)
 * - Ticket PDF generation (with flyer, without flyer, with optional fields)
 * - Receipt PDF generation (with fees, without fees, status colors)
 * - Backward compatibility (existing callers still work)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Currency formatter tests ──

describe('formatTicketCurrency', () => {
  let formatTicketCurrency: typeof import('../currency').formatTicketCurrency;
  let getCurrencySymbol: typeof import('../currency').getCurrencySymbol;

  beforeEach(async () => {
    const mod = await import('../currency');
    formatTicketCurrency = mod.formatTicketCurrency;
    getCurrencySymbol = mod.getCurrencySymbol;
  });

  it('NGN: renders ₦ symbol', () => {
    const result = formatTicketCurrency(5000, 'NG');
    expect(result).toContain('₦');
    expect(result).toContain('5,000');
  });

  it('GHS: renders GH₵ symbol', () => {
    const result = formatTicketCurrency(250, 'GH');
    expect(result).toContain('GH₵');
    expect(result).toContain('250');
  });

  it('KES: renders Ksh/KSh symbol', () => {
    const result = formatTicketCurrency(1500, 'KE');
    // Intl.NumberFormat may render as "Ksh" or "KSh" depending on runtime
    expect(result).toMatch(/[Kk][Ss]h/);
    expect(result).toContain('1,500');
  });

  it('USD: renders $ symbol', () => {
    const result = formatTicketCurrency(99.99, 'US');
    expect(result).toContain('$');
    expect(result).toContain('99.99');
  });

  it('GBP: renders £ symbol', () => {
    const result = formatTicketCurrency(50, 'GB');
    expect(result).toContain('£');
    expect(result).toContain('50');
  });

  it('EUR (DE): renders € symbol', () => {
    const result = formatTicketCurrency(120, 'DE');
    // EUR formatting varies by locale — just verify € is present
    expect(result).toMatch(/€/);
  });

  it('unknown country code: falls back to CODE amount', () => {
    const result = formatTicketCurrency(10000, 'XY');
    expect(result).toBe('XY 10,000');
  });

  it('null country code: defaults to NGN', () => {
    const result = formatTicketCurrency(3000, null);
    expect(result).toContain('₦');
  });

  it('handles decimal amounts correctly', () => {
    const result = formatTicketCurrency(19.50, 'US');
    expect(result).toContain('19.50') ;
  });

  it('getCurrencySymbol returns correct symbols', () => {
    expect(getCurrencySymbol('NG')).toBe('₦');
    expect(getCurrencySymbol('GH')).toBe('GH₵');
    expect(getCurrencySymbol('KE')).toBe('KSh');
    expect(getCurrencySymbol('US')).toBe('$');
    expect(getCurrencySymbol('GB')).toBe('£');
    expect(getCurrencySymbol(null)).toBe('₦'); // default
    expect(getCurrencySymbol('XZ')).toBe('XZ'); // unknown → code
  });
});

// ── Ticket PDF generator tests ──

describe('generateTicketsPdf', () => {
  // Mock fetch for flyer/logo
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
    }) as any;
  });

  it('generates PDF buffer with basic options (no flyer)', async () => {
    const { generateTicketsPdf } = await import('../ticket-generator');
    const buffer = await generateTicketsPdf({
      eventName: 'Praise Night 2026',
      eventDate: 'Saturday, 20 September 2026',
      eventTime: '7:00 PM',
      venue: 'Citadel Arena, Lagos',
      guestName: 'Adebayo Olumide',
      referenceCode: 'WAA-TK-001',
      tickets: [{ ticketCode: 'TK-A3F8X2', ticketNumber: 1, totalTickets: 2 }],
      verifyBaseUrl: 'https://www.waaiio.com/tickets',
    });
    expect(buffer).toBeInstanceOf(Buffer);
    expect(buffer.length).toBeGreaterThan(0);
    // PDF starts with %PDF
    expect(buffer.toString('ascii', 0, 5)).toBe('%PDF-');
  });

  it('generates PDF with all optional fields (ticket type, price, section)', async () => {
    const { generateTicketsPdf } = await import('../ticket-generator');
    const buffer = await generateTicketsPdf({
      eventName: 'Afro Jazz Festival',
      eventDate: 'Friday, 15 November 2026',
      eventTime: '6:30 PM',
      venue: 'National Theatre, Accra',
      guestName: 'Kwame Asante',
      referenceCode: 'AJF-002',
      tickets: [
        { ticketCode: 'TK-VIP001', ticketNumber: 1, totalTickets: 1 },
      ],
      verifyBaseUrl: 'https://www.waaiio.com/tickets',
      ticketType: 'VIP',
      price: 5000,
      countryCode: 'GH',
      section: 'A',
      row: '3',
      seat: '12',
    });
    expect(buffer).toBeInstanceOf(Buffer);
    expect(buffer.length).toBeGreaterThan(0);
  });

  it('generates multi-page PDF for multiple tickets', async () => {
    const { generateTicketsPdf } = await import('../ticket-generator');
    const buffer = await generateTicketsPdf({
      eventName: 'Test Event',
      eventDate: 'Monday, 1 January 2026',
      venue: 'Test Venue',
      guestName: 'Test Guest',
      referenceCode: 'TST-001',
      tickets: [
        { ticketCode: 'TK-001', ticketNumber: 1, totalTickets: 3 },
        { ticketCode: 'TK-002', ticketNumber: 2, totalTickets: 3 },
        { ticketCode: 'TK-003', ticketNumber: 3, totalTickets: 3 },
      ],
      verifyBaseUrl: 'https://www.waaiio.com/tickets',
    });
    expect(buffer).toBeInstanceOf(Buffer);
    // Multi-page PDF should be larger
    expect(buffer.length).toBeGreaterThan(1000);
  });

  it('backward compat: works without new optional fields', async () => {
    const { generateTicketsPdf } = await import('../ticket-generator');
    // Call with the old interface shape — no flyerUrl, ticketType, price, etc.
    const buffer = await generateTicketsPdf({
      eventName: 'Legacy Event',
      eventDate: 'Dec 25, 2025',
      venue: 'Old Venue',
      guestName: 'Old Guest',
      referenceCode: 'OLD-001',
      tickets: [{ ticketCode: 'TK-OLD1', ticketNumber: 1, totalTickets: 1 }],
      verifyBaseUrl: 'https://www.waaiio.com/tickets',
      subscriptionTier: 'free',
    });
    expect(buffer).toBeInstanceOf(Buffer);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });
});

// ── Receipt PDF generator tests ──

describe('generateReceiptPdf', () => {
  it('generates receipt PDF with NGN currency', async () => {
    const { generateReceiptPdf } = await import('../receipt-generator');
    const buffer = await generateReceiptPdf({
      businessName: 'Citadel of Grace',
      referenceCode: 'WAA-PAY-001',
      date: '2026-09-18T10:00:00Z',
      serviceName: 'Sunday Service Offering',
      amount: 15000,
      paymentStatus: 'paid',
      customerName: 'Adebayo Olumide',
      customerPhone: '+2348012345678',
      countryCode: 'NG',
    });
    expect(buffer).toBeInstanceOf(Buffer);
    expect(buffer.toString('ascii', 0, 5)).toBe('%PDF-');
  });

  it('generates receipt with fee breakdown', async () => {
    const { generateReceiptPdf } = await import('../receipt-generator');
    const buffer = await generateReceiptPdf({
      businessName: 'Accra Barbershop',
      referenceCode: 'ACC-001',
      date: '2026-09-15',
      serviceName: 'Premium Haircut',
      amount: 285,
      paymentStatus: 'completed',
      customerName: 'Kwame Asante',
      customerPhone: '+233501234567',
      countryCode: 'GH',
      subtotal: 250,
      fees: 35,
      paymentMethod: 'Card ****4242',
    });
    expect(buffer).toBeInstanceOf(Buffer);
  });

  it('generates receipt with USD currency', async () => {
    const { generateReceiptPdf } = await import('../receipt-generator');
    const buffer = await generateReceiptPdf({
      businessName: 'NYC Spa',
      referenceCode: 'NYC-001',
      date: '2026-09-10',
      serviceName: 'Deep Tissue Massage',
      amount: 150,
      paymentStatus: 'paid',
      customerName: 'John Smith',
      customerPhone: '+12025551234',
      countryCode: 'US',
    });
    expect(buffer).toBeInstanceOf(Buffer);
  });

  it('backward compat: works without new optional fields', async () => {
    const { generateReceiptPdf } = await import('../receipt-generator');
    const buffer = await generateReceiptPdf({
      businessName: 'Legacy Biz',
      referenceCode: 'LEG-001',
      date: '2025-01-01',
      serviceName: 'Service',
      amount: 1000,
      paymentStatus: 'paid',
      customerName: 'Customer',
      customerPhone: '08012345678',
      countryCode: 'NG',
    });
    expect(buffer).toBeInstanceOf(Buffer);
  });
});

// ── History + Annual Statement (ensure they still work) ──

describe('generateHistoryPdf', () => {
  it('generates history PDF', async () => {
    const { generateHistoryPdf } = await import('../receipt-generator');
    const buffer = await generateHistoryPdf({
      customerName: 'Test Customer',
      customerPhone: '+2348012345678',
      countryCode: 'NG',
      rows: [
        { date: '2026-01-15', serviceName: 'Haircut', businessName: 'BarberShop', referenceCode: 'REF-001', amount: 3000, status: 'paid' },
        { date: '2026-02-20', serviceName: 'Massage', businessName: 'Spa Place', referenceCode: 'REF-002', amount: 5000, status: 'completed' },
      ],
    });
    expect(buffer).toBeInstanceOf(Buffer);
  });
});

describe('generateAnnualStatementPdf', () => {
  it('generates annual statement PDF', async () => {
    const { generateAnnualStatementPdf } = await import('../receipt-generator');
    const buffer = await generateAnnualStatementPdf({
      customerName: 'Test Customer',
      customerPhone: '+2348012345678',
      countryCode: 'NG',
      year: 2026,
      rows: [
        { date: '2026-03-10', serviceName: 'Service A', businessName: 'Biz A', referenceCode: 'R-1', amount: 2000, status: 'paid' },
        { date: '2026-06-15', serviceName: 'Service B', businessName: 'Biz B', referenceCode: 'R-2', amount: 8000, status: 'completed' },
      ],
    });
    expect(buffer).toBeInstanceOf(Buffer);
  });
});
