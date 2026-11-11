import { validateTaxSnapshot, type TaxSnapshot } from './calculation';

export interface PaymentTaxAllocationLine {
  id: string;
  netAmount: number;
  taxAmount: number;
  grossAmount: number;
}
export interface PaymentTaxAllocation {
  version: 1;
  currency: string;
  lines: PaymentTaxAllocationLine[];
  netAmount: number;
  taxAmount: number;
  grossAmount: number;
}

function amount(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Invalid payment tax allocation amount');
}
function total(values: number[]): number {
  const result = values.reduce((sum, value) => sum + BigInt(value), BigInt(0));
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Payment tax allocation exceeds safe range');
  return Number(result);
}

/** Validate immutable minor-unit payment allocations against their original sale. */
export function validatePaymentTaxAllocation(value: unknown, snapshot: TaxSnapshot): asserts value is PaymentTaxAllocation {
  validateTaxSnapshot(snapshot);
  if (!value || typeof value !== 'object') throw new Error('Invalid payment tax allocation');
  const allocation = value as PaymentTaxAllocation;
  if (allocation.version !== 1 || allocation.currency !== snapshot.currency || !Array.isArray(allocation.lines)
    || !allocation.lines.length || allocation.lines.length > snapshot.lines.length) throw new Error('Invalid payment tax allocation');
  const originals = new Map(snapshot.lines.map(line => [line.id, line]));
  const seen = new Set<string>();
  for (const line of allocation.lines) {
    if (!line || typeof line.id !== 'string' || seen.has(line.id)) throw new Error('Invalid payment tax allocation line');
    seen.add(line.id);
    const original = originals.get(line.id);
    if (!original) throw new Error('Payment tax allocation references an unknown line');
    for (const key of ['netAmount', 'taxAmount', 'grossAmount'] as const) {
      amount(line[key]);
      if (line[key] > original[key]) throw new Error('Payment tax allocation exceeds original line');
    }
    if (total([line.netAmount, line.taxAmount]) !== line.grossAmount) throw new Error('Payment tax allocation line does not reconcile');
  }
  for (const key of ['netAmount', 'taxAmount', 'grossAmount'] as const) {
    amount(allocation[key]);
    if (total(allocation.lines.map(line => line[key])) !== allocation[key]) throw new Error('Payment tax allocation totals do not reconcile');
  }
}

/** Combined successful allocations must not collect any line more than once. */
export function sumPaymentTaxAllocations(values: unknown[], snapshot: TaxSnapshot): PaymentTaxAllocation {
  if (!values.length) throw new Error('Payment tax allocations are missing');
  const lines = snapshot.lines.map(original => ({ id: original.id, netAmount: 0, taxAmount: 0, grossAmount: 0 }));
  const indexed = new Map(lines.map(line => [line.id, line]));
  for (const value of values) {
    validatePaymentTaxAllocation(value, snapshot);
    for (const line of value.lines) {
      const combined = indexed.get(line.id)!;
      for (const key of ['netAmount', 'taxAmount', 'grossAmount'] as const) combined[key] = total([combined[key], line[key]]);
    }
  }
  const result: PaymentTaxAllocation = {
    version: 1, currency: snapshot.currency, lines,
    netAmount: total(lines.map(line => line.netAmount)), taxAmount: total(lines.map(line => line.taxAmount)), grossAmount: total(lines.map(line => line.grossAmount)),
  };
  validatePaymentTaxAllocation(result, snapshot);
  return result;
}

/** Subtract only finalized refund allocations; pending provider outcomes are not money returned. */
export function netPaymentTaxAllocations(payments: unknown[], refunds: unknown[], snapshot: TaxSnapshot): PaymentTaxAllocation {
  const collected = sumPaymentTaxAllocations(payments, snapshot);
  if (!refunds.length) return collected;
  const returned = sumPaymentTaxAllocations(refunds, snapshot);
  const byId = new Map(returned.lines.map(line => [line.id, line]));
  const lines = collected.lines.map(line => {
    const refund = byId.get(line.id)!;
    return { id: line.id, netAmount: line.netAmount - refund.netAmount, taxAmount: line.taxAmount - refund.taxAmount, grossAmount: line.grossAmount - refund.grossAmount };
  });
  const result = { version: 1 as const, currency: snapshot.currency, lines,
    netAmount: collected.netAmount - returned.netAmount, taxAmount: collected.taxAmount - returned.taxAmount, grossAmount: collected.grossAmount - returned.grossAmount };
  validatePaymentTaxAllocation(result, snapshot);
  return result;
}
