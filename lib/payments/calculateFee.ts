import type { SubscriptionTier } from '@/lib/constants';

/**
 * Config snapshot shape expected from platform_config_versions.config_snapshot.
 * Only the fee-relevant keys are required.
 */
export interface FeeConfigSnapshot {
  pricing_tiers?: Record<string, {
    feePercentage?: number;
    feeFlat?: number;
  }>;
  category_fee_rates?: Record<string, {
    feePercentage: number;
  }>;
}

/**
 * Immutable fee basis persisted on the payment row (five keys only).
 * No config_version_id, transaction_category, amount, or currency —
 * those are top-level columns on payments.
 */
export interface FeeBasis {
  payment_routing: 'platform' | 'byo' | 'connect';
  tier: SubscriptionTier;
  is_in_trial: boolean;
  custom_fee_percentage: number | null;
  custom_fee_flat: number | null;
}

export interface FeeResult {
  feePercentage: number;
  feeFlat: number;
  feeTotal: number;
}

/**
 * Pure fee calculator — NO DB calls, NO cache reads.
 *
 * Two modes:
 *   - Pinned (configSnapshot provided): uses immutable snapshot for rate resolution.
 *     For v1 fee-policy-active payments at initiation, finalization, retry, and refund.
 *   - Legacy (configSnapshot = null): caller must provide resolved tier config via overrides.
 *     Used by the getPlatformFees() wrapper for v0 payments.
 *
 * Precedence (pinned mode):
 *   1. BYO routing → 0% (invariant, highest precedence)
 *   2. Trial waiver → 0%
 *   3. Per-business custom override (custom_fee_percentage / custom_fee_flat)
 *   4. Category rate from snapshot (percentage-only)
 *   5. Tier rate from snapshot (percentage fallback)
 *   6. Missing category-specific rate → tier fallback (NOT zero, NOT fail closed)
 *   7. feeFlat: custom_fee_flat is the only v1 flat source (tier flat must be 0)
 *
 * Amount and feeFlat are in major currency units (naira/dollars/pounds).
 * Two-decimal precision for v1; legacy rounding preserved for v0 callers.
 */
export function calculateFee(
  amount: number,
  basis: FeeBasis,
  category: string | null,
  configSnapshot: FeeConfigSnapshot | null,
): FeeResult {
  // 1. BYO routing → zero fee (invariant)
  if (basis.payment_routing === 'byo') {
    return { feePercentage: 0, feeFlat: 0, feeTotal: 0 };
  }

  // 2. Trial waiver → zero fee
  if (basis.is_in_trial) {
    return { feePercentage: 0, feeFlat: 0, feeTotal: 0 };
  }

  // 3. Resolve percentage: custom override > category rate > tier default
  let feePercentage: number;

  if (typeof basis.custom_fee_percentage === 'number') {
    // Per-business custom override (highest non-zero precedence)
    feePercentage = basis.custom_fee_percentage;
  } else if (configSnapshot && category) {
    // Category rate from pinned snapshot (percentage-only)
    const categoryRate = configSnapshot.category_fee_rates?.[category];
    if (categoryRate && typeof categoryRate.feePercentage === 'number') {
      feePercentage = categoryRate.feePercentage;
    } else {
      // Missing category rate → tier fallback (NOT zero)
      const tierConfig = configSnapshot.pricing_tiers?.[basis.tier];
      if (!tierConfig || typeof tierConfig.feePercentage !== 'number') {
        throw new Error(`Missing tier fee config for tier "${basis.tier}" in pinned snapshot`);
      }
      feePercentage = tierConfig.feePercentage;
    }
  } else if (configSnapshot) {
    // No category but pinned snapshot → tier default
    const tierConfig = configSnapshot.pricing_tiers?.[basis.tier];
    if (!tierConfig || typeof tierConfig.feePercentage !== 'number') {
      throw new Error(`Missing tier fee config for tier "${basis.tier}" in pinned snapshot`);
    }
    feePercentage = tierConfig.feePercentage;
  } else {
    // Legacy mode (no snapshot) — caller should use getPlatformFees wrapper
    throw new Error('calculateFee requires configSnapshot for fee-policy-active payments');
  }

  // 4. Resolve flat fee: custom_fee_flat is the only v1 flat source
  // (v1 global tier feeFlat must be 0 — enforced at config activation)
  const feeFlat = typeof basis.custom_fee_flat === 'number' ? basis.custom_fee_flat : 0;

  // Waive flat fee on micro-transactions (> 10% of amount)
  const effectiveFeeFlat = (feeFlat > 0 && amount > 0 && feeFlat / amount > 0.10) ? 0 : feeFlat;

  // 5. Calculate total with two-decimal precision
  const pctComponent = Math.round(amount * feePercentage * 100) / 10000;
  const rawTotal = pctComponent + effectiveFeeFlat;
  const feeTotal = Math.round(rawTotal * 100) / 100;

  return { feePercentage, feeFlat: effectiveFeeFlat, feeTotal };
}

/**
 * Validate that a pinned config snapshot is safe for v1 fee policy activation.
 * Returns null on success, or an error message on failure.
 */
export function validateV1Snapshot(
  snapshot: FeeConfigSnapshot,
  tier: SubscriptionTier,
): string | null {
  const tierConfig = snapshot.pricing_tiers?.[tier];
  if (!tierConfig) {
    return `Missing pricing_tiers config for tier "${tier}"`;
  }
  if (typeof tierConfig.feePercentage !== 'number') {
    return `Missing feePercentage for tier "${tier}"`;
  }
  // v1 global tier feeFlat must be exactly 0
  const flat = tierConfig.feeFlat ?? 0;
  if (flat !== 0) {
    return `Non-zero global tier feeFlat (${flat}) for tier "${tier}" — v1 requires 0`;
  }
  return null;
}
