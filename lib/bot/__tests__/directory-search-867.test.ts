/**
 * #867: what the WhatsApp directory search sends to searchMarketplace.
 * Production "Shop in ikoyi" returned 0 results; these pin the criteria the
 * handler builds for the phrasings customers use.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimitAsync: vi.fn().mockResolvedValue({ allowed: true }),
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const searchMarketplace = vi.fn();
vi.mock('@/lib/marketplace/search', () => ({
  searchMarketplace: (...args: unknown[]) => searchMarketplace(...args),
  searchFuzzy: vi.fn().mockResolvedValue([]),
  loadDirectoryHiddenIds: vi.fn().mockResolvedValue([]),
  isBusinessDirectoryEligible: vi.fn().mockResolvedValue(true),
}));

import { handleDirectorySearch } from '@/lib/bot/handlers/directory-search';

const send = {
  sendPlatformText: vi.fn().mockResolvedValue(undefined),
  sendPlatformList: vi.fn().mockResolvedValue(undefined),
  sendPlatformButtons: vi.fn().mockResolvedValue(undefined),
};

async function criteriaFor(text: string) {
  searchMarketplace.mockResolvedValue({ ok: true, results: [], hasMore: false });
  await handleDirectorySearch({} as never, send as never, '+2348000000000', text, 'NG', 'en');
  expect(searchMarketplace).toHaveBeenCalled();
  // The first search is the one for the customer's place (#1072 may then widen).
  return searchMarketplace.mock.calls[0][1] as Record<string, any>;
}

beforeEach(() => {
  searchMarketplace.mockReset();
});

// #1072: places are matched against neighborhood, city, state and address via
// `place` (area first, then the rest of its state) instead of city + address hint.
describe('#867 directory search criteria (as revised by #1072)', () => {
  it.each(['shop in Ikoyi', 'Shop in ikoyi', 'shops Ikoyi', 'Ikoyi shop'])(
    '"%s" searches the Ikoyi area within Lagos and keeps the shop filter',
    async (text) => {
      const c = await criteriaFor(text);
      expect(c.place.areaTerms).toEqual(['Ikoyi']);
      expect(c.place.stateTerms).toContain('Lagos');
      expect(c.locationText).toBeUndefined();
      expect(c.country).toBe('NG');
      // "shop" is a generic word, so the shop synonym filter comes from the text.
      expect(String(c.query ?? c.category).toLowerCase()).toContain('shop');
    },
  );

  it('"businesses in Ikoyi" searches the place only, not the literal phrase', async () => {
    const c = await criteriaFor('businesses in Ikoyi');
    expect(c.place.areaTerms).toEqual(['Ikoyi']);
    expect(c.query).toBeUndefined();
    expect(c.category).toBeUndefined();
  });

  it('"Ikoyi" alone searches the place only', async () => {
    const c = await criteriaFor('Ikoyi');
    expect(c.place.areaTerms).toEqual(['Ikoyi']);
    expect(c.query).toBeUndefined();
  });

  it('"boutique in Ikoyi" searches the name "boutique" in Ikoyi, not the whole phrase', async () => {
    const c = await criteriaFor('boutique in Ikoyi');
    expect(c.place.areaTerms).toEqual(['Ikoyi']);
    expect(c.query).toBe('boutique');
  });

  it('a bare generic word without a place keeps the raw text (never the whole directory)', async () => {
    const c = await criteriaFor('businesses');
    expect(c.query).toBe('businesses');
  });

  // A state is now a place filter (#1072), so a state search lists only that state.
  it.each(['Oyo', 'businesses in Oyo'])(
    '"%s" searches Oyo state only (never the whole country)',
    async (text) => {
      const c = await criteriaFor(text);
      expect(c.place.level).toBe('state');
      expect(c.place.stateTerms).toEqual(['Oyo']);
      expect(c.query).toBeUndefined();
      expect(searchMarketplace).toHaveBeenCalledTimes(1); // a place alone is never widened
    },
  );

  // Review r2 P1-1: a country applies no place filter, so the text must be kept.
  it.each(['Nigeria', 'businesses in Nigeria'])(
    '"%s" keeps its text (a country never lists the whole directory)',
    async (text) => {
      const c = await criteriaFor(text);
      expect(c.place).toBeUndefined();
      expect(c.query).toBe(text);
    },
  );
});
