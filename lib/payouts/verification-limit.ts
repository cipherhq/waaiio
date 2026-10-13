import { type SupabaseClient } from '@supabase/supabase-js';
import { getVerificationTiers, type CountryCode, type VerificationLevel } from '@/lib/constants';

export interface VerificationLimitResult {
  allowed: boolean;
  limit: number;
  used: number;
  remaining: number;
  reason?: string;
}

/**
 * Check whether a business can receive a payout of `payoutAmountMinor`
 * without exceeding its monthly verification-tier limit.
 *
 * All amounts are in minor currency units (kobo, cents, pesewas).
 *
 * The monthly total includes payouts with status: approved, processing, paid.
 * The current payout (if it already has a DB row) is excluded via `excludePayoutId`.
 */
export async function checkVerificationLimit(
  supabase: SupabaseClient,
  businessId: string,
  payoutAmountMinor: number,
  excludePayoutId?: string,
): Promise<VerificationLimitResult> {
  // 1. Load business verification level and country
  const { data: biz } = await supabase
    .from('businesses')
    .select('verification_level, payout_limit_monthly, country_code')
    .eq('id', businessId)
    .single();

  if (!biz) {
    return { allowed: false, limit: 0, used: 0, remaining: 0, reason: 'Business not found' };
  }

  const level = (biz.verification_level || 'unverified') as VerificationLevel;
  const cc = (biz.country_code || 'NG') as CountryCode;
  const tiers = getVerificationTiers(cc);
  const tierEntry = tiers[level];

  // No tier entry → payouts held
  if (!tierEntry) {
    return { allowed: false, limit: 0, used: 0, remaining: 0, reason: `No verification tier for level "${level}"` };
  }

  const limit = tierEntry.limit;

  // Limit of 0 → payouts held
  if (limit === 0) {
    return { allowed: false, limit: 0, used: 0, remaining: 0, reason: 'Verification level does not allow payouts' };
  }

  // Unlimited (999999999+)
  if (limit >= 999_999_999) {
    return { allowed: true, limit, used: 0, remaining: limit };
  }

  // 2. Sum this month's approved + processing + paid payouts for the business
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

  let query = supabase
    .from('business_payouts')
    .select('net_amount')
    .eq('business_id', businessId)
    .in('status', ['approved', 'processing', 'paid'])
    .gte('created_at', monthStart);

  if (excludePayoutId) {
    query = query.neq('id', excludePayoutId);
  }

  const { data: payouts } = await query;

  // Convert to minor units — net_amount is stored as a numeric (major units)
  const usedMinor = (payouts || []).reduce((sum, p) => sum + Math.round(Number(p.net_amount) * 100), 0);
  const remaining = limit - usedMinor;
  const wouldExceed = usedMinor + payoutAmountMinor > limit;

  if (wouldExceed) {
    return {
      allowed: false,
      limit,
      used: usedMinor,
      remaining: Math.max(0, remaining),
      reason: `Monthly payout limit exceeded: used ${usedMinor} + requested ${payoutAmountMinor} > limit ${limit}`,
    };
  }

  return { allowed: true, limit, used: usedMinor, remaining: remaining - payoutAmountMinor };
}
