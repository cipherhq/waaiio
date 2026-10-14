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

    it('accepts valid minimum_bank_transfer with one country', () => {
      const result = validateCountryAmounts('minimum_bank_transfer', { NG: 10000 });
      expect(result).toBeNull();
    });

    it('accepts valid minimum_payout', () => {
      const result = validateCountryAmounts('minimum_payout', {
        NG: 5000, US: 2500, GB: 2000, CA: 2500, GH: 50,
      });
      expect(result).toBeNull();
    });

    it('accepts zero as a value', () => {
      const result = validateCountryAmounts('minimum_bank_transfer', { NG: 0 });
      expect(result).toBeNull();
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
    it('rejects {}', () => {
      const result = validateCountryAmounts('minimum_bank_transfer', {});
      expect(result).not.toBeNull();
      expect(result![0].message).toContain('At least one country');
    });
  });

  describe('rejects string values (the "1000" bug)', () => {
    it('rejects string amounts like "1000"', () => {
      const result = validateCountryAmounts('minimum_bank_transfer', { NG: '1000' });
      expect(result).not.toBeNull();
      expect(result![0].field).toBe('NG');
      expect(result![0].message).toContain('number');
    });
  });

  describe('rejects negative numbers', () => {
    it('rejects -1', () => {
      const result = validateCountryAmounts('minimum_bank_transfer', { NG: -1 });
      expect(result).not.toBeNull();
      expect(result![0].message).toContain('0 or greater');
    });
  });

  describe('rejects non-integer numbers', () => {
    it('rejects 1.5', () => {
      const result = validateCountryAmounts('minimum_bank_transfer', { NG: 1.5 });
      expect(result).not.toBeNull();
      expect(result![0].message).toContain('whole number');
    });
  });

  describe('rejects NaN and Infinity', () => {
    it('rejects NaN', () => {
      const result = validateCountryAmounts('minimum_bank_transfer', { NG: NaN });
      expect(result).not.toBeNull();
      expect(result![0].message).toContain('finite');
    });

    it('rejects Infinity', () => {
      const result = validateCountryAmounts('minimum_bank_transfer', { NG: Infinity });
      expect(result).not.toBeNull();
    });
  });

  describe('rejects unknown country codes', () => {
    it('rejects FR for minimum_bank_transfer', () => {
      const result = validateCountryAmounts('minimum_bank_transfer', { FR: 5000 });
      expect(result).not.toBeNull();
      expect(result![0].message).toContain('not allowed');
      expect(result![0].message).toContain('FR');
    });

    it('rejects JP for minimum_payout', () => {
      const result = validateCountryAmounts('minimum_payout', { NG: 5000, JP: 100 });
      expect(result).not.toBeNull();
      expect(result!.some(e => e.field === 'JP')).toBe(true);
    });

    it('accepts NG for minimum_payout even with invalid JP', () => {
      const result = validateCountryAmounts('minimum_payout', { NG: 5000, JP: 100 });
      // JP should have an error, but NG should be fine
      expect(result).not.toBeNull();
      expect(result!.every(e => e.field !== 'NG')).toBe(true);
    });
  });

  describe('rejects nested objects', () => {
    it('rejects { NG: { amount: 5000 } }', () => {
      const result = validateCountryAmounts('minimum_bank_transfer', { NG: { amount: 5000 } });
      expect(result).not.toBeNull();
      expect(result![0].message).toContain('number');
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
    it('returns errors for each invalid country', () => {
      const result = validateCountryAmounts('minimum_payout', {
        NG: -1,
        US: 'bad',
        GB: 1.5,
      });
      expect(result).not.toBeNull();
      expect(result!.length).toBe(3);
    });
  });
});
