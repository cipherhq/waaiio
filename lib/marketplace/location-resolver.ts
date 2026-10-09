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
 * Resolve a compound location string (possibly comma-separated).
 *
 * For "Lekki, Lagos": resolves "Lekki" first (tier 2 → neighbourhood),
 * then "Lagos" (tier 1 → city). Returns the most specific resolution.
 *
 * Priority:
 * - Neighbourhood hit wins over city (more specific)
 * - City hit wins over country
 * - If all tokens are unknown → tier 3
 */
export function resolveCompoundLocation(locationText: string): LocationResolution {
  const tokens = locationText
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .slice(0, 3);

  if (tokens.length === 0) {
    return { tier: 3, city: null, addressHint: null, countryCode: null, parentCityLabel: null, resolvedTerm: locationText };
  }

  // Resolve each token independently
  const resolutions = tokens.map((t) => resolveLocation(t));

  // Pick the most specific: tier 2 > tier 1 > tier 3
  const tier2 = resolutions.find((r) => r.tier === 2);
  if (tier2) return tier2;

  const tier1 = resolutions.find((r) => r.tier === 1);
  if (tier1) return tier1;

  // All unknown — return tier 3 with the full text
  return {
    tier: 3,
    city: null,
    addressHint: null,
    countryCode: null,
    parentCityLabel: null,
    resolvedTerm: locationText,
  };
}
