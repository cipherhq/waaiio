import PDFDocument from 'pdfkit';
import { afterEach, expect, it, vi } from 'vitest';
import { generateInvoicePdf, type InvoicePdfData } from '@/lib/pdf/invoice-pdf-generator';
import { previewInvoiceTax } from '../invoice';
afterEach(() => vi.restoreAllMocks());
const snapshot = previewInvoiceTax({ enabled: true, label: 'VAT', rateBps: 2000, priceMode: 'inclusive' }, 'GBP', [{ description: 'Consulting', quantity: 1.5, unit_price: 8 }], 'flat', 0);
const data: InvoicePdfData = { businessName: 'Shop', referenceCode: 'INV', issueDate: '2026-11-11', dueDate: null,
 customerName: 'Buyer', customerPhone: null, customerEmail: null, customerAddress: null,
 items: [{ description: 'Consulting', quantity: 1.5, unitPrice: 8, amount: 12 }], subtotal: 12, taxRate: 20, taxAmount: 2,
 discountType: null, discountValue: 0, discountAmount: 0, totalAmount: 12, amountPaid: 0, currency: 'GBP', notes: null, terms: null, status: 'draft', countryCode: 'UK', taxSnapshot: snapshot };
it('renders original fractional quantity and included tax without adding it again', async () => {
 const text = vi.spyOn(PDFDocument.prototype, 'text');
 expect((await generateInvoicePdf(data)).subarray(0, 5).toString()).toBe('%PDF-');
 const strings = text.mock.calls.map(call => String(call[0]));
 expect(strings).toContain('1.5'); expect(strings).toContain('VAT (20%, included)');
 expect(strings).toContain('Before tax (after discounts)');
});
it('rejects snapshot/total disagreement', async () => {
 await expect(generateInvoicePdf({ ...data, totalAmount: 14 })).rejects.toThrow('terms mismatch');
});
it('preserves legacy single tax rendering without a snapshot', async () => {
 const text = vi.spyOn(PDFDocument.prototype, 'text');
 await generateInvoicePdf({ ...data, taxSnapshot: undefined });
 expect(text.mock.calls.map(call => String(call[0]))).toContain('Tax (20%)');
});
