/**
 * Bot-side current-capability guard for CREATE_NEW commit points.
 *
 * Uses the same canonical policy resolver as the API guard (api-guard.ts).
 * Must be called immediately before irreversible CREATE_NEW mutations
 * (booking INSERT, order INSERT, payment provider initiation, etc.).
 *
 * Does NOT replace the session-resume revalidation or flow-start guards —
 * those are complementary. This is the final pre-commit check.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { CapabilityId } from '@/lib/capabilities/types';
import {
  type CapabilityAction,
  getEffectiveCapabilities,
  canPerformAction,
} from '@/lib/capabilities/policy';
import { getConfiguredCapabilities } from '@/lib/capabilities/service';
import { getLegacyDefaultCapabilities } from '@/lib/capabilities/legacy-defaults';
import { logger } from '@/lib/logger';

// ── Result types ──

export interface BotCapabilityGuardAllowed {
  allowed: true;
}

export interface BotCapabilityGuardDenied {
  allowed: false;
  reason: string;
  /** Human-readable message suitable for the customer */
  customerMessage: string;
}

export type BotCapabilityGuardResult = BotCapabilityGuardAllowed | BotCapabilityGuardDenied;

/**
 * Verify CURRENT capability entitlement immediately before a CREATE_NEW commit.
 *
 * Loads fresh business state, capability rows, overrides, and resolves via
 * the canonical getEffectiveCapabilities() policy. Fails closed on DB errors.
 *
 * For MANAGE_EXISTING operations (e.g. payment retry on an existing booking),
 * callers should pass action='manage_existing' — those are always allowed.
 */
export async function requireCurrentCapability(
  supabase: SupabaseClient,
  params: {
    businessId: string;
    capability: CapabilityId;
    action: CapabilityAction;
    /** Optional pre-loaded business from the executor context.
     *  When provided, skips the business query (avoids re-query when executor already loaded it). */
    currentBusiness?: { id: string; status?: string; subscription_tier: string; trial_ends_at: string | null; category: string | null };
  },
): Promise<BotCapabilityGuardResult> {
  const { businessId, capability, action } = params;

  // 1. Load current business state (use pre-loaded if available)
  let business = params.currentBusiness as { id: string; status: string; subscription_tier: string; trial_ends_at: string | null; category: string | null } | null;
  if (!business) {
    const { data, error: bizError } = await supabase
      .from('businesses')
      .select('id, status, subscription_tier, trial_ends_at, category')
      .eq('id', businessId)
      .single();

    if (bizError || !data) {
      logger.error('[BOT-GUARD] Business read failed:', bizError?.message);
      return {
        allowed: false,
        reason: 'business_read_error',
        customerMessage: 'We\'re experiencing a temporary issue. Please try again shortly.',
      };
    }
    business = data;
  }

  // 2. Business operational status
  // When currentBusiness is provided from flow executor context, status may not be
  // in the select. Point A (session-resume revalidation) already enforces business
  // status before the executor runs, so we only do the status check here when we
  // performed the fresh DB query ourselves.
  const hasStatus = 'status' in business && business.status !== undefined;
  if (hasStatus) {
    if (business.status === 'suspended') {
      return {
        allowed: false,
        reason: 'business_suspended',
        customerMessage: 'This business is currently unavailable. Please try again later.',
      };
    }

    if (business.status !== 'active' && action === 'create_new') {
      return {
        allowed: false,
        reason: 'business_not_active',
        customerMessage: 'This business is currently unavailable. Please try again later.',
      };
    }
  }

  // 3. Load current configured capabilities
  const capResult = await getConfiguredCapabilities(supabase, businessId);
  if (!capResult.ok) {
    logger.error('[BOT-GUARD] Capability read failed:', capResult.error);
    return {
      allowed: false,
      reason: 'capability_read_error',
      customerMessage: 'We\'re experiencing a temporary issue. Please try again shortly.',
    };
  }

  // 4. Load current overrides
  const { data: overrideRows, error: overrideError } = await supabase
    .from('capability_overrides')
    .select('capability')
    .eq('business_id', businessId);

  if (overrideError) {
    logger.error('[BOT-GUARD] Override read failed:', overrideError.message);
    return {
      allowed: false,
      reason: 'override_read_error',
      customerMessage: 'We\'re experiencing a temporary issue. Please try again shortly.',
    };
  }

  const overrides = (overrideRows || []).map(r => r.capability as string);

  // 5. Zero-row legacy fallback using canonical helper
  let configuredRows = capResult.rows;
  if (configuredRows.length === 0) {
    const defaultCaps = getLegacyDefaultCapabilities(business.category);
    configuredRows = defaultCaps.map((cap, i) => ({
      capability: cap,
      is_enabled: true,
      sort_order: i,
    }));
  }

  // 6. Resolve effective capabilities using canonical policy
  const resolution = getEffectiveCapabilities({
    configuredCapabilities: configuredRows,
    overrides,
    tier: business.subscription_tier || 'free',
    trialEndsAt: business.trial_ends_at,
  });

  // 7. Apply action semantics
  const actionResult = canPerformAction({
    action,
    capability,
    effectiveCapabilities: resolution.effective,
  });

  if (!actionResult.allowed) {
    const blockedEntry = resolution.blocked.find(b => b.capability === capability);
    const detail = blockedEntry?.reason || 'capability_not_effective';
    logger.warn(`[BOT-GUARD] CREATE_NEW denied: capability=${capability} reason=${detail} business=${businessId}`);

    return {
      allowed: false,
      reason: detail,
      customerMessage: 'This service is currently unavailable. Please contact the business owner or try again later.',
    };
  }

  return { allowed: true };
}
