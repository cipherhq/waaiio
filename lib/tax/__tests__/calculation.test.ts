import { describe, expect, it } from 'vitest';
import { allocateMinorUnits, allocateTaxPayment, calculateTaxQuote, calculateTaxRefund, type MerchantTaxConfig } from '../calculation';
const defaults: MerchantTaxConfig = { enabled: true, label: 'VAT', rateBps: 1000, priceMode: 'exclusive' };
const line = (id = 'item', unitAmount = 10000, quantity = 1) => ({ id, description: 'Product', quantity, unitAmount });
describe('merchant tax arithmetic', () => {
  it('adds tax after discounts and excludes tax from the percentage fee base', () => {
    const q = calculateTaxQuote(defaults, 'GBP', [line()], 1000);
    expect(q).toMatchObject({ netAmount: 9000, taxAmount: 900, grossAmount: 9900, percentageFeeBase: 9000 });
  });
  it('extracts tax from inclusive prices rather than charging it twice', () => {
    expect(calculateTaxQuote({ ...defaults, priceMode: 'inclusive' }, 'GBP', [line('a', 11000)])).toMatchObject({ netAmount: 10000, taxAmount: 1000, grossAmount: 11000 });
  });
  it('handles mixed inherited, overridden, exempt and zero-rated items', () => {
    const q = calculateTaxQuote(defaults, 'CAD', [line('a'), { ...line('b'), tax: { treatment: 'override', rule: { ...defaults, rateBps: 500 } } }, { ...line('c'), tax: { treatment: 'exempt' } }, { ...line('d'), tax: { treatment: 'override', rule: { ...defaults, rateBps: 0 } } }]);
    expect(q).toMatchObject({ netAmount: 40000, taxAmount: 1500, grossAmount: 41500 });
    expect(q.lines.map(l => l.treatment)).toEqual(['taxable', 'taxable', 'exempt', 'zero_rated']);
  });
  it('keeps disabled merchants untaxed even with item overrides', () => {
    const q = calculateTaxQuote({ ...defaults, enabled: false }, 'NGN', [{ ...line(), tax: { treatment: 'override', rule: { ...defaults, rateBps: 2000 } } }]);
    expect(q.taxAmount).toBe(0); expect(q.grossAmount).toBe(10000);
  });
  it('allocates discounts deterministically and excludes delivery', () => {
    const q = calculateTaxQuote(defaults, 'USD', [line('a', 100), line('b', 100), { ...line('delivery', 100), discountEligible: false, tax: { treatment: 'exempt' } }], 1);
    expect(q.lines.map(l => l.discountAmount)).toEqual([1, 0, 0]);
    expect(allocateMinorUnits(10, [1, 1, 1])).toEqual([4, 3, 3]);
  });
  it.each([-1, 0.1, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])('rejects invalid money %s', value => {
    expect(() => calculateTaxQuote(defaults, 'USD', [line('a', value)])).toThrow();
  });
  it('rejects overflow, invalid rates, duplicate ids, over-discount and missing overrides', () => {
    expect(() => calculateTaxQuote(defaults, 'USD', [line('a', Number.MAX_SAFE_INTEGER, 2)])).toThrow();
    expect(() => calculateTaxQuote({ ...defaults, rateBps: 10001 }, 'USD', [line()])).toThrow();
    expect(() => calculateTaxQuote(defaults, 'USD', [line(), line()])).toThrow();
    expect(() => calculateTaxQuote(defaults, 'USD', [line()], 10001)).toThrow();
    expect(() => calculateTaxQuote(defaults, 'USD', [{ ...line(), tax: { treatment: 'override' } }])).toThrow();
  });
  it('reconciles deposits to the original tax on the final payment', () => {
    const q = calculateTaxQuote(defaults, 'GBP', [line('a', 101)]);
    let paid = 0, tax = 0, net = 0;
    while (paid < q.grossAmount) { const p = allocateTaxPayment(q, 1, paid++); tax += p.taxAmount; net += p.netAmount; expect(p.netAmount).toBeGreaterThanOrEqual(0); }
    expect(tax).toBe(q.taxAmount); expect(net).toBe(q.netAmount);
    expect(() => allocateTaxPayment(q, 1, paid)).toThrow();
  });
  it('refunds the selected taxable item rather than using the mixed basket average', () => {
    const q = calculateTaxQuote(defaults, 'GBP', [line('taxed'), { ...line('exempt'), tax: { treatment: 'exempt' } }]);
    expect(calculateTaxRefund(q, { taxed: 1 })).toMatchObject({ grossAmount: 11000, taxAmount: 1000, netAmount: 10000 });
    expect(calculateTaxRefund(q, { exempt: 1 })).toMatchObject({ grossAmount: 10000, taxAmount: 0 });
  });
  it('reconciles cumulative item refunds without negative net or excess tax', () => {
    for (let price = 0; price < 20; price++) {
      const q = calculateTaxQuote({ ...defaults, rateBps: 10000 }, 'USD', [line('a', price, 3)], price ? price * 3 - 1 : 0);
      let net = 0, tax = 0;
      for (let i = 0; i < 3; i++) { const r = calculateTaxRefund(q, { a: 1 }, { a: i }); expect(r.netAmount).toBeGreaterThanOrEqual(0); net += r.netAmount; tax += r.taxAmount; }
      expect(net).toBe(q.netAmount); expect(tax).toBe(q.taxAmount);
      expect(() => calculateTaxRefund(q, { a: 1 }, { a: 3 })).toThrow();
    }
  });
  it('never reads new merchant settings when refunding an old snapshot', () => {
    const q = calculateTaxQuote(defaults, 'GBP', [line()]);
    const refund = calculateTaxRefund(q, { item: 1 });
    calculateTaxQuote({ ...defaults, rateBps: 2000 }, 'GBP', [line()]);
    expect(calculateTaxRefund(q, { item: 1 })).toEqual(refund);
  });
});

describe('persisted snapshot validation', () => {
  it.each(['grossAmount', 'taxAmount', 'netAmount', 'discountAmount', 'percentageFeeBase'] as const)('rejects a tampered %s', field => {
    const q = calculateTaxQuote(defaults, 'GBP', [line()]);
    q[field]++;
    expect(() => allocateTaxPayment(q, 100, 0)).toThrow();
    expect(() => calculateTaxRefund(q, { item: 1 })).toThrow();
  });
  it('rejects internally balanced but fabricated line tax', () => {
    const q = calculateTaxQuote(defaults, 'GBP', [line()]);
    q.lines[0].taxAmount++; q.lines[0].grossAmount++; q.taxAmount++; q.grossAmount++;
    expect(() => allocateTaxPayment(q, 100, 0)).toThrow();
  });
  it('handles the reviewer tiny-inclusive-discount regression', () => {
    const q = calculateTaxQuote({ ...defaults, priceMode: 'inclusive', rateBps: 10000 }, 'USD', [line('a', 1, 3)], 1);
    expect(q).toMatchObject({ grossAmount: 2, netAmount: 1, taxAmount: 1 });
    const refunds = [0, 1, 2].map(previous => calculateTaxRefund(q, { a: 1 }, { a: previous }));
    for (const r of refunds) { expect(r.taxAmount).toBeLessThanOrEqual(r.grossAmount); expect(r.netAmount).toBeGreaterThanOrEqual(0); }
    expect(refunds.reduce((n, r) => n + r.grossAmount, 0)).toBe(2);
    expect(refunds.reduce((n, r) => n + r.taxAmount, 0)).toBe(1);
  });
});
