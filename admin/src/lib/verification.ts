// Per-country verification configuration
// Now delegates to admin/src/lib/countries.ts (DB-backed) with hardcoded fallback

import {
  getCountry,
  getVerificationTiers as dbGetVerificationTiers,
  getPayoutLimit as dbGetPayoutLimit,
  getCurrencyCode as dbGetCurrencyCode,
  getDocTypes as dbGetDocTypes,
  getDocTypeLabel as dbGetDocTypeLabel,
  formatPayoutLimit as dbFormatPayoutLimit,
} from './countries';

export type CountryCode = string;
export type VerificationLevel = 'unverified' | 'basic' | 'standard' | 'full';

export interface DocTypeConfig {
  key: string;
  label: string;
  desc: string;
}

// Hardcoded fallbacks (only used before cache loads)
const FALLBACK_CURRENCIES: Record<string, { code: string; symbol: string }> = {
  NG: { code: 'NGN', symbol: '₦' },
  US: { code: 'USD', symbol: '$' },
  GB: { code: 'GBP', symbol: '£' },
  CA: { code: 'CAD', symbol: 'CA$' },
  GH: { code: 'GHS', symbol: 'GH₵' },
};

export function getVerificationTiers(cc: CountryCode = 'NG') {
  const db = dbGetVerificationTiers(cc);
  if (db && Object.keys(db).length > 0) return db;
  // fallback for NG if DB not loaded yet
  return {
    unverified: { label: 'Unverified', limit: 0, requirements: 'Just signed up' },
    basic: { label: 'Basic', limit: 500_000, requirements: 'Email + Phone + Bank verified' },
    standard: { label: 'Standard', limit: 5_000_000, requirements: '+ Business document' },
    full: { label: 'Full', limit: 999_999_999, requirements: '+ Government ID + Address proof' },
  };
}

export function getPayoutLimit(cc: CountryCode, level: VerificationLevel): number {
  const limit = dbGetPayoutLimit(cc, level);
  if (limit > 0 || getCountry(cc)) return limit;
  return 0;
}

export function getCurrencyCode(cc: CountryCode): string {
  const db = dbGetCurrencyCode(cc);
  if (db !== 'NGN' || cc === 'NG') return db;
  // Fallback
  return (FALLBACK_CURRENCIES[cc] || FALLBACK_CURRENCIES.NG).code;
}

export function getDocTypes(cc: CountryCode): DocTypeConfig[] {
  return dbGetDocTypes(cc);
}

export function getDocTypeLabel(cc: CountryCode, key: string): string {
  return dbGetDocTypeLabel(cc, key);
}

export function formatPayoutLimit(cc: CountryCode, level: VerificationLevel): string {
  const result = dbFormatPayoutLimit(cc, level);
  if (result !== 'No payouts' || level === 'unverified') return result;
  // Fallback
  const { code } = FALLBACK_CURRENCIES[cc] || FALLBACK_CURRENCIES.NG;
  const locale = code === 'NGN' ? 'en-NG' : code === 'GHS' ? 'en-GH' : 'en-US';
  return new Intl.NumberFormat(locale, { style: 'currency', currency: code, minimumFractionDigits: 0 }).format(0);
}

export const LEVEL_LABELS: Record<string, string> = {
  unverified: 'Unverified',
  basic: 'Basic',
  standard: 'Standard',
  full: 'Full',
};

export const LEVEL_COLORS: Record<string, string> = {
  unverified: 'bg-gray-100 text-gray-600',
  basic: 'bg-blue-100 text-blue-700',
  standard: 'bg-purple-100 text-purple-700',
  full: 'bg-green-100 text-green-700',
};
