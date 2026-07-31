// ═══════════════════════════════════════════════════════
// Capability Policy Resolver
// Pure logic — no DB calls. Safe for server and client contexts.
// ═══════════════════════════════════════════════════════

import {
  type CapabilityId,
  CAPABILITIES,
  CAPABILITY_TIER_REQUIREMENTS,
} from '@/lib/capabilities/types';

// ── Internal types ──────────────────────────────────────

type SubscriptionTier = 'free' | 'growth' | 'business';

const TIER_RANK: Record<SubscriptionTier, number> = {
  free: 0,
  growth: 1,
  business: 2,
};

const VALID_CAPABILITY_IDS: ReadonlySet<string> = new Set(
  CAPABILITIES.map((c) => c.id),
);

function isValidCapabilityId(id: string): id is CapabilityId {
  return VALID_CAPABILITY_IDS.has(id);
}

function isTierSufficient(
  businessTier: SubscriptionTier,
  required: SubscriptionTier,
): boolean {
  return TIER_RANK[businessTier] >= TIER_RANK[required];
}

// ── 1. isTrialActive ────────────────────────────────────

/**
 * Returns true only when the business is on the free tier AND their trial
 * end date is strictly in the future. No grace period.
 */
export function isTrialActive(
  tier: string,
  trialEndsAt: string | Date | null,
): boolean {
  if (tier !== 'free') return false;
  if (trialEndsAt === null || trialEndsAt === undefined) return false;

  const expiresAt =
    trialEndsAt instanceof Date
      ? trialEndsAt.getTime()
      : new Date(trialEndsAt).getTime();

  if (Number.isNaN(expiresAt)) return false;

  return expiresAt > Date.now();
}

// ── 2. getEffectiveCapabilities ─────────────────────────

export interface ConfiguredCapability {
  capability: string;
  is_enabled: boolean;
  sort_order?: number;
}

export interface GetEffectiveCapabilitiesParams {
  configuredCapabilities: ConfiguredCapability[];
  overrides: string[];
  tier: string;
  trialEndsAt: string | Date | null;
}

export interface BlockedCapability {
  capability: CapabilityId;
  reason: string;
}

export interface GetEffectiveCapabilitiesResult {
  effective: CapabilityId[];
  configured: CapabilityId[];
  blocked: BlockedCapability[];
  paused: BlockedCapability[];
}

/**
 * The authoritative capability policy resolver.
 *
 * - configured = every capability with a row (regardless of is_enabled)
 * - effective  = is_enabled=true AND (tier allows OR override OR trial active)
 * - blocked    = is_enabled=true BUT tier blocks AND no override AND trial expired
 * - paused     = identical to blocked
 * - Category defaults are NOT auto-merged for existing configured businesses
 */
export function getEffectiveCapabilities(
  params: GetEffectiveCapabilitiesParams,
): GetEffectiveCapabilitiesResult {
  const { configuredCapabilities, overrides, tier, trialEndsAt } = params;

  const safeTier = (
    tier === 'free' || tier === 'growth' || tier === 'business'
      ? tier
      : 'free'
  ) as SubscriptionTier;

  const trialActive = isTrialActive(tier, trialEndsAt);
  const overrideSet = new Set(overrides);

  const effective: CapabilityId[] = [];
  const configured: CapabilityId[] = [];
  const blocked: BlockedCapability[] = [];

  for (const row of configuredCapabilities) {
    if (!isValidCapabilityId(row.capability)) continue;

    const capId = row.capability as CapabilityId;
    configured.push(capId);

    if (!row.is_enabled) continue;

    const hasOverride = overrideSet.has(capId);
    const required = CAPABILITY_TIER_REQUIREMENTS[capId];
    const tierAllows = isTierSufficient(safeTier, required);

    if (tierAllows || hasOverride || trialActive) {
      effective.push(capId);
    } else {
      const reason =
        safeTier === 'free' && required !== 'free' && trialEndsAt
          ? 'trial_expired'
          : 'tier_required';

      blocked.push({ capability: capId, reason });
    }
  }

  return { effective, configured, blocked, paused: blocked };
}

// ── 3. canModifyCapability ──────────────────────────────

export interface CanModifyCapabilityParams {
  capabilityId: string;
  requestedState: boolean;
  tier: string;
  trialEndsAt: string | Date | null;
  overrides: string[];
}

export interface CanModifyCapabilityResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Write-authorisation check for the capability toggle.
 */
export function canModifyCapability(
  params: CanModifyCapabilityParams,
): CanModifyCapabilityResult {
  const { capabilityId, requestedState, tier, trialEndsAt, overrides } = params;

  if (!isValidCapabilityId(capabilityId)) {
    return { allowed: false, reason: 'unknown_capability' };
  }

  if (!requestedState) {
    return { allowed: true };
  }

  const capId = capabilityId as CapabilityId;
  const required = CAPABILITY_TIER_REQUIREMENTS[capId];

  if (required === 'free') {
    return { allowed: true };
  }

  const safeTier = (
    tier === 'free' || tier === 'growth' || tier === 'business'
      ? tier
      : 'free'
  ) as SubscriptionTier;

  if (isTierSufficient(safeTier, required)) return { allowed: true };
  if (overrides.includes(capId)) return { allowed: true };
  if (isTrialActive(tier, trialEndsAt)) return { allowed: true };

  return { allowed: false, reason: `requires_${required}_tier` };
}

// ── 4. CapabilityAction ─────────────────────────────────

export type CapabilityAction = 'create_new' | 'manage_existing' | 'read_history';

// ── 5. canPerformAction ─────────────────────────────────

export interface CanPerformActionParams {
  action: CapabilityAction;
  capability: CapabilityId;
  effectiveCapabilities: CapabilityId[];
}

export interface CanPerformActionResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Reusable API guard. Ownership/route-level auth is enforced separately.
 */
export function canPerformAction(
  params: CanPerformActionParams,
): CanPerformActionResult {
  const { action, capability, effectiveCapabilities } = params;

  switch (action) {
    case 'create_new': {
      const allowed = effectiveCapabilities.includes(capability);
      return allowed
        ? { allowed: true }
        : { allowed: false, reason: 'capability_not_effective' };
    }
    case 'manage_existing':
    case 'read_history':
      return { allowed: true };
    default: {
      const _exhaustive: never = action;
      return { allowed: false, reason: 'unknown_action' };
    }
  }
}
