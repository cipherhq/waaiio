/**
 * Receipt branding (Owner decision 2026-11-05): Waaiio logo at the top, "Powered by Waaiio" at the
 * bottom; a business's own logo sits small beside its name. White-label: no Waaiio branding, the
 * business logo leads as before. The business logo uses the shared, bucket-only loader (#889 Bug D: WebP works).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import sharp from 'sharp';
import { generateReceiptPdf, type ReceiptData } from '../receipt-generator';

const SUPABASE = 'https://proj.supabase.co';
const LOGO_URL = `${SUPABASE}/storage/v1/object/public/business-documents/biz-1/logos/1.webp`;

const imageCount = (buf: Buffer) => (buf.toString('latin1').match(/\/Subtype \/Image/g) || []).length;
const squash = (s: string) => s.replace(/\s+/g, '');

async function pdfText(buf: Buffer): Promise<{ pages: number; text: string }> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(buf), verbosity: 0 }).promise;
  const content = await (await pdf.getPage(1)).getTextContent();
  return { pages: pdf.numPages, text: content.items.map((i: any) => i.str).join(' ') };
}

const BASE: ReceiptData = {
  businessName: 'Citadel of Grace', referenceCode: 'WA-PAY-7742', date: '2026-11-05T10:00:00Z',
  serviceName: 'Sunday Offering', amount: 15000, paymentStatus: 'paid', customerName: 'Adebayo Olumide',
  customerPhone: '+2348012345678', countryCode: 'NG', currencyCode: 'NGN',
};

describe('generateReceiptPdf: Waaiio logo and business logo', () => {
  const realFetch = globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', SUPABASE);
    const webp = await sharp({ create: { width: 2048, height: 2048, channels: 4, background: '#1E5AA8' } }).webp().toBuffer();
    fetchMock = vi.fn(async (url: string) => (url === LOGO_URL
      ? { ok: true, headers: new Headers(), arrayBuffer: async () => webp.buffer.slice(webp.byteOffset, webp.byteOffset + webp.byteLength) }
      : { ok: false }));
    globalThis.fetch = fetchMock as any;
  });
  afterEach(() => { globalThis.fetch = realFetch; vi.unstubAllEnvs(); });

  it('Waaiio logo at the top and "Powered by Waaiio" at the bottom', async () => {
    const branded = await generateReceiptPdf(BASE);
    const plain = await generateReceiptPdf({ ...BASE, whitelabel: true });
    const { pages, text } = await pdfText(branded);
    expect(pages).toBe(1);
    expect(imageCount(plain)).toBe(0);
    expect(imageCount(branded)).toBe(2); // wordmark + its transparency mask
    for (const s of ['RECEIPT', 'Citadel of Grace', 'Powered by Waaiio · waaiio.com', 'Adebayo Olumide']) {
      expect(squash(text)).toContain(squash(s));
    }
  });

  it('a WebP business logo from the bucket is fetched (no redirects) and drawn beside the name', async () => {
    const withLogo = await generateReceiptPdf({ ...BASE, logoUrl: LOGO_URL });
    expect(fetchMock).toHaveBeenCalledWith(LOGO_URL, expect.objectContaining({ redirect: 'error' }));
    expect(imageCount(withLogo)).toBe(3); // wordmark + mask + business logo (opaque)
    expect(squash((await pdfText(withLogo)).text)).toContain('CitadelofGrace');
  });

  it('white-label: no Waaiio logo or text; the business logo leads', async () => {
    const wl = await generateReceiptPdf({ ...BASE, whitelabel: true, logoUrl: LOGO_URL });
    const { text } = await pdfText(wl);
    expect(text).not.toContain('Waaiio');
    expect(imageCount(wl)).toBe(1); // business logo only
  });

  it('a very long business name stays on one line, with or without a logo', async () => {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const longName = 'Redeemed Christian Assembly of the Living Waters International Lekki Phase One Lagos';
    for (const logoUrl of [undefined, LOGO_URL]) {
      const pdf = await pdfjs.getDocument({ data: new Uint8Array(await generateReceiptPdf({ ...BASE, businessName: longName, logoUrl })), verbosity: 0 }).promise;
      expect(pdf.numPages).toBe(1);
      const items = (await (await pdf.getPage(1)).getTextContent()).items as Array<{ str: string; transform: number[] }>;
      const nameItems = items.filter(i => i.str.trim() && longName.includes(i.str.replace('…', '').trim()));
      expect(nameItems.length).toBeGreaterThan(0);
      expect(new Set(nameItems.map(i => Math.round(i.transform[5]))).size).toBe(1); // one line
      expect(items.some(i => i.str.includes('…'))).toBe(true);
    }
  });

  it('logo URLs outside the business-documents bucket are never fetched', async () => {
    for (const url of ['http://169.254.169.254/latest/meta-data/', `${SUPABASE}/storage/v1/object/public/other/x.png`, 'https://example.com/logo.png']) {
      const pdf = await generateReceiptPdf({ ...BASE, logoUrl: url });
      expect(imageCount(pdf)).toBe(2); // wordmark only
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
