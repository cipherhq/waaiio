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
 * Use this in payment paths and other server-side code that has
 * access to a Supabase client.
 *
 * Falls back to time-only check if the credit query fails (e.g., table
 * doesn't exist yet during migration rollout, or in test environments
 * with incomplete mocks).
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
      // Query failed — fall back to time-only check (backward compat)
      return isTrialActive(tier, trialEndsAt, true);
    }

    const hasCredit = (data?.length ?? 0) > 0;
    return isTrialActive(tier, trialEndsAt, hasCredit);
  } catch {
    // Supabase client doesn't support .gt() or table doesn't exist
    // Fall back to time-only check for backward compat
    return isTrialActive(tier, trialEndsAt, true);
  }
}
