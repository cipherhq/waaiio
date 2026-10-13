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

// ── State/province index ──────────────────────────────
// Curated list of states/provinces + common aliases.
// Used for "businesses in Maryland", "spa in Oyo", etc.

interface StateEntry {
  name: string;
  /** Aliases that should resolve to this state (e.g., "DC" → "District of Columbia") */
  aliases: string[];
  countryCode: CountryCode;
}

const STATE_DATA: StateEntry[] = [
  // Nigeria
  { name: 'Lagos', aliases: [], countryCode: 'NG' },
  { name: 'Oyo', aliases: [], countryCode: 'NG' },
  { name: 'Rivers', aliases: [], countryCode: 'NG' },
  { name: 'Abuja', aliases: ['fct', 'federal capital territory'], countryCode: 'NG' },
  { name: 'Ogun', aliases: [], countryCode: 'NG' },
  { name: 'Enugu', aliases: [], countryCode: 'NG' },
  { name: 'Anambra', aliases: [], countryCode: 'NG' },
  { name: 'Kano', aliases: [], countryCode: 'NG' },
  { name: 'Kaduna', aliases: [], countryCode: 'NG' },
  { name: 'Delta', aliases: [], countryCode: 'NG' },
  // Ghana
  { name: 'Greater Accra', aliases: ['accra region'], countryCode: 'GH' },
  { name: 'Ashanti', aliases: ['kumasi region'], countryCode: 'GH' },
  // US
  { name: 'New York', aliases: ['ny'], countryCode: 'US' },
  { name: 'California', aliases: ['ca'], countryCode: 'US' },
  { name: 'Texas', aliases: ['tx'], countryCode: 'US' },
  { name: 'Georgia', aliases: ['ga'], countryCode: 'US' },
  { name: 'Maryland', aliases: ['md'], countryCode: 'US' },
  { name: 'District of Columbia', aliases: ['dc', 'washington dc', 'washington d.c.'], countryCode: 'US' },
  { name: 'Florida', aliases: ['fl'], countryCode: 'US' },
  { name: 'Illinois', aliases: ['il'], countryCode: 'US' },
  // UK
  { name: 'England', aliases: [], countryCode: 'GB' },
  { name: 'Greater London', aliases: ['london region'], countryCode: 'GB' },
  { name: 'Greater Manchester', aliases: [], countryCode: 'GB' },
  { name: 'West Midlands', aliases: [], countryCode: 'GB' },
  // Canada
  { name: 'Ontario', aliases: ['on'], countryCode: 'CA' },
  { name: 'Alberta', aliases: ['ab'], countryCode: 'CA' },
  { name: 'British Columbia', aliases: ['bc'], countryCode: 'CA' },
];

/** state name (lowercase) → StateEntry */
const stateIndex: Map<string, StateEntry> = new Map();
for (const s of STATE_DATA) {
  stateIndex.set(s.name.toLowerCase(), s);
  for (const alias of s.aliases) {
    stateIndex.set(alias.toLowerCase(), s);
  }
}

// ── Phone country dialing code map ────────────────────
// Used for ambiguity resolution: "Maryland" from +234 = Lagos neighborhood,
// from +1 = US state.
const DIALING_CODE_TO_COUNTRY: Record<string, CountryCode> = {
  '+234': 'NG', '+233': 'GH', '+1': 'US', '+44': 'GB',
};

/**
 * Resolve phone country from a dialing code prefix.
 * "+1" maps to US (not CA) by default — CA shares +1 but US is more common.
 */
export function phoneCountryFromDialingCode(phone: string): CountryCode | null {
  if (!phone) return null;
  const p = phone.startsWith('+') ? phone : `+${phone}`;
  for (const [prefix, cc] of Object.entries(DIALING_CODE_TO_COUNTRY)) {
    if (p.startsWith(prefix)) return cc;
  }
  return null;
}

// ── Public API ──────────────────────────────────────────

/**
 * Resolve a single location token against the COUNTRIES lookup data.
 *
 * Returns a typed resolution with tier, city filter, optional address hint,
 * and optional country code. The caller uses these to build the Supabase query.
 */
export function resolveLocation(
  locationToken: string,
  phoneCountryCode?: CountryCode | null,
): LocationResolution {
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
  // Ambiguity: a city name can appear in multiple countries. Prefer the
  // user's phone country if available.
  const cityMatches = cityIndex.filter((c) => c.name.toLowerCase() === lower);
  if (cityMatches.length === 1) {
    return {
      tier: 1,
      city: cityMatches[0].name,
      addressHint: null,
      countryCode: null,
      parentCityLabel: cityMatches[0].name,
      resolvedTerm: term,
    };
  }
  if (cityMatches.length > 1) {
    // Disambiguate by phone country
    const preferred = phoneCountryCode
      ? cityMatches.find((c) => c.countryCode === phoneCountryCode)
      : null;
    if (preferred) {
      return {
        tier: 1,
        city: preferred.name,
        addressHint: null,
        countryCode: preferred.countryCode,
        parentCityLabel: preferred.name,
        resolvedTerm: term,
      };
    }
    // Multiple matches, no phone hint — tier 3 with candidates
    return {
      tier: 3,
      city: null,
      addressHint: null,
      countryCode: null,
      parentCityLabel: null,
      resolvedTerm: term,
    };
  }

  // 3. Neighbourhood substring match (e.g., "Lekki" matches "Lekki Phase 1")
  // Also handles "Maryland" → neighborhood of Lagos for NG users.
  const nMatches = neighborhoodIndex.filter((n) =>
    n.name.toLowerCase().includes(lower),
  );
  if (nMatches.length > 0) {
    // Prefer phone country if ambiguous
    const preferred = phoneCountryCode
      ? nMatches.find((n) => n.countryCode === phoneCountryCode)
      : nMatches[0];
    const nMatch = preferred || nMatches[0];
    return {
      tier: 2,
      city: nMatch.parentCityName,
      addressHint: term,
      countryCode: nMatch.countryCode,
      parentCityLabel: nMatch.parentCityName,
      resolvedTerm: term,
    };
  }

  // 4. State/province match (e.g., "Oyo", "DC", "Maryland" for US users)
  const stateMatch = stateIndex.get(lower);
  if (stateMatch) {
    // If this state name also matches a neighborhood in a different country,
    // disambiguate by phone country. E.g., "Maryland" is both a US state and
    // a Lagos neighborhood. +234 → Lagos neighborhood (handled above),
    // +1 → US state (handled here).
    return {
      tier: 1,
      city: null,
      addressHint: null,
      countryCode: stateMatch.countryCode,
      parentCityLabel: stateMatch.name,
      resolvedTerm: term,
    };
  }

  // 5. Unknown location — tier 3 (caller should ask for clarification)
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
