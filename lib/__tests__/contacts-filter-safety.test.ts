/**
 * contacts-filter-safety.test.ts
 *
 * Tests the PRODUCTION sanitizeIlikeSearch function from lib/utils/sanitize.ts,
 * which is used by app/dashboard/growth/contacts/page.tsx to build PostgREST
 * .or() ILIKE filters from user search input.
 *
 * Verifies both ILIKE wildcard escaping and PostgREST filter-syntax safety.
 */

import { describe, it, expect } from 'vitest';
import { sanitizeIlikeSearch, sanitizeFilterValue } from '@/lib/utils/sanitize';

/**
 * Builds the exact .or() filter string that the contacts page produces.
 * This mirrors the production code at page.tsx line 80:
 *   query.or(`first_name.ilike.%${s}%,last_name.ilike.%${s}%,phone.ilike.%${s}%`)
 */
function buildContactsOrFilter(search: string): string {
  const s = sanitizeIlikeSearch(search);
  if (!s) return '';
  return `first_name.ilike.%${s}%,last_name.ilike.%${s}%,phone.ilike.%${s}%`;
}

// ── sanitizeIlikeSearch (production function) ──

describe('sanitizeIlikeSearch — production function', () => {
  it('passes normal names through unchanged', () => {
    expect(sanitizeIlikeSearch('John')).toBe('John');
    expect(sanitizeIlikeSearch('Ade Ogunlesi')).toBe('Ade Ogunlesi');
  });

  it('passes phone numbers through unchanged', () => {
    expect(sanitizeIlikeSearch('+234 801 234 5678')).toBe('+234 801 234 5678');
  });

  it('escapes % as literal ILIKE wildcard', () => {
    expect(sanitizeIlikeSearch('100%')).toBe('100\\%');
  });

  it('escapes _ as literal ILIKE wildcard', () => {
    expect(sanitizeIlikeSearch('john_doe')).toBe('john\\_doe');
  });

  it('strips commas (PostgREST filter delimiter)', () => {
    expect(sanitizeIlikeSearch('Smith, Jr')).toBe('Smith Jr');
  });

  it('strips parentheses (PostgREST filter delimiter)', () => {
    expect(sanitizeIlikeSearch('John (CEO)')).toBe('John CEO');
  });

  it('composes ILIKE escaping and PostgREST stripping', () => {
    // % is escaped first, then , is stripped
    expect(sanitizeIlikeSearch('100%, (test)')).toBe('100\\% test');
  });

  it('handles PostgREST injection attempt', () => {
    // Attacker tries to inject: ,phone.eq.+1234567890
    const attack = ',phone.eq.+1234567890';
    const result = sanitizeIlikeSearch(attack);
    expect(result).not.toContain(',');
    expect(result).toBe('phone.eq.+1234567890');
  });

  it('handles parenthesis injection attempt', () => {
    const attack = '),email.eq.admin@evil.com,(';
    const result = sanitizeIlikeSearch(attack);
    expect(result).not.toContain('(');
    expect(result).not.toContain(')');
    expect(result).not.toContain(',');
  });

  it('returns empty string for whitespace-only input', () => {
    expect(sanitizeIlikeSearch('   ')).toBe('');
    expect(sanitizeIlikeSearch('')).toBe('');
  });

  it('trims leading and trailing whitespace', () => {
    expect(sanitizeIlikeSearch('  John  ')).toBe('John');
  });

  it('preserves dots (used in email addresses)', () => {
    expect(sanitizeIlikeSearch('john.doe@example.com')).toBe('john.doe@example.com');
  });

  it('preserves quotes', () => {
    expect(sanitizeIlikeSearch("O'Brien")).toBe("O'Brien");
    expect(sanitizeIlikeSearch('"test"')).toBe('"test"');
  });

  it('handles backslashes without double-escaping', () => {
    expect(sanitizeIlikeSearch('test\\value')).toBe('test\\value');
  });

  it('handles combined wildcards and delimiters', () => {
    expect(sanitizeIlikeSearch('50% off, (limited)')).toBe('50\\% off limited');
  });
});

// ── buildContactsOrFilter (production .or() string) ──

describe('contacts page .or() filter construction', () => {
  it('builds correct filter for normal name', () => {
    const filter = buildContactsOrFilter('John');
    expect(filter).toBe('first_name.ilike.%John%,last_name.ilike.%John%,phone.ilike.%John%');
  });

  it('builds correct filter with escaped wildcards', () => {
    const filter = buildContactsOrFilter('100%');
    expect(filter).toBe('first_name.ilike.%100\\%%,last_name.ilike.%100\\%%,phone.ilike.%100\\%%');
  });

  it('returns empty string for empty search', () => {
    expect(buildContactsOrFilter('')).toBe('');
    expect(buildContactsOrFilter('   ')).toBe('');
  });

  it('filter contains exactly 3 conditions separated by commas', () => {
    const filter = buildContactsOrFilter('test');
    const conditions = filter.split(',');
    expect(conditions).toHaveLength(3);
    expect(conditions[0]).toMatch(/^first_name\.ilike\./);
    expect(conditions[1]).toMatch(/^last_name\.ilike\./);
    expect(conditions[2]).toMatch(/^phone\.ilike\./);
  });

  it('injection attempt cannot add a 4th condition', () => {
    // If commas pass through, this would create 4+ conditions
    const filter = buildContactsOrFilter(',phone.eq.+123,');
    const conditions = filter.split(',');
    expect(conditions).toHaveLength(3);
  });

  it('parenthesis injection cannot break filter syntax', () => {
    const filter = buildContactsOrFilter('),id.eq.1,(');
    expect(filter).not.toContain('),(');
    const conditions = filter.split(',');
    expect(conditions).toHaveLength(3);
  });
});

// ── sanitizeFilterValue (standalone) ──

describe('sanitizeFilterValue — standalone', () => {
  it('strips commas', () => {
    expect(sanitizeFilterValue('a,b,c')).toBe('abc');
  });

  it('strips parentheses', () => {
    expect(sanitizeFilterValue('a(b)c')).toBe('abc');
  });

  it('preserves % and _', () => {
    expect(sanitizeFilterValue('100%_test')).toBe('100%_test');
  });

  it('preserves normal text', () => {
    expect(sanitizeFilterValue('hello world')).toBe('hello world');
  });
});
