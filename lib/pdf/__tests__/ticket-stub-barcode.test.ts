/**
 * Event ticket redesign (stub + barcode + QR). Owner decisions 2026-11-04:
 *   1A: Code 128 barcode on the stub, plus a small QR. Check-in must not change.
 *   2A: Waaiio purple for every ticket.
 *
 * The barcode is decoded with the zxing build that the dashboard scanner
 * (html5-qrcode) ships, so "it scans" is checked against the same decoder staff use.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import sharp from 'sharp';

const requireCjs = createRequire(import.meta.url);
// Same decoder bundle the dashboard scanner loads (html5-qrcode → third_party/zxing-js).
const Z = requireCjs('html5-qrcode/third_party/zxing-js.umd.js');

const qrSpy = vi.hoisted(() => vi.fn());
vi.mock('qrcode', async (importOriginal) => {
  const actual: any = await importOriginal();
  const real = actual.default ?? actual;
  return {
    default: {
      ...real,
      toDataURL: (text: string, o: unknown) => { qrSpy(text); return real.toDataURL(text, o); },
    },
  };
});

const whiteLabel = vi.hoisted(() => ({ on: false }));
vi.mock('@/lib/whitelabel', () => ({ isWhiteLabel: () => whiteLabel.on }));

import { encodeCode128B } from '../code128';
import { generateTicketsPdf, isAllowedBusinessLogoUrl } from '../ticket-generator';

/** Draw the module list as a 1-pixel-per-unit bitmap and decode it with the scanner's Code 128 reader. */
function decodeModules(modules: number[], unit = 2): string {
  const quiet = 10 * unit;
  const width = modules.reduce((a, b) => a + b, 0) * unit + quiet * 2;
  const height = 20;
  const row = new Uint8ClampedArray(width).fill(255);
  let x = quiet;
  modules.forEach((w, i) => {
    if (i % 2 === 0) row.fill(0, x, x + w * unit);
    x += w * unit;
  });
  const lum = new Uint8ClampedArray(width * height);
  for (let y = 0; y < height; y++) lum.set(row, y * width);
  const reader = new Z.MultiFormatReader();
  reader.setHints(new Map([[Z.DecodeHintType.POSSIBLE_FORMATS, [Z.BarcodeFormat.CODE_128]]]));
  const result = reader.decode(new Z.BinaryBitmap(new Z.HybridBinarizer(new Z.RGBLuminanceSource(lum, width, height))));
  expect(result.getBarcodeFormat()).toBe(Z.BarcodeFormat.CODE_128);
  return result.getText();
}

async function pdfText(buf: Buffer): Promise<{ pages: number; size: number[]; text: string[] }> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(buf), verbosity: 0 }).promise;
  const text: string[] = [];
  let size: number[] = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    if (p === 1) size = [page.view[2], page.view[3]];
    const content = await page.getTextContent();
    text.push(content.items.map((i: any) => i.str).join(' '));
  }
  return { pages: pdf.numPages, size, text };
}

// Letter-spaced labels come out of text extraction as "L I E U", so compare without whitespace.
const squash = (s: string) => s.replace(/\s+/g, '');
const expectText = (text: string, needle: string) => expect(squash(text)).toContain(squash(needle));

const imageCount = (buf: Buffer) => (buf.toString('latin1').match(/\/Subtype \/Image/g) || []).length;

const SUPABASE = 'https://proj.supabase.co';
const LOGO_URL = `${SUPABASE}/storage/v1/object/public/business-documents/biz-1/logos/1.webp`;

const BASE = {
  eventName: 'Praise Night 2026',
  eventDate: 'Sat, 20 Sep 2026',
  eventTime: '7:00 PM',
  venue: 'Citadel Arena, Lagos',
  guestName: 'Adebayo Olumide',
  referenceCode: 'WA-TK-7742',
  verifyBaseUrl: 'https://www.waaiio.com/tickets',
  ticketType: 'VIP',
  price: 15000,
  currencyCode: 'NGN',
  section: 'A', row: '3', seat: '15',
  businessName: 'Citadel of Grace',
  tickets: [
    { ticketCode: 'TK-A3F8X2C91', ticketNumber: 1, totalTickets: 2 },
    { ticketCode: 'TK-0B77E1D24', ticketNumber: 2, totalTickets: 2 },
  ],
};

describe('encodeCode128B: decodes with the dashboard scanner decoder', () => {
  it.each(['TK-A3F8X2C91', 'TK-A3F8X2', 'TK-000000000', 'TK-FFFFFFFFF'])('%s round-trips exactly', (code) => {
    expect(decodeModules(encodeCode128B(code))).toBe(code);
  });

  it('every printable ASCII character round-trips', () => {
    let all = '';
    for (let c = 32; c <= 126; c++) all += String.fromCharCode(c);
    for (let i = 0; i < all.length; i += 20) {
      const chunk = all.slice(i, i + 20);
      expect(decodeModules(encodeCode128B(chunk))).toBe(chunk);
    }
  });

  it('module count is 11 per symbol + 13 for stop', () => {
    const modules = encodeCode128B('TK-A3F8X2C91'); // start + 12 chars + checksum + stop
    expect(modules.reduce((a, b) => a + b, 0)).toBe(14 * 11 + 13);
  });

  it('rejects empty and non-printable input', () => {
    expect(() => encodeCode128B('')).toThrow('code128_empty_input');
    expect(() => encodeCode128B('TK-é')).toThrow('code128_unsupported_character');
    expect(() => encodeCode128B('TK\n1')).toThrow('code128_unsupported_character');
  });
});

describe('generateTicketsPdf: ticket layout', () => {
  const realFetch = globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;
  let logoWebp: Buffer;

  beforeEach(async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', SUPABASE);
    qrSpy.mockClear();
    whiteLabel.on = false;
    logoWebp = await sharp({ create: { width: 64, height: 64, channels: 4, background: '#F59E0B' } }).webp().toBuffer();
    fetchMock = vi.fn(async (url: string) => (url === LOGO_URL
      ? { ok: true, arrayBuffer: async () => logoWebp.buffer.slice(logoWebp.byteOffset, logoWebp.byteOffset + logoWebp.byteLength) }
      : { ok: false }));
    globalThis.fetch = fetchMock as any;
  });
  afterEach(() => { globalThis.fetch = realFetch; vi.unstubAllEnvs(); });

  it('one landscape ticket page per ticket, every detail printed', async () => {
    const { pages, size, text } = await pdfText(await generateTicketsPdf(BASE));
    expect(pages).toBe(2);
    expect(size).toEqual([780, 300]);
    const p1 = text[0];
    for (const s of [
      'Praise Night 2026', 'VIP', 'CITADEL OF GRACE', 'Citadel of Grace',
      'Adebayo Olumide', 'NGN', '15,000', 'Section A · Row 3 · Seat 15',
      'Sat, 20 Sep 2026', '7:00 PM', 'Citadel Arena, Lagos',
      'TK-A3F8X2C91', 'REF WA-TK-7742', 'Ticket 1 / 2', 'Scan to verify', 'Powered by Waaiio',
    ]) expectText(p1, s);
    expect(text[1]).toContain('TK-0B77E1D24');
    expect(text[1]).toContain('Ticket 2 / 2');
    expect(text[1]).not.toContain('TK-A3F8X2C91');
  });

  it('QR payload is unchanged: verify URL + ticket code, once per ticket', async () => {
    await generateTicketsPdf(BASE);
    expect(qrSpy.mock.calls.map(c => c[0])).toEqual([
      'https://www.waaiio.com/tickets/TK-A3F8X2C91',
      'https://www.waaiio.com/tickets/TK-0B77E1D24',
    ]);
  });

  it('WebP business logo from the business-documents bucket is fetched and drawn', async () => {
    const withLogo = await generateTicketsPdf({ ...BASE, tickets: [BASE.tickets[0]], businessLogoUrl: LOGO_URL });
    const without = await generateTicketsPdf({ ...BASE, tickets: [BASE.tickets[0]] });
    expect(fetchMock).toHaveBeenCalledWith(LOGO_URL, expect.anything());
    // PNG images with transparency add a mask object, so compare rather than count exactly.
    expect(imageCount(without)).toBeGreaterThan(0); // QR
    expect(imageCount(withLogo)).toBeGreaterThan(imageCount(without)); // QR + logo (WebP converted to PNG)
  });

  it('logo URLs outside the business-documents bucket are never fetched', async () => {
    for (const url of [
      'http://169.254.169.254/latest/meta-data/',
      `${SUPABASE}/storage/v1/object/public/other-bucket/x.png`,
      `${SUPABASE}.evil.com/storage/v1/object/public/business-documents/x.png`,
    ]) {
      expect(isAllowedBusinessLogoUrl(url)).toBe(false);
      await generateTicketsPdf({ ...BASE, tickets: [BASE.tickets[0]], businessLogoUrl: url });
      expect(fetchMock).not.toHaveBeenCalledWith(url, expect.anything());
    }
  });

  it('white-label tiers hide the Waaiio footer', async () => {
    whiteLabel.on = true;
    const { text } = await pdfText(await generateTicketsPdf({ ...BASE, tickets: [BASE.tickets[0]] }));
    expect(text[0]).not.toContain('Waaiio');
    expect(text[0]).toContain('TK-A3F8X2C91');
  });

  it('localized labels are used', async () => {
    const { DEFAULT_TICKET_LABELS } = await import('../localize-pdf');
    const fr = { ...DEFAULT_TICKET_LABELS, lblVenue: 'LIEU', scanVerify: 'Scanner pour vérifier', ticketOf: 'Billet' };
    const { text } = await pdfText(await generateTicketsPdf({ ...BASE, tickets: [BASE.tickets[0]], labels: fr }));
    expectText(text[0], 'LIEU');
    expectText(text[0], 'Billet 1 / 2');
    expectText(text[0], 'Scanner pour vérifier');
  });

  it('minimal ticket (no type, time, price, seat, business, flyer) still renders', async () => {
    const { pages, text } = await pdfText(await generateTicketsPdf({
      eventName: 'Youth Fellowship', eventDate: '23 Apr 2026', venue: '', guestName: 'Kwame', referenceCode: 'R-1',
      verifyBaseUrl: 'https://www.waaiio.com/tickets', tickets: [{ ticketCode: 'TK-A3F8X2', ticketNumber: 1, totalTickets: 1 }],
    }));
    expect(pages).toBe(1);
    expect(text[0]).toContain('Youth Fellowship');
    expect(text[0]).toContain('TK-A3F8X2');
  });
});
