/**
 * Server-side capability action guard for API routes.
 *
 * Enforces the CapabilityAction contract at the API boundary:
 * - create_new: requires capability to be currently EFFECTIVE
 * - manage_existing: allowed even when paused (for existing obligations)
 * - read_history: always allowed (history is never hidden by pause)
 *
 * The server route hard-codes capability + action. Clients cannot override.
 *
 * Usage:
 *   const guard = await requireCapability(supabase, service, {
 *     businessId, userId, capability: 'scheduling', action: 'create_new',
 *   });
 *   if (!guard.allowed) return NextResponse.json(guard.denial, { status: guard.status });
 *   // proceed with the operation
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { CapabilityId } from '@/lib/capabilities/types';
import {
  type CapabilityAction,
  getEffectiveCapabilities,
  canPerformAction,
  type GetEffectiveCapabilitiesResult,
} from '@/lib/capabilities/policy';
import { getConfiguredCapabilities } from '@/lib/capabilities/service';
import { getCategoryDefaultCapabilities } from '@/lib/categoryConfig';
import { CATEGORY_DEFAULT_CAPABILITIES } from '@/lib/capabilities/types';

// ── Result types ──

export interface CapabilityGuardAllowed {
  allowed: true;
  business: { id: string; status: string; subscription_tier: string; trial_ends_at: string | null; category: string | null };
  resolution: GetEffectiveCapabilitiesResult;
}

export interface CapabilityGuardDenied {
  allowed: false;
  status: number;
  denial: {
    success: false;
    reason: string;
    detail?: string;
    capability?: string;
    action?: string;
  };
}

export type CapabilityGuardResult = CapabilityGuardAllowed | CapabilityGuardDenied;

// ── Guard implementation ──

export async function requireCapability(
  supabase: SupabaseClient,
  service: SupabaseClient,
  params: {
    businessId: string;
    userId: string;
    capability: CapabilityId;
    action: CapabilityAction;
  },
): Promise<CapabilityGuardResult> {
  const { businessId, userId, capability, action } = params;

  // 1. Verify business ownership via authenticated client (RLS-aware)
  const { data: business, error: bizError } = await supabase
    .from('businesses')
    .select('id, status, subscription_tier, trial_ends_at, category')
    .eq('id', businessId)
    .eq('owner_id', userId)
    .maybeSingle();

  if (bizError) {
    return {
      allowed: false,
      status: 500,
      denial: { success: false, reason: 'authorization_error' },
    };
  }

  if (!business) {
    return {
      allowed: false,
      status: 403,
      denial: { success: false, reason: 'business_not_found' },
    };
  }

  if (business.status === 'suspended') {
    return {
      allowed: false,
      status: 403,
      denial: { success: false, reason: 'business_suspended' },
    };
  }

  // 2. Load capability rows via service client (bypasses RLS for server reads)
  const capResult = await getConfiguredCapabilities(service, businessId);
  if (!capResult.ok) {
    // DB failure — fail closed
    return {
      allowed: false,
      status: 500,
      denial: { success: false, reason: 'capability_read_error' },
    };
  }

  // 3. Load overrides via service client
  const { data: overrideRows, error: overrideError } = await service
    .from('capability_overrides')
    .select('capability')
    .eq('business_id', businessId);

  if (overrideError) {
    return {
      allowed: false,
      status: 500,
      denial: { success: false, reason: 'override_read_error' },
    };
  }

  const overrides = (overrideRows || []).map(r => r.capability as string);

  // 4. Handle zero-row legacy businesses consistently with bot/dashboard
  let configuredRows = capResult.rows;
  if (configuredRows.length === 0) {
    // Legacy business without explicit configuration.
    // Match the bot/dashboard behavior: use category defaults as implicitly enabled.
    const category = business.category;
    let defaultCaps: string[] = [];
    if (category) {
      const dbCaps = getCategoryDefaultCapabilities(category);
      defaultCaps = dbCaps || CATEGORY_DEFAULT_CAPABILITIES[category] || ['scheduling'];
    } else {
      defaultCaps = ['scheduling'];
    }
    // Synthesize capability rows as if they were explicitly enabled
    configuredRows = defaultCaps.map((cap, i) => ({
      capability: cap,
      is_enabled: true,
      sort_order: i,
    }));
  }

  // 5. Resolve effective capabilities using the authoritative policy
  const resolution = getEffectiveCapabilities({
    configuredCapabilities: configuredRows,
    overrides,
    tier: business.subscription_tier || 'free',
    trialEndsAt: business.trial_ends_at,
  });

  // 6. Check action permission
  const actionResult = canPerformAction({
    action,
    capability,
    effectiveCapabilities: resolution.effective,
  });

  if (!actionResult.allowed) {
    // Determine helpful detail for client
    const isSelected = resolution.selected.includes(capability);
    const blockedEntry = resolution.blocked.find(b => b.capability === capability);

    let detail = 'capability_not_configured';
    if (isSelected && blockedEntry) {
      detail = blockedEntry.reason; // 'trial_expired' or 'tier_required'
    } else if (isSelected) {
      detail = 'capability_paused';
    }

    return {
      allowed: false,
      status: 403,
      denial: {
        success: false,
        reason: actionResult.reason || 'capability_not_effective',
        detail,
        capability,
        action,
      },
    };
  }

  return {
    allowed: true,
    business,
    resolution,
  };
}
