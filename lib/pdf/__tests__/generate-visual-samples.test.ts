/**
 * Visual sample generation for CTO review.
 *
 * Renders actual ticket and receipt PDFs to /tmp for manual inspection.
 * Run with: npx vitest run lib/pdf/__tests__/generate-visual-samples.test.ts
 *
 * Output files:
 * - /tmp/waaiio-ticket-with-flyer.pdf
 * - /tmp/waaiio-ticket-no-flyer.pdf
 * - /tmp/waaiio-receipt-ngn.pdf
 * - /tmp/waaiio-receipt-ghs.pdf
 * - /tmp/waaiio-receipt-usd.pdf
 */
import { describe, it, expect, vi } from 'vitest';
import { writeFileSync } from 'fs';

// Minimal 50x50 purple PNG for flyer simulation (valid PNG, not just 1x1)
function createTestPng(): Buffer {
  // Use a real but minimal PNG
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAADIAAAAyCAYAAAAeP4ixAAAARElEQVR42u3PMQEAAAwCoNm/tBn8' +
    'IXQBJ3m3AgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADgagF3bAABPNVJXQAAAABJ' +
    'RU5ErkJggg==',
    'base64'
  );
}

describe('Visual sample generation', () => {
  it('renders ticket WITH flyer → /tmp/waaiio-ticket-with-flyer.pdf', async () => {
    const testPng = createTestPng();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation(async () => ({
      ok: true,
      arrayBuffer: async () => testPng.buffer.slice(testPng.byteOffset, testPng.byteOffset + testPng.byteLength),
    })) as any;

    try {
      const { generateTicketsPdf } = await import('../ticket-generator');
      const buffer = await generateTicketsPdf({
        eventName: 'Praise Night 2026',
        eventDate: 'Saturday, 20 September 2026',
        eventTime: '7:00 PM',
        venue: 'Citadel Arena, Victoria Island, Lagos',
        guestName: 'Adebayo Olumide',
        referenceCode: 'WAA-TK-7742',
        tickets: [
          { ticketCode: 'TK-P9K3MX', ticketNumber: 1, totalTickets: 2 },
          { ticketCode: 'TK-R4J8NV', ticketNumber: 2, totalTickets: 2 },
        ],
        verifyBaseUrl: 'https://www.waaiio.com/tickets',
        flyerUrl: 'https://example.com/praise-night-flyer.jpg',
        ticketType: 'VIP',
        price: 15000,
        countryCode: 'NG',
        section: 'A',
        row: '3',
        seat: '15',
      });

      writeFileSync('/tmp/waaiio-ticket-with-flyer.pdf', buffer);
      expect(buffer.length).toBeGreaterThan(0);
      console.log(`✅ Written: /tmp/waaiio-ticket-with-flyer.pdf (${buffer.length} bytes, ${2} pages)`);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('renders ticket WITHOUT flyer → /tmp/waaiio-ticket-no-flyer.pdf', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false }) as any;

    try {
      const { generateTicketsPdf } = await import('../ticket-generator');
      const buffer = await generateTicketsPdf({
        eventName: 'Afro Jazz Festival',
        eventDate: 'Friday, 15 November 2026',
        eventTime: '6:30 PM',
        venue: 'National Theatre, Accra',
        guestName: 'Kwame Asante',
        referenceCode: 'AJF-1089',
        tickets: [
          { ticketCode: 'TK-VIP872', ticketNumber: 1, totalTickets: 1 },
        ],
        verifyBaseUrl: 'https://www.waaiio.com/tickets',
        ticketType: 'General Admission',
        price: 250,
        countryCode: 'GH',
      });

      writeFileSync('/tmp/waaiio-ticket-no-flyer.pdf', buffer);
      expect(buffer.length).toBeGreaterThan(0);
      console.log(`✅ Written: /tmp/waaiio-ticket-no-flyer.pdf (${buffer.length} bytes)`);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('renders receipt NGN → /tmp/waaiio-receipt-ngn.pdf', async () => {
    const { generateReceiptPdf } = await import('../receipt-generator');
    const buffer = await generateReceiptPdf({
      businessName: 'Citadel of Grace International',
      referenceCode: 'WAA-PAY-7742',
      date: '2026-09-18T10:30:00Z',
      serviceName: 'Praise Night 2026 — VIP Ticket x2',
      amount: 30000,
      paymentStatus: 'paid',
      customerName: 'Adebayo Olumide',
      customerPhone: '+2348012345678',
      countryCode: 'NG',
      subtotal: 28500,
      fees: 1500,
      paymentMethod: 'Card ****4242',
    });

    writeFileSync('/tmp/waaiio-receipt-ngn.pdf', buffer);
    expect(buffer.length).toBeGreaterThan(0);
    console.log(`✅ Written: /tmp/waaiio-receipt-ngn.pdf (${buffer.length} bytes)`);
  });

  it('renders receipt GHS → /tmp/waaiio-receipt-ghs.pdf', async () => {
    const { generateReceiptPdf } = await import('../receipt-generator');
    const buffer = await generateReceiptPdf({
      businessName: 'Accra Premium Barbershop',
      referenceCode: 'ACC-PAY-0093',
      date: '2026-09-15T14:00:00Z',
      serviceName: 'Premium Haircut + Beard Trim',
      amount: 285,
      paymentStatus: 'completed',
      customerName: 'Kwame Asante',
      customerPhone: '+233501234567',
      countryCode: 'GH',
      paymentMethod: 'Mobile Money',
    });

    writeFileSync('/tmp/waaiio-receipt-ghs.pdf', buffer);
    expect(buffer.length).toBeGreaterThan(0);
    console.log(`✅ Written: /tmp/waaiio-receipt-ghs.pdf (${buffer.length} bytes)`);
  });

  it('renders receipt USD → /tmp/waaiio-receipt-usd.pdf', async () => {
    const { generateReceiptPdf } = await import('../receipt-generator');
    const buffer = await generateReceiptPdf({
      businessName: 'NYC Wellness Spa',
      referenceCode: 'NYC-REC-4451',
      date: '2026-09-10T16:00:00Z',
      serviceName: 'Deep Tissue Massage — 90 min',
      amount: 175,
      paymentStatus: 'paid',
      customerName: 'John Smith',
      customerPhone: '+12025551234',
      countryCode: 'US',
      subtotal: 150,
      fees: 25,
      paymentMethod: 'Visa ****1234',
    });

    writeFileSync('/tmp/waaiio-receipt-usd.pdf', buffer);
    expect(buffer.length).toBeGreaterThan(0);
    console.log(`✅ Written: /tmp/waaiio-receipt-usd.pdf (${buffer.length} bytes)`);
  });
});
