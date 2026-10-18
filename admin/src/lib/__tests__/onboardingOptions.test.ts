import { describe, it, expect } from 'vitest';
import { resolveOnboardingSelection } from '../onboardingOptions';

describe('admin onboarding authoritative options', () => {
  it('never falls back to Nigeria when no countries loaded', () => {
    expect(resolveOnboardingSelection([], 'NG')).toBe('');
  });
  it('uses first enabled country rather than assumed NG', () => {
    expect(resolveOnboardingSelection(['US', 'GB', 'GH'], 'NG')).toBe('US');
  });
  it('preserves a valid selection when options refresh', () => {
    expect(resolveOnboardingSelection(['NG', 'US', 'GB'], 'GB')).toBe('GB');
  });
  it('respects active supported options and category default', () => {
    expect(resolveOnboardingSelection(['service', 'other'], '', 'other')).toBe('other');
    expect(resolveOnboardingSelection(['service'], '', 'other')).toBe('service');
  });
});
