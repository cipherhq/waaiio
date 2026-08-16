/**
 * Promo code normalization tests.
 */
import { describe, it, expect } from 'vitest';
import { normalizePromoCode, formatPromoCode, maskPromoCode, getDisplaySuffix } from '@/lib/promotions/normalize';

describe('normalizePromoCode', () => {
  it('uppercases input', () => {
    expect(normalizePromoCode('k7pm4xq9n2wf')).toBe('K7PM4XQ9N2WF');
  });

  it('removes hyphens', () => {
    expect(normalizePromoCode('K7PM-4XQ9-N2WF')).toBe('K7PM4XQ9N2WF');
  });

  it('removes spaces', () => {
    expect(normalizePromoCode('K7PM 4XQ9 N2WF')).toBe('K7PM4XQ9N2WF');
  });

  it('trims whitespace', () => {
    expect(normalizePromoCode('  K7PM4XQ9N2WF  ')).toBe('K7PM4XQ9N2WF');
  });

  it('removes dots and underscores', () => {
    expect(normalizePromoCode('K7PM.4XQ9_N2WF')).toBe('K7PM4XQ9N2WF');
  });

  it('hyphen + space + lowercase resolves to same normalized code', () => {
    const a = normalizePromoCode('K7PM-4XQ9-N2WF');
    const b = normalizePromoCode('k7pm 4xq9 n2wf');
    const c = normalizePromoCode('k7pm4xq9n2wf');
    expect(a).toBe(b);
    expect(b).toBe(c);
  });
});

describe('formatPromoCode', () => {
  it('groups into 4-char groups with hyphens', () => {
    expect(formatPromoCode('K7PM4XQ9N2WF')).toBe('K7PM-4XQ9-N2WF');
  });

  it('handles odd-length codes', () => {
    expect(formatPromoCode('ABCDEF')).toBe('ABCD-EF');
  });
});

describe('maskPromoCode', () => {
  it('masks middle of 12-char code', () => {
    expect(maskPromoCode('K7PM4XQ9N2WF')).toBe('K7PM••••N2WF');
  });

  it('masks short codes', () => {
    expect(maskPromoCode('ABCDEF')).toBe('AB••••EF');
  });
});

describe('getDisplaySuffix', () => {
  it('returns last 4 characters', () => {
    expect(getDisplaySuffix('K7PM4XQ9N2WF')).toBe('N2WF');
  });
});
