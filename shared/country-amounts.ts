/**
 * Country-Amount Validation
 *
 * Shared validation rules for platform settings that store per-country amounts:
 * - minimum_bank_transfer: NG, GH only (bank transfer is NG/GH only)
 * - minimum_payout: NG, US, GB, CA, GH
 *
 * Both settings store values in whole (major) currency units.
 *
 * Framework-neutral — no React, Next.js, or Vite imports.
 */

/** Allowed country codes per setting key */
export const COUNTRY_AMOUNT_COUNTRIES: Record<string, readonly string[]> = {
  minimum_bank_transfer: ['NG', 'GH'],
  minimum_payout: ['NG', 'US', 'GB', 'CA', 'GH'],
} as const;

/** Currency symbols for display */
export const COUNTRY_CURRENCY_SYMBOLS: Record<string, string> = {
  NG: '\u20A6',   // ₦
  GH: 'GH\u20B5', // GH₵
  US: '$',
  GB: '\u00A3',   // £
  CA: 'CA$',
};

/** Country display names */
export const COUNTRY_NAMES: Record<string, string> = {
  NG: 'Nigeria',
  GH: 'Ghana',
  US: 'United States',
  GB: 'United Kingdom',
  CA: 'Canada',
};

/** Help text for each country-amount key */
export const COUNTRY_AMOUNT_HELP: Record<string, string> = {
  minimum_bank_transfer:
    'Smallest order total (in local currency) where customers can pay by direct bank transfer.',
  minimum_payout:
    'Minimum earnings before a business receives an automatic payout, in local currency.',
};

/** All keys that use the country-amount format */
export const COUNTRY_AMOUNT_KEYS = Object.keys(COUNTRY_AMOUNT_COUNTRIES);

export function isCountryAmountKey(key: string): boolean {
  return key in COUNTRY_AMOUNT_COUNTRIES;
}

export interface CountryAmountError {
  field: string;
  message: string;
}

/**
 * Validate a country-amount value for a given setting key.
 * Returns null if valid, or an array of errors.
 *
 * Rules:
 * - Must be a plain object (not null, not an array, not a string)
 * - Every allowed country for the key must be present (no silent omissions)
 * - Keys must be allowed country codes for the setting
 * - Values must be finite, non-negative integers (no strings, no floats, no NaN)
 */
export function validateCountryAmounts(
  key: string,
  value: unknown,
): CountryAmountError[] | null {
  const allowedCountries = COUNTRY_AMOUNT_COUNTRIES[key];
  if (!allowedCountries) {
    return [{ field: key, message: `Unknown country-amount key: ${key}` }];
  }

  if (value === null || value === undefined) {
    return [{ field: key, message: 'Value is required' }];
  }

  if (typeof value !== 'object' || Array.isArray(value)) {
    return [{ field: key, message: 'Value must be an object keyed by country code' }];
  }

  const obj = value as Record<string, unknown>;
  const errors: CountryAmountError[] = [];

  // Every allowed country must be present
  for (const cc of allowedCountries) {
    if (!(cc in obj)) {
      const name = COUNTRY_NAMES[cc] || cc;
      errors.push({ field: cc, message: `${name} (${cc}): amount is required` });
    }
  }

  // Validate each provided key
  for (const countryCode of Object.keys(obj)) {
    if (!allowedCountries.includes(countryCode)) {
      errors.push({
        field: countryCode,
        message: `Country "${countryCode}" is not allowed for ${key}. Allowed: ${allowedCountries.join(', ')}`,
      });
      continue;
    }

    const amount = obj[countryCode];

    if (typeof amount !== 'number') {
      errors.push({
        field: countryCode,
        message: `${countryCode}: value must be a number, got ${typeof amount}`,
      });
      continue;
    }

    if (!Number.isFinite(amount)) {
      errors.push({ field: countryCode, message: `${countryCode}: value must be finite` });
      continue;
    }

    if (amount < 0) {
      errors.push({ field: countryCode, message: `${countryCode}: value must be 0 or greater` });
      continue;
    }

    if (!Number.isInteger(amount)) {
      errors.push({ field: countryCode, message: `${countryCode}: value must be a whole number` });
    }
  }

  return errors.length > 0 ? errors : null;
}
