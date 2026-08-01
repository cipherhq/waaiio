/**
 * Tests for deterministic legacy-default capability resolver.
 * Proves dashboard/bot/API resolve the same set for zero-row businesses.
 */
import { describe, it, expect } from 'vitest';
import { getLegacyDefaultCapabilities } from '../legacy-defaults';
import { CATEGORY_DEFAULT_CAPABILITIES } from '../types';

describe('getLegacyDefaultCapabilities', () => {
  it('salon category returns CATEGORY_DEFAULT_CAPABILITIES.salon', () => {
    const result = getLegacyDefaultCapabilities('salon');
    expect(result).toEqual(CATEGORY_DEFAULT_CAPABILITIES['salon']);
  });

  it('restaurant category returns CATEGORY_DEFAULT_CAPABILITIES.restaurant', () => {
    const result = getLegacyDefaultCapabilities('restaurant');
    expect(result).toEqual(CATEGORY_DEFAULT_CAPABILITIES['restaurant']);
  });

  it('church category returns CATEGORY_DEFAULT_CAPABILITIES.church', () => {
    const result = getLegacyDefaultCapabilities('church');
    expect(result).toEqual(CATEGORY_DEFAULT_CAPABILITIES['church']);
  });

  it('null category returns [scheduling]', () => {
    const result = getLegacyDefaultCapabilities(null);
    expect(result).toEqual(['scheduling']);
  });

  it('undefined category returns [scheduling]', () => {
    const result = getLegacyDefaultCapabilities(undefined);
    expect(result).toEqual(['scheduling']);
  });

  it('unknown category returns [scheduling]', () => {
    const result = getLegacyDefaultCapabilities('nonexistent_category');
    expect(result).toEqual(['scheduling']);
  });

  it('same input always produces same result (deterministic)', () => {
    const a = getLegacyDefaultCapabilities('salon');
    const b = getLegacyDefaultCapabilities('salon');
    expect(a).toEqual(b);
  });

  it('matches static CATEGORY_DEFAULT_CAPABILITIES for all known categories', () => {
    for (const [category, expected] of Object.entries(CATEGORY_DEFAULT_CAPABILITIES)) {
      const result = getLegacyDefaultCapabilities(category);
      expect(result).toEqual(expected);
    }
  });
});
