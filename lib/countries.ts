import { createClient } from '@/lib/supabase/client';
import { COUNTRIES, registerCountryResolver, type CountryCode, type PaymentGatewayName } from '@/lib/constants';

export interface CountryRow {
  code: string;
  name: string;
  flag: string;
  dialing_code: string;
  currency_code: string;
  currency_symbol: string;
  currency_locale: string;
  payment_gateway: PaymentGatewayName;
  phone_digits: number;
  phone_pattern: string;
  phone_placeholder: string;
  cities: Record<string, { name: string; neighborhoods: string[] }>;
  pricing: Record<string, { price: number; feeFlat: number }>;
  verification_tiers: Record<string, { label: string; limit: number; requirements: string }>;
  doc_types: { key: string; label: string; desc: string }[];
  is_active: boolean;
  sort_order: number;
}

// In-memory cache (60s TTL, matches platform settings pattern)
let cache: CountryRow[] | null = null;
let cacheTime = 0;
const CACHE_TTL = 60_000;

function isFresh(): boolean {
  return cache !== null && Date.now() - cacheTime < CACHE_TTL;
}

/** Async: fetch active countries from DB, populate cache */
export async function loadCountries(): Promise<CountryRow[]> {
  if (isFresh()) return cache!;
  try {
    const supabase = createClient();
    const { data, error } = await supabase
      .from('countries')
      .select('*')
      .eq('is_active', true)
      .order('sort_order', { ascending: true });
    if (error) throw error;
    cache = (data ?? []) as CountryRow[];
    cacheTime = Date.now();
    return cache;
  } catch {
    // On error, keep stale cache or return empty
    return cache ?? [];
  }
}

/** Clear cache (call after admin updates) */
export function invalidateCache(): void {
  cache = null;
  cacheTime = 0;
}

/** Convert hardcoded COUNTRIES entry to CountryRow shape for fallback */
function hardcodedFallback(code: string): CountryRow | null {
  const c = COUNTRIES[code as keyof typeof COUNTRIES];
  if (!c) return null;
  return {
    code,
    name: c.name,
    flag: c.flag,
    dialing_code: c.dialingCode,
    currency_code: c.currencyCode,
    currency_symbol: c.currencySymbol,
    currency_locale: c.currencyLocale,
    payment_gateway: c.paymentGateway,
    phone_digits: c.phoneDigits,
    phone_pattern: c.phonePattern.source,
    phone_placeholder: c.phonePlaceholder,
    cities: c.cities,
    pricing: {},
    verification_tiers: {},
    doc_types: [],
    is_active: true,
    sort_order: 0,
  };
}

/** Sync: get a single country. Reads from cache, falls back to hardcoded. */
export function getCountry(code: string): CountryRow | null {
  if (cache) {
    const found = cache.find(c => c.code === code);
    if (found) return found;
  }
  return hardcodedFallback(code);
}

/** Sync: all countries sorted by sort_order */
export function getCountryList(): CountryRow[] {
  if (cache && cache.length > 0) return cache;
  // Fallback: convert hardcoded countries
  return (Object.keys(COUNTRIES) as CountryCode[]).map(code => hardcodedFallback(code)!);
}

/** Runtime validation */
export function isValidCountryCode(code: string): boolean {
  if (cache && cache.length > 0) {
    return cache.some(c => c.code === code);
  }
  return code in COUNTRIES;
}

// Register with constants.ts so helper functions can resolve DB-backed countries
registerCountryResolver(getCountry);
