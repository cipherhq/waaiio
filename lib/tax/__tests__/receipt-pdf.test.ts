import PDFDocument from 'pdfkit';
import { afterEach, expect, it, vi } from 'vitest';
import { generateReceiptPdf } from '@/lib/pdf/receipt-generator';
import { calculateTaxQuote } from '../calculation';

afterEach(() => vi.restoreAllMocks());
const base = { businessName: 'Historical merchant', referenceCode: 'REF', date: '2026-11-11', serviceName: 'Purchase', amount: 5.5,
  paymentStatus: 'success', customerName: 'Customer', customerPhone: '+441234567890', countryCode: 'UK' as const };
const snapshot = calculateTaxQuote({ enabled: true, label: 'VAT', rateBps: 1000, priceMode: 'exclusive' }, 'GBP', [{ id: 'old', description: 'Original item', quantity: 1, unitAmount: 1000 }]);

it('renders a real PDF with original item and separate sale tax and deposit tax', async () => {
  const text = vi.spyOn(PDFDocument.prototype, 'text');
  const buffer = await generateReceiptPdf({ ...base, items: [{ name: 'Renamed catalog item', quantity: 1, unitPrice: 999, lineTotal: 999 }], tax: { snapshot,
    allocations: [{ version: 1, currency: 'GBP', netAmount: 500, taxAmount: 50, grossAmount: 550,
      lines: [{ id: 'old', netAmount: 500, taxAmount: 50, grossAmount: 550 }] }] } });
  expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
  const values = text.mock.calls.map(call => String(call[0]));
  expect(values).toContain('Original item');
  expect(values).not.toContain('Renamed catalog item');
  expect(values).toContain('Full sale tax');
  expect(values).toContain('Tax in amount paid');
  expect(values).toContain('VAT (10%, added)');
});

it('labels unavailable collected tax instead of presenting all sale tax as paid', async () => {
  const text = vi.spyOn(PDFDocument.prototype, 'text');
  await generateReceiptPdf({ ...base, tax: { snapshot } });
  const values = text.mock.calls.map(call => String(call[0]));
  expect(values).toContain('Tax breakdown describes the full sale; collected tax is not available.');
  expect(values).not.toContain('Tax in amount paid');
});

it('does not produce a document for a corrupt tax snapshot', async () => {
  await expect(generateReceiptPdf({ ...base, tax: { snapshot: { ...snapshot, grossAmount: 1 } } })).rejects.toThrow();
});

it('rejects a payment currency which differs from the tax snapshot', async () => {
  await expect(generateReceiptPdf({ ...base, currencyCode: 'USD', tax: { snapshot } })).rejects.toThrow('currency');
});

it('paginates many tax groups and keeps full labels and rates', async () => {
  const text = vi.spyOn(PDFDocument.prototype, 'text');
  const pages = vi.spyOn(PDFDocument.prototype, 'addPage');
  const many = calculateTaxQuote({ enabled: true, label: 'VAT', rateBps: 1000, priceMode: 'exclusive' }, 'GBP', Array.from({ length: 12 }, (_, index) => ({
    id: String(index), description: `Item ${index}`, quantity: 1, unitAmount: 1000,
    tax: { treatment: 'override' as const, rule: { label: `A long original tax name preserved for receipt ${index}`, rateBps: 1000, priceMode: 'exclusive' as const } },
  })));
  await generateReceiptPdf({ ...base, amount: 132, tax: { snapshot: many } });
  expect(pages.mock.calls.length).toBeGreaterThan(1);
  const calls = text.mock.calls.filter(call => String(call[0]).includes('A long original tax name'));
  expect(calls).toHaveLength(12);
  expect(calls.every(call => String(call[0]).includes('(10%, added)'))).toBe(true);
  expect(calls.every(call => (call[2] as number) < 430)).toBe(true);
});
