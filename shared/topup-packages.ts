/**
 * Top-Up Packages Validation
 *
 * Shared validation rules for the messaging_topup_packages platform setting.
 * Shape: { [currencyCode: string]: Array<{ amount_minor: number; label: string; description?: string }> }
 *
 * Validation mirrors M416 save_commercial_config write-time validation and is
 * used by:
 *   - Next.js route: app/api/admin/platform-settings/commercial/route.ts
 *   - Admin component: admin/src/pages/PlatformSettings.tsx
 *
 * Framework-neutral — no React, Next.js, or Vite imports.
 */

/** ISO 4217 currency codes the app supports — must match lib/constants.ts country configs */
export const TOPUP_ALLOWED_CURRENCIES = ['NGN', 'GHS', 'USD', 'GBP', 'CAD'] as const;
export type TopupCurrency = (typeof TOPUP_ALLOWED_CURRENCIES)[number];

/**
 * Maximum character length for a package label.
 * The billing page renders the label inside a button span; 50 chars prevents overflow.
 * There is no WhatsApp interactive list path for topup packages currently.
 */
export const TOPUP_LABEL_MAX_LEN = 50;

/**
 * Maximum character length for an optional package description.
 * Description is stored but not currently rendered in billing UI. Cap is generous
 * (200 chars) purely for data hygiene and to guard against accidental huge strings.
 */
export const TOPUP_DESCRIPTION_MAX_LEN = 200;

/**
 * Maximum amount_minor per package.
 * 10,000,000,000 = 10B minor units ≈ $100M USD / ₦100M NGN.
 * Prevents accidental entry of absurdly large amounts.
 */
export const TOPUP_AMOUNT_MINOR_MAX = 10_000_000_000;

/**
 * Maximum number of packages per currency.
 * Matches the WhatsApp interactive list section row limit for future-proofing.
 */
export const TOPUP_MAX_PACKAGES_PER_CURRENCY = 10;

/**
 * Known keys on a TopupPackage object.
 * Extra keys are rejected to prevent unintentional data in the DB and to surface
 * copy-paste errors (e.g. a field from a different schema pasted into a package).
 */
export const KNOWN_PACKAGE_KEYS = new Set(['amount_minor', 'label', 'description']);

/** Display symbols for major-unit labels */
export const TOPUP_CURRENCY_SYMBOLS: Record<TopupCurrency, string> = {
  NGN: '\u20A6',    // ₦
  GHS: 'GH\u20B5', // GH₵
  USD: '$',
  GBP: '\u00A3',   // £
  CAD: 'CA$',
};

/** Display names */
export const TOPUP_CURRENCY_NAMES: Record<TopupCurrency, string> = {
  NGN: 'Nigerian Naira',
  GHS: 'Ghanaian Cedi',
  USD: 'US Dollar',
  GBP: 'British Pound',
  CAD: 'Canadian Dollar',
};

/**
 * Minor-units per major unit for each currency.
 * All supported currencies use 100 (e.g. ₦1 = 100 kobo, $1 = 100 cents).
 */
export const TOPUP_MINOR_PER_MAJOR: Record<TopupCurrency, number> = {
  NGN: 100,
  GHS: 100,
  USD: 100,
  GBP: 100,
  CAD: 100,
};

export interface TopupPackage {
  amount_minor: number;
  label: string;
  description?: string;
}

export interface TopupPackagesValidationError {
  field: string;
  message: string;
}

export function isTopupPackagesKey(key: string): boolean {
  return key === 'messaging_topup_packages';
}

/**
 * Validate the messaging_topup_packages value.
 * Returns null if valid, or an array of errors.
 *
 * Rules (mirror M416 save_commercial_config):
 * - Must be a plain object (not null, not an array)
 * - Each key must be a non-empty, known currency code
 * - Each value must be an array of package objects with ≤ TOPUP_MAX_PACKAGES_PER_CURRENCY entries
 * - Each package must have only known keys (amount_minor, label, description)
 * - Each package must have:
 *     amount_minor: positive integer (> 0, no decimals, ≤ TOPUP_AMOUNT_MINOR_MAX)
 *     label: non-empty string (≤ TOPUP_LABEL_MAX_LEN chars)
 *     description: optional string (≤ TOPUP_DESCRIPTION_MAX_LEN chars)
 * - No duplicate amount_minor values within a currency
 */
export function validateTopupPackages(
  value: unknown,
): TopupPackagesValidationError[] | null {
  if (value === null || value === undefined) {
    return [{ field: 'root', message: 'Value is required' }];
  }

  if (typeof value !== 'object' || Array.isArray(value)) {
    return [{ field: 'root', message: 'Value must be an object keyed by currency code' }];
  }

  const obj = value as Record<string, unknown>;
  const errors: TopupPackagesValidationError[] = [];

  for (const [currency, packages] of Object.entries(obj)) {
    // Empty key
    if (!currency) {
      errors.push({ field: '', message: 'Currency key must not be empty' });
      continue;
    }

    // Unknown currency
    if (!(TOPUP_ALLOWED_CURRENCIES as readonly string[]).includes(currency)) {
      errors.push({
        field: currency,
        message: `"${currency}" is not an allowed currency code. Allowed: ${TOPUP_ALLOWED_CURRENCIES.join(', ')}`,
      });
      continue;
    }

    // Packages must be array
    if (!Array.isArray(packages)) {
      errors.push({
        field: currency,
        message: `${currency}: packages must be an array`,
      });
      continue;
    }

    // Max packages per currency
    if (packages.length > TOPUP_MAX_PACKAGES_PER_CURRENCY) {
      errors.push({
        field: currency,
        message: `${currency}: at most ${TOPUP_MAX_PACKAGES_PER_CURRENCY} packages per currency (got ${packages.length})`,
      });
      continue;
    }

    const seenAmounts = new Set<number>();

    for (let i = 0; i < packages.length; i++) {
      const pkg = packages[i];

      if (typeof pkg !== 'object' || pkg === null || Array.isArray(pkg)) {
        errors.push({
          field: `${currency}[${i}]`,
          message: `${currency}[${i}]: each package must be an object`,
        });
        continue;
      }

      const p = pkg as Record<string, unknown>;

      // Unknown keys
      for (const k of Object.keys(p)) {
        if (!KNOWN_PACKAGE_KEYS.has(k)) {
          errors.push({
            field: `${currency}[${i}].${k}`,
            message: `${currency}[${i}]: unknown field "${k}" — allowed fields are: ${[...KNOWN_PACKAGE_KEYS].join(', ')}`,
          });
        }
      }

      // amount_minor validation
      const am = p['amount_minor'];
      if (am === undefined || am === null) {
        errors.push({
          field: `${currency}[${i}].amount_minor`,
          message: `${currency}[${i}]: amount_minor is required`,
        });
      } else if (typeof am !== 'number') {
        errors.push({
          field: `${currency}[${i}].amount_minor`,
          message: `${currency}[${i}]: amount_minor must be a number`,
        });
      } else if (!Number.isFinite(am)) {
        errors.push({
          field: `${currency}[${i}].amount_minor`,
          message: `${currency}[${i}]: amount_minor must be finite`,
        });
      } else if (am <= 0) {
        errors.push({
          field: `${currency}[${i}].amount_minor`,
          message: `${currency}[${i}]: amount_minor must be greater than 0`,
        });
      } else if (!Number.isInteger(am)) {
        errors.push({
          field: `${currency}[${i}].amount_minor`,
          message: `${currency}[${i}]: amount_minor must be a whole number (no decimals)`,
        });
      } else if (am > TOPUP_AMOUNT_MINOR_MAX) {
        errors.push({
          field: `${currency}[${i}].amount_minor`,
          message: `${currency}[${i}]: amount_minor must not exceed ${TOPUP_AMOUNT_MINOR_MAX}`,
        });
      } else if (seenAmounts.has(am)) {
        errors.push({
          field: `${currency}[${i}].amount_minor`,
          message: `${currency}: duplicate amount_minor ${am}`,
        });
      } else {
        seenAmounts.add(am);
      }

      // label validation
      const lbl = p['label'];
      if (lbl === undefined || lbl === null) {
        errors.push({
          field: `${currency}[${i}].label`,
          message: `${currency}[${i}]: label is required`,
        });
      } else if (typeof lbl !== 'string') {
        errors.push({
          field: `${currency}[${i}].label`,
          message: `${currency}[${i}]: label must be a string`,
        });
      } else if (!(lbl as string).trim()) {
        errors.push({
          field: `${currency}[${i}].label`,
          message: `${currency}[${i}]: label must not be empty`,
        });
      } else if ((lbl as string).length > TOPUP_LABEL_MAX_LEN) {
        errors.push({
          field: `${currency}[${i}].label`,
          message: `${currency}[${i}]: label must not exceed ${TOPUP_LABEL_MAX_LEN} characters`,
        });
      }

      // description validation (optional)
      const desc = p['description'];
      if (desc !== undefined && desc !== null) {
        if (typeof desc !== 'string') {
          errors.push({
            field: `${currency}[${i}].description`,
            message: `${currency}[${i}]: description must be a string`,
          });
        } else if ((desc as string).length > TOPUP_DESCRIPTION_MAX_LEN) {
          errors.push({
            field: `${currency}[${i}].description`,
            message: `${currency}[${i}]: description must not exceed ${TOPUP_DESCRIPTION_MAX_LEN} characters`,
          });
        }
      }
    }
  }

  return errors.length > 0 ? errors : null;
}
