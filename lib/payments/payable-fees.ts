/**
 * Shared helper for excluding direct-transfer fee rows from payout calculations.
 *
 * Direct transfers (BYO / Connect routing) bypass the platform pool —
 * the business already holds those funds. Only the platform fee is invoiced;
 * the transaction gross never enters the payout pool.
 *
 * Used by both auto-payout cron and admin payout generation.
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
