import { loadPlatformSettings } from '@/lib/platformSettings';
import type { SubscriptionTier } from '@/lib/constants';

/**
 * Centralized async fee calculator — reads tier config from DB-backed
 * platform_settings (with 60s cache and hardcoded fallback).
 *
 * @param amount   Transaction amount in minor units (e.g. kobo / cents)
 * @param tier     Business subscription tier
 * @param isInTrial Whether the business is currently in its free trial
 * @returns Fee breakdown: feePercentage, feeFlat, feeTotal
 */
export async function getPlatformFees(
  amount: number,
  tier: SubscriptionTier,
  isInTrial: boolean,
  overrides?: { feePercentage?: number | null; feeFlat?: number | null },
): Promise<{ feePercentage: number; feeFlat: number; feeTotal: number }> {
  if (isInTrial) {
    return { feePercentage: 0, feeFlat: 0, feeTotal: 0 };
  }

  const settings = await loadPlatformSettings({ useServiceClient: true });
  const tierConfig = settings.pricing_tiers[tier];

  // Use per-business custom overrides if provided, otherwise fall back to tier defaults
  const feePercentage = typeof overrides?.feePercentage === 'number' ? overrides.feePercentage : tierConfig.feePercentage;
  const feeFlat = typeof overrides?.feeFlat === 'number' ? overrides.feeFlat : tierConfig.feeFlat;

  // Waive flat fee on micro-transactions to protect small merchants
  // If flat fee would be more than 10% of the transaction, skip it
  const effectiveFeeFlat = (feeFlat > 0 && amount > 0 && feeFlat / amount > 0.10) ? 0 : feeFlat;
  // Round to 2 decimal places (not to integer) to preserve cent precision.
  // fee_total column is NUMERIC(12,2) — safe for fractional amounts.
  const rawFee = (amount * feePercentage / 100) + effectiveFeeFlat;
  const feeTotal = Number(rawFee.toFixed(2));

  return { feePercentage, feeFlat: effectiveFeeFlat, feeTotal };
}
