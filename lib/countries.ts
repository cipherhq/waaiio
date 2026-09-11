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

/** Sync: get a single country from DB cache. Returns null if not cached. */
export function getCountry(code: string): CountryRow | null {
  if (cache) {
    return cache.find(c => c.code === code) ?? null;
  }
  return null;
}

/** Sync: all active countries from DB cache. Returns empty if cache not populated. */
export function getCountryList(): CountryRow[] {
  return cache ?? [];
}

/** Runtime validation — fail-closed: returns false if cache not populated. */
export function isValidCountryCode(code: string): boolean {
  if (cache && cache.length > 0) {
    return cache.some(c => c.code === code);
  }
  return false;
}

/** Build dialing-code → country-code mapping from DB cache */
export function getDialingCodeMap(): Record<string, string[]> {
  const map: Record<string, string[]> = {};
  for (const c of cache ?? []) {
    if (!c.dialing_code) continue;
    if (!map[c.dialing_code]) map[c.dialing_code] = [];
    map[c.dialing_code].push(c.code);
  }
  return map;
}

// Register with constants.ts so helper functions can resolve DB-backed countries
registerCountryResolver(getCountry);
