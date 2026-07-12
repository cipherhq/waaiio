import { describe, it, expect } from 'vitest';
import { calculateLtvTier } from '../customer-intelligence';

describe('customer-intelligence — calculateLtvTier', () => {
  it('returns "new" for 0 visits, 0 spent', () => {
    expect(calculateLtvTier(0, 0)).toBe('new');
  });

  it('returns "new" for 2 visits, low spend', () => {
    expect(calculateLtvTier(1000, 2)).toBe('new');
  });

  it('returns "regular" for 3+ visits', () => {
    expect(calculateLtvTier(10000, 3)).toBe('regular');
    expect(calculateLtvTier(10000, 10)).toBe('regular');
  });

  it('returns "vip" for 500,000+ spent', () => {
    expect(calculateLtvTier(500_000, 1)).toBe('vip');
    expect(calculateLtvTier(1_000_000, 50)).toBe('vip');
  });

  it('vip takes priority over regular (high spend + high visits)', () => {
    expect(calculateLtvTier(600_000, 10)).toBe('vip');
  });
});
