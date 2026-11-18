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

  it('charges the plan fee during the trial for all tiers (Owner 2026-11-08)', async () => {
    mockLoadSettings.mockResolvedValue(makePricingTiers());

    for (const tier of ['free', 'growth', 'business'] as const) {
      const inTrial = await getPlatformFees(10_000, tier, true);
      const notInTrial = await getPlatformFees(10_000, tier, false);
      expect(inTrial).toEqual(notInTrial);
      expect(inTrial.feeTotal).toBeGreaterThan(0);
    }
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

  it('rounds the fee to the cent/kobo, not to whole units (Owner 2026-11-18)', async () => {
    mockLoadSettings.mockResolvedValue(makePricingTiers());

    // Whole-unit rounding gave 9 and 3 here.
    expect((await getPlatformFees(341.2, 'free', false)).feeTotal).toBe(8.53);
    expect((await getPlatformFees(333.4, 'free', false)).feeTotal).toBe(8.34);
    // Exact half-cent ties (333 * 2.5% = 8.325) follow the same float rounding as
    // v1 calculateFee, so v0 and v1 never disagree; the difference is at most 1 cent.
    expect((await getPlatformFees(333, 'free', false)).feeTotal).toBe(8.32);
  });

  it('charges $1.50 on $50 at 3% (was $2.00)', async () => {
    mockLoadSettings.mockResolvedValue(makePricingTiers({ free: { feePercentage: 3 } }));

    const result = await getPlatformFees(50, 'free', false);

    expect(result.feeTotal).toBe(1.5);
  });

  it('keeps kobo precision on naira amounts', async () => {
    mockLoadSettings.mockResolvedValue(makePricingTiers({ business: { feePercentage: 1, feeFlat: 0 } }));

    // Staging rows that whole-unit rounding recorded as 14 / 278 / 20
    expect((await getPlatformFees(1444, 'business', false)).feeTotal).toBe(14.44);
    expect((await getPlatformFees(27777, 'business', false)).feeTotal).toBe(277.77);
    expect((await getPlatformFees(2020, 'business', false)).feeTotal).toBe(20.2);
    expect((await getPlatformFees(5000, 'business', false)).feeTotal).toBe(50);
  });

  it('matches v1 calculateFee for the same rate and amount', async () => {
    const { calculateFee } = await import('@/lib/payments/calculateFee');
    mockLoadSettings.mockResolvedValue(makePricingTiers({ free: { feePercentage: 3, feeFlat: 0 } }));
    const snapshot = { pricing_tiers: { free: { feePercentage: 3, feeFlat: 0 } } } as unknown as Parameters<typeof calculateFee>[3];
    const basis = { payment_routing: 'platform', tier: 'free', is_in_trial: false, custom_fee_percentage: null, custom_fee_flat: null } as Parameters<typeof calculateFee>[1];

    for (const amount of [0.99, 1.01, 50, 99.99, 333, 1444, 27777, 123456.78]) {
      const legacy = await getPlatformFees(amount, 'free', false);
      expect(legacy.feeTotal).toBe(calculateFee(amount, basis, null, snapshot).feeTotal);
    }
  });

  it('provider split amounts derived from the fee stay whole minor units', async () => {
    mockLoadSettings.mockResolvedValue(makePricingTiers({ free: { feePercentage: 3 } }));

    for (const amount of [50, 333, 1444.5, 27777, 0.99]) {
      const { feeTotal } = await getPlatformFees(amount, 'free', false);
      // Same expressions as paystack.ts (merchant + BYO split), charge-saved.ts, stripe.ts
      const feeMinor = Math.round(feeTotal * 100);
      const merchantKeepsMinor = Math.round((amount - feeTotal) * 100);
      expect(Number.isInteger(feeMinor)).toBe(true);
      expect(Number.isInteger(merchantKeepsMinor)).toBe(true);
      expect(feeMinor + merchantKeepsMinor).toBe(Math.round(amount * 100));
      expect(feeMinor / 100).toBe(feeTotal);
    }
  });
});
