/**
 * Location Resolver — maps user-supplied location text to structured
 * city/state/address-hint criteria using the curated COUNTRIES data.
 *
 * Three resolution tiers:
 *   Tier 1 — City-level match (reliable, from Google Places `locality`)
 *   Tier 2 — Neighbourhood hint (best-effort, parent city + address ILIKE)
 *   Tier 3 — Unknown location (fail to clarification, never silently broaden)
 *
 * Phase B / #584 — independently testable, no bot.service.ts dependency.
 */

import { COUNTRIES, type CountryCode } from '@/lib/constants';

// ── Types ───────────────────────────────────────────────

export interface LocationResolution {
  /** Resolution tier: 1 = city, 2 = neighbourhood hint, 3 = unknown */
  tier: 1 | 2 | 3;
  /** City name to use in `city.ilike` filter (null for tier 3). */
  city: string | null;
  /** Address hint for tier 2 neighbourhood narrowing (null otherwise). */
  addressHint: string | null;
  /** Country code if explicitly resolved from country name (null otherwise). */
  countryCode: string | null;
  /** Parent city display name for user-facing labels (e.g., "Lagos"). */
  parentCityLabel: string | null;
  /** The raw location term that was resolved. */
  resolvedTerm: string;
}

// ── Build lookup indices from COUNTRIES ──────────────────

interface CityEntry {
  name: string;
  key: string;
  countryCode: CountryCode;
}

interface NeighborhoodEntry {
  name: string;
  parentCityName: string;
  parentCityKey: string;
  countryCode: CountryCode;
}

const cityIndex: CityEntry[] = [];
const neighborhoodIndex: NeighborhoodEntry[] = [];
const countryNameIndex: Map<string, CountryCode> = new Map();

for (const [cc, config] of Object.entries(COUNTRIES) as [CountryCode, typeof COUNTRIES[CountryCode]][]) {
  countryNameIndex.set(config.name.toLowerCase(), cc);
  for (const [key, city] of Object.entries(config.cities)) {
    cityIndex.push({ name: city.name, key, countryCode: cc });
    for (const n of city.neighborhoods) {
      neighborhoodIndex.push({
        name: n,
        parentCityName: city.name,
        parentCityKey: key,
        countryCode: cc,
      });
    }
  }
}

// ── Public API ──────────────────────────────────────────

/**
 * Resolve a single location token against the COUNTRIES lookup data.
 *
 * Returns a typed resolution with tier, city filter, optional address hint,
 * and optional country code. The caller uses these to build the Supabase query.
 */
export function resolveLocation(locationToken: string): LocationResolution {
  const term = locationToken.trim();
  if (!term) {
    return { tier: 3, city: null, addressHint: null, countryCode: null, parentCityLabel: null, resolvedTerm: term };
  }

  const lower = term.toLowerCase();

  // 1. Country name match
  const cc = countryNameIndex.get(lower);
  if (cc) {
    return {
      tier: 1,
      city: null,
      addressHint: null,
      countryCode: cc,
      parentCityLabel: null,
      resolvedTerm: term,
    };
  }

  // 2. Exact city name match (case-insensitive)
  const cityMatch = cityIndex.find((c) => c.name.toLowerCase() === lower);
  if (cityMatch) {
    return {
      tier: 1,
      city: cityMatch.name,
      addressHint: null,
      countryCode: null,
      parentCityLabel: cityMatch.name,
      resolvedTerm: term,
    };
  }

  // 3. Neighbourhood substring match (e.g., "Lekki" matches "Lekki Phase 1")
  const nMatch = neighborhoodIndex.find((n) =>
    n.name.toLowerCase().includes(lower),
  );
  if (nMatch) {
    return {
      tier: 2,
      city: nMatch.parentCityName,
      addressHint: term,
      countryCode: null,
      parentCityLabel: nMatch.parentCityName,
      resolvedTerm: term,
    };
  }

  // 4. Unknown location — tier 3 (caller should ask for clarification)
  return {
    tier: 3,
    city: null,
    addressHint: null,
    countryCode: null,
    parentCityLabel: null,
    resolvedTerm: term,
  };
}

/**
 * Resolve a compound location only when all stated places are compatible.
 * Unknown/conflicting parts are ambiguous: the caller must clarify, never
 * silently select one part of the customer's location request.
 */
export function resolveCompoundLocation(locationText: string): LocationResolution {
  const unknown = (): LocationResolution => ({
    tier: 3,
    city: null,
    addressHint: null,
    countryCode: null,
    parentCityLabel: null,
    resolvedTerm: locationText,
  });

  if (locationText.length > 160) return unknown();
  const tokens = locationText.split(',').map((t) => t.trim());
  if (tokens.length < 1 || tokens.length > 3 || tokens.some((t) => !t)) {
    return unknown();
  }

  const matches = tokens.map(resolveLocation);
  if (matches.some((r) => r.tier === 3)) return unknown();

  const neighborhoods = matches.filter((r) => r.tier === 2);
  const cities = matches.filter((r) => r.tier === 1 && r.city !== null);
  const countries = matches.filter((r) => r.tier === 1 && r.countryCode !== null);

  const unique = (values: string[]) => new Set(values.map((v) => v.toLowerCase())).size <= 1;
  if (!unique(neighborhoods.map((r) => r.addressHint!))) return unknown();
  if (!unique(cities.map((r) => r.city!))) return unknown();
  if (!unique(countries.map((r) => r.countryCode!))) return unknown();

  const mostSpecific = neighborhoods[0] || cities[0] || countries[0];
  const requiredCity = mostSpecific.city;
  if (requiredCity && cities.some((r) => r.city!.toLowerCase() !== requiredCity.toLowerCase())) {
    return unknown();
  }

  // City-country compatibility is verified using the curated location index,
  // without implying that an isolated city query automatically sets a country filter.
  const requiredCountry = countries[0]?.countryCode;
  if (requiredCountry && requiredCity) {
    const cityCountry = cityIndex.find((c) => c.name.toLowerCase() === requiredCity.toLowerCase());
    if (!cityCountry || cityCountry.countryCode !== requiredCountry) return unknown();
  }

  return mostSpecific;
}
