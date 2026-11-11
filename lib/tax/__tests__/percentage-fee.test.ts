import { describe, expect, it } from 'vitest';
import { calculateFee, type FeeBasis } from '@/lib/payments/calculateFee';
const basis: FeeBasis = { payment_routing: 'platform', tier: 'free', is_in_trial: false, custom_fee_percentage: 10, custom_fee_flat: 9 };
const config = { pricing_tiers: { free: { feePercentage: 10, feeFlat: 0 } } };
describe('tax-exclusive percentage fee', () => {
  it('changes only the percentage basis and preserves gross-based flat threshold', () => {
    expect(calculateFee(100, basis, null, config, 80)).toEqual({ feePercentage: 10, feeFlat: 9, feeTotal: 17 });
  });
  it('preserves existing no-tax behavior for every payment routing', () => {
    for (const payment_routing of ['platform', 'byo', 'connect'] as const) {
      expect(calculateFee(100, { ...basis, payment_routing }, null, config)).toEqual(calculateFee(100, { ...basis, payment_routing }, null, config, 100));
    }
  });
  it.each([-1, 101, NaN, Infinity])('rejects invalid pre-tax basis %s', value => {
    expect(() => calculateFee(100, basis, null, config, value)).toThrow();
  });
});
