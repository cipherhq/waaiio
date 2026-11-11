import { validateTaxSnapshot, type TaxSnapshot } from './calculation';
import { sumPaymentTaxAllocations } from './payment-allocation';
import { majorToTaxMinor, taxMinorToMajor } from './money';

export interface ReceiptTaxSource {
  snapshot: TaxSnapshot;
  /** Only saved allocations representing the displayed payment amount. Never reconstructed from a current rate. */
  allocations?: unknown[];
  /** Entity totals net completed refunds; a single-payment receipt remains the original payment. */
  refundsApplied?: boolean;
}

export function buildReceiptTax(source: ReceiptTaxSource, paidAmount: number) {
  const snapshot = source.snapshot;
  validateTaxSnapshot(snapshot);
  const paidMinor = majorToTaxMinor(paidAmount, snapshot.currency);
  if (paidMinor > snapshot.grossAmount) throw new Error('Receipt payment exceeds original tax snapshot');
  const groups = new Map<string, { label: string; taxAmount: number }>();
  for (const line of snapshot.lines) {
    const treatment = line.treatment === 'exempt' ? 'exempt' : line.treatment === 'disabled' ? 'not charged'
      : `${line.rateBps / 100}%${line.priceMode === 'inclusive' ? ', included' : ', added'}`;
    const label = `${line.label} (${treatment})`;
    const existing = groups.get(label) || { label, taxAmount: 0 };
    existing.taxAmount += line.taxAmount;
    groups.set(label, existing);
  }
  const allocation = source.allocations ? sumPaymentTaxAllocations(source.allocations, snapshot) : undefined;
  if (allocation && allocation.grossAmount !== paidMinor) throw new Error('Receipt payment does not match saved tax allocation');
  return {
    currency: snapshot.currency,
    items: snapshot.lines.map(line => ({
      name: line.description, quantity: line.quantity,
      unitPrice: taxMinorToMajor(line.unitAmount, snapshot.currency), lineTotal: taxMinorToMajor(line.grossAmount, snapshot.currency),
    })),
    netAmount: taxMinorToMajor(snapshot.netAmount, snapshot.currency),
    taxAmount: taxMinorToMajor(snapshot.taxAmount, snapshot.currency),
    grossAmount: taxMinorToMajor(snapshot.grossAmount, snapshot.currency),
    groups: [...groups.values()].map(group => ({ ...group, taxAmount: taxMinorToMajor(group.taxAmount, snapshot.currency) })),
    taxCollected: allocation ? taxMinorToMajor(allocation.taxAmount, snapshot.currency) : undefined,
    netCollected: allocation ? taxMinorToMajor(allocation.netAmount, snapshot.currency) : undefined,
    partial: paidMinor < snapshot.grossAmount,
  };
}
