import { describe, expect, it } from 'vitest';
import { calculateTaxQuote } from '../calculation';
import { buildReceiptTax } from '../receipt';
import { netPaymentTaxAllocations, validatePaymentTaxAllocation } from '../payment-allocation';

const snapshot = calculateTaxQuote({ enabled: true, label: 'VAT', rateBps: 1000, priceMode: 'exclusive' }, 'GBP', [
  { id: 'original', description: 'Original haircut', quantity: 1, unitAmount: 1000 },
]);
const allocated = (netAmount: number, taxAmount: number) => ({ version: 1, currency: 'GBP', netAmount, taxAmount, grossAmount: netAmount + taxAmount,
  lines: [{ id: 'original', netAmount, taxAmount, grossAmount: netAmount + taxAmount }] });

describe('historical receipt tax', () => {
  it('shows original terms and only the saved tax in a deposit', () => {
    expect(buildReceiptTax({ snapshot, allocations: [allocated(500, 50)] }, 5.5)).toMatchObject({
      currency: 'GBP', netAmount: 10, taxAmount: 1, grossAmount: 11, taxCollected: 0.5, netCollected: 5, partial: true,
      items: [{ name: 'Original haircut', quantity: 1, unitPrice: 10, lineTotal: 11 }],
      groups: [{ label: 'VAT (10%, added)', taxAmount: 1 }],
    });
  });
  it('never invents collected tax when allocation is unavailable', () => {
    const result = buildReceiptTax({ snapshot }, 5.5);
    expect(result.taxAmount).toBe(1);
    expect(result.taxCollected).toBeUndefined();
    expect(result.netCollected).toBeUndefined();
  });
  it('nets only supplied finalized refund allocations and reconciles per line', () => {
    const net = netPaymentTaxAllocations([allocated(500, 50)], [allocated(200, 20)], snapshot);
    expect(net).toMatchObject({ netAmount: 300, taxAmount: 30, grossAmount: 330 });
    expect(buildReceiptTax({ snapshot, allocations: [net] }, 3.3).taxCollected).toBe(0.3);
    expect(() => netPaymentTaxAllocations([allocated(200, 20)], [allocated(500, 50)], snapshot)).toThrow();
  });
  it('rejects a receipt amount which differs from its saved allocation', () => {
    expect(() => buildReceiptTax({ snapshot, allocations: [allocated(500, 50)] }, 11)).toThrow('does not match');
  });
  it('rejects tampered snapshots and excessive collection', () => {
    expect(() => buildReceiptTax({ snapshot: { ...snapshot, taxAmount: 99 } }, 11)).toThrow();
    expect(() => buildReceiptTax({ snapshot }, 12)).toThrow();
    expect(() => netPaymentTaxAllocations([allocated(1000, 100), allocated(1, 0)], [], snapshot)).toThrow();
  });
  it.each([
    { ...allocated(500, 50), currency: 'USD' },
    { ...allocated(500, 50), netAmount: 499 },
    { ...allocated(500, 50), lines: [{ id: 'foreign', netAmount: 500, taxAmount: 50, grossAmount: 550 }] },
    { ...allocated(500, 50), lines: [allocated(500, 50).lines[0], allocated(500, 50).lines[0]] },
    { ...allocated(500, 50), lines: [{ id: 'original', netAmount: 499, taxAmount: 50, grossAmount: 550 }] },
  ])('rejects malformed allocation %j', value => {
    expect(() => validatePaymentTaxAllocation(value, snapshot)).toThrow();
  });
  it('distinguishes inclusive zero-rated and exempt treatment without subtracting discounts twice', () => {
    const mixed = calculateTaxQuote({ enabled: true, label: 'VAT', rateBps: 2000, priceMode: 'inclusive' }, 'GBP', [
      { id: 'a', description: 'Inclusive item', quantity: 1, unitAmount: 1200 },
      { id: 'b', description: 'Zero item', quantity: 1, unitAmount: 100, tax: { treatment: 'override', rule: { label: 'VAT', rateBps: 0, priceMode: 'exclusive' } } },
      { id: 'c', description: 'Exempt item', quantity: 1, unitAmount: 100, tax: { treatment: 'exempt' } },
    ], 140);
    const result = buildReceiptTax({ snapshot: mixed }, 12.6);
    expect(result.grossAmount).toBe(12.6);
    expect(result).toMatchObject({ netAmount: 10.8, taxAmount: 1.8 });
    expect(result.groups.map(group => group.label)).toEqual(['VAT (20%, included)', 'VAT (0%, added)', 'VAT (exempt)']);
  });
});
