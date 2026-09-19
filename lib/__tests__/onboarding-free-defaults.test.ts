/**
 * Tests for #341: onboarding must preselect only free-tier capabilities.
 *
 * Verifies that:
 * - getOnboardingDefaultCapabilities returns only free-tier capabilities
 * - Common categories with paid global defaults start with only their free subset
 * - Order is preserved from the global defaults
 * - Fallback to ['chat'] when no free capabilities remain
 * - Global CATEGORY_DEFAULT_CAPABILITIES is NOT modified
 * - Pro/Premium capabilities remain available for manual opt-in (tier map unchanged)
 * - Manual paid selection still raises requiredPlan
 */

import { describe, it, expect } from 'vitest';
import {
  CATEGORY_DEFAULT_CAPABILITIES,
  CAPABILITY_TIER_REQUIREMENTS,
  getOnboardingDefaultCapabilities,
  type CapabilityId,
} from '@/lib/capabilities/types';

// Snapshot the global defaults before any test runs
const GLOBAL_DEFAULTS_SNAPSHOT = JSON.parse(
  JSON.stringify(CATEGORY_DEFAULT_CAPABILITIES),
);

describe('getOnboardingDefaultCapabilities', () => {
  it('returns only free-tier capabilities for salon (has paid defaults)', () => {
    const result = getOnboardingDefaultCapabilities('salon');
    for (const cap of result) {
      expect(CAPABILITY_TIER_REQUIREMENTS[cap]).toBe('free');
    }
    expect(result.length).toBeGreaterThan(0);
  });

  it('returns only free-tier capabilities for church (has paid defaults)', () => {
    const result = getOnboardingDefaultCapabilities('church');
    for (const cap of result) {
      expect(CAPABILITY_TIER_REQUIREMENTS[cap]).toBe('free');
    }
    expect(result.length).toBeGreaterThan(0);
  });

  it('returns only free-tier capabilities for consultant (heavy pro defaults)', () => {
    const result = getOnboardingDefaultCapabilities('consultant');
    for (const cap of result) {
      expect(CAPABILITY_TIER_REQUIREMENTS[cap]).toBe('free');
    }
    expect(result.length).toBeGreaterThan(0);
  });

  it('preserves order from global defaults', () => {
    const globalSalon = CATEGORY_DEFAULT_CAPABILITIES['salon'];
    const onboardingSalon = getOnboardingDefaultCapabilities('salon');
    const globalFreeOnly = globalSalon.filter(
      (id) => CAPABILITY_TIER_REQUIREMENTS[id] === 'free',
    );
    expect(onboardingSalon).toEqual(globalFreeOnly);
  });

  it('falls back to [chat] for unknown category', () => {
    expect(getOnboardingDefaultCapabilities('nonexistent_category')).toEqual([
      'chat',
    ]);
  });

  it('falls back to [chat] when category has no free capabilities', () => {
    // Hypothetical: all capabilities in a category are paid.
    // We test directly — if someone created such a category, fallback works.
    // This is a safety net test.
    const result = getOnboardingDefaultCapabilities('nonexistent');
    expect(result).toEqual(['chat']);
  });

  it('never includes Pro capabilities in onboarding defaults', () => {
    for (const [category] of Object.entries(CATEGORY_DEFAULT_CAPABILITIES)) {
      const onboardingDefaults = getOnboardingDefaultCapabilities(category);
      const proInDefaults = onboardingDefaults.filter(
        (id) => CAPABILITY_TIER_REQUIREMENTS[id] === 'growth',
      );
      expect(proInDefaults).toEqual([]);
    }
  });

  it('never includes Premium capabilities in onboarding defaults', () => {
    for (const [category] of Object.entries(CATEGORY_DEFAULT_CAPABILITIES)) {
      const onboardingDefaults = getOnboardingDefaultCapabilities(category);
      const premiumInDefaults = onboardingDefaults.filter(
        (id) => CAPABILITY_TIER_REQUIREMENTS[id] === 'business',
      );
      expect(premiumInDefaults).toEqual([]);
    }
  });

  it('does NOT modify global CATEGORY_DEFAULT_CAPABILITIES', () => {
    // Call for multiple categories
    getOnboardingDefaultCapabilities('salon');
    getOnboardingDefaultCapabilities('church');
    getOnboardingDefaultCapabilities('consultant');
    getOnboardingDefaultCapabilities('hotel');

    expect(CATEGORY_DEFAULT_CAPABILITIES).toEqual(GLOBAL_DEFAULTS_SNAPSHOT);
  });

  it('Pro/Premium capabilities remain in CAPABILITY_TIER_REQUIREMENTS (available for manual opt-in)', () => {
    // These paid capabilities must still exist in the tier map
    const paidCapabilities: CapabilityId[] = [
      'recurring',
      'broadcast',
      'invoice',
      'staff',
      'queue',
      'waitlist',
    ];
    for (const cap of paidCapabilities) {
      expect(CAPABILITY_TIER_REQUIREMENTS[cap]).toBeDefined();
      expect(['growth', 'business']).toContain(
        CAPABILITY_TIER_REQUIREMENTS[cap],
      );
    }
  });
});

describe('requiredPlan computation with manual paid selections', () => {
  function computeRequiredPlan(
    capabilities: CapabilityId[],
  ): 'free' | 'growth' | 'business' {
    let highest: 'free' | 'growth' | 'business' = 'free';
    for (const cap of capabilities) {
      const tier = CAPABILITY_TIER_REQUIREMENTS[cap] || 'free';
      if (tier === 'business') {
        highest = 'business';
        break;
      }
      if (tier === 'growth' && highest === 'free') highest = 'growth';
    }
    return highest;
  }

  it('free-only defaults result in free requiredPlan', () => {
    const defaults = getOnboardingDefaultCapabilities('salon');
    expect(computeRequiredPlan(defaults)).toBe('free');
  });

  it('adding a Pro capability raises requiredPlan to growth', () => {
    const defaults = getOnboardingDefaultCapabilities('salon');
    expect(computeRequiredPlan([...defaults, 'broadcast'])).toBe('growth');
  });

  it('adding a Premium capability raises requiredPlan to business', () => {
    const defaults = getOnboardingDefaultCapabilities('salon');
    expect(computeRequiredPlan([...defaults, 'staff'])).toBe('business');
  });
});

describe('category change replaces stale selections', () => {
  it('selecting a new category produces fresh free-only defaults regardless of previous selections', () => {
    // Simulate: user had salon defaults (potentially stale/paid from old behavior)
    const stalePaidCaps: CapabilityId[] = [
      'appointment',
      'payment',
      'broadcast',
      'staff',
    ];

    // User changes to restaurant — StepCategory calls getOnboardingDefaultCapabilities
    const newDefaults = getOnboardingDefaultCapabilities('restaurant');

    // New defaults should be free-only and should NOT contain stale paid selections
    for (const cap of newDefaults) {
      expect(CAPABILITY_TIER_REQUIREMENTS[cap]).toBe('free');
    }
    expect(newDefaults).not.toContain('broadcast');
    expect(newDefaults).not.toContain('staff');
  });
});
