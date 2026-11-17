/**
 * Directory Search Handler — WhatsApp business directory flow.
 *
 * Handles the shared-number directory experience:
 *   1. Greeting (first contact / home / returning customer)
 *   2. Natural language search → WhatsApp List results
 *   3. Close name matches ("No exact match for 'X'. These names are close:")
 *   4. Category/location correction ("Showing results for…")
 *   5. Result selection → enters business bot (postbacks carry the business id, #1072)
 *   6. "connect <name>" command
 *   7. Place search with aliases (#1072): place-aliases.ts
 *
 * Uses existing marketplace infrastructure:
 *   - parseDirectoryQuery (query-parser.ts)
 *   - searchMarketplace / searchFuzzy (search.ts)
 *   - loadDirectoryHiddenIds / isBusinessDirectoryEligible (search.ts)
 *   - resolveLocation (location-resolver.ts)
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { MessageSender } from '@/lib/channels/message-sender';
import { truncTitle } from '@/lib/bot/utils/truncate';
import { getFlowCopy, fillFlowCopy } from '@/lib/bot/flows/flow-localization';
import { parseDirectoryQuery, GENERIC_NOUNS, type DirectoryQueryResult } from '@/lib/marketplace/query-parser';
import { detectCategoryIntent, CATEGORY_KEYWORDS } from '@/lib/bot/fuzzy-match';
import {
  searchMarketplace,
  searchFuzzy,
  loadDirectoryHiddenIds,
  isBusinessDirectoryEligible,
  applyDirectoryEligibility,
  type MarketplaceResult,
  type MarketplaceSearchCriteria,
  type FuzzySuggestion,
  placeTierFor,
} from '@/lib/marketplace/search';
import { resolvePlace, placeCountryName, isKnownPlace } from '@/lib/marketplace/place-aliases';
import { checkRateLimitAsync } from '@/lib/rate-limit';

// ── Constants ─────────────────────────────────────────────

/** Max results in a WhatsApp list message. */
const WHATSAPP_LIST_MAX = 10;

/** Max characters for a WhatsApp list row title. */
const LIST_TITLE_MAX = 24;

/** Per-phone directory search rate limit: 5 per minute. */
const SEARCH_RATE_LIMIT = 5;
const SEARCH_RATE_WINDOW_MS = 60_000;

// ── Session data keys (stored in bot_sessions.session_data) ──

export interface DirectorySessionData {
  _directory_mode: true;
  _directory_results?: MarketplaceResult[];
  _directory_suggestions?: FuzzySuggestion[];
  _directory_query?: string;
  _directory_total?: number;
  _directory_country?: string | null;
  /**
   * #1072: buttons sent with this session carry business ids (dir_biz_<uuid>).
   * An index postback (dir_result_N / dir_sug_N) is then stale and never resolved.
   */
  _directory_postbacks?: 'id';
  /**
   * #1072: the customer typed one business's exact name. Nothing was sent; the
   * caller enters this business. Never persisted as navigation state.
   */
  _directory_enter?: { businessId: string; botCode: string };
  /** Returning-customer quick-pick businesses (past businesses: biz_N or dir_biz_<uuid>). */
  suggestions?: Array<{ id: string; name: string; bot_code: string }>;
}

// ── Types ─────────────────────────────────────────────────

type PlatformSend = {
  sendPlatformText: (to: string, text: string) => Promise<void>;
  sendPlatformButtons: (to: string, body: string, buttons: Array<{ id: string; title: string }>) => Promise<void>;
  sendPlatformList: (to: string, msg: {
    title: string;
    body: string;
    buttonLabel: string;
    items: Array<{ title: string; description?: string; postbackText: string }>;
    footer?: string;
  }) => Promise<void>;
};

// ── Postbacks (#1072) ─────────────────────────────────────

const BIZ_POSTBACK_RE = /^dir_biz_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** Button/list id for a business: carries the id, never a position in a list. */
export function bizPostback(businessId: string): string {
  return `dir_biz_${businessId}`;
}

/** Any directory pick postback, current or legacy (dir_biz_<uuid>, dir_result_N, dir_sug_N). */
export function isDirectoryPickPostback(text: string): boolean {
  return /^dir_(biz|result|sug)_/i.test(text.trim());
}

/** Category list postback ("dir_cat_<category key>"). */
const CATEGORY_POSTBACK_RE = /^dir_cat_([a-z0-9_]{1,40})$/;

export function directoryCategoryFromPostback(text: string): string | null {
  return text.trim().match(CATEGORY_POSTBACK_RE)?.[1] ?? null;
}

/** Language for directory copy: the language already active in the conversation, if any. */
export function directoryLanguage(sessionData: unknown): string | undefined {
  const value = (sessionData as Record<string, unknown> | null | undefined)?._detected_language;
  return typeof value === 'string' && value ? value : undefined;
}

// ── Greeting ──────────────────────────────────────────────

/**
 * Send the directory welcome greeting for first-time users on the shared number.
 */
export async function sendDirectoryGreeting(
  send: PlatformSend,
  from: string,
  lang?: string,
): Promise<void> {
  const text = getFlowCopy(lang, 'directory.welcome');
  await send.sendPlatformText(from, text);
}

/**
 * Send the returning-customer greeting with quick-pick buttons.
 * Up to 2 recent businesses + a "Find a business" button (3 max).
 * Business buttons carry the business id (#1072).
 */
export async function sendReturningGreeting(
  send: PlatformSend,
  from: string,
  recentBusinesses: Array<{ id: string; name: string; bot_code: string }>,
  customerName: string | null,
  lang?: string,
): Promise<void> {
  const greeting = customerName
    ? fillFlowCopy(lang, 'directory.welcome_returning', { name: customerName })
    : getFlowCopy(lang, 'directory.welcome_returning_noname');

  const buttons: Array<{ id: string; title: string }> = recentBusinesses.slice(0, 2)
    .map((b) => ({ id: bizPostback(b.id), title: truncTitle(b.name) }));
  buttons.push({ id: 'dir_find', title: truncTitle(getFlowCopy(lang, 'directory.find_button')) });

  const body = `${greeting} ${getFlowCopy(lang, 'directory.past_businesses')}\n\n${getFlowCopy(lang, 'directory.returning_search_hint')}`;
  await send.sendPlatformButtons(from, body, buttons);
}

/**
 * Customer's search text as shown back to them in quotes: one line, at most 40 chars.
 */
export function searchLabel(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > 40 ? `${oneLine.slice(0, 39)}…` : oneLine;
}

/** Header for close name matches ("No exact match for 'X'. These names are close:"). */
export function closeMatchesHeader(query: string, count: number, lang?: string): string {
  return fillFlowCopy(lang, count === 1 ? 'directory.close_match_one' : 'directory.close_matches', {
    query: searchLabel(query),
  });
}

/**
 * Send businesses the customer used before, labelled as past (sent after any search
 * results, never mixed into them). At most 3 (WhatsApp button limit).
 *
 * `startIndex` = index buttons (biz_{startIndex + i}) into the session's stored
 * `suggestions` list (the "Did you mean?" picker). `'id'` = buttons carry the
 * business id (dir_biz_<uuid>, directory steps, #1072).
 */
export async function sendPastBusinesses(
  send: PlatformSend,
  from: string,
  past: Array<{ id: string; name: string; bot_code: string }>,
  startIndex: number | 'id',
  lang?: string,
): Promise<void> {
  if (past.length === 0) return;
  await send.sendPlatformButtons(from, getFlowCopy(lang, 'directory.past_businesses'),
    past.slice(0, 3).map((b, i) => ({
      id: startIndex === 'id' ? bizPostback(b.id) : `biz_${startIndex + i}`,
      title: truncTitle(b.name),
    })));
}

// ── Search ────────────────────────────────────────────────

/** Same business name: case, accents, spaces and punctuation ignored (#1072). */
export function sameBusinessName(a: string, b: string): boolean {
  const norm = (v: string) => v.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const na = norm(a);
  return na.length >= 2 && na === norm(b);
}

function nameContains(name: string, text: string): boolean {
  const norm = (v: string) => v.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const t = norm(text);
  return t.length >= 2 && norm(name).includes(t);
}

/**
 * Exact-name auto-entry is allowed only for text that is not a generic word, a
 * detected category or a known place: a business named "Salon" or "Lagos" must
 * not capture that search (#1072 review).
 */
export function exactNameMayEnter(text: string, country: string | null): boolean {
  const t = text.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!t || GENERIC_NOUNS.has(t)) return false;
  if (CATEGORY_WORDS.has(t) || CATEGORY_WORDS.has(t.replace(/(es|s)$/, ''))) return false;
  return !isKnownPlace(t, country, true) && !placeCountryName(t);
}

/** Category keys and keywords as whole words ("salon", "restaurant", "barber"). */
const CATEGORY_WORDS: ReadonlySet<string> = new Set(
  Object.entries(CATEGORY_KEYWORDS).flatMap(([key, words]) => [key.replace(/_/g, ' '), ...words])
    .map((w) => w.toLowerCase()),
);

/**
 * Exact-name pick from the "Did you mean?" path: directory-eligible and, when the
 * shared number's country is known, in that country.
 */
export async function exactNamePickAllowed(
  supabase: SupabaseClient,
  businessId: string,
  country: string | null,
): Promise<boolean> {
  if (!(await isBusinessDirectoryEligible(supabase, businessId))) return false;
  if (!country) return true;
  const { data, error } = await supabase.from('businesses').select('country_code').eq('id', businessId).maybeSingle();
  return !error && (data as { country_code?: string | null } | null)?.country_code === country;
}

/**
 * Category or free-text filter for a place search (#1072): a category, a generic
 * word with a category synonym ("shops"), a name ("boutique"), or nothing for a
 * generic word or a place alone ("businesses in Lekki", "Lekki").
 */
function subjectFilter(parsed: DirectoryQueryResult): { category?: string; query?: string } {
  if (parsed.categories.length > 0) return { category: parsed.categories[0] };
  const subject = parsed.subject?.trim();
  if (!subject) return {};
  if (GENERIC_NOUNS.has(subject.toLowerCase())) {
    return detectCategoryIntent(subject).length > 0 ? { query: subject } : {};
  }
  return { query: subject };
}

const base = (text: string, country: string | null) => ({
  _directory_mode: true as const,
  _directory_query: text,
  _directory_country: country,
  _directory_postbacks: 'id' as const,
});

/**
 * Run a directory search from user text. Returns session data to persist, or
 * null when the search was refused (rate limit, database unavailable).
 *
 * #1072 order:
 *   1. One business's exact name → `_directory_enter` (caller enters it, nothing sent).
 *   2. A recognised place ("shops in Lagos", "Lekki", "Laurel, Maryland") → businesses
 *      in that place, the area/city named first, then the rest of its state. Nothing
 *      there → the same search across the country, labelled as widened.
 *   3. An unrecognised place ("Food for Thought", "spa in Gbaksville") → the whole
 *      text as a name first, then the place as an area word, then close names.
 *   4. A name, or a category without a place → as before.
 * A place or parse problem never shows "temporarily unavailable".
 */
export async function handleDirectorySearch(
  supabase: SupabaseClient,
  send: PlatformSend,
  from: string,
  text: string,
  sharedCountry: string | null,
  lang?: string,
): Promise<DirectorySessionData | null> {
  // Rate limit — uses the shared async limiter (same pattern as bot:${from})
  const rl = await checkRateLimitAsync(`dir-search:${from}`, SEARCH_RATE_LIMIT, SEARCH_RATE_WINDOW_MS);
  if (!rl.allowed) {
    await send.sendPlatformText(from, getFlowCopy(lang, 'directory.rate_limited'));
    return null;
  }

  // Parse the query
  const parsed = parseDirectoryQuery(text, sharedCountry);

  // Load hidden IDs
  const hiddenIds = await loadDirectoryHiddenIds(supabase);
  if (hiddenIds === null) {
    await send.sendPlatformText(from, getFlowCopy(lang, 'directory.search_unavailable'));
    return null;
  }

  const out = new DirectoryReply(send, from, text, sharedCountry, lang);

  // 1. Exact business name (case/space-insensitive): unique → enter, several → list them.
  // Never for a generic word, category or place ("Salon", "Lagos"), and only in the
  // shared number's country when known (#1072 review).
  const nameMatches = await searchFuzzy(supabase, text, sharedCountry, hiddenIds);
  const exact = exactNameMayEnter(text, sharedCountry)
    ? nameMatches.filter((s) => s.botCode && sameBusinessName(s.name, text)
      && (!sharedCountry || s.countryCode === sharedCountry))
    : [];
  if (exact.length === 1) {
    return {
      ...base(text, sharedCountry), _directory_results: [], _directory_suggestions: [], _directory_total: 0,
      _directory_enter: { businessId: exact[0].id, botCode: exact[0].botCode! },
    };
  }
  if (exact.length > 1) return out.suggestions(exact, searchResultsText(text, exact.length, lang));

  // Correction notice
  const correctionPrefix = parsed.correctedFrom
    ? fillFlowCopy(lang, 'directory.showing_corrected', { corrected: parsed.categories[0] || text })
    : '';

  const search = (criteria: Partial<MarketplaceSearchCriteria>) => searchMarketplace(supabase, {
    country: sharedCountry || undefined, ...criteria, excludeIds: hiddenIds, limit: WHATSAPP_LIST_MAX,
  });

  const placeText = parsed.locationText;
  const placeCountry = placeText ? placeCountryName(placeText) : null;
  const place = placeText && !placeCountry ? resolvePlace(placeText, sharedCountry) : null;
  const recognised = !!place && (place.known || place.stateTerms.length > 0);

  // 2. A recognised place.
  if (place && recognised) {
    const filter = subjectFilter(parsed);
    const inPlace = await search({ ...filter, place, country: place.countryCode || sharedCountry || undefined });
    if (!inPlace.ok && !inPlace.locationFailed) return out.unavailable();
    if (inPlace.ok && inPlace.results.length > 0) {
      // "Laurel, Maryland" where nothing is in Laurel itself: say so before the region.
      const areaOnly = { ...place, stateTerms: [], stateExact: [], stateAreaTerms: [], stateAreaExact: [] };
      const areaMissing = !place.known && place.areaTerms.length > 0
        && !inPlace.results.some((r) => placeTierFor(areaOnly, r) === 0);
      const notice = areaMissing
        ? fillFlowCopy(lang, 'directory.widened', { place: searchLabel(place.areaTerms[0]) })
        : '';
      return out.results(inPlace.results, inPlace.hasMore, [correctionPrefix, notice].filter(Boolean).join('\n\n'), true);
    }
    // Nothing in the place: widen to the country for a category or name (a place
    // alone is never widened, so a search never lists a whole country).
    if (filter.category || filter.query) {
      const wide = await search(filter);
      if (!wide.ok) return out.unavailable();
      const widened = fillFlowCopy(lang, 'directory.widened', { place: searchLabel(place.label) });
      const prefix = [correctionPrefix, widened].filter(Boolean).join('\n\n');
      if (wide.results.length > 0) return out.results(wide.results, wide.hasMore, prefix, false);
      const sugs = inPlace.suggestions?.length ? inPlace.suggestions : wide.suggestions;
      if (sugs?.length) return out.suggestions(sugs, `${correctionPrefix ? `${correctionPrefix}\n\n` : ''}${closeMatchesHeader(text, sugs.length, lang)}`);
    }
    return out.noResults(correctionPrefix);
  }

  // 3. A place we do not recognise: maybe a name containing in/for/at ("Food for Thought").
  if (place && !recognised) {
    // Only businesses whose name contains the whole text: the free-text search also
    // matches category synonyms ("food"), which would list unrelated businesses here.
    const byName = await search({ query: text });
    const named = byName.ok ? byName.results.filter((r) => nameContains(r.name, text)) : [];
    if (named.length > 0) return out.results(named, false, '', false);
    const filter = subjectFilter(parsed);
    const asArea = await search({ ...filter, place });
    if (asArea.ok && asArea.results.length > 0) {
      return out.results(asArea.results, asArea.hasMore, correctionPrefix, true);
    }
    if (nameMatches.length > 0) return out.suggestions(nameMatches, closeMatchesHeader(text, Math.min(nameMatches.length, WHATSAPP_LIST_MAX), lang));
    if (filter.category || filter.query) {
      const wide = await search(filter);
      if (wide.ok && wide.results.length > 0) {
        const widened = fillFlowCopy(lang, 'directory.widened', { place: searchLabel(place.label) });
        return out.results(wide.results, wide.hasMore, [correctionPrefix, widened].filter(Boolean).join('\n\n'), false);
      }
    }
    if (!byName.ok && !byName.locationFailed && !asArea.ok && !asArea.locationFailed) return out.unavailable();
    return out.noResults(correctionPrefix);
  }

  // 4a. A name (no category, no place): close names, then a full-text search.
  if (parsed.nameQuery && parsed.categories.length === 0 && !placeText) {
    if (nameMatches.length > 0) {
      return out.suggestions(nameMatches, closeMatchesHeader(text, Math.min(nameMatches.length, WHATSAPP_LIST_MAX), lang));
    }
    const byText = await search({ query: parsed.nameQuery });
    if (!byText.ok && !byText.locationFailed) return out.unavailable();
    if (byText.ok && byText.results.length > 0) return out.results(byText.results, byText.hasMore, '', false);
    return out.noResults('');
  }

  // 4b. A category, or a country ("businesses in Nigeria"), without an area. A
  // generic word keeps the raw text, so a search never lists a whole country.
  const category = parsed.categories[0] || undefined;
  const result = await search({
    category,
    country: placeCountry || sharedCountry || undefined,
    query: category ? undefined : (parsed.nameQuery || text),
  });
  if (!result.ok && !result.locationFailed) return out.unavailable();
  if (result.ok && result.results.length > 0) {
    return out.results(result.results, result.hasMore, correctionPrefix, false);
  }
  if (result.ok && result.suggestions?.length) {
    return out.suggestions(result.suggestions, `${correctionPrefix ? `${correctionPrefix}\n\n` : ''}${closeMatchesHeader(text, result.suggestions.length, lang)}`);
  }
  return out.noResults(correctionPrefix);
}

/**
 * Search one category from the "Browse categories" list (#1072).
 */
export async function handleDirectoryCategorySearch(
  supabase: SupabaseClient,
  send: PlatformSend,
  from: string,
  categoryKey: string,
  country: string | null,
  lang?: string,
): Promise<DirectorySessionData | null> {
  if (!/^[a-z0-9_]{1,40}$/.test(categoryKey)) return null;
  const rl = await checkRateLimitAsync(`dir-search:${from}`, SEARCH_RATE_LIMIT, SEARCH_RATE_WINDOW_MS);
  if (!rl.allowed) {
    await send.sendPlatformText(from, getFlowCopy(lang, 'directory.rate_limited'));
    return null;
  }
  const hiddenIds = await loadDirectoryHiddenIds(supabase);
  const label = categoryLabel(categoryKey);
  const out = new DirectoryReply(send, from, label, country, lang);
  if (hiddenIds === null) return out.unavailable();
  const result = await searchMarketplace(supabase, {
    category: categoryKey, country: country || undefined, excludeIds: hiddenIds, limit: WHATSAPP_LIST_MAX,
  });
  if (!result.ok) return out.unavailable();
  if (result.results.length > 0) return out.results(result.results, result.hasMore, '', false);
  return out.noResults('');
}

/**
 * "Browse categories" (#1072): the categories that have directory-eligible
 * businesses in this country, most businesses first (never an empty option).
 */
export async function sendDirectoryCategories(
  supabase: SupabaseClient,
  send: PlatformSend,
  from: string,
  country: string | null,
  lang?: string,
): Promise<void> {
  const hiddenIds = await loadDirectoryHiddenIds(supabase);
  if (hiddenIds === null) {
    await send.sendPlatformText(from, getFlowCopy(lang, 'directory.search_unavailable'));
    return;
  }
  let query = applyDirectoryEligibility(supabase.from('businesses').select('id, category'));
  if (country) query = query.eq('country_code', country);
  const { data, error } = await query.order('id', { ascending: true }).limit(1000);
  if (error) {
    await send.sendPlatformText(from, getFlowCopy(lang, 'directory.search_unavailable'));
    return;
  }
  const hidden = new Set(hiddenIds);
  const counts = new Map<string, number>();
  for (const row of (data || []) as Array<{ id: string; category: string | null }>) {
    if (!row.category || hidden.has(row.id) || !/^[a-z0-9_]{1,40}$/.test(row.category)) continue;
    counts.set(row.category, (counts.get(row.category) || 0) + 1);
  }
  const top = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, WHATSAPP_LIST_MAX);
  if (top.length === 0) {
    await send.sendPlatformText(from, getFlowCopy(lang, 'directory.search_prompt'));
    return;
  }
  await send.sendPlatformList(from, {
    title: truncTitle(getFlowCopy(lang, 'directory.categories_title'), LIST_TITLE_MAX),
    body: getFlowCopy(lang, 'directory.categories_body'),
    buttonLabel: truncTitle(getFlowCopy(lang, 'directory.view_categories'), 20),
    items: top.map(([key, count]) => ({
      title: truncTitle(categoryLabel(key), LIST_TITLE_MAX),
      description: String(count),
      postbackText: `dir_cat_${key}`,
    })),
  });
}

/** Builds the directory replies for one search and the session data to persist. */
class DirectoryReply {
  constructor(
    private readonly send: PlatformSend,
    private readonly from: string,
    private readonly query: string,
    private readonly country: string | null,
    private readonly lang?: string,
  ) {}

  async unavailable(): Promise<null> {
    await this.send.sendPlatformText(this.from, getFlowCopy(this.lang, 'directory.search_unavailable'));
    return null;
  }

  /** `placeGiven`: an area was searched, so "add an area" is never suggested. */
  async results(results: MarketplaceResult[], hasMore: boolean | undefined, prefix: string, placeGiven: boolean): Promise<DirectorySessionData> {
    const items = results.slice(0, WHATSAPP_LIST_MAX);
    let body = prefix ? `${prefix}\n\n` : '';
    if (hasMore && !placeGiven) {
      body += fillFlowCopy(this.lang, 'directory.search_results_more', { query: searchLabel(this.query), count: `${items.length}+` });
    } else if (hasMore) {
      body += fillFlowCopy(this.lang, 'directory.search_results', { query: searchLabel(this.query), count: `${items.length}+` });
    } else {
      body += searchResultsText(this.query, items.length, this.lang);
    }
    await sendResultsList(this.send, this.from, items, body, this.lang);
    return {
      ...base(this.query, this.country),
      _directory_results: items,
      _directory_suggestions: [],
      _directory_total: items.length,
    };
  }

  async suggestions(suggestions: FuzzySuggestion[], header: string): Promise<DirectorySessionData> {
    return sendFuzzySuggestions(this.send, this.from, suggestions, this.query, header, this.country, this.lang);
  }

  /** No results: options to search again or browse categories (#1072). */
  async noResults(prefix: string): Promise<DirectorySessionData> {
    const noResults = fillFlowCopy(this.lang, 'directory.no_results_for', { query: searchLabel(this.query) });
    await this.send.sendPlatformButtons(this.from, prefix ? `${prefix}\n\n${noResults}` : noResults, [
      { id: 'dir_find', title: truncTitle(getFlowCopy(this.lang, 'directory.search_again_button')) },
      { id: 'dir_categories', title: truncTitle(getFlowCopy(this.lang, 'directory.browse_categories_button')) },
    ]);
    return {
      ...base(this.query, this.country),
      _directory_results: [],
      _directory_suggestions: [],
      _directory_total: 0,
    };
  }
}

/**
 * Send close name matches as buttons (≤3) or a list. Buttons carry business ids.
 */
async function sendFuzzySuggestions(
  send: PlatformSend,
  from: string,
  suggestions: FuzzySuggestion[],
  query: string,
  header: string,
  country: string | null,
  lang?: string,
): Promise<DirectorySessionData> {
  const items = suggestions.filter((s) => !!s.botCode).slice(0, WHATSAPP_LIST_MAX);

  if (items.length <= 3) {
    await send.sendPlatformButtons(from, header, items.map((s) => ({
      id: bizPostback(s.id),
      title: truncTitle(s.name),
    })));
  } else {
    await send.sendPlatformList(from, {
      title: getFlowCopy(lang, 'directory.close_matches_title'),
      body: header,
      buttonLabel: truncTitle(getFlowCopy(lang, 'directory.view_suggestions'), LIST_TITLE_MAX),
      items: items.map((s) => ({
        title: truncTitle(s.name, LIST_TITLE_MAX),
        description: buildSuggestionDescription(s),
        postbackText: bizPostback(s.id),
      })),
    });
  }

  return {
    ...base(query, country),
    _directory_results: [],
    _directory_suggestions: items,
    _directory_total: 0,
  };
}

// ── Result selection ──────────────────────────────────────

/**
 * A business a customer has used before may be re-entered when it is active, has a
 * bot code and is not messaging-suspended. Directory visibility (merchant
 * discovery_enabled, admin directory_hidden) does not apply (#1083). Fails closed.
 */
async function isBusinessReachable(supabase: SupabaseClient, businessId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('businesses')
    .select('id')
    .eq('id', businessId)
    .eq('status', 'active')
    .not('bot_code', 'is', null)
    .eq('messaging_suspended', false)
    .maybeSingle();
  return !error && !!data;
}

/**
 * Handle user tapping a search result, close match or past business.
 * Returns the business to enter, or null (any reply already sent).
 *
 * #1072: dir_biz_<uuid> must name a business in this session's stored results,
 * close matches or past businesses; results and close matches are re-checked for
 * directory eligibility, past businesses for being reachable (#1083). A legacy index postback (dir_result_N / dir_sug_N) is
 * honoured only for a session written before id postbacks; otherwise, or when out
 * of range, the customer is asked to search again — never a different business.
 */
export async function handleDirectorySelection(
  supabase: SupabaseClient,
  send: PlatformSend,
  from: string,
  text: string,
  sessionData: DirectorySessionData,
  lang?: string,
): Promise<{ businessId: string; botCode: string; source: 'search' | 'past' } | null> {
  const results = (sessionData._directory_results || []).map((r) => ({ id: r.businessId, botCode: r.botCode || null }));
  const sugs = (sessionData._directory_suggestions || []).map((s) => ({ id: s.id, botCode: s.botCode }));

  const pickIfEligible = async (item: { id: string; botCode: string | null } | undefined) => {
    if (!item?.botCode) return null;
    if (await isBusinessDirectoryEligible(supabase, item.id)) {
      return { businessId: item.id, botCode: item.botCode, source: 'search' as const };
    }
    await send.sendPlatformText(from, getFlowCopy(lang, 'directory.business_unavailable'));
    return null;
  };
  const stale = async () => {
    await send.sendPlatformText(from, getFlowCopy(lang, 'directory.stale_selection'));
    return null;
  };

  const idMatch = text.trim().match(BIZ_POSTBACK_RE);
  if (idMatch) {
    const id = idMatch[1].toLowerCase();
    const hit = [...results, ...sugs].find((r) => r.id.toLowerCase() === id && r.botCode);
    if (hit) return pickIfEligible(hit);
    const past = (sessionData.suggestions || []).find((p) => p.id.toLowerCase() === id);
    if (past?.bot_code) {
      // Past businesses are re-checked (#1072 review), but only for being active:
      // a business hidden from the directory stays open to its past customers (#1083).
      if (await isBusinessReachable(supabase, past.id)) {
        return { businessId: past.id, botCode: past.bot_code, source: 'past' };
      }
      await send.sendPlatformText(from, getFlowCopy(lang, 'directory.business_unavailable'));
      return null;
    }
    return stale();
  }

  const legacy = text.trim().match(/^dir_(result|sug)_(\d+)$/i);
  if (legacy) {
    if (sessionData._directory_postbacks === 'id') return stale();
    const list = legacy[1].toLowerCase() === 'result' ? results : sugs;
    const item = list[parseInt(legacy[2], 10)];
    if (!item?.botCode) return stale();
    return pickIfEligible(item);
  }

  // Numeric reply (1, 2, 3…) against the list the customer has now.
  const numMatch = text.match(/^(\d+)$/);
  if (numMatch) {
    const idx = parseInt(numMatch[1], 10) - 1;
    if (results[idx]?.botCode) return pickIfEligible(results[idx]);
    if (sugs[idx]?.botCode) return pickIfEligible(sugs[idx]);
  }

  return null;
}

// ── "connect <name>" command ──────────────────────────────

/** Pattern for "connect <name>" or "switch <name>" commands. */
export const CONNECT_PATTERN = /^(?:connect|switch)\s+(.+)$/i;

/**
 * Handle "connect <name>" command — directory-eligible lookup by name.
 *
 * Returns:
 * - { action: 'enter', businessId, botCode } for confident single match
 * - { action: 'suggestions', sessionData } for fuzzy matches
 * - { action: 'search', sessionData } for no name match → try directory search
 * - { action: 'none' } for no match at all
 */
export async function handleConnectCommand(
  supabase: SupabaseClient,
  send: PlatformSend,
  from: string,
  name: string,
  sharedCountry: string | null,
  lang?: string,
): Promise<
  | { action: 'enter'; businessId: string; botCode: string }
  | { action: 'suggestions'; sessionData: DirectorySessionData }
  | { action: 'search'; sessionData: DirectorySessionData | null }
  | { action: 'none' }
> {
  const hiddenIds = await loadDirectoryHiddenIds(supabase);
  if (hiddenIds === null) {
    await send.sendPlatformText(from, getFlowCopy(lang, 'directory.search_unavailable'));
    return { action: 'none' };
  }

  // Try fuzzy name match
  const suggestions = await searchFuzzy(supabase, name, sharedCountry, hiddenIds);

  if (suggestions.length === 1 && suggestions[0].matchScore >= 0.6) {
    // Confident single match
    const s = suggestions[0];
    if (s.botCode) {
      return { action: 'enter', businessId: s.id, botCode: s.botCode };
    }
  }

  if (suggestions.length > 0) {
    const sd = await sendFuzzySuggestions(send, from, suggestions, name,
      closeMatchesHeader(name, Math.min(suggestions.length, WHATSAPP_LIST_MAX), lang), sharedCountry, lang);
    return { action: 'suggestions', sessionData: sd };
  }

  // No name match — try as directory search
  const sd = await handleDirectorySearch(supabase, send, from, name, sharedCountry, lang);
  if (sd?._directory_enter) return { action: 'enter', ...sd._directory_enter };
  return { action: 'search', sessionData: sd };
}

// ── Formatting helpers ────────────────────────────────────

/**
 * Send search results as a WhatsApp interactive list. Rows carry business ids.
 */
async function sendResultsList(
  send: PlatformSend,
  from: string,
  results: MarketplaceResult[],
  bodyText: string,
  lang?: string,
): Promise<void> {
  const items = results.slice(0, WHATSAPP_LIST_MAX);

  await send.sendPlatformList(from, {
    title: truncTitle(getFlowCopy(lang, 'directory.results_title'), LIST_TITLE_MAX),
    body: bodyText,
    buttonLabel: truncTitle(getFlowCopy(lang, 'directory.view_results'), LIST_TITLE_MAX),
    items: items.map((r) => ({
      title: truncTitle(r.name, LIST_TITLE_MAX),
      description: buildResultDescription(r, lang),
      postbackText: bizPostback(r.businessId),
    })),
  });
}

/** "instagram_vendor" → "Instagram vendor". */
export function categoryLabel(category: string): string {
  const words = category.replace(/_/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : '';
}

/** "Area, State" ("Lekki, Lagos"); the state is left out when it repeats the area. */
export function placeLine(area: string | null | undefined, state: string | null | undefined): string {
  const a = area?.trim() || '';
  const st = state?.trim() || '';
  if (!a) return st;
  if (!st || a.toLowerCase() === st.toLowerCase()) return a;
  return `${a}, ${st}`;
}

/**
 * List row description (max 72 chars for WhatsApp): "Category · Area, State",
 * plus "Open now" only when it is known (hours and timezone, #1072).
 */
export function buildResultDescription(r: MarketplaceResult, lang?: string): string {
  const parts: string[] = [];
  if (r.category) parts.push(categoryLabel(r.category));
  const where = placeLine(r.neighborhood || r.city, r.state);
  if (where) parts.push(where);
  if (r.isOpenNow === true) parts.push(getFlowCopy(lang, 'directory.open_now'));
  return parts.join(' · ').slice(0, 72);
}

/**
 * Build a short description for a fuzzy suggestion list row.
 */
function buildSuggestionDescription(s: FuzzySuggestion): string {
  const parts: string[] = [];
  if (s.category) parts.push(categoryLabel(s.category));
  const where = placeLine(s.city, s.state);
  if (where) parts.push(where);
  return parts.join(' · ').slice(0, 72);
}

/**
 * Body for a results list: "Search results for 'X': I found N businesses. Tap below to choose one."
 */
function searchResultsText(query: string, count: number, lang?: string): string {
  return fillFlowCopy(lang, count === 1 ? 'directory.search_results_one' : 'directory.search_results', {
    query: searchLabel(query),
    count,
  });
}

// ── Search typed on a business menu (#1072) ───────────────

const MENU_ACTION_WORDS = /\b(book|booking|order|buy|pay|reserve|appointment|table|tables|ticket|tickets|donate|give|cancel|reschedule|my|out|more|menu|price|prices|hours|deliver|delivers|delivery|pickup|pick)\b/i;

/** A question to the business ("Do you deliver to Lekki?") is never a directory search. */
const QUESTION_RE = /^(do|does|did|can|could|is|are|will|would|where|how|what|which|who|when|why)\b/i;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * An explicit directory search typed on a business's menu: "search …", "find …",
 * or "<category> in|near|around <known place>" ("salons in Lekki"). Returns the
 * text to search, or null for anything else (real menu choices and questions to
 * the business stay with the business). Only clear searches qualify (#1072 review):
 * no questions, no fuzzy-corrected categories, no menu action words.
 */
export function explicitDirectorySearch(text: string): string | null {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t || t.length > 120) return null;
  if (t.includes('?') || QUESTION_RE.test(t)) return null;
  const verb = t.match(/^(?:search|find)\s+(?:for\s+)?(.+)$/i);
  if (verb) {
    const rest = verb[1].trim();
    if (!rest || /^(my|me)\b/i.test(rest) || MENU_ACTION_WORDS.test(rest)) return null;
    return rest;
  }
  const parsed = parseDirectoryQuery(t, null);
  if (!parsed.locationText || parsed.needsLocation || !parsed.subject || parsed.correctedFrom) return null;
  if (MENU_ACTION_WORDS.test(parsed.subject)) return null;
  // Only "in" / "near" / "around" + the place ("to" / "at" / "for" read as questions or orders).
  if (!new RegExp(`\\b(in|near|around)\\s+${escapeRegExp(parsed.locationText)}$`, 'i').test(t)) return null;
  const isCategory = parsed.categories.length > 0 || GENERIC_NOUNS.has(parsed.subject.toLowerCase());
  if (!isCategory) return null;
  return isKnownPlace(parsed.locationText, null, false) ? t : null;
}
