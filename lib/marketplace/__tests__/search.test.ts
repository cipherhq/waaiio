import { describe, it, expect } from 'vitest';
import { formatMarketplaceResults } from '../search';
import type { MarketplaceResult } from '../search';

function makeResult(overrides: Partial<MarketplaceResult> = {}): MarketplaceResult {
  return {
    businessId: 'biz-1',
    name: 'Test Salon',
    category: 'salon',
    shortDescription: 'A great salon',
    matchReasons: [],
    actions: ['view_business', 'book', 'chat'],
    ...overrides,
  };
}

describe('formatMarketplaceResults', () => {
  it('formats results with business names and bot codes', () => {
    const results = [
      makeResult({ name: 'Ace Barbers', botCode: 'ACE001' }),
      makeResult({ name: 'Cool Cuts', botCode: 'COOL02', businessId: 'biz-2' }),
    ];

    const output = formatMarketplaceResults(results, 'barbers');

    expect(output).toContain('*Ace Barbers*');
    expect(output).toContain('*Cool Cuts*');
    expect(output).toContain('ACE001');
    expect(output).toContain('COOL02');
    expect(output).toContain('I found 2');
  });

  it('shows "I couldn\'t find" for empty results', () => {
    const output = formatMarketplaceResults([], 'barbers near me');

    expect(output).toContain("I couldn't find");
    expect(output).toContain('barbers near me');
  });

  it('includes distance when available', () => {
    const results = [makeResult({ distanceKm: 2.5 })];

    const output = formatMarketplaceResults(results, 'salon');

    expect(output).toContain('2.5 km away');
  });

  it('includes "Open now" when applicable', () => {
    const results = [makeResult({ isOpenNow: true })];

    const output = formatMarketplaceResults(results, 'salon');

    expect(output).toContain('Open now');
  });

  it('includes "Delivery available"', () => {
    const results = [makeResult({ supportsDelivery: true })];

    const output = formatMarketplaceResults(results, 'restaurant');

    expect(output).toContain('Delivery available');
  });

  it('does not include "Open now" when not open', () => {
    const results = [makeResult({ isOpenNow: false })];

    const output = formatMarketplaceResults(results, 'salon');

    expect(output).not.toContain('Open now');
  });

  it('includes short description', () => {
    const results = [makeResult({ shortDescription: 'Best cuts in town' })];

    const output = formatMarketplaceResults(results, 'salon');

    expect(output).toContain('Best cuts in town');
  });

  it('handles single result correctly (no plural)', () => {
    const results = [makeResult()];

    const output = formatMarketplaceResults(results, 'salon');

    expect(output).toContain('I found 1 Waaiio business for you');
    expect(output).not.toContain('businesses');
  });
});
