import { describe, expect, it } from 'vitest';
import { majorToTaxMinor, taxMinorToMajor } from '../money';

describe('explicit tax currency-unit boundary', () => {
  it.each(['NGN', 'USD', 'GBP', 'CAD'])('preserves a fractional total in %s', currency => {
    expect(majorToTaxMinor('10.75', currency)).toBe(1075);
    expect(taxMinorToMajor(1075, currency)).toBe(10.75);
    expect(majorToTaxMinor(10, currency)).toBe(1000);
  });
  it('does not multiply the database amount twice or silently round sub-cent values', () => {
    expect(taxMinorToMajor(1, 'USD')).toBe(0.01);
    expect(majorToTaxMinor('0.2900', 'USD')).toBe(29);
    expect(() => majorToTaxMinor('0.291', 'USD')).toThrow('fractional');
    expect(() => majorToTaxMinor(0.1 + 0.2, 'USD')).toThrow('fractional');
  });
  it.each(['JPY', 'KWD', 'usd', '__proto__'])('rejects unapproved currency %s', currency => {
    expect(() => majorToTaxMinor(1, currency)).toThrow('Unsupported');
    expect(() => taxMinorToMajor(1, currency)).toThrow('Unsupported');
  });
  it.each(['-1', '1e3', '', ' 1', 'NaN', 'Infinity', '01.00'])('rejects malformed major amount %s', amount => {
    expect(() => majorToTaxMinor(amount, 'GBP')).toThrow();
  });
  it('rejects unsafe and lossy conversions', () => {
    expect(() => majorToTaxMinor('9007199254740992', 'USD')).toThrow();
    expect(() => taxMinorToMajor(1.1, 'USD')).toThrow();
    expect(() => taxMinorToMajor(-1, 'USD')).toThrow();
    expect(() => taxMinorToMajor(Number.MAX_SAFE_INTEGER, 'USD')).toThrow('precision');
  });
});
