/**
 * Shared helper for excluding direct-transfer fee rows from payout calculations.
 *
 * Direct transfers (BYO / Connect routing) bypass the platform pool —
 * the business already holds those funds. Only the platform fee is invoiced;
 * the transaction gross never enters the payout pool.
 *
 * Used by generate, auto-payout, approve, balance, and nudge routes.
 */

export interface PayableFeeRow {
  transaction_amount: number;
  fee_total: number;
  gateway_fee: number;
  waived: boolean;
  is_direct_transfer?: boolean | null;
}

/**
 * Returns fee rows eligible for payout — requires explicit is_direct_transfer === false.
 * Fail-closed: NULL or undefined custody is treated as ineligible (unknown ≠ platform-held).
 */
export function getPayableFeeRows<T extends PayableFeeRow>(rows: T[]): T[] {
  return rows.filter(f => f.is_direct_transfer === false);
}

/**
 * Returns fee rows whose custody is unclassified (is_direct_transfer is null or undefined).
 * Used to surface custody-unknown rows for monitoring without silently dropping them.
 */
export function getUnclassifiedFeeRows<T extends PayableFeeRow>(rows: T[]): T[] {
  return rows.filter(f => f.is_direct_transfer == null);
}

/**
 * Canonical formula for platform-held payout totals.
 *
 * All callers (generate, auto-payout, approve, balance, nudge) MUST use this
 * function so the formula stays in one place. Never duplicate these reduces.
 *
 * Formula:
 *   eligible  = rows where is_direct_transfer === false  (fail-closed: null excluded)
 *   gross     = sum(transaction_amount) for eligible
 *   totalFees = sum(fee_total) for non-waived eligible
 *   gatewayFees = sum(gateway_fee) for eligible
 *   adjustmentSum = sum(amount) for adjustments (negative = deduction, positive = credit)
 *   priorPaidOut  = sum(net_amount) for priorPayouts (omit for period-specific callers)
 *   netAvailable  = max(0, gross - totalFees - gatewayFees + adjustmentSum - priorPaidOut)
 *
 * Callers that compute a period-specific net (generate, auto-payout) omit priorPayouts.
 * Callers that compute an available balance (approve, balance endpoint) pass priorPayouts.
 */
export function computePlatformHeldTotals(
  fees: PayableFeeRow[],
  adjustments: { amount: number }[] = [],
  priorPayouts: { net_amount: number | string }[] = [],
): {
  eligible: PayableFeeRow[];
  gross: number;
  totalFees: number;
  gatewayFees: number;
  adjustmentSum: number;
  priorPaidOut: number;
  netAvailable: number;
} {
  const eligible = fees.filter(f => f.is_direct_transfer === false);
  const gross = eligible.reduce((s, f) => s + Number(f.transaction_amount || 0), 0);
  const totalFees = eligible.filter(f => !f.waived).reduce((s, f) => s + Number(f.fee_total || 0), 0);
  const gatewayFees = eligible.reduce((s, f) => s + Number(f.gateway_fee || 0), 0);
  const adjustmentSum = adjustments.reduce((s, a) => s + Number(a.amount || 0), 0);
  const priorPaidOut = priorPayouts.reduce((s, p) => s + Number(p.net_amount || 0), 0);
  const netAvailable = Math.max(0, gross - totalFees - gatewayFees + adjustmentSum - priorPaidOut);
  return { eligible, gross, totalFees, gatewayFees, adjustmentSum, priorPaidOut, netAvailable };
}
