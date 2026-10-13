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
 * Returns fee rows eligible for payout — excludes direct transfers.
 */
export function getPayableFeeRows<T extends PayableFeeRow>(rows: T[]): T[] {
  return rows.filter(f => !f.is_direct_transfer);
}
