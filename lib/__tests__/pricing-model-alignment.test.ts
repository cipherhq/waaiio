/**
 * Locked pricing model alignment — asserts lib/constants.ts matches
 * the approved pricing model exactly.
 *
 * Values tested: TRIAL_DAYS, fee percentages, feeFlat (must be 0),
 * activity caps, whitelabel flag, per-country subscription prices,
 * and India exclusion.
 */

import { describe, it, expect } from 'vitest';
import {
  TRIAL_DAYS,
  PRICING_TIERS,
  TIER_FEATURES,
  getPricingTiers,
} from '@/lib/constants';

// ── Trial ──

describe('Trial days', () => {
  it('TRIAL_DAYS is 14', () => {
    expect(TRIAL_DAYS).toBe(14);
  });
});

// ── Transaction fees ──

describe('Transaction fees — percentage only, no flat fee', () => {
  it('Free/Starter: 3% fee, feeFlat 0', () => {
    expect(PRICING_TIERS.free.feePercentage).toBe(3);
    expect(PRICING_TIERS.free.feeFlat).toBe(0);
    expect(TIER_FEATURES.free.feePercentage).toBe(3);
  });

  it('Pro/growth: 1.5% fee, feeFlat 0', () => {
    expect(PRICING_TIERS.growth.feePercentage).toBe(1.5);
    expect(PRICING_TIERS.growth.feeFlat).toBe(0);
    expect(TIER_FEATURES.growth.feePercentage).toBe(1.5);
  });

  it('Premium/business: 1% fee, feeFlat 0', () => {
    expect(PRICING_TIERS.business.feePercentage).toBe(1);
    expect(PRICING_TIERS.business.feeFlat).toBe(0);
    expect(TIER_FEATURES.business.feePercentage).toBe(1);
  });
});

// ── Activity caps ──

describe('Monthly activity caps', () => {
  it('Free: 100', () => {
    expect(PRICING_TIERS.free.maxBookings).toBe(100);
    expect(TIER_FEATURES.free.maxBookings).toBe(100);
  });

  it('Pro/growth: 1000', () => {
    expect(PRICING_TIERS.growth.maxBookings).toBe(1000);
    expect(TIER_FEATURES.growth.maxBookings).toBe(1000);
  });

  it('Premium/business: unlimited', () => {
    expect(PRICING_TIERS.business.maxBookings).toBe(Infinity);
    expect(TIER_FEATURES.business.maxBookings).toBe(Infinity);
  });
});

// ── White-label ──

describe('White-label off for launch', () => {
  it('all tiers have whitelabel = false', () => {
    expect(PRICING_TIERS.free.whitelabel).toBe(false);
    expect(PRICING_TIERS.growth.whitelabel).toBe(false);
    expect(PRICING_TIERS.business.whitelabel).toBe(false);
    expect(TIER_FEATURES.free.whitelabel).toBe(false);
    expect(TIER_FEATURES.growth.whitelabel).toBe(false);
    expect(TIER_FEATURES.business.whitelabel).toBe(false);
  });
});

// ── Per-country subscription prices ──

describe('Country subscription prices (major units)', () => {
  const EXPECTED: Record<string, { growth: number; business: number }> = {
    NG: { growth: 15_000, business: 45_000 },
    US: { growth: 49, business: 89.99 },
    GB: { growth: 30, business: 80 },
    CA: { growth: 49, business: 89.99 },
    GH: { growth: 150, business: 400 },
  };

  for (const [code, prices] of Object.entries(EXPECTED)) {
    it(`${code}: Pro ${prices.growth}, Premium ${prices.business}`, () => {
      const tiers = getPricingTiers(code);
      expect(tiers.growth.price).toBe(prices.growth);
      expect(tiers.business.price).toBe(prices.business);
      expect(tiers.free.price).toBe(0);
    });
  }

  it('all countries have feeFlat = 0 in getPricingTiers', () => {
    for (const code of Object.keys(EXPECTED)) {
      const tiers = getPricingTiers(code);
      expect(tiers.free.feeFlat).toBe(0);
      expect(tiers.growth.feeFlat).toBe(0);
      expect(tiers.business.feeFlat).toBe(0);
    }
  });
});

// ── India excluded ──

describe('India (INR) excluded at launch', () => {
  it('IN returns zero-price fallback, not a configured pricing entry', () => {
    const tiers = getPricingTiers('IN');
    // Falls through to the zero fallback since IN is not in COUNTRY_PRICING
    expect(tiers.growth.price).toBe(0);
    expect(tiers.business.price).toBe(0);
  });
});
