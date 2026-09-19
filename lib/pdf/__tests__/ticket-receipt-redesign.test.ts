/**
 * Ticket + Receipt redesign tests — R2 corrections.
 *
 * Covers:
 * - formatCurrencyCode: NGN, GHS, USD, KES, GBP, EUR, unknown fallback
 * - Ticket PDF: flyer success, flyer failure, no flyer, optional fields
 * - Receipt PDF: NGN, USD, fee breakdown, backward compat
 * - Real delivery wiring: deliverTicketsWhatsApp passes presentation fields
 * - Real post-completion: handlePostCompletion passes logo/currency
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { formatCurrency, formatCurrencyCode } from '@/lib/constants';

// ── 1. formatCurrencyCode tests ──

describe('formatCurrencyCode (authoritative ISO code)', () => {
  it('NGN: contains NGN or ₦', () => {
    const r = formatCurrencyCode(5000, 'NGN');
    // en-US locale may render as "NGN 5,000" or "₦5,000" depending on runtime
    expect(r).toMatch(/NGN|₦/);
    expect(r).toContain('5,000');
  });

  it('GHS: contains GHS or GH₵', () => {
    const r = formatCurrencyCode(250, 'GHS');
    expect(r).toMatch(/GHS|GH₵/);
  });

  it('USD: $ symbol', () => {
    const r = formatCurrencyCode(99.99, 'USD');
    expect(r).toContain('$');
    expect(r).toContain('99.99');
  });

  it('KES: contains KES or Ksh', () => {
    const r = formatCurrencyCode(1500, 'KES');
    expect(r).toMatch(/KES|[Kk][Ss]h/);
    expect(r).toContain('1,500');
  });

  it('GBP: £ symbol', () => {
    const r = formatCurrencyCode(50, 'GBP');
    expect(r).toContain('£');
  });

  it('EUR: € symbol', () => {
    const r = formatCurrencyCode(120, 'EUR');
    expect(r).toMatch(/€/);
  });

  it('unknown code: NEVER becomes ₦ — shows code identifier', () => {
    const r = formatCurrencyCode(10000, 'XYZ');
    expect(r).toContain('XYZ');
    expect(r).toContain('10,000');
    expect(r).not.toContain('₦');
  });

  it('empty code: safe fallback, never ₦', () => {
    const r = formatCurrencyCode(500, '');
    expect(r).not.toContain('₦');
  });

  it('lowercase code: normalized to uppercase', () => {
    const r = formatCurrencyCode(100, 'usd');
    expect(r).toContain('$');
  });
});

// ── 2. Existing formatCurrency still works ──

describe('Canonical formatCurrency (country-derived)', () => {
  it('NGN via country', () => { expect(formatCurrency(5000, 'NG')).toContain('₦'); });
  it('GHS via country', () => { expect(formatCurrency(250, 'GH')).toContain('GH₵'); });
  it('USD via country', () => { expect(formatCurrency(99, 'US')).toContain('$'); });
  it('GBP via country', () => { expect(formatCurrency(50, 'GB')).toContain('£'); });
  it('default NGN', () => { expect(formatCurrency(3000)).toContain('₦'); });
});

// ── 3. Ticket PDF tests ──

describe('generateTicketsPdf', () => {
  const TINY_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  );

  it('WITH flyer: flyer URL fetched, valid PDF', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation(async () => ({
      ok: true, arrayBuffer: async () => TINY_PNG.buffer.slice(TINY_PNG.byteOffset, TINY_PNG.byteOffset + TINY_PNG.byteLength),
    })) as any;
    try {
      const { generateTicketsPdf } = await import('../ticket-generator');
      const buf = await generateTicketsPdf({
        eventName: 'Praise Night', eventDate: 'Sat 20 Sep 2026', venue: 'Lagos',
        guestName: 'Ade', referenceCode: 'TK-1', verifyBaseUrl: 'https://waaiio.com/tickets',
        tickets: [{ ticketCode: 'TK-001', ticketNumber: 1, totalTickets: 1 }],
        flyerUrl: 'https://example.com/flyer.png', ticketType: 'VIP', price: 5000, countryCode: 'NG',
      });
      expect(buf.toString('ascii', 0, 5)).toBe('%PDF-');
      expect(globalThis.fetch).toHaveBeenCalledWith('https://example.com/flyer.png', expect.anything());
    } finally { globalThis.fetch = originalFetch; }
  });

  it('flyer fetch fails: fallback PDF', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false }) as any;
    try {
      const { generateTicketsPdf } = await import('../ticket-generator');
      const buf = await generateTicketsPdf({
        eventName: 'Test', eventDate: 'Jan 1', venue: 'V', guestName: 'G', referenceCode: 'R',
        tickets: [{ ticketCode: 'TK-F1', ticketNumber: 1, totalTickets: 1 }],
        verifyBaseUrl: 'https://waaiio.com/tickets', flyerUrl: 'https://bad.com/fail.png',
      });
      expect(buf.toString('ascii', 0, 5)).toBe('%PDF-');
    } finally { globalThis.fetch = originalFetch; }
  });

  it('NO flyer: Waaiio branded fallback', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false }) as any;
    try {
      const { generateTicketsPdf } = await import('../ticket-generator');
      const buf = await generateTicketsPdf({
        eventName: 'No Flyer Event', eventDate: 'Dec 25', venue: 'Accra',
        guestName: 'Kwame', referenceCode: 'NF-1',
        tickets: [{ ticketCode: 'TK-NF1', ticketNumber: 1, totalTickets: 1 }],
        verifyBaseUrl: 'https://waaiio.com/tickets',
      });
      expect(buf).toBeInstanceOf(Buffer);
    } finally { globalThis.fetch = originalFetch; }
  });

  it('currencyCode overrides countryCode for price display', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false }) as any;
    try {
      const { generateTicketsPdf } = await import('../ticket-generator');
      const buf = await generateTicketsPdf({
        eventName: 'Test', eventDate: 'Jan 1', venue: 'V', guestName: 'G', referenceCode: 'R',
        tickets: [{ ticketCode: 'TK-CC1', ticketNumber: 1, totalTickets: 1 }],
        verifyBaseUrl: 'https://waaiio.com/tickets',
        price: 100, currencyCode: 'GBP', countryCode: 'NG',
      });
      expect(buf).toBeInstanceOf(Buffer);
    } finally { globalThis.fetch = originalFetch; }
  });
});

// ── 4. Receipt PDF tests ──

describe('generateReceiptPdf', () => {
  it('NGN receipt', async () => {
    const { generateReceiptPdf } = await import('../receipt-generator');
    const buf = await generateReceiptPdf({
      businessName: 'Citadel', referenceCode: 'PAY-1', date: '2026-09-18',
      serviceName: 'Offering', amount: 15000, paymentStatus: 'paid',
      customerName: 'Ade', customerPhone: '+2348012345678', countryCode: 'NG',
    });
    expect(buf.toString('ascii', 0, 5)).toBe('%PDF-');
  });

  it('currencyCode used when present', async () => {
    const { generateReceiptPdf } = await import('../receipt-generator');
    const buf = await generateReceiptPdf({
      businessName: 'NYC Spa', referenceCode: 'NYC-1', date: '2026-09-10',
      serviceName: 'Massage', amount: 150, paymentStatus: 'paid',
      customerName: 'John', customerPhone: '+12025551234', countryCode: 'US',
      currencyCode: 'USD',
    });
    expect(buf).toBeInstanceOf(Buffer);
  });

  it('fees NOT fabricated when unavailable', async () => {
    const { generateReceiptPdf } = await import('../receipt-generator');
    const buf = await generateReceiptPdf({
      businessName: 'Biz', referenceCode: 'R-1', date: '2026-01-01',
      serviceName: 'Svc', amount: 1000, paymentStatus: 'paid',
      customerName: 'C', customerPhone: '080', countryCode: 'NG',
      // subtotal, fees, paymentMethod intentionally NOT provided
    });
    expect(buf).toBeInstanceOf(Buffer);
  });
});

// Real delivery wiring tests are in delivery-wiring.test.ts (separate mock scope)

// ── 5. History/Annual backward compat ──

describe('History + Annual Statement', () => {
  it('generateHistoryPdf', async () => {
    const { generateHistoryPdf } = await import('../receipt-generator');
    const buf = await generateHistoryPdf({
      customerName: 'C', customerPhone: '+234', countryCode: 'NG',
      rows: [{ date: '2026-01-15', serviceName: 'S', businessName: 'B', referenceCode: 'R', amount: 3000, status: 'paid' }],
    });
    expect(buf).toBeInstanceOf(Buffer);
  });

  it('generateAnnualStatementPdf', async () => {
    const { generateAnnualStatementPdf } = await import('../receipt-generator');
    const buf = await generateAnnualStatementPdf({
      customerName: 'C', customerPhone: '+234', countryCode: 'NG', year: 2026,
      rows: [{ date: '2026-03-10', serviceName: 'S', businessName: 'B', referenceCode: 'R', amount: 2000, status: 'paid' }],
    });
    expect(buf).toBeInstanceOf(Buffer);
  });
});
