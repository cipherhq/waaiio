// ═══════════════════════════════════════════════════════
// Trial Status Resolver
// Queries messaging_allowances for trial_v2 credit,
// then delegates to isTrialActive() for the dual-condition check.
// ═══════════════════════════════════════════════════════

import type { SupabaseClient } from '@supabase/supabase-js';
import { isTrialActive } from '@/lib/capabilities/policy';

/**
 * Resolves whether a business is in an active trial by checking both
 * the time condition (trial_ends_at) and the credit condition
 * (remaining trial_v2 grant in messaging_allowances).
 *
 * Fails closed: if the credit query fails or throws, returns false.
 * No fallback to time-only check.
 */
export async function resolveTrialStatus(
  supabase: SupabaseClient,
  businessId: string,
  tier: string,
  trialEndsAt: string | null,
): Promise<boolean> {
  // Fast exit: if tier or time already fail, no need to query
  if (tier !== 'free' || !trialEndsAt) return false;

  try {
    const { data, error } = await supabase
      .from('messaging_allowances')
      .select('remaining_minor')
      .eq('business_id', businessId)
      .eq('type', 'trial_grant')
      .eq('source_ref', 'trial_v2')
      .gt('remaining_minor', 0)
      .limit(1);

    if (error) {
      // Query failed — fail closed, no trial access
      return false;
    }

    const hasCredit = (data?.length ?? 0) > 0;
    return isTrialActive(tier, trialEndsAt, hasCredit);
  } catch {
    // DB/network error — fail closed, no trial access
    return false;
  }
}

/**
 * Resolves the canonical trial_v2 credit state for a business.
 * Returns true if the business has a trial_v2 grant with remaining_minor > 0.
 * Fails closed: returns false on any DB/query error.
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
