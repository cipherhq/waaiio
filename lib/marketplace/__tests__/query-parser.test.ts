import { describe, it, expect } from 'vitest';
import { parseDirectoryQuery } from '../query-parser';

describe('parseDirectoryQuery', () => {
  // ── Category + Location splits ──

  it('"spa in Lagos" → categories: ["spa"], location: "Lagos"', () => {
    const result = parseDirectoryQuery('spa in Lagos');
    expect(result.categories).toEqual(['spa']);
    expect(result.locationText).toBe('Lagos');
    expect(result.resolvedLocation).not.toBeNull();
    expect(result.resolvedLocation!.tier).toBe(1);
    expect(result.resolvedLocation!.city).toBe('Lagos');
    expect(result.needsLocation).toBe(false);
    expect(result.nameQuery).toBeNull();
  });

  it('"restaurants in Ibadan" → categories: ["restaurant"], location: "Ibadan"', () => {
    const result = parseDirectoryQuery('restaurants in Ibadan');
    expect(result.categories).toContain('restaurant');
    expect(result.locationText).toBe('Ibadan');
    // Ibadan is not in COUNTRIES data, so tier 3
    expect(result.resolvedLocation).not.toBeNull();
    expect(result.needsLocation).toBe(false);
  });

  it('"salon in Maryland" → location: "Maryland" (resolved as neighbourhood)', () => {
    const result = parseDirectoryQuery('salon in Maryland');
    expect(result.categories).toContain('salon');
    expect(result.locationText).toBe('Maryland');
    expect(result.resolvedLocation).not.toBeNull();
    // Maryland is a Lagos neighbourhood in COUNTRIES data
    expect(result.resolvedLocation!.tier).toBe(2);
    expect(result.resolvedLocation!.city).toBe('Lagos');
    expect(result.resolvedLocation!.addressHint).toBe('Maryland');
    expect(result.needsLocation).toBe(false);
  });

  it('"business in DC" → generic noun, no category, location DC', () => {
    const result = parseDirectoryQuery('business in DC');
    // "business" is a generic noun — no category filter, no nameQuery
    expect(result.categories).toEqual([]);
    expect(result.nameQuery).toBeNull();
    expect(result.locationText).toBe('DC');
    expect(result.needsLocation).toBe(false);
  });

  // ── Word boundary: "Kitchen Inn" must NOT split on "in" inside "Inn" ──

  it('"Kitchen Inn" → nameQuery: "Kitchen Inn" (not split on "in")', () => {
    const result = parseDirectoryQuery('Kitchen Inn');
    // The "in" inside "Inn" is not standalone — no split
    expect(result.nameQuery).toBe('Kitchen Inn');
    expect(result.locationText).toBeNull();
    expect(result.categories).toEqual([]);
  });

  // ── Pidgin "for" preposition ──

  it('"spa for Lekki" → categories: ["spa"], location: "Lekki"', () => {
    const result = parseDirectoryQuery('spa for Lekki');
    expect(result.categories).toContain('spa');
    expect(result.locationText).toBe('Lekki');
    // "Lekki" matches "Lekki Phase 1" neighbourhood
    expect(result.resolvedLocation).not.toBeNull();
    expect(result.needsLocation).toBe(false);
  });

  // ── "near me" ──

  it('"barber near me" → categories: ["barber"], needsLocation: true', () => {
    const result = parseDirectoryQuery('barber near me');
    expect(result.categories).toContain('barber');
    expect(result.needsLocation).toBe(true);
    expect(result.locationText).toBeNull();
    expect(result.resolvedLocation).toBeNull();
  });

  // ── Bare location ──

  it('bare "Lagos" → location only, no category', () => {
    const result = parseDirectoryQuery('Lagos');
    expect(result.categories).toEqual([]);
    expect(result.locationText).toBe('Lagos');
    expect(result.resolvedLocation).not.toBeNull();
    expect(result.resolvedLocation!.tier).toBe(1);
    expect(result.resolvedLocation!.city).toBe('Lagos');
    expect(result.needsLocation).toBe(false);
    expect(result.nameQuery).toBeNull();
  });

  // ── Bare category ──

  it('bare "restaurants" → categories: ["restaurant"], needsLocation: true', () => {
    const result = parseDirectoryQuery('restaurants');
    expect(result.categories).toContain('restaurant');
    expect(result.needsLocation).toBe(true);
    expect(result.locationText).toBeNull();
    expect(result.nameQuery).toBeNull();
  });

  // ── Category spelling correction ──

  it('"resturant in lagos" → categories: ["restaurant"], correctedFrom: "resturant"', () => {
    const result = parseDirectoryQuery('resturant in lagos');
    expect(result.categories).toContain('restaurant');
    expect(result.correctedFrom).toBe('resturant');
    expect(result.nameQuery).toBeNull();
    expect(result.locationText).toBe('lagos');
  });

  it('"barbr near me" → categories: ["barber"], correctedFrom: "barbr"', () => {
    const result = parseDirectoryQuery('barbr near me');
    expect(result.categories).toContain('barber');
    expect(result.correctedFrom).toBe('barbr');
    expect(result.needsLocation).toBe(true);
  });

  it('bare "resturant" → categories: ["restaurant"], correctedFrom', () => {
    const result = parseDirectoryQuery('resturant');
    expect(result.categories).toContain('restaurant');
    expect(result.correctedFrom).toBe('resturant');
  });

  // ── Generic nouns ──

  it('"business in DC" → no category, no nameQuery, location DC', () => {
    const result = parseDirectoryQuery('business in DC');
    expect(result.categories).toEqual([]);
    expect(result.nameQuery).toBeNull();
    expect(result.locationText).toBe('DC');
  });

  it('"businesses in Lagos" → no category, location Lagos', () => {
    const result = parseDirectoryQuery('businesses in Lagos');
    expect(result.categories).toEqual([]);
    expect(result.nameQuery).toBeNull();
    expect(result.locationText).toBe('Lagos');
  });

  it('"places" (bare) → no category, needsLocation', () => {
    const result = parseDirectoryQuery('places');
    expect(result.categories).toEqual([]);
    expect(result.nameQuery).toBeNull();
    expect(result.needsLocation).toBe(true);
  });

  it('"services in Lekki" → no category, location Lekki', () => {
    const result = parseDirectoryQuery('services in Lekki');
    expect(result.categories).toEqual([]);
    expect(result.nameQuery).toBeNull();
    expect(result.locationText).toBe('Lekki');
  });

  // ── Edge cases ──

  it('empty string → needsLocation: true, everything null', () => {
    const result = parseDirectoryQuery('');
    expect(result.categories).toEqual([]);
    expect(result.locationText).toBeNull();
    expect(result.resolvedLocation).toBeNull();
    expect(result.needsLocation).toBe(true);
    expect(result.nameQuery).toBeNull();
  });

  it('whitespace-only → same as empty', () => {
    const result = parseDirectoryQuery('   ');
    expect(result.categories).toEqual([]);
    expect(result.needsLocation).toBe(true);
  });

  it('Pidgin "wey dey" → splits correctly', () => {
    const result = parseDirectoryQuery('barber wey dey Ikeja');
    expect(result.categories).toContain('barber');
    // "Ikeja" is not a standalone city in COUNTRIES, so tier 3
    expect(result.locationText).toBe('Ikeja');
    expect(result.needsLocation).toBe(false);
  });

  it('passes through phoneCountryCode without error', () => {
    const result = parseDirectoryQuery('spa in Lagos', 'NG');
    expect(result.categories).toContain('spa');
    expect(result.locationText).toBe('Lagos');
  });
});
