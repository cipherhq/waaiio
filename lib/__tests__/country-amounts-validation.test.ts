/**
 * Country-amount validator unit tests
 *
 * Tests the shared validateCountryAmounts() function used by both
 * the admin UI (PlatformSettings page) and the server route
 * (commercial config API).
 *
 * Run:
 *   npx vitest run lib/__tests__/country-amounts-validation.test.ts
 */
import { describe, it, expect } from 'vitest';
import {
  validateCountryAmounts,
  isCountryAmountKey,
  COUNTRY_AMOUNT_COUNTRIES,
} from '../../shared/country-amounts';

describe('isCountryAmountKey', () => {
  it('returns true for minimum_bank_transfer', () => {
    expect(isCountryAmountKey('minimum_bank_transfer')).toBe(true);
  });

  it('returns true for minimum_payout', () => {
    expect(isCountryAmountKey('minimum_payout')).toBe(true);
  });

  it('returns false for other keys', () => {
    expect(isCountryAmountKey('pricing_tiers')).toBe(false);
    expect(isCountryAmountKey('trial_days')).toBe(false);
  });
});

describe('COUNTRY_AMOUNT_COUNTRIES', () => {
  it('minimum_bank_transfer allows NG and GH only', () => {
    expect(COUNTRY_AMOUNT_COUNTRIES.minimum_bank_transfer).toEqual(['NG', 'GH']);
  });

  it('minimum_payout allows NG, US, GB, CA, GH', () => {
    expect(COUNTRY_AMOUNT_COUNTRIES.minimum_payout).toEqual(['NG', 'US', 'GB', 'CA', 'GH']);
  });
});

describe('validateCountryAmounts', () => {
  describe('valid inputs', () => {
    it('accepts valid minimum_bank_transfer with all countries', () => {
      const result = validateCountryAmounts('minimum_bank_transfer', { NG: 5000, GH: 5000 });
      expect(result).toBeNull();
    });

    it('accepts valid minimum_payout with all countries', () => {
      const result = validateCountryAmounts('minimum_payout', {
        NG: 5000, US: 2500, GB: 2000, CA: 2500, GH: 50,
      });
      expect(result).toBeNull();
    });

    it('accepts zero as a value', () => {
      const result = validateCountryAmounts('minimum_bank_transfer', { NG: 0, GH: 0 });
      expect(result).toBeNull();
    });
  });

  describe('rejects missing countries', () => {
    it('rejects minimum_bank_transfer with only NG (missing GH)', () => {
      const result = validateCountryAmounts('minimum_bank_transfer', { NG: 10000 });
      expect(result).not.toBeNull();
      expect(result!.some(e => e.field === 'GH' && e.message.includes('required'))).toBe(true);
    });

    it('rejects minimum_payout missing US', () => {
      const result = validateCountryAmounts('minimum_payout', {
        NG: 5000, GB: 2000, CA: 2500, GH: 50,
      });
      expect(result).not.toBeNull();
      expect(result!.some(e => e.field === 'US' && e.message.includes('required'))).toBe(true);
    });

    it('reports all missing countries', () => {
      const result = validateCountryAmounts('minimum_payout', { NG: 5000 });
      expect(result).not.toBeNull();
      // US, GB, CA, GH all missing
      expect(result!.filter(e => e.message.includes('required')).length).toBe(4);
    });
  });

  describe('rejects null/undefined/wrong types', () => {
    it('rejects null', () => {
      const result = validateCountryAmounts('minimum_bank_transfer', null);
      expect(result).not.toBeNull();
      expect(result![0].message).toContain('required');
    });

    it('rejects undefined', () => {
      const result = validateCountryAmounts('minimum_bank_transfer', undefined);
      expect(result).not.toBeNull();
    });

    it('rejects a string', () => {
      const result = validateCountryAmounts('minimum_bank_transfer', '{"NG": 5000}');
      expect(result).not.toBeNull();
      expect(result![0].message).toContain('object');
    });

    it('rejects an empty string', () => {
      const result = validateCountryAmounts('minimum_bank_transfer', '');
      expect(result).not.toBeNull();
    });

    it('rejects an array', () => {
      const result = validateCountryAmounts('minimum_bank_transfer', [5000]);
      expect(result).not.toBeNull();
      expect(result![0].message).toContain('object');
    });

    it('rejects a number', () => {
      const result = validateCountryAmounts('minimum_bank_transfer', 5000);
      expect(result).not.toBeNull();
    });
  });

  describe('rejects empty object', () => {
    it('rejects {} with missing-country errors', () => {
      const result = validateCountryAmounts('minimum_bank_transfer', {});
      expect(result).not.toBeNull();
      expect(result!.some(e => e.message.includes('required'))).toBe(true);
    });
  });

  describe('rejects string values (the "1000" bug)', () => {
    it('rejects string amounts like "1000"', () => {
      const result = validateCountryAmounts('minimum_bank_transfer', { NG: '1000', GH: 5000 });
      expect(result).not.toBeNull();
      expect(result!.some(e => e.field === 'NG' && e.message.includes('number'))).toBe(true);
    });
  });

  describe('rejects negative numbers', () => {
    it('rejects -1', () => {
      const result = validateCountryAmounts('minimum_bank_transfer', { NG: -1, GH: 5000 });
      expect(result).not.toBeNull();
      expect(result!.some(e => e.message.includes('0 or greater'))).toBe(true);
    });
  });

  describe('rejects non-integer numbers', () => {
    it('rejects 1.5', () => {
      const result = validateCountryAmounts('minimum_bank_transfer', { NG: 1.5, GH: 5000 });
      expect(result).not.toBeNull();
      expect(result!.some(e => e.message.includes('whole number'))).toBe(true);
    });
  });

  describe('rejects NaN and Infinity', () => {
    it('rejects NaN', () => {
      const result = validateCountryAmounts('minimum_bank_transfer', { NG: NaN, GH: 5000 });
      expect(result).not.toBeNull();
      expect(result!.some(e => e.message.includes('finite'))).toBe(true);
    });

    it('rejects Infinity', () => {
      const result = validateCountryAmounts('minimum_bank_transfer', { NG: Infinity, GH: 5000 });
      expect(result).not.toBeNull();
    });
  });

  describe('rejects unknown country codes', () => {
    it('rejects FR for minimum_bank_transfer', () => {
      const result = validateCountryAmounts('minimum_bank_transfer', { NG: 5000, GH: 5000, FR: 5000 });
      expect(result).not.toBeNull();
      expect(result!.some(e => e.message.includes('not allowed') && e.message.includes('FR'))).toBe(true);
    });

    it('rejects JP for minimum_payout', () => {
      const result = validateCountryAmounts('minimum_payout', {
        NG: 5000, US: 2500, GB: 2000, CA: 2500, GH: 50, JP: 100,
      });
      expect(result).not.toBeNull();
      expect(result!.some(e => e.field === 'JP')).toBe(true);
    });

    it('valid countries pass even with an invalid extra', () => {
      const result = validateCountryAmounts('minimum_payout', {
        NG: 5000, US: 2500, GB: 2000, CA: 2500, GH: 50, JP: 100,
      });
      expect(result).not.toBeNull();
      // Only JP should have an error
      expect(result!.length).toBe(1);
      expect(result![0].field).toBe('JP');
    });
  });

  describe('rejects nested objects', () => {
    it('rejects { NG: { amount: 5000 } }', () => {
      const result = validateCountryAmounts('minimum_bank_transfer', { NG: { amount: 5000 }, GH: 5000 });
      expect(result).not.toBeNull();
      expect(result!.some(e => e.message.includes('number'))).toBe(true);
    });
  });

  describe('unknown key', () => {
    it('rejects unknown setting key', () => {
      const result = validateCountryAmounts('unknown_setting', { NG: 5000 });
      expect(result).not.toBeNull();
      expect(result![0].message).toContain('Unknown');
    });
  });

  describe('multiple errors', () => {
    it('returns errors for each invalid country plus missing countries', () => {
      const result = validateCountryAmounts('minimum_payout', {
        NG: -1,
        US: 'bad',
        GB: 1.5,
      });
      expect(result).not.toBeNull();
      // 3 value errors (NG, US, GB) + 2 missing (CA, GH)
      expect(result!.length).toBe(5);
    });
  });
});
