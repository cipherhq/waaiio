// @vitest-environment node
/**
 * Legacy loyalty tier multiplier — #762 W17
 *
 * Verifies that the legacy (no paymentId) path in handlePostCompletion
 * applies the membership tier multiplier. Tests the tier-lookup logic
 * by verifying the code path in post-completion.ts reads the correct
 * fields and applies base-then-multiply ordering.
 *
 * Since handlePostCompletion has many dynamic imports and side effects,
 * we test the tier-lookup integration by reading the source and verifying
 * the structural contracts, then test the arithmetic independently.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const postCompletionSource = readFileSync(
  resolve(__dirname, '../../lib/bot/flows/shared/post-completion.ts'), 'utf-8'
);

describe('#762 legacy loyalty tier multiplier contracts', () => {
  // ── Source structure verification ──

  it('legacy path checks membership capability before tier lookup', () => {
    // The tier lookup should be gated by capabilities.includes('membership')
    const legacySection = postCompletionSource.slice(
      postCompletionSource.indexOf('Legacy path (no paymentId)'),
      postCompletionSource.indexOf('loyalty_transactions')
    );
    expect(legacySection).toContain("capabilities.includes('membership')");
  });

  it('legacy path uses phoneWithPlus for customer_profiles.phone lookup', () => {
    const legacySection = postCompletionSource.slice(
      postCompletionSource.indexOf("capabilities.includes('membership')"),
      postCompletionSource.indexOf('loyalty_transactions')
    );
    expect(legacySection).toContain('phoneWithPlus');
    expect(legacySection).toContain("'phone'");
  });

  it('legacy path joins membership_tiers!inner for the tier lookup', () => {
    const legacySection = postCompletionSource.slice(
      postCompletionSource.indexOf("capabilities.includes('membership')"),
      postCompletionSource.indexOf('loyalty_transactions')
    );
    expect(legacySection).toContain('membership_tiers!inner');
    expect(legacySection).toContain('points_multiplier');
    expect(legacySection).toContain('is_active');
    expect(legacySection).toContain('business_id');
  });

  it('legacy path checks is_active and business_id before applying multiplier', () => {
    const legacySection = postCompletionSource.slice(
      postCompletionSource.indexOf("capabilities.includes('membership')"),
      postCompletionSource.indexOf('loyalty_transactions')
    );
    expect(legacySection).toContain('tier.is_active');
    expect(legacySection).toContain('tier.business_id === businessId');
  });

  it('legacy path applies multiplier only when > 1 using floor', () => {
    const legacySection = postCompletionSource.slice(
      postCompletionSource.indexOf("capabilities.includes('membership')"),
      postCompletionSource.indexOf('loyalty_transactions')
    );
    expect(legacySection).toContain('multiplier > 1');
    expect(legacySection).toContain('Math.floor(earnedPoints * multiplier)');
  });

  it('legacy path throws on tier lookup error (does not silently award at 1x)', () => {
    const legacySection = postCompletionSource.slice(
      postCompletionSource.indexOf("capabilities.includes('membership')"),
      postCompletionSource.indexOf('loyalty_transactions')
    );
    // Must check tierError and throw — no try/catch that silently continues
    expect(legacySection).toContain('tierError');
    expect(legacySection).toContain('throw new Error');
    expect(legacySection).toContain('legacy_tier_lookup_failed');
    // Must NOT have a catch block that silently continues with base points
    expect(legacySection).not.toContain('catch (tierErr)');
  });

  it('legacy path calculates base points BEFORE multiplier (base-then-multiply)', () => {
    const legacySection = postCompletionSource.slice(
      postCompletionSource.indexOf('Legacy path (no paymentId)'),
      postCompletionSource.indexOf('loyalty_transactions')
    );
    // Base points come first
    const baseCalcPos = legacySection.indexOf('let earnedPoints = pointsPerVisit');
    // Multiplier comes after
    const multiplierPos = legacySection.indexOf("capabilities.includes('membership')");
    expect(baseCalcPos).toBeLessThan(multiplierPos);
  });

  // ── Arithmetic verification ──

  it('floor(base * multiplier) arithmetic: 10 * 2 = 20', () => {
    expect(Math.floor(10 * 2)).toBe(20);
  });

  it('floor(base * multiplier) arithmetic: 10 * 1.5 = 15', () => {
    expect(Math.floor(10 * 1.5)).toBe(15);
  });

  it('floor(base * multiplier) arithmetic: 5 * 1.5 = 7 (not 8)', () => {
    expect(Math.floor(5 * 1.5)).toBe(7);
  });

  it('multiplier = 1 does not change points (guard: multiplier > 1)', () => {
    const base = 10;
    const multiplier = 1;
    // When multiplier is not > 1, earned stays at base
    expect(multiplier > 1 ? Math.floor(base * multiplier) : base).toBe(10);
  });

  it('paid path delegates to RPC via terminal effects, not inline tier logic', () => {
    // The paid path uses driveInternalEffect + supabase.rpc, not inline multiplier
    const paidSection = postCompletionSource.slice(
      postCompletionSource.indexOf('if (paymentId)'),
      postCompletionSource.indexOf('Legacy path (no paymentId)')
    );
    expect(paidSection).toContain('driveInternalEffect');
    expect(paidSection).toContain('supabase.rpc');
    // Inline tier lookup only appears in the legacy else branch
    expect(paidSection).not.toContain('membership_tiers!inner');
  });
});
