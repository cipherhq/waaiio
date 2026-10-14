/**
 * Directory Search Handler — WhatsApp business directory flow.
 *
 * Handles the shared-number directory experience:
 *   1. Greeting (first contact / home / returning customer)
 *   2. Natural language search → WhatsApp List results
 *   3. "Did you mean?" fuzzy name suggestions
 *   4. Category/location correction ("Showing results for…")
 *   5. Result selection → enters business bot
 *   6. "connect <name>" command
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
import { parseDirectoryQuery } from '@/lib/marketplace/query-parser';
import {
  searchMarketplace,
  searchFuzzy,
  loadDirectoryHiddenIds,
  isBusinessDirectoryEligible,
  type MarketplaceResult,
  type FuzzySuggestion,
} from '@/lib/marketplace/search';
import { checkRateLimit } from '@/lib/rate-limit';
import { logger } from '@/lib/logger';

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
  /** Returning-customer quick-pick businesses (used for biz_N button handling). */
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

  const buttons: Array<{ id: string; title: string }> = [];
  const picks = recentBusinesses.slice(0, 2);
  for (let i = 0; i < picks.length; i++) {
    buttons.push({ id: `biz_${i}`, title: truncTitle(picks[i].name) });
  }
  buttons.push({ id: 'dir_find', title: truncTitle(getFlowCopy(lang, 'directory.find_button')) });

  const body = `${greeting}\n\n${getFlowCopy(lang, 'directory.returning_search_hint')}`;
  await send.sendPlatformButtons(from, body, buttons);
}

// ── Search ────────────────────────────────────────────────

/**
 * Run a directory search from user text. Returns session data to persist.
 *
 * Handles:
 * - Category/location search ("salon in Lagos")
 * - Typo correction ("resturant in Lagos" → "Showing results for restaurant in Lagos")
 * - Name search → fuzzy suggestions ("Glow Studio" → did-you-mean list)
 * - No results → suggestion text
 */
export async function handleDirectorySearch(
  supabase: SupabaseClient,
  send: PlatformSend,
  from: string,
  text: string,
  sharedCountry: string | null,
  lang?: string,
): Promise<DirectorySessionData | null> {
  // Rate limit
  const rl = checkRateLimit(`dir-search:${from}`, SEARCH_RATE_LIMIT, SEARCH_RATE_WINDOW_MS);
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

  // If it's a name query (no category or location matched), do fuzzy name search
  if (parsed.nameQuery && parsed.categories.length === 0 && !parsed.locationText) {
    return handleNameSearch(supabase, send, from, parsed.nameQuery, sharedCountry, hiddenIds, lang);
  }

  // Build search criteria from parsed query
  const category = parsed.categories[0] || undefined;
  const searchResult = await searchMarketplace(supabase, {
    category,
    locationText: parsed.resolvedLocation?.city || parsed.locationText || undefined,
    _addressHint: parsed.resolvedLocation?.addressHint || undefined,
    country: parsed.resolvedLocation?.countryCode || sharedCountry || undefined,
    excludeIds: hiddenIds,
    limit: WHATSAPP_LIST_MAX,
    query: !category ? text : undefined,
  });

  if (!searchResult.ok) {
    await send.sendPlatformText(from, getFlowCopy(lang, 'directory.search_unavailable'));
    return null;
  }

  // Correction notice
  let correctionPrefix = '';
  if (parsed.correctedFrom) {
    const correctedTo = parsed.categories[0] || text;
    correctionPrefix = fillFlowCopy(lang, 'directory.showing_corrected', { corrected: correctedTo });
  }

  // Results found → send as WhatsApp list
  if (searchResult.results.length > 0) {
    const total = searchResult.hasMore
      ? searchResult.results.length + '+' // indicate more exist
      : String(searchResult.results.length);

    const description = buildSearchDescription(parsed.categories[0], parsed.locationText);

    let bodyText = correctionPrefix
      ? `${correctionPrefix}\n\n`
      : '';

    if (searchResult.hasMore) {
      bodyText += fillFlowCopy(lang, 'directory.results_hint_more', {
        count: total,
        description,
      });
    } else {
      bodyText += fillFlowCopy(lang, 'directory.results_found', {
        count: String(searchResult.results.length),
        description,
      });
    }

    await sendResultsList(send, from, searchResult.results, bodyText, lang);

    return {
      _directory_mode: true,
      _directory_results: searchResult.results,
      _directory_query: text,
      _directory_total: searchResult.results.length,
      _directory_country: sharedCountry,
    };
  }

  // No results but fuzzy suggestions exist
  if (searchResult.suggestions && searchResult.suggestions.length > 0) {
    return sendFuzzySuggestions(send, from, searchResult.suggestions, text, correctionPrefix, lang);
  }

  // No results at all
  const noResultsMsg = correctionPrefix
    ? `${correctionPrefix}\n\n${getFlowCopy(lang, 'directory.no_results')}`
    : getFlowCopy(lang, 'directory.no_results');
  await send.sendPlatformText(from, noResultsMsg);

  return {
    _directory_mode: true,
    _directory_query: text,
    _directory_country: sharedCountry,
  };
}

/**
 * Handle a name-based search using fuzzy matching.
 */
async function handleNameSearch(
  supabase: SupabaseClient,
  send: PlatformSend,
  from: string,
  nameQuery: string,
  country: string | null,
  hiddenIds: string[],
  lang?: string,
): Promise<DirectorySessionData | null> {
  const suggestions = await searchFuzzy(supabase, nameQuery, country, hiddenIds);

  if (suggestions.length > 0) {
    return sendFuzzySuggestions(send, from, suggestions, nameQuery, '', lang);
  }

  // No fuzzy matches either — fall back to full-text search
  const searchResult = await searchMarketplace(supabase, {
    query: nameQuery,
    country: country || undefined,
    excludeIds: hiddenIds,
    limit: WHATSAPP_LIST_MAX,
  });

  if (searchResult.ok && searchResult.results.length > 0) {
    const bodyText = fillFlowCopy(lang, 'directory.results_found', {
      count: String(searchResult.results.length),
      description: `"${nameQuery}"`,
    });

    await sendResultsList(send, from, searchResult.results, bodyText, lang);

    return {
      _directory_mode: true,
      _directory_results: searchResult.results,
      _directory_query: nameQuery,
      _directory_total: searchResult.results.length,
      _directory_country: country,
    };
  }

  // Nothing found
  await send.sendPlatformText(from, getFlowCopy(lang, 'directory.no_results'));
  return {
    _directory_mode: true,
    _directory_query: nameQuery,
    _directory_country: country,
  };
}

/**
 * Send fuzzy suggestions as a "Did you mean?" list.
 */
async function sendFuzzySuggestions(
  send: PlatformSend,
  from: string,
  suggestions: FuzzySuggestion[],
  originalQuery: string,
  prefix: string,
  lang?: string,
): Promise<DirectorySessionData> {
  const items = suggestions.slice(0, WHATSAPP_LIST_MAX);

  const headerText = prefix
    ? `${prefix}\n\n${getFlowCopy(lang, 'directory.did_you_mean')}`
    : getFlowCopy(lang, 'directory.did_you_mean');

  if (items.length <= 3) {
    // Use buttons for small suggestion sets
    const buttons = items.map((s, i) => ({
      id: `dir_sug_${i}`,
      title: truncTitle(s.name),
    }));
    await send.sendPlatformButtons(from, headerText, buttons);
  } else {
    // Use list for larger sets
    await send.sendPlatformList(from, {
      title: getFlowCopy(lang, 'directory.did_you_mean_title'),
      body: headerText,
      buttonLabel: truncTitle(getFlowCopy(lang, 'directory.view_suggestions'), LIST_TITLE_MAX),
      items: items.map((s, i) => ({
        title: truncTitle(s.name, LIST_TITLE_MAX),
        description: buildSuggestionDescription(s),
        postbackText: `dir_sug_${i}`,
      })),
    });
  }

  return {
    _directory_mode: true,
    _directory_suggestions: items,
    _directory_query: originalQuery,
    _directory_country: null,
  };
}

// ── Result selection ──────────────────────────────────────

/**
 * Handle user tapping a search result or fuzzy suggestion.
 * Returns the selected business ID, or null if selection is invalid.
 */
export async function handleDirectorySelection(
  supabase: SupabaseClient,
  send: PlatformSend,
  from: string,
  text: string,
  sessionData: DirectorySessionData,
  lang?: string,
): Promise<{ businessId: string; botCode: string } | null> {
  // Match dir_result_N (list row postback)
  const resultMatch = text.match(/^dir_result_(\d+)$/i);
  if (resultMatch && sessionData._directory_results) {
    const idx = parseInt(resultMatch[1], 10);
    const result = sessionData._directory_results[idx];
    if (result && result.botCode) {
      // Verify the business is still eligible
      const eligible = await isBusinessDirectoryEligible(supabase, result.businessId);
      if (eligible) {
        return { businessId: result.businessId, botCode: result.botCode };
      }
      await send.sendPlatformText(from, getFlowCopy(lang, 'directory.business_unavailable'));
      return null;
    }
  }

  // Match dir_sug_N (fuzzy suggestion postback)
  const sugMatch = text.match(/^dir_sug_(\d+)$/i);
  if (sugMatch && sessionData._directory_suggestions) {
    const idx = parseInt(sugMatch[1], 10);
    const suggestion = sessionData._directory_suggestions[idx];
    if (suggestion && suggestion.botCode) {
      const eligible = await isBusinessDirectoryEligible(supabase, suggestion.id);
      if (eligible) {
        return { businessId: suggestion.id, botCode: suggestion.botCode };
      }
      await send.sendPlatformText(from, getFlowCopy(lang, 'directory.business_unavailable'));
      return null;
    }
  }

  // Match numeric reply (1, 2, 3…)
  const numMatch = text.match(/^(\d+)$/);
  if (numMatch) {
    const idx = parseInt(numMatch[1], 10) - 1;
    if (sessionData._directory_results && sessionData._directory_results[idx]) {
      const result = sessionData._directory_results[idx];
      if (result.botCode) {
        const eligible = await isBusinessDirectoryEligible(supabase, result.businessId);
        if (eligible) {
          return { businessId: result.businessId, botCode: result.botCode };
        }
        await send.sendPlatformText(from, getFlowCopy(lang, 'directory.business_unavailable'));
        return null;
      }
    }
    if (sessionData._directory_suggestions && sessionData._directory_suggestions[idx]) {
      const suggestion = sessionData._directory_suggestions[idx];
      if (suggestion.botCode) {
        const eligible = await isBusinessDirectoryEligible(supabase, suggestion.id);
        if (eligible) {
          return { businessId: suggestion.id, botCode: suggestion.botCode };
        }
        await send.sendPlatformText(from, getFlowCopy(lang, 'directory.business_unavailable'));
        return null;
      }
    }
  }

  // "Find a business" button (from returning greeting)
  if (text === 'dir_find') {
    await send.sendPlatformText(from, getFlowCopy(lang, 'directory.search_prompt'));
    return null;
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
    const sd = await sendFuzzySuggestions(send, from, suggestions, name, '', lang);
    return { action: 'suggestions', sessionData: sd };
  }

  // No name match — try as directory search
  const sd = await handleDirectorySearch(supabase, send, from, name, sharedCountry, lang);
  return { action: 'search', sessionData: sd };
}

// ── Formatting helpers ────────────────────────────────────

/**
 * Send search results as a WhatsApp interactive list.
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
    items: items.map((r, i) => ({
      title: truncTitle(r.name, LIST_TITLE_MAX),
      description: buildResultDescription(r),
      postbackText: `dir_result_${i}`,
    })),
  });
}

/**
 * Build a short description for a list row (max 72 chars for WhatsApp).
 */
function buildResultDescription(r: MarketplaceResult): string {
  const parts: string[] = [];
  if (r.category) parts.push(r.category);
  if (r.city) parts.push(r.city);
  if (r.isOpenNow) parts.push('Open now');
  return parts.join(' · ').slice(0, 72);
}

/**
 * Build a short description for a fuzzy suggestion list row.
 */
function buildSuggestionDescription(s: FuzzySuggestion): string {
  const parts: string[] = [];
  if (s.category) parts.push(s.category);
  if (s.city) parts.push(s.city);
  return parts.join(' · ').slice(0, 72);
}

/**
 * Build a human-readable search description from category + location.
 */
function buildSearchDescription(category?: string, location?: string | null): string {
  if (category && location) return `${category} in ${location}`;
  if (category) return category;
  if (location) return `businesses in ${location}`;
  return 'your search';
}
