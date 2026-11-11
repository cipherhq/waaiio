/**
 * #889 (Owner decision 2026-11-11, option B): the receipt lists what was bought and, for a
 * deposit, shows the full price, the amount paid and the balance due. Real PDFKit output,
 * read back with pdfjs.
 */
import { describe, it, expect } from 'vitest';
import { generateReceiptPdf, RECEIPT_MAX_ITEM_ROWS, type ReceiptData } from '../receipt-generator';
import { getPdfLocalizationBundle } from '../localize-pdf';

const squash = (s: string) => s.replace(/\s+/g, '');

async function pdfText(buf: Buffer): Promise<{ pages: number; text: string }> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(buf), verbosity: 0 }).promise;
  let text = '';
  for (let p = 1; p <= pdf.numPages; p++) {
    const content = await (await pdf.getPage(p)).getTextContent();
    text += ' ' + content.items.map((i: any) => i.str).join(' ');
  }
  return { pages: pdf.numPages, text };
}

const BASE: ReceiptData = {
  businessName: 'Mama Put Kitchen', referenceCode: 'WA-OR-1234', date: '2026-11-11T10:00:00Z',
  serviceName: 'Order WA-OR-1234', amount: 5500, paymentStatus: 'paid', customerName: 'Chiamaka Obi',
  customerPhone: '+2348012345678', countryCode: 'NG', currencyCode: 'NGN', whitelabel: true,
};

describe('#889 receipt item table', () => {
  it('lists each item with quantity, unit price and line total under translated headers', async () => {
    const { pages, text } = await pdfText(await generateReceiptPdf({
      ...BASE,
      items: [
        { name: 'Jollof Rice (Large)', quantity: 2, unitPrice: 2000, lineTotal: 4000 },
        { name: 'Zobo', quantity: 3, unitPrice: 500, lineTotal: 1500 },
      ],
    }));
    expect(pages).toBe(1);
    const t = squash(text);
    for (const s of ['DESCRIPTION', 'QTY', 'UNITPRICE', 'AMOUNT', 'JollofRice(Large)', 'Zobo', 'NGN2,000', 'NGN4,000', 'NGN500', 'NGN1,500', 'Total', 'NGN5,500']) {
      expect(t).toContain(s);
    }
    expect(t).not.toContain('BalanceDue');
  });

  it('no items: no table (unchanged receipt)', async () => {
    const t = squash((await pdfText(await generateReceiptPdf(BASE))).text);
    expect(t).not.toContain('UNITPRICE');
    expect(t).toContain('OrderWA-OR-1234');
  });

  it(`more than ${RECEIPT_MAX_ITEM_ROWS} items: the rest are counted, and everything stays on one page`, async () => {
    const items = Array.from({ length: RECEIPT_MAX_ITEM_ROWS + 3 }, (_, i) => ({
      name: `Item number ${i + 1} with a very long descriptive product name that cannot fit`, quantity: 1, unitPrice: 100, lineTotal: 100,
    }));
    const { pages, text } = await pdfText(await generateReceiptPdf({ ...BASE, items, totalDue: 9000, balanceDue: 3500 }));
    expect(pages).toBe(1);
    const t = squash(text);
    expect(t).toContain('+3…');
    expect(t).toContain('BalanceDue');
    expect(t).not.toContain(`Itemnumber${RECEIPT_MAX_ITEM_ROWS + 1}`);
  });

  it('items with zero quantity are left out', async () => {
    const t = squash((await pdfText(await generateReceiptPdf({
      ...BASE, items: [{ name: 'Ghost', quantity: 0, unitPrice: 1, lineTotal: 0 }],
    }))).text);
    expect(t).not.toContain('Ghost');
    expect(t).not.toContain('UNITPRICE');
  });
});

describe('#889 deposit lines', () => {
  it('a deposit shows Total (full price), Amount Paid (this payment) and Balance Due', async () => {
    const t = squash((await pdfText(await generateReceiptPdf({
      ...BASE, serviceName: 'Bridal Makeup', amount: 20000, totalDue: 50000, balanceDue: 30000, items: undefined,
    }))).text);
    expect(t).toContain('TotalNGN50,000');
    expect(t).toContain('AmountPaidNGN20,000');
    expect(t).toContain('BalanceDueNGN30,000');
  });

  it('fully paid (no balance): a single Total, as before', async () => {
    for (const extra of [{}, { totalDue: 50000, balanceDue: 0 }]) {
      const t = squash((await pdfText(await generateReceiptPdf({ ...BASE, amount: 50000, ...extra }))).text);
      expect(t).toContain('TotalNGN50,000');
      expect(t).not.toContain('AmountPaid');
      expect(t).not.toContain('BalanceDue');
    }
  });
});

describe('#889 labels reuse each language’s invoice wording', () => {
  it('every bundle’s receipt item and deposit labels equal its invoice labels', () => {
    for (const lang of ['en', 'pcm', 'yo', 'ig', 'ha', 'tw', 'fr', 'es']) {
      const b = getPdfLocalizationBundle(lang);
      expect(b.receipt.colDescription).toBe(b.invoice.colDescription);
      expect(b.receipt.colQty).toBe(b.invoice.colQty);
      expect(b.receipt.colUnitPrice).toBe(b.invoice.colUnitPrice);
      expect(b.receipt.colAmount).toBe(b.invoice.colAmount);
      expect(b.receipt.lblAmountPaid).toBe(b.invoice.lblAmountPaid);
      expect(b.receipt.lblBalanceDue).toBe(b.invoice.lblBalanceDue);
    }
    expect(getPdfLocalizationBundle('fr').receipt.colQty).toBe('Qté');
  });

  it('a French deposit receipt uses the French words', async () => {
    const t = squash((await pdfText(await generateReceiptPdf({
      ...BASE, amount: 20000, totalDue: 50000, balanceDue: 30000,
      items: [{ name: 'Robe', quantity: 1, unitPrice: 50000, lineTotal: 50000 }],
      labels: getPdfLocalizationBundle('fr').receipt,
    }))).text);
    for (const s of ['QTÉ', 'PRIXUNITAIRE', 'Montantpayé', 'Soldedû']) expect(t).toContain(s);
  });
});
