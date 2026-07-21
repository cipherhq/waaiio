import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock loadPlatformSettings before importing
vi.mock('@/lib/platformSettings', () => ({
  loadPlatformSettings: vi.fn(),
}));

import { getPlatformFees } from '../getPlatformFees';
import { loadPlatformSettings } from '@/lib/platformSettings';

const mockLoadSettings = loadPlatformSettings as ReturnType<typeof vi.fn>;

function makePricingTiers(overrides?: Record<string, Partial<{ feePercentage: number; feeFlat: number }>>) {
  return {
    pricing_tiers: {
      free: { feePercentage: 2.5, feeFlat: 0, maxBookings: 50, whitelabel: false, ...overrides?.free },
      growth: { feePercentage: 1.5, feeFlat: 0, maxBookings: 500, whitelabel: false, ...overrides?.growth },
      business: { feePercentage: 1.5, feeFlat: 75, maxBookings: Infinity, whitelabel: true, ...overrides?.business },
    },
  };
}

describe('getPlatformFees', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calculates 2.5% fee for free tier on 10,000', async () => {
    mockLoadSettings.mockResolvedValue(makePricingTiers());

    const result = await getPlatformFees(10_000, 'free', false);

    expect(result.feePercentage).toBe(2.5);
    expect(result.feeTotal).toBe(250);
  });

  it('calculates 1.5% fee for growth tier on 10,000', async () => {
    mockLoadSettings.mockResolvedValue(makePricingTiers());

    const result = await getPlatformFees(10_000, 'growth', false);

    expect(result.feePercentage).toBe(1.5);
    expect(result.feeTotal).toBe(150);
  });

  it('calculates 1% fee for business tier on 10,000', async () => {
    mockLoadSettings.mockResolvedValue(makePricingTiers());

    const result = await getPlatformFees(10_000, 'business', false);

    expect(result.feePercentage).toBe(1.5);
    expect(result.feeTotal).toBe(225); // 1.5% of 10000 = 150 + 75 flat = 225
  });

  it('returns 0% fee during trial period for all tiers', async () => {
    mockLoadSettings.mockResolvedValue(makePricingTiers());

    for (const tier of ['free', 'growth', 'business'] as const) {
      const result = await getPlatformFees(10_000, tier, true);
      expect(result.feePercentage).toBe(0);
      expect(result.feeFlat).toBe(0);
      expect(result.feeTotal).toBe(0);
    }

    // loadPlatformSettings should NOT be called during trial
    expect(mockLoadSettings).not.toHaveBeenCalled();
  });

  it('returns 0 fee for zero amount', async () => {
    mockLoadSettings.mockResolvedValue(makePricingTiers());

    const result = await getPlatformFees(0, 'free', false);

    expect(result.feeTotal).toBe(0);
  });

  it('calculates correct fee on large amount (1,000,000 at 2.5%)', async () => {
    mockLoadSettings.mockResolvedValue(makePricingTiers());

    const result = await getPlatformFees(1_000_000, 'free', false);

    expect(result.feeTotal).toBe(25_000);
  });

  it('waives flat fee on micro-transactions where flat > 10% of amount', async () => {
    // Flat fee of 150 on a 1000 transaction = 15% > 10% threshold
    mockLoadSettings.mockResolvedValue(makePricingTiers({
      free: { feePercentage: 2.0, feeFlat: 150 },
    }));

    const result = await getPlatformFees(1_000, 'free', false);

    expect(result.feeFlat).toBe(0); // Waived
    expect(result.feeTotal).toBe(20); // Only percentage: 1000 * 2% = 20
  });

  it('keeps flat fee when it is within 10% threshold', async () => {
    // Flat fee of 150 on 10,000 = 1.5% < 10% threshold
    mockLoadSettings.mockResolvedValue(makePricingTiers({
      free: { feePercentage: 2.0, feeFlat: 150 },
    }));

    const result = await getPlatformFees(10_000, 'free', false);

    expect(result.feeFlat).toBe(150);
    expect(result.feeTotal).toBe(200 + 150); // 10000 * 2% + 150
  });

  it('rounds percentage fee to 2 decimal places', async () => {
    mockLoadSettings.mockResolvedValue(makePricingTiers());

    // 333 * 2.5% = 8.325 in math, 8.324999... in IEEE 754 → toFixed(2) = 8.32
    const result = await getPlatformFees(333, 'free', false);

    expect(result.feeTotal).toBe(8.32);
  });
});
