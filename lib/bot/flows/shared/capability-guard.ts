/**
 * Bot-side current-capability guard for CREATE_NEW commit points.
 *
 * Uses the same canonical policy resolver as the API guard (api-guard.ts).
 * Must be called immediately before irreversible CREATE_NEW mutations
 * (booking INSERT, order INSERT, payment provider initiation, etc.).
 *
 * Does NOT replace the session-resume revalidation or flow-start guards —
 * those are complementary. This is the final pre-commit check.
 *
 * For CREATE_NEW: always queries CURRENT business state from the database.
 * Does not accept stale/pre-loaded business data for authorization.
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
  /** CAS-005: Recovery status — caller must obey 'stale' by not responding */
  recoveryStatus?: 'persisted' | 'stale' | 'not_attempted';
}

export type BotCapabilityGuardResult = BotCapabilityGuardAllowed | BotCapabilityGuardDenied;

/**
 * Verify CURRENT capability entitlement immediately before a protected operation.
 *
 * Always loads fresh business state, capability rows, and overrides from the
 * database. Resolves via the canonical getEffectiveCapabilities() policy.
 * Fails closed on DB errors.
 *
 * For MANAGE_EXISTING operations (e.g. payment retry on an existing booking),
 * callers should pass action='manage_existing' — those are always allowed
 * provided the business is not suspended.
 */
export async function requireCurrentCapability(
  supabase: SupabaseClient,
  params: {
    businessId: string;
    capability: CapabilityId;
    action: CapabilityAction;
    /** CAS-005: Session context for recovery on denial */
    session?: { id: string; version: number; session_data: Record<string, unknown> };
  },
): Promise<BotCapabilityGuardResult> {
  const { businessId, capability, action } = params;

  // 1. Load CURRENT business state — always fresh from DB
  const { data: business, error: bizError } = await supabase
    .from('businesses')
    .select('id, status, subscription_tier, trial_ends_at, category')
    .eq('id', businessId)
    .single();

  if (bizError || !business) {
    logger.error('[BOT-GUARD] Business read failed:', bizError?.message);
    return {
      allowed: false,
      reason: 'business_read_error',
      customerMessage: 'We\'re experiencing a temporary issue. Please try again shortly.',
    };
  }

  // 2. Business operational status
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

  // 3. Load CURRENT configured capabilities
  const capResult = await getConfiguredCapabilities(supabase, businessId);
  if (!capResult.ok) {
    logger.error('[BOT-GUARD] Capability read failed:', capResult.error);
    return {
      allowed: false,
      reason: 'capability_read_error',
      customerMessage: 'We\'re experiencing a temporary issue. Please try again shortly.',
    };
  }

  // 4. Load CURRENT overrides
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
    logger.warn(`[BOT-GUARD] ${action} denied: capability=${capability} reason=${detail} business=${businessId}`);

    // CAS-005: Build recovery message + recover session if available
    const { buildCapabilityRecoveryMessage, recoverFromRevokedCapability, replaceSessionDataContents } = await import('@/lib/bot/capability-recovery');
    const { getUserFacingCapabilities } = await import('@/lib/bot/handlers/flow-routing');
    const ufCaps = getUserFacingCapabilities(resolution.effective);
    const customerMessage = buildCapabilityRecoveryMessage(
      capability, ufCaps, business.category || 'other',
    );

    // CAS-005: If session context provided, attempt CAS recovery
    let recoveryStatus: 'persisted' | 'stale' | 'not_attempted' = 'not_attempted';
    if (params.session && action === 'create_new') {
      // Clone session data — do NOT mutate caller's in-memory state before CAS success
      const clonedData = JSON.parse(JSON.stringify(params.session.session_data));
      const recoveryResult = await recoverFromRevokedCapability({
        supabase, sessionId: params.session.id, sessionVersion: params.session.version,
        sessionData: clonedData, // operates on clone
        revokedCapability: capability,
        effectiveCapabilities: resolution.effective,
        businessCategory: business.category || 'other',
      });
      if (recoveryResult.success) {
        // CAS succeeded — replace caller's in-memory state (deletes removed keys)
        replaceSessionDataContents(params.session.session_data, clonedData);
        recoveryStatus = 'persisted';
      } else {
        // CAS failed (conflict or error) — caller must NOT respond
        recoveryStatus = 'stale';
      }
    }

    return {
      allowed: false,
      reason: detail,
      customerMessage,
      recoveryStatus,
    };
  }

  return { allowed: true };
}
