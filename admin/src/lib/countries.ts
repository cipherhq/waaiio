import { supabase } from './supabase';

export interface CountryRow {
  code: string;
  name: string;
  flag: string;
  dialing_code: string;
  currency_code: string;
  currency_symbol: string;
  currency_locale: string;
  payment_gateway: string;
  phone_digits: number;
  phone_pattern: string;
  phone_placeholder: string;
  cities: Record<string, { name: string; neighborhoods: string[] }>;
  pricing: Record<string, { price: number; feeFlat: number }>;
  verification_tiers: Record<string, { label: string; limit: number; requirements: string }>;
  doc_types: { key: string; label: string; desc: string }[];
  is_active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
  updated_by: string | null;
}

// In-memory cache (60s TTL)
let cache: CountryRow[] | null = null;
let cacheTime = 0;
const CACHE_TTL = 60_000;

function isFresh(): boolean {
  return cache !== null && Date.now() - cacheTime < CACHE_TTL;
}

/** Fetch ALL countries (including inactive) for admin */
export async function loadCountries(): Promise<CountryRow[]> {
  if (isFresh()) return cache!;
  try {
    const { data, error } = await supabase
      .from('countries')
      .select('*')
      .order('sort_order', { ascending: true });
    if (error) throw error;
    cache = (data ?? []) as CountryRow[];
    cacheTime = Date.now();
    return cache;
  } catch {
    return cache ?? [];
  }
}

/** Clear cache (call after admin updates) */
export function invalidateCache(): void {
  cache = null;
  cacheTime = 0;
}

/** Sync: get a single country from cache */
export function getCountry(code: string): CountryRow | null {
  if (!cache) return null;
  return cache.find(c => c.code === code) ?? null;
}

/** Sync: all countries from cache */
export function getCountryList(): CountryRow[] {
  return cache ?? [];
}

/** Sync: get active countries only */
export function getActiveCountries(): CountryRow[] {
  return (cache ?? []).filter(c => c.is_active);
}

export function getCurrencyCode(code: string): string {
  const c = getCountry(code);
  return c?.currency_code ?? 'NGN';
}

/** Build a country-code → currency-code map from the cached countries table.
 *  If cache is empty, returns a minimal fallback. */
export function getCountryCurrencyMap(): Record<string, string> {
  const rows = getCountryList();
  if (rows.length > 0) {
    return Object.fromEntries(rows.map(c => [c.code, c.currency_code]));
  }
  // Fallback until countries are loaded
  return { US: 'USD', CA: 'CAD', GB: 'GBP', NG: 'NGN', GH: 'GHS' };
}

/** Build a country-code → { code, locale } map from the cached countries table.
 *  If cache is empty, returns a minimal fallback. */
export function getCountryCurrencyDetailMap(): Record<string, { code: string; locale: string }> {
  const rows = getCountryList();
  if (rows.length > 0) {
    return Object.fromEntries(rows.map(c => [c.code, { code: c.currency_code, locale: c.currency_locale }]));
  }
  // Fallback until countries are loaded
  return {
    NG: { code: 'NGN', locale: 'en-NG' },
    US: { code: 'USD', locale: 'en-US' },
    GB: { code: 'GBP', locale: 'en-GB' },
    CA: { code: 'CAD', locale: 'en-CA' },
    GH: { code: 'GHS', locale: 'en-GH' },
  };
}

export function getVerificationTiers(code: string) {
  const c = getCountry(code);
  return c?.verification_tiers ?? {};
}

export function getDocTypes(code: string): { key: string; label: string; desc: string }[] {
  const c = getCountry(code);
  return c?.doc_types ?? [];
}

export function getDocTypeLabel(code: string, key: string): string {
  const docs = getDocTypes(code);
  const dt = docs.find(d => d.key === key);
  return dt?.label ?? key.replace(/_/g, ' ');
}

export function getPayoutLimit(code: string, level: string): number {
  const tiers = getVerificationTiers(code);
  return (tiers as Record<string, { limit: number }>)[level]?.limit ?? 0;
}

export function formatPayoutLimit(code: string, level: string): string {
  const limit = getPayoutLimit(code, level);
  if (limit === 0) return 'No payouts';
  if (limit >= 999_999_999) return 'Unlimited';
  const c = getCountry(code);
  const currencyCode = c?.currency_code ?? 'NGN';
  const locale = c?.currency_locale ?? 'en-NG';
  return new Intl.NumberFormat(locale, { style: 'currency', currency: currencyCode, minimumFractionDigits: 0 }).format(limit);
}
