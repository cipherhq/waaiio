/**
 * Fuzzy matching utilities for bot code detection.
 * Levenshtein distance, Soundex phonetic matching, and acronym detection.
 */

// ── Levenshtein Distance ──

/** Calculate the edit distance between two strings */
export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  // Use single-row optimization for memory efficiency
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array<number>(n + 1);

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,       // deletion
        curr[j - 1] + 1,   // insertion
        prev[j - 1] + cost, // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

/**
 * Check if two strings are "close enough" based on their lengths.
 * Allows 1 edit for strings <= 6 chars, 2 edits for 7-12, 3 for longer.
 */
export function isCloseMatch(a: string, b: string): boolean {
  const maxLen = Math.max(a.length, b.length);
  const threshold = maxLen <= 6 ? 1 : maxLen <= 12 ? 2 : 3;
  return levenshtein(a, b) <= threshold;
}

/**
 * Score a match: lower is better. Returns Infinity if not close enough.
 */
export function matchScore(input: string, target: string): number {
  const dist = levenshtein(input, target);
  const maxLen = Math.max(input.length, target.length);
  const threshold = maxLen <= 6 ? 1 : maxLen <= 12 ? 2 : 3;
  return dist <= threshold ? dist : Infinity;
}


// ── Soundex Phonetic Matching ──

/** Generate a Soundex code for a string */
export function soundex(str: string): string {
  const s = str.toUpperCase().replace(/[^A-Z]/g, '');
  if (!s) return '';

  const map: Record<string, string> = {
    B: '1', F: '1', P: '1', V: '1',
    C: '2', G: '2', J: '2', K: '2', Q: '2', S: '2', X: '2', Z: '2',
    D: '3', T: '3',
    L: '4',
    M: '5', N: '5',
    R: '6',
  };

  let code = s[0];
  let lastCode = map[s[0]] || '';

  for (let i = 1; i < s.length && code.length < 4; i++) {
    const c = map[s[i]];
    if (c && c !== lastCode) {
      code += c;
    }
    lastCode = c || '';
  }

  return code.padEnd(4, '0');
}

/**
 * Compare two strings phonetically.
 * Splits on hyphens/spaces and compares each segment's Soundex code.
 */
export function phoneticMatch(input: string, target: string): boolean {
  const inputParts = input.toLowerCase().split(/[-\s]+/).filter(Boolean);
  const targetParts = target.toLowerCase().split(/[-\s]+/).filter(Boolean);

  // Must have same number of segments
  if (inputParts.length !== targetParts.length) return false;
  if (inputParts.length === 0) return false;

  return inputParts.every((part, i) => {
    const s1 = soundex(part);
    const s2 = soundex(targetParts[i]);
    return s1 && s2 && s1 === s2;
  });
}


// ── Acronym Detection ──

/**
 * Check if input is an acronym of a hyphenated bot code.
 * "COG" matches "Citadel-Of-Grace", "BH" matches "Bukka-Hut"
 */
export function isAcronymOf(input: string, botCode: string): boolean {
  const acronym = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (acronym.length < 2 || acronym.length > 6) return false;

  const parts = botCode.split('-').filter(p => p.length > 0);
  if (parts.length < 2) return false;

  // Build acronym from first letter of each part
  const codeAcronym = parts.map(p => p[0].toUpperCase()).join('');
  return acronym === codeAcronym;
}


// ── Phone Country Detection ──

const PHONE_COUNTRY_MAP: Record<string, string> = {
  '234': 'NG',  // Nigeria
  '1': 'US',    // USA / Canada
  '44': 'GB',   // UK
  '233': 'GH',  // Ghana
  '254': 'KE',  // Kenya
  '27': 'ZA',   // South Africa
  '91': 'IN',   // India
  '971': 'AE',  // UAE
};

/** Detect country code from a phone number (E.164 format) */
export function phoneToCountry(phone: string): string | null {
  const digits = phone.replace(/[^0-9]/g, '');

  // Try 3-digit, then 2-digit, then 1-digit prefix
  for (const len of [3, 2, 1]) {
    const prefix = digits.slice(0, len);
    if (PHONE_COUNTRY_MAP[prefix]) return PHONE_COUNTRY_MAP[prefix];
  }
  return null;
}


// ── Category Keyword Mapping ──

/** Maps common natural language terms to business category keys */
export const CATEGORY_KEYWORDS: Record<string, string[]> = {
  restaurant: ['restaurant', 'food', 'eat', 'dining', 'chop', 'amala', 'jollof', 'suya', 'pepper soup', 'eatery', 'bukka', 'mama put'],
  barber: ['barber', 'barbershop', 'barbing', 'haircut', 'trim', 'fade', 'shave'],
  spa: ['spa', 'massage', 'facial', 'pedicure', 'manicure', 'nail', 'nails', 'wax', 'waxing'],
  salon: ['salon', 'hair', 'hairdresser', 'braids', 'weave', 'wig', 'locs', 'dreadlocks', 'cornrow'],
  gym: ['gym', 'fitness', 'workout', 'exercise', 'training', 'yoga', 'pilates'],
  clinic: ['clinic', 'hospital', 'doctor', 'medical', 'health', 'checkup'],
  church: ['church', 'parish', 'ministry', 'pastor', 'tithe', 'offering'],
  mosque: ['mosque', 'masjid', 'imam'],
  shop: ['shop', 'store', 'retail', 'buy', 'purchase'],
  food_delivery: ['delivery', 'deliver', 'dispatch'],
  events: ['event', 'concert', 'show', 'party', 'festival', 'conference'],
  hotel: ['hotel', 'lodge', 'accommodation', 'room', 'stay', 'guest house'],
  laundry: ['laundry', 'dry cleaning', 'wash', 'iron', 'pressing'],
  pharmacy: ['pharmacy', 'chemist', 'drug', 'medicine', 'medication'],
  dental: ['dental', 'dentist', 'teeth', 'tooth'],
  car_wash: ['car wash', 'wash car', 'auto wash', 'detailing'],
  tailor: ['tailor', 'fashion', 'sew', 'sewing', 'cloth', 'outfit', 'dress'],
  photographer: ['photographer', 'photography', 'photo', 'shoot', 'studio'],
  catering: ['catering', 'caterer'],
  tattoo: ['tattoo', 'ink', 'piercing'],
};

/**
 * Detect category intent from natural language.
 * Returns matched category keys or empty array.
 */
export function detectCategoryIntent(text: string): string[] {
  const lower = text.toLowerCase();
  const matched: string[] = [];

  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    for (const kw of keywords) {
      if (lower.includes(kw)) {
        matched.push(category);
        break;
      }
    }
  }

  return matched;
}
