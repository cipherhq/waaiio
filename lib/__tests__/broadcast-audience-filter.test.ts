/** #591 Part B — the Broadcasts page filters only ever narrow the opted-in list. */
import { describe, expect, it } from 'vitest';
import { filterEligibleAudience, eligibleTags, keepEligible, type EligibleContact, type AudienceFilterInput } from '@/lib/broadcasts/audience-filter';

const NOW = Date.parse('2026-11-06T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();
const c = (phone: string, over: Partial<EligibleContact> = {}): EligibleContact => ({ phone, name: null, tags: [], total_spent: null, last_seen_at: null, ...over });
const f = (over: Partial<AudienceFilterInput> = {}): AudienceFilterInput => ({ preset: 'all', lastVisit: '', minSpend: '', tags: [], ...over });

const RECENT = c('+2348031111111', { tags: ['vip', 'lagos'], total_spent: 9000, last_seen_at: daysAgo(2) });
const OLD = c('+2348032222222', { tags: ['vip'], total_spent: 100, last_seen_at: daysAgo(120) });
const NO_PROFILE = c('+2348033333333');
const ALL = [RECENT, OLD, NO_PROFILE];
const phones = (list: EligibleContact[]) => list.map(x => x.phone);

describe('filterEligibleAudience', () => {
  it('"all" is the whole opted-in list, including people with no profile', () => {
    expect(phones(filterEligibleAudience(ALL, f(), NOW))).toEqual(phones(ALL));
  });

  it('activity filters match on last seen; a missing value never matches', () => {
    expect(phones(filterEligibleAudience(ALL, f({ preset: 'active_30' }), NOW))).toEqual([RECENT.phone]);
    expect(phones(filterEligibleAudience(ALL, f({ preset: 'inactive_30' }), NOW))).toEqual([OLD.phone]);
    expect(phones(filterEligibleAudience(ALL, f({ lastVisit: 'over90' }), NOW))).toEqual([OLD.phone]);
    expect(phones(filterEligibleAudience(ALL, f({ lastVisit: '7days' }), NOW))).toEqual([RECENT.phone]);
  });

  it('spend, tags (all must match) and high spenders narrow the list', () => {
    expect(phones(filterEligibleAudience(ALL, f({ minSpend: 500 }), NOW))).toEqual([RECENT.phone]);
    expect(phones(filterEligibleAudience(ALL, f({ tags: ['vip'] }), NOW))).toEqual([RECENT.phone, OLD.phone]);
    expect(phones(filterEligibleAudience(ALL, f({ tags: ['vip', 'lagos'] }), NOW))).toEqual([RECENT.phone]);
    expect(phones(filterEligibleAudience(ALL, f({ preset: 'high_spenders' }), NOW))).toEqual([RECENT.phone]);
  });

  it('never returns anyone outside the opted-in list', () => {
    for (const filters of [f(), f({ preset: 'active_30' }), f({ preset: 'high_spenders' }), f({ tags: ['vip'] })]) {
      for (const p of phones(filterEligibleAudience(ALL, filters, NOW))) expect(phones(ALL)).toContain(p);
    }
    expect(filterEligibleAudience([], f(), NOW)).toEqual([]);
  });
});

describe('eligibleTags / keepEligible', () => {
  it('offers only tags opted-in people have', () => {
    expect(eligibleTags(ALL)).toEqual(['lagos', 'vip']);
  });

  it('keeps imported numbers that match an opted-in person by digits and counts the rest', () => {
    const { kept, skipped } = keepEligible(['2348031111111', '+234 803 222 2222', '08031111111', '+2348039999999', '+2348031111111'], ALL);
    expect(phones(kept)).toEqual([RECENT.phone, OLD.phone]);
    expect(skipped).toBe(2);
  });
});
