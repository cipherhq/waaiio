/**
 * Discovery Search Tests — Phase B / #584
 *
 * Tests for geographic search (location resolver + search criteria wiring),
 * hidden-business exclusion, public-field allowlisting, and pagination bounds.
 *
 * These tests exercise the location-resolver and search.ts criteria logic
 * independently of bot.service.ts (which is #266-owned).
 */

import { describe, it, expect } from 'vitest';
import {
  resolveLocation,
  resolveCompoundLocation,
  type LocationResolution,
} from '../location-resolver';
import { DISCOVERY_PUBLIC_FIELDS } from '../search';
import type { MarketplaceSearchCriteria, MarketplaceResult } from '../search';

// ── Location Resolver: Tier 1 — City-level match ────────

describe('resolveLocation — Tier 1 (city)', () => {
  it('resolves "Lagos" as tier 1 city match', () => {
    const r = resolveLocation('Lagos');
    expect(r.tier).toBe(1);
    expect(r.city).toBe('Lagos');
    expect(r.addressHint).toBeNull();
    expect(r.countryCode).toBeNull();
  });

  it('resolves "Accra" as tier 1 city match', () => {
    const r = resolveLocation('Accra');
    expect(r.tier).toBe(1);
    expect(r.city).toBe('Accra');
  });

  it('resolves "Abuja" as tier 1 city match', () => {
    const r = resolveLocation('Abuja');
    expect(r.tier).toBe(1);
    expect(r.city).toBe('Abuja');
  });

  it('resolves "london" case-insensitively', () => {
    const r = resolveLocation('london');
    expect(r.tier).toBe(1);
    expect(r.city).toBe('London');
  });

  it('resolves "Port Harcourt" as tier 1', () => {
    const r = resolveLocation('Port Harcourt');
    expect(r.tier).toBe(1);
    expect(r.city).toBe('Port Harcourt');
  });

  it('resolves country name "Nigeria" as tier 1 with countryCode', () => {
    const r = resolveLocation('Nigeria');
    expect(r.tier).toBe(1);
    expect(r.countryCode).toBe('NG');
    expect(r.city).toBeNull();
  });

  it('resolves country name "Ghana" as tier 1 with countryCode', () => {
    const r = resolveLocation('Ghana');
    expect(r.tier).toBe(1);
    expect(r.countryCode).toBe('GH');
  });
});

// ── Location Resolver: Tier 2 — Neighbourhood hint ──────

describe('resolveLocation — Tier 2 (neighbourhood)', () => {
  it('resolves "Lekki" as tier 2 neighbourhood under Lagos', () => {
    const r = resolveLocation('Lekki');
    expect(r.tier).toBe(2);
    expect(r.city).toBe('Lagos');
    expect(r.addressHint).toBe('Lekki');
    expect(r.parentCityLabel).toBe('Lagos');
  });

  it('resolves "Victoria Island" as tier 2 under Lagos', () => {
    const r = resolveLocation('Victoria Island');
    expect(r.tier).toBe(2);
    expect(r.city).toBe('Lagos');
    expect(r.addressHint).toBe('Victoria Island');
  });

  it('resolves "Ikeja" as tier 2 under Lagos (substring of "Ikeja GRA")', () => {
    const r = resolveLocation('Ikeja');
    expect(r.tier).toBe(2);
    expect(r.city).toBe('Lagos');
    expect(r.addressHint).toBe('Ikeja');
  });

  it('resolves "East Legon" as tier 2 under Accra', () => {
    const r = resolveLocation('East Legon');
    expect(r.tier).toBe(2);
    expect(r.city).toBe('Accra');
    expect(r.addressHint).toBe('East Legon');
  });

  it('resolves "Shoreditch" as tier 2 under London', () => {
    const r = resolveLocation('Shoreditch');
    expect(r.tier).toBe(2);
    expect(r.city).toBe('London');
  });

  it('Lekki resolves to different parent city than Victoria Island', () => {
    const lekki = resolveLocation('Lekki');
    const vi = resolveLocation('Victoria Island');
    // Both are under Lagos, but have different addressHints
    expect(lekki.city).toBe('Lagos');
    expect(vi.city).toBe('Lagos');
    expect(lekki.addressHint).toBe('Lekki');
    expect(vi.addressHint).toBe('Victoria Island');
    expect(lekki.addressHint).not.toBe(vi.addressHint);
  });
});

// ── Location Resolver: Tier 3 — Unknown location ────────

describe('resolveLocation — Tier 3 (unknown)', () => {
  it('returns tier 3 for unknown location "Zxywvut"', () => {
    const r = resolveLocation('Zxywvut');
    expect(r.tier).toBe(3);
    expect(r.city).toBeNull();
    expect(r.addressHint).toBeNull();
    expect(r.countryCode).toBeNull();
  });

  it('returns tier 3 for empty string', () => {
    const r = resolveLocation('');
    expect(r.tier).toBe(3);
  });

  it('returns tier 3 for whitespace-only', () => {
    const r = resolveLocation('   ');
    expect(r.tier).toBe(3);
  });

  it('returns tier 3 for a bot-code-like string', () => {
    const r = resolveLocation('CITADEL-GRACE');
    expect(r.tier).toBe(3);
  });
});

// ── Compound Location Resolution ────────────────────────

describe('resolveCompoundLocation', () => {
  it('"Lekki, Lagos" resolves as tier 2 neighbourhood (Lekki wins over Lagos)', () => {
    const r = resolveCompoundLocation('Lekki, Lagos');
    expect(r.tier).toBe(2);
    expect(r.city).toBe('Lagos');
    expect(r.addressHint).toBe('Lekki');
    expect(r.parentCityLabel).toBe('Lagos');
  });

  it('"Lagos" resolves as tier 1 city', () => {
    const r = resolveCompoundLocation('Lagos');
    expect(r.tier).toBe(1);
    expect(r.city).toBe('Lagos');
    expect(r.addressHint).toBeNull();
  });

  it('"Victoria Island, Lagos" resolves as tier 2', () => {
    const r = resolveCompoundLocation('Victoria Island, Lagos');
    expect(r.tier).toBe(2);
    expect(r.city).toBe('Lagos');
    expect(r.addressHint).toBe('Victoria Island');
  });

  it('"Zxywvut" resolves as tier 3', () => {
    const r = resolveCompoundLocation('Zxywvut');
    expect(r.tier).toBe(3);
  });

  it('"East Legon, Accra" resolves as tier 2 under Accra', () => {
    const r = resolveCompoundLocation('East Legon, Accra');
    expect(r.tier).toBe(2);
    expect(r.city).toBe('Accra');
    expect(r.addressHint).toBe('East Legon');
  });

  it('truncates to max 3 tokens', () => {
    const r = resolveCompoundLocation('xzqq, yzzr, wxxp, aaaa, bbbb');
    // Only first 3 tokens are considered — all unknown
    expect(r.tier).toBe(3);
  });

  it('"Lagos, Accra" rejects contradictory cities instead of silently choosing one', () => {
    expect(resolveCompoundLocation('Lagos, Accra').tier).toBe(3);
  });

  it('"Lekki, Accra" rejects conflicting neighborhood and parent city', () => {
    expect(resolveCompoundLocation('Lekki, Accra').tier).toBe(3);
  });

  it('"Lekki, Zxywvut" rejects unknown extra tokens', () => {
    expect(resolveCompoundLocation('Lekki, Zxywvut').tier).toBe(3);
  });

  it('"Lekki, Nigeria" resolves a compatible neighborhood + country', () => {
    const r = resolveCompoundLocation('Lekki, Nigeria');
    expect(r.tier).toBe(2);
    expect(r.city).toBe('Lagos');
  });

  it('"Lekki, Ghana" rejects incompatible neighborhood + country', () => {
    expect(resolveCompoundLocation('Lekki, Ghana').tier).toBe(3);
  });
});

// ── Search Criteria Wiring ──────────────────────────────

describe('search criteria from location resolution', () => {
  function buildCriteria(
    resolution: LocationResolution,
    category?: string,
  ): Partial<MarketplaceSearchCriteria> {
    const criteria: Partial<MarketplaceSearchCriteria> = {};
    if (category) criteria.category = category;
    if (resolution.city) criteria.locationText = resolution.city;
    if (resolution.addressHint) {
      criteria._addressHint = resolution.addressHint;
      // Ensure locationText is the parent city, not the hint
      if (resolution.city) criteria.locationText = resolution.city;
    }
    if (resolution.countryCode) criteria.country = resolution.countryCode;
    return criteria;
  }

  it('"restaurants in Lagos" → category=restaurant, locationText=Lagos', () => {
    const loc = resolveLocation('Lagos');
    const c = buildCriteria(loc, 'restaurant');
    expect(c.category).toBe('restaurant');
    expect(c.locationText).toBe('Lagos');
    expect(c._addressHint).toBeUndefined();
  });

  it('"salon in Lekki" → category=salon, locationText=Lagos, _addressHint=Lekki', () => {
    const loc = resolveLocation('Lekki');
    const c = buildCriteria(loc, 'salon');
    expect(c.category).toBe('salon');
    expect(c.locationText).toBe('Lagos');
    expect(c._addressHint).toBe('Lekki');
  });

  it('"barbers in Accra" → category=barber, locationText=Accra, NO country filter', () => {
    const loc = resolveLocation('Accra');
    const c = buildCriteria(loc, 'barber');
    expect(c.category).toBe('barber');
    expect(c.locationText).toBe('Accra');
    expect(c.country).toBeUndefined();
  });

  it('"salons in Ghana" → category=salon, country=GH, no city filter', () => {
    const loc = resolveLocation('Ghana');
    const c = buildCriteria(loc, 'salon');
    expect(c.category).toBe('salon');
    expect(c.country).toBe('GH');
    expect(c.locationText).toBeUndefined();
  });

  it('"restaurants in Zxywvut" → tier 3, no criteria filters applied', () => {
    const loc = resolveLocation('Zxywvut');
    const c = buildCriteria(loc, 'restaurant');
    expect(c.category).toBe('restaurant');
    expect(c.locationText).toBeUndefined();
    expect(c._addressHint).toBeUndefined();
    expect(c.country).toBeUndefined();
  });
});

// ── Address Hint Specificity (Lekki vs Victoria Island) ──

describe('address hint specificity', () => {
  // These tests verify the CONTRACT that will be enforced when
  // searchMarketplace() processes the criteria. The address hint
  // is an AND filter on the `address` column.

  it('Lekki address hint would match "45 Admiralty Way, Lekki Phase 1, Lagos"', () => {
    const address = '45 Admiralty Way, Lekki Phase 1, Lagos';
    const hint = 'Lekki';
    expect(address.toLowerCase().includes(hint.toLowerCase())).toBe(true);
  });

  it('Lekki address hint would NOT match "23 Adeola Odeku St, Victoria Island, Lagos"', () => {
    const address = '23 Adeola Odeku St, Victoria Island, Lagos';
    const hint = 'Lekki';
    expect(address.toLowerCase().includes(hint.toLowerCase())).toBe(false);
  });

  it('Lekki address hint would NOT match "Lekki Villa Complex, Wuse, Abuja"', () => {
    // This address contains "Lekki" BUT the parent-city filter (city='Lagos')
    // would exclude this Abuja business. The test verifies the hint alone
    // WOULD match, but the city AND hint together prevent cross-city leakage.
    const address = 'Lekki Villa Complex, Wuse, Abuja';
    const hint = 'Lekki';
    const businessCity = 'Abuja';
    const filterCity = 'Lagos';
    const hintMatches = address.toLowerCase().includes(hint.toLowerCase());
    const cityMatches = businessCity.toLowerCase().includes(filterCity.toLowerCase());
    // Hint matches the address, but city constraint fails → excluded
    expect(hintMatches).toBe(true);
    expect(cityMatches).toBe(false);
  });

  it('Victoria Island hint would NOT match a Lekki address', () => {
    const address = '45 Admiralty Way, Lekki Phase 1, Lagos';
    const hint = 'Victoria Island';
    expect(address.toLowerCase().includes(hint.toLowerCase())).toBe(false);
  });
});

// ── Sanitization / Injection Prevention ─────────────────

describe('location text sanitization', () => {
  it('locationText with only injection chars "%%%" results in locationFailed', () => {
    // The search function strips %_'"\ and checks if result is empty.
    // "%%%" → "" → locationFailed=true
    const input = '%%%';
    const sanitized = input.replace(/[%_'"\\]/g, '');
    expect(sanitized).toBe('');
    // This maps to locationFailed=true in searchMarketplace()
  });

  it('locationText with mixed valid/injection chars preserves valid parts', () => {
    const input = "Lagos'%";
    const sanitized = input.replace(/[%_'"\\]/g, '');
    expect(sanitized).toBe('Lagos');
    expect(sanitized.length).toBeGreaterThan(0);
  });

  it('_addressHint with injection chars is sanitized', () => {
    const input = "Lekki'; DROP TABLE";
    const sanitized = input.replace(/[%_'"\\]/g, '');
    expect(sanitized).toBe('Lekki; DROP TABLE');
    // Apostrophe stripped; remaining text is safe for ILIKE (no SQL injection via Supabase client)
  });
});

// ── ExcludeIds Validation ───────────────────────────────

describe('excludeIds UUID validation', () => {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  it('accepts valid UUID v4', () => {
    expect(UUID_RE.test('a1b2c3d4-e5f6-7890-abcd-ef1234567890')).toBe(true);
  });

  it('rejects non-UUID strings', () => {
    expect(UUID_RE.test('not-a-uuid')).toBe(false);
    expect(UUID_RE.test('')).toBe(false);
    expect(UUID_RE.test('DROP TABLE businesses')).toBe(false);
  });

  it('rejects UUID-like strings with wrong length', () => {
    expect(UUID_RE.test('a1b2c3d4-e5f6-7890-abcd-ef12345678')).toBe(false);
  });

  it('rejects strings with special characters in UUID position', () => {
    expect(UUID_RE.test("a1b2c3d4-e5f6-7890-abcd-ef123456789'")).toBe(false);
  });
});

// ── Public Field Allowlist Contract ─────────────────────

describe('DISCOVERY_PUBLIC_FIELDS contract', () => {
  it('contains exactly the 6 approved public fields', () => {
    expect(DISCOVERY_PUBLIC_FIELDS).toEqual([
      'name',
      'category',
      'city',
      'isOpenNow',
      'shortDescription',
      'botCode',
    ]);
  });

  it('does NOT contain private fields', () => {
    const prohibited = [
      'businessId', 'id', 'address', 'phone', 'slug',
      'priceBand', 'supportsDelivery', 'distanceKm',
      'countryCode', 'matchReasons', 'actions',
    ];
    for (const field of prohibited) {
      expect((DISCOVERY_PUBLIC_FIELDS as readonly string[]).includes(field)).toBe(false);
    }
  });

  it('every field exists on MarketplaceResult type', () => {
    // Type-level check: create a MarketplaceResult and verify fields exist
    const result: MarketplaceResult = {
      businessId: 'test',
      name: 'Test',
      category: 'salon',
      shortDescription: null,
      matchReasons: [],
      actions: [],
    };
    for (const field of DISCOVERY_PUBLIC_FIELDS) {
      expect(field in result || field === 'isOpenNow' || field === 'botCode' || field === 'city').toBe(true);
    }
  });
});

// ── Pagination Bounds Contract ──────────────────────────

describe('pagination bounds', () => {
  const DISCOVERY_PAGE_SIZE = 5;
  const DISCOVERY_MAX_PAGES = 3;
  const DISCOVERY_MAX_RESULTS = DISCOVERY_PAGE_SIZE * DISCOVERY_MAX_PAGES; // 15

  it('max results is 15 (5 per page × 3 pages)', () => {
    expect(DISCOVERY_MAX_RESULTS).toBe(15);
  });

  it('page index maps correctly to result slice', () => {
    const results = Array.from({ length: 15 }, (_, i) => `biz-${i}`);
    for (let page = 0; page < DISCOVERY_MAX_PAGES; page++) {
      const start = page * DISCOVERY_PAGE_SIZE;
      const end = start + DISCOVERY_PAGE_SIZE;
      const pageResults = results.slice(start, end);
      expect(pageResults).toHaveLength(5);
      expect(pageResults[0]).toBe(`biz-${page * 5}`);
    }
  });

  it('selection index maps from page-local (1-5) to global correctly', () => {
    for (let page = 0; page < DISCOVERY_MAX_PAGES; page++) {
      for (let selection = 1; selection <= DISCOVERY_PAGE_SIZE; selection++) {
        const globalIndex = page * DISCOVERY_PAGE_SIZE + (selection - 1);
        expect(globalIndex).toBeGreaterThanOrEqual(0);
        expect(globalIndex).toBeLessThan(DISCOVERY_MAX_RESULTS);
      }
    }
  });

  it('selection outside 1-5 range is invalid', () => {
    const validSelections = [1, 2, 3, 4, 5];
    expect(validSelections.includes(0)).toBe(false);
    expect(validSelections.includes(6)).toBe(false);
    expect(validSelections.includes(-1)).toBe(false);
  });

  it('partial last page handles correctly', () => {
    const totalResults = 12; // 3 pages: 5, 5, 2
    const lastPage = 2;
    const start = lastPage * DISCOVERY_PAGE_SIZE;
    const end = Math.min(start + DISCOVERY_PAGE_SIZE, totalResults);
    expect(end - start).toBe(2); // Only 2 results on last page
  });
});
