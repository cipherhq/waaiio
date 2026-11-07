/**
 * Broadcasts page audience (#591 Part B). Client-safe, no database access.
 *
 * The page starts from the server's opted-in list (GET /api/broadcasts/recipients,
 * the same rule the send routes apply) and only ever narrows it here, so the
 * "Sending to N" count can never include someone the server would skip.
 */

/** One opted-in person, with the profile details the page filters on (null when they have no profile). */
export interface EligibleContact {
  phone: string;
  name: string | null;
  tags: string[];
  total_spent: number | null;
  last_seen_at: string | null;
}

export interface AudienceFilterInput {
  preset: 'all' | 'active_30' | 'inactive_30' | 'high_spenders' | 'by_tag';
  lastVisit: '' | '7days' | '30days' | '90days' | 'over90';
  minSpend: number | '';
  tags: string[];
}

const DAY_MS = 86_400_000;

export const phoneDigits = (p: string) => (p || '').replace(/\D/g, '');

/** Same filters the page offered before, applied to opted-in people only. A missing profile value never matches a filter on it. */
export function filterEligibleAudience(eligible: EligibleContact[], f: AudienceFilterInput, now = Date.now()): EligibleContact[] {
  const seen = (c: EligibleContact) => (c.last_seen_at ? Date.parse(c.last_seen_at) : NaN);
  const seenSince = (days: number) => (c: EligibleContact) => seen(c) >= now - days * DAY_MS;
  const seenBefore = (days: number) => (c: EligibleContact) => seen(c) <= now - days * DAY_MS;

  let out = eligible;
  if (f.preset === 'active_30') out = out.filter(seenSince(30));
  else if (f.preset === 'inactive_30') out = out.filter(seenBefore(30));

  if (f.lastVisit === '7days') out = out.filter(seenSince(7));
  else if (f.lastVisit === '30days') out = out.filter(seenSince(30));
  else if (f.lastVisit === '90days') out = out.filter(seenSince(90));
  else if (f.lastVisit === 'over90') out = out.filter(seenBefore(90));

  if (f.minSpend && Number(f.minSpend) > 0) {
    const min = Number(f.minSpend);
    out = out.filter(c => c.total_spent !== null && Number(c.total_spent) >= min);
  }
  if (f.tags.length > 0) out = out.filter(c => f.tags.every(t => c.tags.includes(t)));

  // High spenders: above the average of what is left.
  if (f.preset === 'high_spenders' && out.length > 0) {
    const avg = out.reduce((s, c) => s + Number(c.total_spent || 0), 0) / out.length;
    out = out.filter(c => Number(c.total_spent || 0) > avg);
  }
  return out;
}

/** Tags worth offering as filters: only tags some opted-in person has. */
export function eligibleTags(eligible: EligibleContact[]): string[] {
  return Array.from(new Set(eligible.flatMap(c => c.tags))).sort();
}

/**
 * Keeps only the given phone numbers that belong to an opted-in person (matched
 * on digits, as the send route does), returning that person's record.
 */
export function keepEligible(phones: string[], eligible: EligibleContact[]): { kept: EligibleContact[]; skipped: number } {
  const byDigits = new Map(eligible.map(c => [phoneDigits(c.phone), c]));
  const kept = new Map<string, EligibleContact>();
  let skipped = 0;
  for (const p of phones) {
    const d = phoneDigits(p);
    const hit = byDigits.get(d);
    if (hit) kept.set(d, hit);
    else skipped++;
  }
  return { kept: Array.from(kept.values()), skipped };
}
