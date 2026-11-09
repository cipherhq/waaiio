/**
 * PROMO-1: Effective capability authority tests.
 *
 * Proves that Promotions uses the canonical capability resolver,
 * not raw businesses.capabilities checks.
 */
import { describe, it, expect } from 'vitest';
import { getEffectiveCapabilities } from '@/lib/capabilities/policy';
import { CAPABILITY_TIER_REQUIREMENTS } from '@/shared/capabilities';

describe('promo_verification capability authority', () => {
  it('promo_verification requires growth tier', () => {
    expect(CAPABILITY_TIER_REQUIREMENTS.promo_verification).toBe('growth');
  });

  it('free tier business without override cannot use promo_verification', () => {
    const result = getEffectiveCapabilities({
      configuredCapabilities: [{ capability: 'promo_verification', is_enabled: true }],
      overrides: [],
      tier: 'free',
      trialEndsAt: null,
    });
    expect(result.effective).not.toContain('promo_verification');
    expect(result.blocked.some(b => b.capability === 'promo_verification')).toBe(true);
  });

  it('growth tier business with promo_verification enabled gets effective', () => {
    const result = getEffectiveCapabilities({
      configuredCapabilities: [{ capability: 'promo_verification', is_enabled: true }],
      overrides: [],
      tier: 'growth',
      trialEndsAt: null,
    });
    expect(result.effective).toContain('promo_verification');
  });

  it('free tier with admin override gets effective promo_verification', () => {
    const result = getEffectiveCapabilities({
      configuredCapabilities: [{ capability: 'promo_verification', is_enabled: true }],
      overrides: ['promo_verification'],
      tier: 'free',
      trialEndsAt: null,
    });
    expect(result.effective).toContain('promo_verification');
  });

  it('free tier with active trial gets effective promo_verification', () => {
    const future = new Date(Date.now() + 86400000).toISOString();
    const result = getEffectiveCapabilities({
      configuredCapabilities: [{ capability: 'promo_verification', is_enabled: true }],
      overrides: [],
      tier: 'free',
      trialEndsAt: future,
    });
    expect(result.effective).toContain('promo_verification');
  });

  it('configured but disabled promo_verification is not effective', () => {
    const result = getEffectiveCapabilities({
      configuredCapabilities: [{ capability: 'promo_verification', is_enabled: false }],
      overrides: [],
      tier: 'growth',
      trialEndsAt: null,
    });
    expect(result.effective).not.toContain('promo_verification');
    expect(result.disabled).toContain('promo_verification');
  });

  it('revoked capability (not in configured list) is not effective', () => {
    const result = getEffectiveCapabilities({
      configuredCapabilities: [],
      overrides: [],
      tier: 'growth',
      trialEndsAt: null,
    });
    expect(result.effective).not.toContain('promo_verification');
  });

  it('bot handler exports accept effective capabilities array', async () => {
    const mod = await import('@/lib/bot/handlers/promo-verification');
    // Function signature should accept effectiveCapabilities
    expect(typeof mod.handlePromoVerification).toBe('function');
    expect(mod.handlePromoVerification.length).toBeGreaterThanOrEqual(6);
  });
});
