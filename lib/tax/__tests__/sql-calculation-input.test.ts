import { expect, it } from 'vitest';
import { calculateTaxQuote, type TaxInputLine } from '../calculation';
const config = { enabled: true, label: 'Tax', rateBps: 750, priceMode: 'exclusive' as const };
const line = { id: 'a', description: 'Item', quantity: 1, unitAmount: 100 };

it.each([1, true, {}, [], null])('rejects malformed JSON line id %j before producing a snapshot', id => {
  expect(() => calculateTaxQuote(config, 'USD', [{ ...line, id } as unknown as TaxInputLine])).toThrow();
});
it('rejects non-string currency and non-array lines instead of coercing them', () => {
  expect(() => calculateTaxQuote(config, ['USD'] as unknown as string, [line])).toThrow();
  expect(() => calculateTaxQuote(config, 'USD', null as unknown as TaxInputLine[])).toThrow();
  expect(() => calculateTaxQuote(config, 'USD', [null] as unknown as TaxInputLine[])).toThrow();
});
it('rejects malformed extra rules even when JavaScript would consider the value falsy', () => {
  const input = { ...line, tax: { treatment: 'inherit', rule: false } } as unknown as TaxInputLine;
  expect(() => calculateTaxQuote(config, 'USD', [input])).toThrow();
});
it('keeps product volume discounts on their own line before allocating basket discounts', () => {
  const quote = calculateTaxQuote(config, 'USD', [
    { ...line, unitAmount: 1000, lineDiscountAmount: 500 },
    { ...line, id: 'exempt', unitAmount: 1000, tax: { treatment: 'exempt' } },
  ], 300);
  expect(quote.lines.map(l => l.discountAmount)).toEqual([600, 200]);
  expect(quote.lines[0]).toMatchObject({ lineDiscountAmount: 500, netAmount: 400, taxAmount: 30 });
  expect(quote.discountAmount).toBe(800);
  expect(() => calculateTaxQuote(config, 'USD', [{ ...line, lineDiscountAmount: 101 }])).toThrow();
});
