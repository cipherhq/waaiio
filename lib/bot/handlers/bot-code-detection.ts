import type { SupabaseClient } from '@supabase/supabase-js';
import { isAcronymOf, matchScore, phoneticMatch, phoneToCountry, detectCategoryIntent } from '../fuzzy-match';
import { sanitizeFilterValue } from '@/lib/utils/sanitize';

/**
 * Simple bot code detection — returns just a business ID or null.
 */
export async function detectBotCode(supabase: SupabaseClient, text: string): Promise<string | null> {
  const result = await detectBotCodeWithSuggestions(supabase, text);
  return result.businessId;
}

/**
 * Enhanced bot code detection with multiple matching strategies:
 * 1. Exact match (case-insensitive)
 * 2. Spaces-to-hyphens ("citadel of grace" -> "citadel-of-grace")
 * 3. Hyphenated token extraction
 * 4. Filler/pidgin word stripping
 * 5. Acronym detection ("COG" -> "Citadel-Of-Grace")
 * 6. Typo tolerance (Levenshtein distance)
 * 7. Phonetic matching (Soundex -- "sitadel" -> "citadel")
 * 8. Partial name/code search with popularity ranking
 * 9. Category browsing ("I need a salon")
 *
 * Returns { businessId } for confident matches, or { suggestions } for fuzzy/partial matches.
 * suggestions include `confidence: 'fuzzy'` to trigger confirmation UI.
 */
export async function detectBotCodeWithSuggestions(
  supabase: SupabaseClient,
  text: string,
  callerPhone?: string,
  countryFilter?: string | null,
): Promise<{
  businessId: string | null;
  suggestions?: { id: string; name: string; bot_code: string }[];
  isCategory?: boolean;
}> {
  const normalizedText = text.toLowerCase().trim();

  const FILLER_WORDS = new Set([
    // English greetings & pleasantries
    'hi', 'hello', 'hey', 'yo', 'sup', 'hiya', 'howdy',
    'good', 'morning', 'afternoon', 'evening', 'night',
    'please', 'pls', 'plz', 'thanks', 'thank', 'you',
    // English action words
    'book', 'booking', 'reserve', 'reservation', 'table', 'order',
    'i', 'want', 'need', 'would', 'like', 'to', 'a', 'an', 'at', 'the', 'for',
    'can', 'me', 'my', 'get', 'make', 'help', 'pay', 'buy', 'ticket',
    'do', 'is', 'are', 'was', 'were', 'be', 'been', 'have', 'has', 'had',
    'this', 'that', 'it', 'its', 'with', 'from', 'of', 'on', 'in', 'or', 'and',
    // Nigerian pidgin / informal
    'wan', 'go', 'dey', 'na', 'abeg', 'oga', 'bro', 'sis', 'bros',
    'madam', 'sir', 'dis', 'dat', 'wetin', 'where', 'how', 'una',
    'e', 'o', 'sha', 'sef', 'joor', 'jare', 'abi', 'shey', 'ehen',
    'no', 'nor', 'don', 'just', 'come', 'give', 'take', 'put',
    'find', 'show', 'look', 'see', 'know', 'tell',
    'one', 'some', 'any', 'which', 'what',
    'im', 'dem', 'we', 'us', 'them', 'they', 'he', 'she',
    'pls', 'biko', 'ejoor', 'mehn', 'guy', 'babe',
  ]);

  // -- 1-4. Batch bot code matching (exact, spaces-to-hyphens, tokens, filler-stripped) in ONE query --
  const spacesToHyphens = normalizedText.replace(/\s+/g, '-');
  const tokens = normalizedText.split(/\s+/);
  const hyphenated = tokens.filter(t => t.includes('-') && /^[a-z0-9-]{2,30}$/.test(t));
  const meaningful = tokens.filter(t => !FILLER_WORDS.has(t) && t.length > 0);

  const codeCandidates = new Set<string>();
  if (/^[a-z0-9-]{2,30}$/.test(normalizedText)) codeCandidates.add(normalizedText);
  if (/^[a-z0-9-]{2,30}$/.test(spacesToHyphens)) codeCandidates.add(spacesToHyphens);
  for (const t of hyphenated) codeCandidates.add(t);
  if (meaningful.length > 0 && meaningful.length <= 6) {
    const joined = meaningful.join('-').replace(/-+/g, '-').slice(0, 30);
    if (/^[a-z0-9-]{2,30}$/.test(joined)) codeCandidates.add(joined);
  }

  if (codeCandidates.size > 0) {
    const orFilter = Array.from(codeCandidates).map(c => `bot_code.ilike.${c}`).join(',');
    const { data } = await supabase
      .from('businesses')
      .select('id')
      .eq('status', 'active')
      .or(orFilter)
      .maybeSingle();
    if (data) return { businessId: data.id };
  }

  // Skip advanced matching if the input is just common greetings/filler
  const allFiller = tokens.every(t => FILLER_WORDS.has(t));
  if (allFiller) return { businessId: null };

  // -- Fetch candidate businesses for advanced matching (5-8) --
  // Grab a broader set of active businesses for local matching algorithms
  const searchWords = meaningful.length > 0 ? meaningful : tokens;
  const nameFilters = searchWords.map(w => `name.ilike.%${sanitizeFilterValue(w)}%`).join(',');
  const codeFilters = searchWords.map(w => `bot_code.ilike.%${sanitizeFilterValue(w)}%`).join(',');

  const { data: candidatePool } = await supabase
    .from('businesses')
    .select('id, name, bot_code, country_code, total_bookings, rating_avg')
    .eq('status', 'active')
    .not('bot_code', 'is', null)
    .or(`${nameFilters},${codeFilters}`)
    .limit(20);

  // -- 5. Acronym detection -- "COG" -> "Citadel-Of-Grace" --
  if (/^[a-z]{2,6}$/i.test(normalizedText)) {
    // Check against the broader pool first, then a targeted query
    const acronymMatches = (candidatePool || []).filter(b =>
      b.bot_code && isAcronymOf(normalizedText, b.bot_code)
    );
    if (acronymMatches.length === 0) {
      // Wider search -- acronym might not match name/code ilike filters
      const { data: allActive } = await supabase
        .from('businesses')
        .select('id, name, bot_code, country_code, total_bookings, rating_avg')
        .eq('status', 'active')
        .not('bot_code', 'is', null)
        .limit(100);

      const wideAcronyms = (allActive || []).filter(b =>
        b.bot_code && isAcronymOf(normalizedText, b.bot_code)
      );

      if (wideAcronyms.length === 1) {
        return { businessId: wideAcronyms[0].id };
      }
      if (wideAcronyms.length > 1) {
        return {
          businessId: null,
          suggestions: rankSuggestions(wideAcronyms, callerPhone).slice(0, 3),
        };
      }
    } else if (acronymMatches.length === 1) {
      return { businessId: acronymMatches[0].id };
    } else {
      return {
        businessId: null,
        suggestions: rankSuggestions(acronymMatches, callerPhone).slice(0, 3),
      };
    }
  }

  // -- 6 & 7. Typo tolerance (Levenshtein) + Phonetic matching (Soundex) --
  // Compare input against all candidates using edit distance and phonetic matching
  if (candidatePool && candidatePool.length > 0) {
    const inputHyphenated = searchWords.join('-');

    type ScoredMatch = { id: string; name: string; bot_code: string; country_code: string | null; total_bookings: number; rating_avg: number; score: number };
    const scored: ScoredMatch[] = [];

    for (const biz of candidatePool) {
      if (!biz.bot_code) continue;
      const code = biz.bot_code.toLowerCase();

      // Levenshtein against bot_code
      const editDist = matchScore(inputHyphenated, code);

      // Levenshtein against name (hyphenated form)
      const nameHyphenated = biz.name.toLowerCase().replace(/\s+/g, '-');
      const nameDist = matchScore(inputHyphenated, nameHyphenated);

      // Phonetic match against bot_code segments
      const isPhonetic = phoneticMatch(inputHyphenated, code);

      // Phonetic match against name
      const isPhoneticName = phoneticMatch(searchWords.join(' '), biz.name);

      const bestDist = Math.min(editDist, nameDist);

      if (bestDist < Infinity || isPhonetic || isPhoneticName) {
        scored.push({
          ...biz,
          bot_code: biz.bot_code,
          score: bestDist < Infinity ? bestDist : 0.5, // phonetic matches get 0.5 score
        });
      }
    }

    if (scored.length > 0) {
      scored.sort((a, b) => a.score - b.score);
      // If the best match has score 0, it's a direct partial match -- auto-route
      if (scored.length === 1 || (scored[0].score <= 1 && scored.length > 1 && scored[1].score > scored[0].score + 1)) {
        // Very confident single best match
        return { businessId: scored[0].id };
      }
      // Return top matches as suggestions
      return {
        businessId: null,
        suggestions: rankSuggestions(scored, callerPhone).slice(0, 3),
      };
    }
  }

  // -- 8. Wider partial name/code search (if narrower filters found nothing) --
  if (!candidatePool || candidatePool.length === 0) {
    // Try each word individually
    for (const word of searchWords) {
      if (word.length < 3) continue;
      const { data: singleWordMatches } = await supabase
        .from('businesses')
        .select('id, name, bot_code, country_code, total_bookings, rating_avg')
        .eq('status', 'active')
        .not('bot_code', 'is', null)
        .or(`name.ilike.%${sanitizeFilterValue(word)}%,bot_code.ilike.%${sanitizeFilterValue(word)}%`)
        .limit(5);

      if (singleWordMatches && singleWordMatches.length > 0) {
        if (singleWordMatches.length === 1) {
          return { businessId: singleWordMatches[0].id };
        }
        return {
          businessId: null,
          suggestions: rankSuggestions(singleWordMatches, callerPhone).slice(0, 3),
        };
      }
    }

    // -- 6b & 7b. Levenshtein + Soundex against ALL businesses (expensive fallback) --
    if (searchWords.length <= 4) {
      const { data: allActive } = await supabase
        .from('businesses')
        .select('id, name, bot_code, country_code, total_bookings, rating_avg')
        .eq('status', 'active')
        .not('bot_code', 'is', null)
        .limit(100);

      if (allActive && allActive.length > 0) {
        const inputHyphenated = searchWords.join('-');
        const fuzzyHits: { id: string; name: string; bot_code: string; country_code: string | null; total_bookings: number; rating_avg: number; score: number }[] = [];

        for (const biz of allActive) {
          if (!biz.bot_code) continue;
          const code = biz.bot_code.toLowerCase();
          const editDist = matchScore(inputHyphenated, code);
          const nameHyphenated = biz.name.toLowerCase().replace(/\s+/g, '-');
          const nameDist = matchScore(inputHyphenated, nameHyphenated);
          const isPhonetic = phoneticMatch(inputHyphenated, code);
          const isPhoneticName = phoneticMatch(searchWords.join(' '), biz.name);

          const bestDist = Math.min(editDist, nameDist);
          if (bestDist < Infinity || isPhonetic || isPhoneticName) {
            fuzzyHits.push({ ...biz, bot_code: biz.bot_code!, score: bestDist < Infinity ? bestDist : 0.5 });
          }
        }

        if (fuzzyHits.length > 0) {
          fuzzyHits.sort((a, b) => a.score - b.score);
          return {
            businessId: null,
            suggestions: rankSuggestions(fuzzyHits, callerPhone).slice(0, 3),
          };
        }
      }
    }
  }

  // -- 9. Category browsing -- "I need a salon near me" --
  const categories = detectCategoryIntent(normalizedText);
  if (categories.length > 0) {
    const catFilter = categories.map(c => `category.eq.${c}`).join(',');
    const { data: catMatches } = await supabase
      .from('businesses')
      .select('id, name, bot_code, country_code, total_bookings, rating_avg')
      .eq('status', 'active')
      .not('bot_code', 'is', null)
      .or(catFilter)
      .order('total_bookings', { ascending: false })
      .limit(5);

    if (catMatches && catMatches.length > 0) {
      return {
        businessId: null,
        suggestions: rankSuggestions(catMatches, callerPhone).slice(0, 3),
        isCategory: true,
      };
    }
  }

  return { businessId: null };
}

/**
 * Rank suggestion results by:
 * 1. Country match (caller's country = business country -> boost)
 * 2. Popularity (total_bookings + rating)
 */
export function rankSuggestions(
  businesses: { id: string; name: string; bot_code: string; country_code?: string | null; total_bookings?: number; rating_avg?: number; score?: number }[],
  callerPhone?: string,
): { id: string; name: string; bot_code: string }[] {
  const callerCountry = callerPhone ? phoneToCountry(callerPhone) : null;

  const scored = businesses.map(b => {
    let rank = 0;
    // Country match bonus (big boost)
    if (callerCountry && b.country_code && b.country_code.toUpperCase() === callerCountry) {
      rank += 1000;
    }
    // Popularity score
    rank += (b.total_bookings || 0) * 2 + (b.rating_avg || 0) * 50;
    // If there's an existing match score, invert it (lower distance = better)
    if (typeof b.score === 'number' && b.score < Infinity) {
      rank -= b.score * 100;
    }
    return { ...b, rank };
  });

  scored.sort((a, b) => b.rank - a.rank);
  return scored.map(({ id, name, bot_code }) => ({ id, name, bot_code }));
}

/**
 * Look up a returning customer's most recent business from past sessions, bookings, and orders.
 * If they've only interacted with one business, auto-route there.
 */
export async function findReturningCustomerBusiness(
  supabase: SupabaseClient,
  phone: string,
  userId: string | null,
  countryFilter?: string | null,
): Promise<string | null> {
  const result = await findReturningCustomerBusinesses(supabase, phone, userId, countryFilter);
  // Auto-route to single business or most recent
  if (result.length > 0) return result[0].id;
  return null;
}

/**
 * Returns ALL recent businesses for a returning customer, ordered by recency.
 * Used for quick-pick lists when customer has multiple past businesses.
 */
export async function findReturningCustomerBusinesses(
  supabase: SupabaseClient,
  phone: string,
  userId: string | null,
  countryFilter?: string | null,
): Promise<{ id: string; name: string; bot_code: string }[]> {
  // Parallel: past sessions + bookings lookup (independent queries)
  const [{ data: pastSessions }, bookingsResult] = await Promise.all([
    supabase
      .from('bot_sessions')
      .select('business_id')
      .eq('whatsapp_number', phone)
      .not('business_id', 'is', null)
      .order('last_active_at', { ascending: false })
      .limit(10),
    userId
      ? supabase
          .from('bookings')
          .select('business_id')
          .eq('user_id', userId)
          .order('created_at', { ascending: false })
          .limit(5)
      : Promise.resolve({ data: null }),
  ]);

  const seen = new Set<string>();
  const uniqueBusinessIds: string[] = [];

  if (pastSessions) {
    for (const s of pastSessions) {
      if (s.business_id && !seen.has(s.business_id)) {
        seen.add(s.business_id);
        uniqueBusinessIds.push(s.business_id);
      }
    }
  }

  if (bookingsResult.data) {
    for (const b of bookingsResult.data) {
      if (b.business_id && !seen.has(b.business_id)) {
        seen.add(b.business_id);
        uniqueBusinessIds.push(b.business_id);
      }
    }
  }

  if (uniqueBusinessIds.length === 0) return [];

  // Fetch business details — prefer same-country, fall back to cross-country
  const baseBizQuery = () => supabase
    .from('businesses')
    .select('id, name, bot_code')
    .in('id', uniqueBusinessIds)
    .eq('status', 'active')
    .not('bot_code', 'is', null);

  let { data: businesses } = countryFilter
    ? await baseBizQuery().eq('country_code', countryFilter)
    : await baseBizQuery();

  // If country filter excluded all results, retry without it — the user
  // explicitly interacted with a cross-country business (e.g. NG business via US number)
  if ((!businesses || businesses.length === 0) && countryFilter) {
    const fallback = await baseBizQuery();
    businesses = fallback.data;
  }

  if (!businesses || businesses.length === 0) return [];

  // Preserve recency order from uniqueBusinessIds
  const bizMap = new Map(businesses.map(b => [b.id, b]));
  return uniqueBusinessIds
    .map(id => bizMap.get(id))
    .filter((b): b is { id: string; name: string; bot_code: string } => !!b && !!b.bot_code);
}
