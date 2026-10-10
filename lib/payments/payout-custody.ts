/**
 * #597: Platform-held custody eligibility for payout calculations.
 *
 * This module provides the canonical filter for determining which
 * platform_fees rows represent funds that Waaiio actually holds and
 * can pay out to businesses.
 *
 * The filter is used by:
 * - Auto-payout cron (app/api/cron/auto-payout/route.ts)
 * - Manual payout generator (app/api/admin/payouts/generate/route.ts)
 * - Payout approval balance check (app/api/admin/payouts/[id]/approve/route.ts)
 *
 * CTO 601-A: Uses strict === false, not negation.
 * !null === true would incorrectly include unknown custody as eligible.
 */

export interface PlatformFeeRow {
  transaction_amount: number;
  fee_total: number;
  gateway_fee: number;
  waived: boolean;
  is_direct_transfer: boolean | null;
}

/**
 * Returns true only for fees with explicitly confirmed platform custody.
 *
 * - is_direct_transfer === false → Waaiio holds the funds (eligible)
 * - is_direct_transfer === true → funds went directly to business (ineligible)
 * - is_direct_transfer === null → unknown custody (ineligible, fail-closed)
 */
export function isPlatformHeld(fee: Pick<PlatformFeeRow, 'is_direct_transfer'>): boolean {
  return fee.is_direct_transfer === false;
}

/**
 * Compute payout amounts from platform-held fees only.
 * Excludes direct transfer and unknown custody rows.
 */
export function computePlatformHeldTotals(fees: PlatformFeeRow[]): {
  eligible: PlatformFeeRow[];
  gross: number;
  totalFees: number;
  totalGatewayFees: number;
} {
  const eligible = fees.filter(isPlatformHeld);
  const gross = eligible.reduce((s, f) => s + Number(f.transaction_amount || 0), 0);
  const totalFees = eligible.filter(f => !f.waived).reduce((s, f) => s + Number(f.fee_total || 0), 0);
  const totalGatewayFees = eligible.reduce((s, f) => s + Number(f.gateway_fee || 0), 0);
  return { eligible, gross, totalFees, totalGatewayFees };
}
