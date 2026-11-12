// ═══════════════════════════════════════════════════════
// Trial Status Resolver
//
// Owner decision 2026-11-08: the 14-day free trial is for Pro and Premium
// features. It starts at sign-up (businesses.feature_trial_ends_at, set by
// the M525 insert trigger) and is independent of the free messaging credit
// (trial_v2 grant, businesses.trial_ends_at). The trial never waives the
// Waaiio fee.
// ═══════════════════════════════════════════════════════

import type { SupabaseClient } from '@supabase/supabase-js';
import { getLimitTier, isTrialActive } from '@/lib/capabilities/policy';

type LimitTier = 'free' | 'growth' | 'business';

/**
 * Reads the feature-trial clock (businesses.feature_trial_ends_at).
 * Fails closed: returns null (no trial) on any DB/query error.
 */
export async function resolveFeatureTrialEndsAt(
  supabase: SupabaseClient,
  businessId: string,
): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .from('businesses')
      .select('feature_trial_ends_at')
      .eq('id', businessId)
      .maybeSingle();
    if (error || !data) return null;
    return (data as { feature_trial_ends_at?: string | null }).feature_trial_ends_at ?? null;
  } catch {
    return null;
  }
}

/**
 * Whether the business is inside its Pro/Premium feature trial right now.
 * Only Starter ('free') businesses are in a trial. Fails closed.
 *
 * For fee callers this value is recorded on the fee basis (`is_in_trial`)
 * for reporting only. It never changes the fee.
 */
export async function resolveTrialStatus(
  supabase: SupabaseClient,
  businessId: string,
  tier: string,
): Promise<boolean> {
  if (tier !== 'free') return false;
  const endsAt = await resolveFeatureTrialEndsAt(supabase, businessId);
  return isTrialActive(tier, endsAt);
}

/**
 * The tier whose usage limits apply. During the feature trial a Starter
 * business uses Premium ('business') limits; otherwise its own tier.
 * Fails closed to the business's own tier.
 */
export async function resolveLimitTier(
  supabase: SupabaseClient,
  businessId: string,
  tier: string | null | undefined,
): Promise<LimitTier> {
  if (tier === 'growth' || tier === 'business') return tier;
  return getLimitTier('free', await resolveFeatureTrialEndsAt(supabase, businessId));
}

/**
 * Resolves the canonical trial_v2 messaging-credit state for a business.
 * Returns true if the business has a trial_v2 grant with remaining_minor > 0.
 * Fails closed: returns false on any DB/query error.
 *
 * This is the free messaging credit (#955). It does not affect capabilities,
 * limits or fees.
 */
export async function resolveTrialCredit(
  supabase: SupabaseClient,
  businessId: string,
): Promise<boolean> {
  try {
    const { data, error } = await supabase
      .from('messaging_allowances')
      .select('remaining_minor')
      .eq('business_id', businessId)
      .eq('type', 'trial_grant')
      .eq('source_ref', 'trial_v2')
      .gt('remaining_minor', 0)
      .limit(1);

    if (error) return false;
    return (data?.length ?? 0) > 0;
  } catch {
    return false;
  }
}
