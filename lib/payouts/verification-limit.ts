import { type SupabaseClient } from '@supabase/supabase-js';
import { getVerificationTiers, type CountryCode, type VerificationLevel } from '@/lib/constants';
import { loadCountries } from '@/lib/countries';
import { logger } from '@/lib/logger';

export interface VerificationLimitResult {
  allowed: boolean;
  /** Limit in minor currency units (kobo/cents/pesewas) */
  limit: number;
  /** Amount already used this month in minor units */
  used: number;
  /** Remaining capacity in minor units */
  remaining: number;
  reason?: string;
}

/**
 * Check whether a business can receive a payout of `payoutAmountMinor`
 * without exceeding its monthly verification-tier limit.
 *
 * All amounts are in minor currency units (kobo, cents, pesewas).
 * Tier limits from countries.verification_tiers are in MAJOR units
 * and are converted to minor (×100) internally.
 *
 * The monthly total includes payouts with status: approved, processing, paid.
 * The current payout (if it already has a DB row) is excluded via `excludePayoutId`.
 *
 * Concurrency note: this is a read-only check. Two concurrent approvals for
 * different payouts of the same business could both pass. This is acceptable
 * because: (a) admin payout approval requires per-payout step-up authorization,
 * making simultaneous approvals impractical; (b) the claim_payout_for_transfer
 * RPC provides atomic single-winner for the same payout; (c) auto-payout runs
 * sequentially per business. If stricter enforcement is needed later, add a
 * SELECT ... FOR UPDATE on the business row inside a transaction.
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

  // Ensure DB-backed countries cache is populated for getVerificationTiers
  await loadCountries().catch(() => {});

  const tiers = getVerificationTiers(cc);
  const tierEntry = tiers[level];

  // No tier entry → payouts held
  if (!tierEntry) {
    return { allowed: false, limit: 0, used: 0, remaining: 0, reason: `No verification tier for level "${level}"` };
  }

  const limitMajor = tierEntry.limit;

  // Limit of 0 → payouts held
  if (limitMajor === 0) {
    return { allowed: false, limit: 0, used: 0, remaining: 0, reason: 'Verification level does not allow payouts' };
  }

  // Unlimited (999_999_999+ in major units)
  if (limitMajor >= 999_999_999) {
    return { allowed: true, limit: limitMajor, used: 0, remaining: limitMajor };
  }

  // Convert major-unit limit to minor units (kobo/cents/pesewas)
  const limitMinor = Math.round(limitMajor * 100);

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

  // net_amount is stored in major units → convert to minor
  const usedMinor = (payouts || []).reduce((sum, p) => sum + Math.round(Number(p.net_amount) * 100), 0);
  const remaining = limitMinor - usedMinor;
  const wouldExceed = usedMinor + payoutAmountMinor > limitMinor;

  if (wouldExceed) {
    return {
      allowed: false,
      limit: limitMinor,
      used: usedMinor,
      remaining: Math.max(0, remaining),
      reason: `Monthly payout limit exceeded: used ${usedMinor} + requested ${payoutAmountMinor} > limit ${limitMinor}`,
    };
  }

  return { allowed: true, limit: limitMinor, used: usedMinor, remaining: remaining - payoutAmountMinor };
}
