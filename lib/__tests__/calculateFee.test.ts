import { describe, it, expect } from 'vitest';
import { calculateFee, validateV1Snapshot, type FeeBasis, type FeeConfigSnapshot } from '@/lib/payments/calculateFee';

const BASE_SNAPSHOT: FeeConfigSnapshot = {
  pricing_tiers: {
    free: { feePercentage: 2.5, feeFlat: 0 },
    growth: { feePercentage: 1.5, feeFlat: 0 },
    business: { feePercentage: 1.5, feeFlat: 0 },
  },
  category_fee_rates: {
    scheduling: { feePercentage: 3.0 },
    ticketing: { feePercentage: 5.0 },
    giving: { feePercentage: 1.0 },
  },
};

function basis(overrides: Partial<FeeBasis> = {}): FeeBasis {
  return {
    payment_routing: 'platform',
    tier: 'free',
    is_in_trial: false,
    custom_fee_percentage: null,
    custom_fee_flat: null,
    ...overrides,
  };
}

// ══════════════════════════════════════════════════════════
// BYO routing → 0% invariant
// ══════════════════════════════════════════════════════════

describe('calculateFee: BYO routing', () => {
  it('BYO routing produces zero fee regardless of tier/amount', () => {
    const result = calculateFee(10000, basis({ payment_routing: 'byo', tier: 'free' }), 'scheduling', BASE_SNAPSHOT);
    expect(result).toEqual({ feePercentage: 0, feeFlat: 0, feeTotal: 0 });
  });

  it('BYO overrides custom fee percentage', () => {
    const result = calculateFee(10000, basis({ payment_routing: 'byo', custom_fee_percentage: 5 }), 'scheduling', BASE_SNAPSHOT);
    expect(result).toEqual({ feePercentage: 0, feeFlat: 0, feeTotal: 0 });
  });

  it('BYO overrides trial=false + category rate', () => {
    const result = calculateFee(50000, basis({ payment_routing: 'byo' }), 'ticketing', BASE_SNAPSHOT);
    expect(result).toEqual({ feePercentage: 0, feeFlat: 0, feeTotal: 0 });
  });
});

// ══════════════════════════════════════════════════════════
// Trial waiver
// ══════════════════════════════════════════════════════════

describe('calculateFee: trial waiver', () => {
  it('trial=true produces zero fee', () => {
    const result = calculateFee(10000, basis({ is_in_trial: true }), 'scheduling', BASE_SNAPSHOT);
    expect(result).toEqual({ feePercentage: 0, feeFlat: 0, feeTotal: 0 });
  });

  it('trial=true overrides custom override', () => {
    const result = calculateFee(10000, basis({ is_in_trial: true, custom_fee_percentage: 10 }), null, BASE_SNAPSHOT);
    expect(result).toEqual({ feePercentage: 0, feeFlat: 0, feeTotal: 0 });
  });
});

// ══════════════════════════════════════════════════════════
// Category rate resolution
// ══════════════════════════════════════════════════════════

describe('calculateFee: category rates', () => {
  it('category rate used when available (scheduling → 3%)', () => {
    const result = calculateFee(10000, basis(), 'scheduling', BASE_SNAPSHOT);
    expect(result.feePercentage).toBe(3.0);
    expect(result.feeTotal).toBe(300); // 10000 * 3% = 300
  });

  it('category rate: ticketing → 5%', () => {
    const result = calculateFee(10000, basis(), 'ticketing', BASE_SNAPSHOT);
    expect(result.feePercentage).toBe(5.0);
    expect(result.feeTotal).toBe(500);
  });

  it('category rate: giving → 1%', () => {
    const result = calculateFee(10000, basis(), 'giving', BASE_SNAPSHOT);
    expect(result.feePercentage).toBe(1.0);
    expect(result.feeTotal).toBe(100);
  });

  it('missing category rate → tier fallback (NOT zero)', () => {
    const result = calculateFee(10000, basis({ tier: 'free' }), 'ordering', BASE_SNAPSHOT);
    expect(result.feePercentage).toBe(2.5); // falls back to free tier
    expect(result.feeTotal).toBe(250);
  });

  it('null category → tier fallback', () => {
    const result = calculateFee(10000, basis({ tier: 'growth' }), null, BASE_SNAPSHOT);
    expect(result.feePercentage).toBe(1.5);
    expect(result.feeTotal).toBe(150);
  });
});

// ══════════════════════════════════════════════════════════
// Custom override precedence
// ══════════════════════════════════════════════════════════

describe('calculateFee: custom overrides', () => {
  it('custom_fee_percentage overrides category rate', () => {
    const result = calculateFee(10000, basis({ custom_fee_percentage: 4.0 }), 'scheduling', BASE_SNAPSHOT);
    expect(result.feePercentage).toBe(4.0);
    expect(result.feeTotal).toBe(400);
  });

  it('custom_fee_flat is the only v1 flat source', () => {
    const result = calculateFee(10000, basis({ custom_fee_flat: 50 }), 'scheduling', BASE_SNAPSHOT);
    expect(result.feeFlat).toBe(50);
    expect(result.feeTotal).toBe(350); // 10000 * 3% + 50
  });

  it('custom_fee_flat waived on micro-transactions (> 10% of amount)', () => {
    const result = calculateFee(100, basis({ custom_fee_flat: 50 }), 'scheduling', BASE_SNAPSHOT);
    expect(result.feeFlat).toBe(0); // 50/100 = 50% > 10%
  });
});

// ══════════════════════════════════════════════════════════
// Precision: two-decimal for v1
// ══════════════════════════════════════════════════════════

describe('calculateFee: precision', () => {
  it('USD $50 × 3% = $1.50 (not $2)', () => {
    const result = calculateFee(50, basis(), 'scheduling', BASE_SNAPSHOT);
    expect(result.feeTotal).toBe(1.50);
  });

  it('USD $33.33 × 2.5% = $0.83 (rounded to 2 decimals)', () => {
    const result = calculateFee(33.33, basis({ tier: 'free' }), null, BASE_SNAPSHOT);
    // 33.33 * 2.5 * 100 = 8332.5, round = 8333, / 10000 = 0.8333
    // round(0.8333 * 100) / 100 = 0.83
    expect(result.feeTotal).toBe(0.83);
  });

  it('NGN ₦5000 × 2.5% = ₦125', () => {
    const result = calculateFee(5000, basis({ tier: 'free' }), null, BASE_SNAPSHOT);
    expect(result.feeTotal).toBe(125);
  });
});

// ══════════════════════════════════════════════════════════
// Connect routing (treated as platform)
// ══════════════════════════════════════════════════════════

describe('calculateFee: connect routing', () => {
  it('connect routing uses normal fee (not zero)', () => {
    const result = calculateFee(10000, basis({ payment_routing: 'connect', tier: 'free' }), 'scheduling', BASE_SNAPSHOT);
    expect(result.feePercentage).toBe(3.0);
    expect(result.feeTotal).toBe(300);
  });
});

// ══════════════════════════════════════════════════════════
// validateV1Snapshot
// ══════════════════════════════════════════════════════════

describe('validateV1Snapshot', () => {
  it('valid snapshot with zero feeFlat returns null', () => {
    expect(validateV1Snapshot(BASE_SNAPSHOT, 'free')).toBeNull();
    expect(validateV1Snapshot(BASE_SNAPSHOT, 'growth')).toBeNull();
  });

  it('non-zero global tier feeFlat → error', () => {
    const snap: FeeConfigSnapshot = {
      pricing_tiers: { free: { feePercentage: 2.5, feeFlat: 150 } },
    };
    const err = validateV1Snapshot(snap, 'free');
    expect(err).toMatch(/non-zero.*feeFlat/i);
  });

  it('missing tier config → error', () => {
    const snap: FeeConfigSnapshot = { pricing_tiers: {} };
    const err = validateV1Snapshot(snap, 'growth');
    expect(err).toMatch(/missing.*growth/i);
  });

  it('missing feePercentage → error', () => {
    const snap: FeeConfigSnapshot = {
      pricing_tiers: { free: { feeFlat: 0 } },
    };
    const err = validateV1Snapshot(snap, 'free');
    expect(err).toMatch(/missing.*feePercentage/i);
  });
});

// ══════════════════════════════════════════════════════════
// Error cases
// ══════════════════════════════════════════════════════════

describe('calculateFee: error cases', () => {
  it('null snapshot throws for fee-policy-active payments', () => {
    expect(() => calculateFee(10000, basis(), 'scheduling', null))
      .toThrow(/requires configSnapshot/);
  });

  it('missing tier in snapshot throws', () => {
    const snap: FeeConfigSnapshot = { pricing_tiers: {} };
    expect(() => calculateFee(10000, basis({ tier: 'free' }), null, snap))
      .toThrow(/missing tier fee config/i);
  });
});
