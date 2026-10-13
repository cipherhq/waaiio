/**
 * Directory Search Query Parser
 *
 * Parses natural language directory search queries like:
 *   "spa in Lagos", "restaurants in Ibadan", "salon in Maryland",
 *   "barber near me", "Kitchen Inn", "spa for Lekki", "barber wey dey Ikeja"
 *
 * Splits on the LAST standalone preposition, expands category synonyms
 * via detectCategoryIntent, and resolves locations via resolveLocation.
 *
 * Phase B / #584 — pure, deterministic, no side effects.
 */

import { detectCategoryIntent } from '@/lib/bot/fuzzy-match';
import { resolveLocation, type LocationResolution } from './location-resolver';

// ── Types ──────────────────────────────────────────────

export interface DirectoryQueryResult {
  /** Matched category keys (e.g., ['restaurant', 'spa']). */
  categories: string[];
  /** Raw location text extracted from the query (null if none). */
  locationText: string | null;
  /** Structured location resolution (null if no location extracted). */
  resolvedLocation: LocationResolution | null;
  /** True when the user said "near me" or provided no location. */
  needsLocation: boolean;
  /** Fallback: the raw query treated as a business name search. */
  nameQuery: string | null;
  /** Location candidates with country codes (for multi-country disambiguation). */
  candidates?: Array<{ name: string; countryCode: string }>;
}

// ── Preposition patterns ───────────────────────────────

/**
 * Prepositions that split "category PREP location".
 * Order does not matter — we always match the LAST occurrence.
 *
 * Each pattern must match as a standalone word (word boundaries)
 * to avoid splitting "Kitchen Inn" on the "in" inside "Inn".
 */
const SPLIT_PREPOSITIONS = [
  'in',
  'near',
  'around',
  'at',
  // Pidgin English
  'for',
  'wey dey',
];

/**
 * Build a regex that matches the LAST standalone preposition in the string.
 * Uses word boundaries (\b) to ensure we don't split inside words.
 *
 * "wey dey" is multi-word so it needs special handling — it's placed first
 * in the alternation so it matches before "for" alone could.
 */
function buildSplitRegex(): RegExp {
  // Sort longer patterns first so "wey dey" matches before single words
  const sorted = [...SPLIT_PREPOSITIONS].sort((a, b) => b.length - a.length);
  const alternatives = sorted.map((p) => p.replace(/\s+/g, '\\s+'));
  // Global + case-insensitive; we'll find the last match
  return new RegExp(`\\b(${alternatives.join('|')})\\b`, 'gi');
}

const SPLIT_RE = buildSplitRegex();

/**
 * "near me" pattern — if the location part is exactly "me", the user
 * wants geolocation and we should ask for their location.
 */
const NEAR_ME_RE = /^me$/i;

// ── Public API ─────────────────────────────────────────

/**
 * Parse a directory search query into structured parts.
 *
 * @param rawQuery       The user's raw search input.
 * @param phoneCountryCode  Optional ISO country code from the user's phone number
 *                          (e.g., "NG", "US"). Not used for parsing but passed
 *                          through for downstream filtering.
 */
export function parseDirectoryQuery(
  rawQuery: string,
  phoneCountryCode?: string | null,
): DirectoryQueryResult {
  const trimmed = rawQuery.trim();

  if (!trimmed) {
    return {
      categories: [],
      locationText: null,
      resolvedLocation: null,
      needsLocation: true,
      nameQuery: null,
    };
  }

  // ── Try to split on the last standalone preposition ──

  const { categoryPart, locationPart, preposition } = splitOnLastPreposition(trimmed);

  // ── "near me" detection ──
  if (locationPart !== null && NEAR_ME_RE.test(locationPart.trim())) {
    const categories = detectCategoryIntent(categoryPart);
    return {
      categories,
      locationText: null,
      resolvedLocation: null,
      needsLocation: true,
      nameQuery: categories.length === 0 ? categoryPart : null,
    };
  }

  // ── Category detection ──
  const categories = categoryPart ? detectCategoryIntent(categoryPart) : [];

  // ── Location resolution ──
  let locationText: string | null = null;
  let resolvedLocation: LocationResolution | null = null;
  let needsLocation = false;

  if (locationPart !== null && locationPart.trim()) {
    locationText = locationPart.trim();
    resolvedLocation = resolveLocation(locationText);
  }

  // ── If we split successfully ──
  if (categoryPart && locationPart !== null) {
    return {
      categories,
      locationText,
      resolvedLocation,
      needsLocation: false,
      nameQuery: categories.length === 0 ? categoryPart : null,
    };
  }

  // ── No preposition found — entire input is one thing ──
  // Try as category first, then as location, then as name fallback.

  const fullCategories = detectCategoryIntent(trimmed);
  if (fullCategories.length > 0) {
    // Pure category query: "restaurants", "barber"
    return {
      categories: fullCategories,
      locationText: null,
      resolvedLocation: null,
      needsLocation: true,
      nameQuery: null,
    };
  }

  // Try as pure location: "Lagos", "Lekki"
  const locationAttempt = resolveLocation(trimmed);
  if (locationAttempt.tier < 3) {
    return {
      categories: [],
      locationText: trimmed,
      resolvedLocation: locationAttempt,
      needsLocation: false,
      nameQuery: null,
    };
  }

  // ── Fallback: treat entire input as a name query ──
  return {
    categories: [],
    locationText: null,
    resolvedLocation: null,
    needsLocation: false,
    nameQuery: trimmed,
  };
}

// ── Internal helpers ───────────────────────────────────

interface SplitResult {
  categoryPart: string;
  locationPart: string | null;
  preposition: string | null;
}

/**
 * Find the LAST standalone preposition and split around it.
 * Returns the category (left) and location (right) parts.
 *
 * If no preposition is found, returns the full string as categoryPart
 * with locationPart = null.
 */
function splitOnLastPreposition(text: string): SplitResult {
  // Reset the global regex
  SPLIT_RE.lastIndex = 0;

  let lastMatch: { index: number; length: number; matched: string } | null = null;

  let match: RegExpExecArray | null;
  while ((match = SPLIT_RE.exec(text)) !== null) {
    lastMatch = {
      index: match.index,
      length: match[0].length,
      matched: match[0],
    };
  }

  if (!lastMatch) {
    return { categoryPart: text, locationPart: null, preposition: null };
  }

  const left = text.slice(0, lastMatch.index).trim();
  const right = text.slice(lastMatch.index + lastMatch.length).trim();

  // If the left side is empty (e.g., "in Lagos" with no category),
  // don't treat it as a valid split — return as-is for location-only handling.
  if (!left) {
    return { categoryPart: text, locationPart: null, preposition: null };
  }

  return {
    categoryPart: left,
    locationPart: right || null,
    preposition: lastMatch.matched.toLowerCase(),
  };
}
