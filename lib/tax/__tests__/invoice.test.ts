import { describe, expect, it } from 'vitest';
import { invoiceLineMinor, previewInvoiceTax, previewLegacyInvoice } from '../invoice';
import { initialQuotedItems } from '../quote-items';
const config = { enabled: true, label: 'VAT', rateBps: 1000, priceMode: 'exclusive' as const };
describe('itemized invoice tax', () => {
  it('preserves fractional hours as explicitly described charged lines', () => {
    const quote = previewInvoiceTax(config, 'USD', [{ description: 'Consulting', quantity: 1.5, unit_price: 10 }], 'flat', 0);
    expect(quote.lines[0]).toMatchObject({ quantity: 1, unitAmount: 1500, description: 'Consulting (1.5 × 10 USD)' });
    expect(quote).toMatchObject({ netAmount: 1500, taxAmount: 150, grossAmount: 1650 });
  });
  it('rounds decimal extensions exactly once', () => {
    expect(invoiceLineMinor(0.333, 10, 'GBP')).toBe(333);
    expect(invoiceLineMinor(1.005, 1, 'USD')).toBe(101);
    expect(invoiceLineMinor(0.333, 0.05, 'CAD')).toBe(2);
  });
  it('discounts before mixed inclusive and exempt tax', () => {
    const quote = previewInvoiceTax(config, 'USD', [
      { description: 'Included', quantity: 1, unit_price: 12, tax_treatment: 'override', tax_label: 'VAT', tax_rate_bps: 2000, tax_price_mode: 'inclusive' },
      { description: 'Exempt', quantity: 1, unit_price: 12, tax_treatment: 'exempt' },
    ], 'percent', 50);
    expect(quote).toMatchObject({ netAmount: 1100, taxAmount: 100, grossAmount: 1200, discountAmount: 1200 });
  });
  it('rejects invalid quantities and fractional cents', () => {
    expect(() => invoiceLineMinor(0, 1, 'USD')).toThrow();
    expect(() => invoiceLineMinor(1, 1.001, 'USD')).toThrow();
  });
  it('keeps add-ons attached and delivery separate without duplicating addons_snapshot', () => {
    const lines = initialQuotedItems({ cart_snapshot: [{ product_id: 'p1', name: 'Cake', price: 10, quantity: 2,
      addons: [{ name: 'Ribbon', price: 2, quantity: 2 }] }], delivery_address: 'Here' });
    expect(lines).toHaveLength(3);
    expect(lines[1]).toMatchObject({ parent_id: 'item-0', unit_price: 2, quantity: 2 });
    expect(lines[2]).toMatchObject({ kind: 'delivery', unit_price: 0 });
  });
});

it('legacy invoice preview keeps tax-before-discount without new currency conversion', () => {
 expect(previewLegacyInvoice([{ description: 'Work', quantity: 1, unit_price: 10 }], 20, 'flat', 2)).toEqual({ subtotal: 10, taxAmount: 2, discountAmount: 2, totalAmount: 10 });
 expect(previewLegacyInvoice([{ description: 'Work', quantity: 1, unit_price: 10 }], 0, 'flat', 0).totalAmount).toBe(10);
});
