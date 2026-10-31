/**
 * Shared helper for payout calculations — currency-scoped, custody-aware.
 *
 * M466: All three monetary inputs (fees, adjustments, prior payouts) are
 * scoped to a single authoritative currency. Cross-currency summation is
 * prevented at the formula level.
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
  /** Payment currency (e.g. 'NGN', 'USD'). Required for currency-scoped calculations. */
  currency?: string | null;
}

export interface AdjustmentRow {
  amount: number;
  /** Adjustment currency. NULL/missing = excluded from all currency-scoped calculations. */
  currency?: string | null;
}

export interface PriorPayoutRow {
  net_amount: number | string;
  /** Payout currency. NULL/missing = excluded from all currency-scoped calculations. */
  currency?: string | null;
}

/**
 * Returns fee rows eligible for payout — requires explicit is_direct_transfer === false.
 * Fail-closed: NULL or undefined custody is treated as ineligible (unknown != platform-held).
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
 * Returns fee rows that have NULL or missing currency.
 * These block payout generation for the affected business (fail-closed).
 */
export function getUnknownCurrencyFeeRows<T extends PayableFeeRow>(rows: T[]): T[] {
  return rows.filter(f => f.is_direct_transfer === false && (!f.currency || !/^[A-Z]{3}$/.test(f.currency)));
}

/**
 * Returns the distinct currencies present in eligible (non-direct-transfer) fee rows.
 * Used by generate/auto-payout to create one payout per currency.
 */
export function getEligibleCurrencies(fees: PayableFeeRow[]): string[] {
  const eligible = fees.filter(f => f.is_direct_transfer === false && f.currency && /^[A-Z]{3}$/.test(f.currency));
  return [...new Set(eligible.map(f => f.currency!))];
}

/**
 * Canonical formula for platform-held payout totals — currency-scoped.
 *
 * All callers (generate, auto-payout, approve, balance, nudge) MUST use this
 * function so the formula stays in one place. Never duplicate these reduces.
 *
 * M466: The `currency` parameter is REQUIRED. All three monetary inputs are
 * filtered to only rows matching the specified currency. Rows with NULL or
 * missing currency are excluded (fail-closed — they don't silently disappear;
 * callers should check getUnknownCurrencyFeeRows separately).
 *
 * Formula:
 *   eligible  = rows where is_direct_transfer === false AND currency matches
 *   gross     = sum(transaction_amount) for eligible
 *   totalFees = sum(fee_total) for non-waived eligible
 *   gatewayFees = sum(gateway_fee) for eligible
 *   adjustmentSum = sum(amount) for adjustments with matching currency
 *   priorPaidOut  = sum(net_amount) for priorPayouts with matching currency
 *   netAvailable  = max(0, gross - totalFees - gatewayFees + adjustmentSum - priorPaidOut)
 */
export function computePlatformHeldTotals(
  fees: PayableFeeRow[],
  currency: string,
  adjustments: AdjustmentRow[] = [],
  priorPayouts: PriorPayoutRow[] = [],
): {
  eligible: PayableFeeRow[];
  gross: number;
  totalFees: number;
  gatewayFees: number;
  adjustmentSum: number;
  priorPaidOut: number;
  netAvailable: number;
} {
  // Custody filter (fail-closed) + currency filter (exact match only)
  const eligible = fees.filter(f => f.is_direct_transfer === false && f.currency === currency);
  const gross = eligible.reduce((s, f) => s + Number(f.transaction_amount || 0), 0);
  const totalFees = eligible.filter(f => !f.waived).reduce((s, f) => s + Number(f.fee_total || 0), 0);
  const gatewayFees = eligible.reduce((s, f) => s + Number(f.gateway_fee || 0), 0);

  // Only same-currency adjustments (NULL-currency adjustments excluded)
  const currencyAdj = adjustments.filter(a => a.currency === currency);
  const adjustmentSum = currencyAdj.reduce((s, a) => s + Number(a.amount || 0), 0);

  // Only same-currency prior payouts (NULL-currency legacy payouts excluded)
  const currencyPrior = priorPayouts.filter(p => p.currency === currency);
  const priorPaidOut = currencyPrior.reduce((s, p) => s + Number(p.net_amount || 0), 0);

  const netAvailable = Math.max(0, gross - totalFees - gatewayFees + adjustmentSum - priorPaidOut);
  return { eligible, gross, totalFees, gatewayFees, adjustmentSum, priorPaidOut, netAvailable };
}

// M468: Historical money with unknown currency requires reconciliation.
// Never attribute an unclassified historical amount to any currency.
export function hasUnreconciledCurrencyRecords(
  payouts: Array<{ currency?: string | null }> = [],
  adjustments: Array<{ currency?: string | null }> = [],
): boolean {
  return [...payouts, ...adjustments].some(row => !row.currency || !/^[A-Z]{3}$/.test(row.currency));
}
