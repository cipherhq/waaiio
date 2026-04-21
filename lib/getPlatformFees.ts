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
): Promise<{ feePercentage: number; feeFlat: number; feeTotal: number }> {
  if (isInTrial) {
    return { feePercentage: 0, feeFlat: 0, feeTotal: 0 };
  }

  const settings = await loadPlatformSettings({ useServiceClient: true });
  const tierConfig = settings.pricing_tiers[tier];

  const feePercentage = tierConfig.feePercentage;
  const feeFlat = tierConfig.feeFlat;
  const feeTotal = Math.round(amount * feePercentage / 100) + feeFlat;

  return { feePercentage, feeFlat, feeTotal };
}
