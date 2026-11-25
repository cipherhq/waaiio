import { formatCurrency, type CountryCode } from '@/lib/constants';
import type { TablePackage } from '../table-reservation.flow';

/**
 * Minimum spend and bottle packages on a table (M557, Owner decision 2026-11-23).
 * Reads the offer the customer was shown from the session; book_table_atomic
 * works out the same amount from the table row and refuses a difference.
 */
export interface TableOffer {
  packages: TablePackage[];
  minimumSpend: number | null;
  paymentMode: 'deposit' | 'full';
  deposit: number;
  /** A minimum spend or at least one package. Without one the table works as before. */
  hasOffer: boolean;
  selectedPackage: TablePackage | null;
}

export function tableOffer(d: Record<string, unknown>): TableOffer {
  const packages = Array.isArray(d._seating_packages) ? (d._seating_packages as TablePackage[]) : [];
  const minimumSpend = typeof d._seating_minimum_spend === 'number' && d._seating_minimum_spend > 0 ? d._seating_minimum_spend : null;
  const packageId = d._seating_package_id as string | null | undefined;
  return {
    packages,
    minimumSpend,
    paymentMode: d._seating_payment_mode === 'full' ? 'full' : 'deposit',
    deposit: Number(d._seating_deposit ?? 0) || 0,
    hasOffer: minimumSpend !== null || packages.length > 0,
    selectedPackage: (packageId && packages.find(p => p.id === packageId)) || null,
  };
}

/**
 * What the customer pays now. Pay in full: the package price, else the minimum
 * spend, else the deposit (Owner Q1 A). Deposit only, or no offer: the deposit.
 */
export function tablePayableNow(offer: TableOffer): number {
  if (offer.paymentMode === 'full' && offer.hasOffer) {
    return offer.selectedPackage?.price ?? offer.minimumSpend ?? offer.deposit;
  }
  return offer.deposit;
}

/** True when this table asks for payment in full now (so messages say "Payment", not "Deposit"). */
export function tablePaysInFull(offer: TableOffer): boolean {
  return offer.paymentMode === 'full' && offer.hasOffer;
}

/** Summary and confirmation lines naming the package and minimum spend; empty without an offer. */
export function tableOfferLines(offer: TableOffer, cc: CountryCode): string[] {
  if (!offer.hasOffer) return [];
  const lines: string[] = [];
  const pkg = offer.selectedPackage;
  if (pkg) {
    lines.push(`🍾 Package: ${pkg.name} – ${formatCurrency(pkg.price, cc)}`);
    if (pkg.includes) lines.push(`   ${pkg.includes}`);
  } else if (offer.packages.length > 0) {
    lines.push('🍾 No package');
  }
  if (offer.minimumSpend !== null) lines.push(`💵 Minimum spend: ${formatCurrency(offer.minimumSpend, cc)}`);
  if (!tablePaysInFull(offer)) lines.push('The rest is paid at the venue.');
  return lines;
}
