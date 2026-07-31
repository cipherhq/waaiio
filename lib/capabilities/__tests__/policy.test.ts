import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  isTrialActive,
  getEffectiveCapabilities,
  canModifyCapability,
  canPerformAction,
} from '@/lib/capabilities/policy';

// ── Helpers ─────────────────────────────────────────────

const futureDate = new Date(Date.now() + 86400000).toISOString(); // +1 day
const pastDate = new Date(Date.now() - 86400000).toISOString();   // -1 day
const nowMs = Date.now();

function makeRows(...caps: Array<[string, boolean]>) {
  return caps.map(([capability, is_enabled], i) => ({
    capability,
    is_enabled,
    sort_order: i,
  }));
}

// ══════════════════════════════════════════════════════════
// isTrialActive
// ══════════════════════════════════════════════════════════

describe('isTrialActive', () => {
  it('returns true for free tier with future trial_ends_at', () => {
    expect(isTrialActive('free', futureDate)).toBe(true);
  });

  it('returns false for free tier with past trial_ends_at', () => {
    expect(isTrialActive('free', pastDate)).toBe(false);
  });

  it('returns false for growth tier even with future trial', () => {
    expect(isTrialActive('growth', futureDate)).toBe(false);
  });

  it('returns false for business tier even with future trial', () => {
    expect(isTrialActive('business', futureDate)).toBe(false);
  });

  it('returns false for null trial_ends_at', () => {
    expect(isTrialActive('free', null)).toBe(false);
  });

  it('returns false for invalid date string', () => {
    expect(isTrialActive('free', 'not-a-date')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isTrialActive('free', '')).toBe(false);
  });

  it('accepts Date objects', () => {
    expect(isTrialActive('free', new Date(Date.now() + 10000))).toBe(true);
    expect(isTrialActive('free', new Date(Date.now() - 10000))).toBe(false);
  });

  it('returns false for unknown tier', () => {
    expect(isTrialActive('premium', futureDate)).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════
// getEffectiveCapabilities — policy matrix
// ══════════════════════════════════════════════════════════

describe('getEffectiveCapabilities', () => {
  // 1. Free tier, no trial
  it('free tier, no trial — only free capabilities are effective', () => {
    const result = getEffectiveCapabilities({
      configuredCapabilities: makeRows(
        ['scheduling', true],
        ['appointment', true],
        ['reservation', true],  // growth
        ['staff', true],        // business
      ),
      overrides: [],
      tier: 'free',
      trialEndsAt: pastDate,
    });

    expect(result.effective).toEqual(['scheduling', 'appointment']);
    expect(result.blocked).toEqual([
      { capability: 'reservation', reason: 'trial_expired' },
      { capability: 'staff', reason: 'trial_expired' },
    ]);
    expect(result.configured).toEqual(['scheduling', 'appointment', 'reservation', 'staff']);
  });

  // 2. Free tier, active trial
  it('free tier, active trial — all enabled capabilities are effective', () => {
    const result = getEffectiveCapabilities({
      configuredCapabilities: makeRows(
        ['scheduling', true],
        ['reservation', true],
        ['staff', true],
      ),
      overrides: [],
      tier: 'free',
      trialEndsAt: futureDate,
    });

    expect(result.effective).toEqual(['scheduling', 'reservation', 'staff']);
    expect(result.blocked).toEqual([]);
  });

  // 3. Free tier, trial expired
  it('free tier, trial expired — growth/business capabilities blocked', () => {
    const result = getEffectiveCapabilities({
      configuredCapabilities: makeRows(
        ['scheduling', true],
        ['broadcast', true],   // growth
        ['crowdfunding', true], // business
      ),
      overrides: [],
      tier: 'free',
      trialEndsAt: pastDate,
    });

    expect(result.effective).toEqual(['scheduling']);
    expect(result.blocked).toHaveLength(2);
    expect(result.blocked[0].reason).toBe('trial_expired');
  });

  // 4. Growth tier
  it('growth tier — free and growth capabilities effective', () => {
    const result = getEffectiveCapabilities({
      configuredCapabilities: makeRows(
        ['scheduling', true],
        ['reservation', true],
        ['staff', true],        // business
      ),
      overrides: [],
      tier: 'growth',
      trialEndsAt: null,
    });

    expect(result.effective).toEqual(['scheduling', 'reservation']);
    expect(result.blocked).toEqual([
      { capability: 'staff', reason: 'tier_required' },
    ]);
  });

  // 5. Business tier
  it('business tier — all capabilities effective', () => {
    const result = getEffectiveCapabilities({
      configuredCapabilities: makeRows(
        ['scheduling', true],
        ['reservation', true],
        ['staff', true],
      ),
      overrides: [],
      tier: 'business',
      trialEndsAt: null,
    });

    expect(result.effective).toEqual(['scheduling', 'reservation', 'staff']);
    expect(result.blocked).toEqual([]);
  });

  // 6. Explicitly disabled capability
  it('explicitly disabled capability is configured but not effective or blocked', () => {
    const result = getEffectiveCapabilities({
      configuredCapabilities: makeRows(
        ['scheduling', true],
        ['appointment', false], // explicitly disabled
      ),
      overrides: [],
      tier: 'free',
      trialEndsAt: null,
    });

    expect(result.effective).toEqual(['scheduling']);
    expect(result.configured).toEqual(['scheduling', 'appointment']);
    expect(result.blocked).toEqual([]);
  });

  // 7. Admin override
  it('admin override allows a growth capability on free tier', () => {
    const result = getEffectiveCapabilities({
      configuredCapabilities: makeRows(
        ['scheduling', true],
        ['reservation', true],
      ),
      overrides: ['reservation'],
      tier: 'free',
      trialEndsAt: pastDate,
    });

    expect(result.effective).toEqual(['scheduling', 'reservation']);
    expect(result.blocked).toEqual([]);
  });

  // 8. Newly added category default for existing business
  it('does NOT auto-merge missing category defaults', () => {
    const result = getEffectiveCapabilities({
      configuredCapabilities: makeRows(
        ['scheduling', true],
      ),
      overrides: [],
      tier: 'free',
      trialEndsAt: null,
    });

    // Only 'scheduling' — no auto-merged defaults
    expect(result.effective).toEqual(['scheduling']);
    expect(result.configured).toEqual(['scheduling']);
  });

  // 9. New business (tested via onboarding — rows present)
  it('new business with all onboarding defaults enabled', () => {
    const result = getEffectiveCapabilities({
      configuredCapabilities: makeRows(
        ['scheduling', true],
        ['payment', true],
        ['chat', true],
        ['feedback', true],
      ),
      overrides: [],
      tier: 'free',
      trialEndsAt: futureDate,
    });

    expect(result.effective).toEqual(['scheduling', 'payment', 'chat', 'feedback']);
  });

  // 10. Empty rows (legacy zero-row business)
  it('empty configured capabilities returns empty effective', () => {
    const result = getEffectiveCapabilities({
      configuredCapabilities: [],
      overrides: [],
      tier: 'free',
      trialEndsAt: null,
    });

    expect(result.effective).toEqual([]);
    expect(result.configured).toEqual([]);
    expect(result.blocked).toEqual([]);
  });

  // 11. Setup-incomplete business (same as empty — no rows yet)
  it('setup-incomplete business returns empty effective', () => {
    const result = getEffectiveCapabilities({
      configuredCapabilities: [],
      overrides: [],
      tier: 'free',
      trialEndsAt: futureDate,
    });

    expect(result.effective).toEqual([]);
  });

  // 12. Upgrade after expired trial restores access
  it('upgrade from free to growth restores growth capabilities', () => {
    const result = getEffectiveCapabilities({
      configuredCapabilities: makeRows(
        ['scheduling', true],
        ['reservation', true],
        ['broadcast', true],
      ),
      overrides: [],
      tier: 'growth',
      trialEndsAt: pastDate,
    });

    expect(result.effective).toEqual(['scheduling', 'reservation', 'broadcast']);
    expect(result.blocked).toEqual([]);
  });

  // paused = blocked reference
  it('paused is identical to blocked', () => {
    const result = getEffectiveCapabilities({
      configuredCapabilities: makeRows(['reservation', true]),
      overrides: [],
      tier: 'free',
      trialEndsAt: pastDate,
    });

    expect(result.paused).toBe(result.blocked);
    expect(result.paused).toHaveLength(1);
  });

  // Unknown capability IDs are silently skipped
  it('skips unknown capability IDs', () => {
    const result = getEffectiveCapabilities({
      configuredCapabilities: [
        { capability: 'scheduling', is_enabled: true },
        { capability: 'nonexistent_cap', is_enabled: true },
      ],
      overrides: [],
      tier: 'free',
      trialEndsAt: null,
    });

    expect(result.effective).toEqual(['scheduling']);
    expect(result.configured).toEqual(['scheduling']);
  });
});

// ══════════════════════════════════════════════════════════
// canModifyCapability
// ══════════════════════════════════════════════════════════

describe('canModifyCapability', () => {
  it('allows disabling any capability', () => {
    expect(canModifyCapability({
      capabilityId: 'staff',
      requestedState: false,
      tier: 'free',
      trialEndsAt: null,
      overrides: [],
    })).toEqual({ allowed: true });
  });

  it('allows enabling free-tier capability', () => {
    expect(canModifyCapability({
      capabilityId: 'scheduling',
      requestedState: true,
      tier: 'free',
      trialEndsAt: null,
      overrides: [],
    })).toEqual({ allowed: true });
  });

  it('blocks enabling growth capability on free tier without trial', () => {
    const result = canModifyCapability({
      capabilityId: 'reservation',
      requestedState: true,
      tier: 'free',
      trialEndsAt: pastDate,
      overrides: [],
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('requires_growth_tier');
  });

  it('allows enabling growth capability during trial', () => {
    expect(canModifyCapability({
      capabilityId: 'reservation',
      requestedState: true,
      tier: 'free',
      trialEndsAt: futureDate,
      overrides: [],
    })).toEqual({ allowed: true });
  });

  it('allows enabling growth capability on growth tier', () => {
    expect(canModifyCapability({
      capabilityId: 'reservation',
      requestedState: true,
      tier: 'growth',
      trialEndsAt: null,
      overrides: [],
    })).toEqual({ allowed: true });
  });

  it('allows enabling with admin override', () => {
    expect(canModifyCapability({
      capabilityId: 'staff',
      requestedState: true,
      tier: 'free',
      trialEndsAt: pastDate,
      overrides: ['staff'],
    })).toEqual({ allowed: true });
  });

  it('blocks unknown capability', () => {
    const result = canModifyCapability({
      capabilityId: 'fake_cap',
      requestedState: true,
      tier: 'business',
      trialEndsAt: null,
      overrides: [],
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('unknown_capability');
  });

  it('blocks business capability on growth tier', () => {
    const result = canModifyCapability({
      capabilityId: 'staff',
      requestedState: true,
      tier: 'growth',
      trialEndsAt: null,
      overrides: [],
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('requires_business_tier');
  });
});

// ══════════════════════════════════════════════════════════
// canPerformAction
// ══════════════════════════════════════════════════════════

describe('canPerformAction', () => {
  const effective = ['scheduling', 'payment'] as any[];

  it('allows create_new for effective capability', () => {
    expect(canPerformAction({
      action: 'create_new',
      capability: 'scheduling',
      effectiveCapabilities: effective,
    })).toEqual({ allowed: true });
  });

  it('blocks create_new for non-effective capability', () => {
    const result = canPerformAction({
      action: 'create_new',
      capability: 'reservation',
      effectiveCapabilities: effective,
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('capability_not_effective');
  });

  it('allows manage_existing regardless of effective set', () => {
    expect(canPerformAction({
      action: 'manage_existing',
      capability: 'reservation',
      effectiveCapabilities: effective,
    })).toEqual({ allowed: true });
  });

  it('allows read_history regardless of effective set', () => {
    expect(canPerformAction({
      action: 'read_history',
      capability: 'reservation',
      effectiveCapabilities: effective,
    })).toEqual({ allowed: true });
  });
});

// ══════════════════════════════════════════════════════════
// Legacy zero-row eligibility through policy
// ══════════════════════════════════════════════════════════

describe('legacy zero-row through policy', () => {
  // Simulate what dashboard/bot do: convert legacy defaults to ConfiguredCapability[]
  // then run through getEffectiveCapabilities

  function makeLegacyRows(...caps: string[]) {
    return caps.map(cap => ({ capability: cap, is_enabled: true, sort_order: 0 }));
  }

  const pastDate = new Date(Date.now() - 86400000).toISOString();
  const futureDate = new Date(Date.now() + 86400000).toISOString();

  it('free tier, expired trial — growth defaults blocked', () => {
    const legacyDefaults = ['scheduling', 'appointment', 'reservation', 'broadcast'];
    const result = getEffectiveCapabilities({
      configuredCapabilities: makeLegacyRows(...legacyDefaults),
      overrides: [],
      tier: 'free',
      trialEndsAt: pastDate,
    });
    expect(result.effective).toEqual(['scheduling', 'appointment']);
    expect(result.blocked.map(b => b.capability)).toEqual(['reservation', 'broadcast']);
  });

  it('free tier, active trial — all defaults effective', () => {
    const legacyDefaults = ['scheduling', 'appointment', 'reservation', 'staff'];
    const result = getEffectiveCapabilities({
      configuredCapabilities: makeLegacyRows(...legacyDefaults),
      overrides: [],
      tier: 'free',
      trialEndsAt: futureDate,
    });
    expect(result.effective).toEqual(['scheduling', 'appointment', 'reservation', 'staff']);
    expect(result.blocked).toEqual([]);
  });

  it('growth tier — growth defaults effective, business defaults blocked', () => {
    const legacyDefaults = ['scheduling', 'reservation', 'staff'];
    const result = getEffectiveCapabilities({
      configuredCapabilities: makeLegacyRows(...legacyDefaults),
      overrides: [],
      tier: 'growth',
      trialEndsAt: null,
    });
    expect(result.effective).toEqual(['scheduling', 'reservation']);
    expect(result.blocked).toEqual([{ capability: 'staff', reason: 'tier_required' }]);
  });

  it('business tier — all defaults effective', () => {
    const legacyDefaults = ['scheduling', 'reservation', 'staff', 'crowdfunding'];
    const result = getEffectiveCapabilities({
      configuredCapabilities: makeLegacyRows(...legacyDefaults),
      overrides: [],
      tier: 'business',
      trialEndsAt: null,
    });
    expect(result.effective).toEqual(['scheduling', 'reservation', 'staff', 'crowdfunding']);
  });

  it('free tier, no trial, with override — override bypasses tier', () => {
    const legacyDefaults = ['scheduling', 'reservation'];
    const result = getEffectiveCapabilities({
      configuredCapabilities: makeLegacyRows(...legacyDefaults),
      overrides: ['reservation'],
      tier: 'free',
      trialEndsAt: null,
    });
    expect(result.effective).toEqual(['scheduling', 'reservation']);
  });
});

// ══════════════════════════════════════════════════════════
// Dependency enforcement
// ══════════════════════════════════════════════════════════

import { getMissingDependencies, getDependents } from '@/lib/capabilities/dependencies';

describe('capability dependencies', () => {
  it('membership requires loyalty', () => {
    const missing = getMissingDependencies('membership', ['scheduling']);
    expect(missing).toEqual(['loyalty']);
  });

  it('membership with loyalty present has no missing deps', () => {
    const missing = getMissingDependencies('membership', ['scheduling', 'loyalty']);
    expect(missing).toEqual([]);
  });

  it('scheduling has no dependencies', () => {
    const missing = getMissingDependencies('scheduling', []);
    expect(missing).toEqual([]);
  });

  it('disabling loyalty warns about membership', () => {
    const deps = getDependents('loyalty', ['scheduling', 'loyalty', 'membership']);
    expect(deps).toEqual(['membership']);
  });

  it('disabling loyalty when membership is not enabled returns empty', () => {
    const deps = getDependents('loyalty', ['scheduling', 'loyalty']);
    expect(deps).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════
// Downgrade preservation and upgrade restoration
// ══════════════════════════════════════════════════════════

describe('downgrade preservation', () => {
  const pastDate = new Date(Date.now() - 86400000).toISOString();

  it('paid capability remains configured after downgrade to free', () => {
    // Step 1: business has reservation configured and enabled on growth tier
    const beforeDowngrade = getEffectiveCapabilities({
      configuredCapabilities: [
        { capability: 'scheduling', is_enabled: true, sort_order: 0 },
        { capability: 'reservation', is_enabled: true, sort_order: 1 },
      ],
      overrides: [],
      tier: 'growth',
      trialEndsAt: null,
    });
    expect(beforeDowngrade.effective).toContain('reservation');

    // Step 2: tier changes to free — row stays is_enabled=true (no mutation)
    const afterDowngrade = getEffectiveCapabilities({
      configuredCapabilities: [
        { capability: 'scheduling', is_enabled: true, sort_order: 0 },
        { capability: 'reservation', is_enabled: true, sort_order: 1 }, // row unchanged!
      ],
      overrides: [],
      tier: 'free',
      trialEndsAt: pastDate,
    });
    expect(afterDowngrade.effective).toEqual(['scheduling']);
    expect(afterDowngrade.configured).toContain('reservation');
    expect(afterDowngrade.blocked.map(b => b.capability)).toContain('reservation');
    expect(afterDowngrade.blocked.find(b => b.capability === 'reservation')?.reason).toBe('trial_expired');

    // Step 3: later upgrade back to growth — access restored automatically
    const afterUpgrade = getEffectiveCapabilities({
      configuredCapabilities: [
        { capability: 'scheduling', is_enabled: true, sort_order: 0 },
        { capability: 'reservation', is_enabled: true, sort_order: 1 }, // row still unchanged!
      ],
      overrides: [],
      tier: 'growth',
      trialEndsAt: null,
    });
    expect(afterUpgrade.effective).toEqual(['scheduling', 'reservation']);
    expect(afterUpgrade.blocked).toEqual([]);
  });
});
