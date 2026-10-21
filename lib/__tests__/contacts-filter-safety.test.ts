/**
 * contacts-filter-safety.test.ts
 *
 * Regression tests for Growth Contacts search filter safety.
 *
 * The contacts page search interpolates user input into a PostgREST `.or()` filter
 * with ILIKE conditions. Two distinct protections are required:
 *
 *   1. ILIKE wildcard escaping: `%` and `_` must be backslash-escaped so they are
 *      treated as literal characters, not SQL wildcards.
 *   2. PostgREST filter-syntax sanitization: `,`, `(`, `)` must be stripped to
 *      prevent injection of additional filter conditions into the `.or()` string.
 *
 * Both protections must be composed in order: ILIKE escaping first, then
 * PostgREST sanitization via `sanitizeFilterValue()`.
 */

import { describe, it, expect } from 'vitest';
import { sanitizeFilterValue } from '@/lib/utils/sanitize';

/**
 * Replicates the exact sanitization pipeline used in
 * `app/dashboard/growth/contacts/page.tsx` lines 79.
 *
 * Step 1: Escape ILIKE wildcards (% → \%, _ → \_)
 * Step 2: Strip PostgREST filter delimiters via sanitizeFilterValue
 */
function contactsSearchSanitize(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  return sanitizeFilterValue(trimmed.replace(/[%_]/g, '\\$&'));
}

/**
 * Builds the `.or()` filter string exactly as the contacts page does.
 */
function buildOrFilter(raw: string): string {
  const s = contactsSearchSanitize(raw);
  return `first_name.ilike.%${s}%,last_name.ilike.%${s}%,phone.ilike.%${s}%`;
}

describe('Contacts filter safety', () => {
  describe('Normal input passthrough', () => {
    it('passes plain names through unchanged', () => {
      expect(contactsSearchSanitize('John')).toBe('John');
      expect(contactsSearchSanitize('Jane Doe')).toBe('Jane Doe');
    });

    it('passes phone numbers through unchanged', () => {
      expect(contactsSearchSanitize('+2348012345678')).toBe('+2348012345678');
      expect(contactsSearchSanitize('080 1234 5678')).toBe('080 1234 5678');
    });

    it('trims whitespace', () => {
      expect(contactsSearchSanitize('  John  ')).toBe('John');
    });

    it('builds correct .or() filter for normal input', () => {
      const filter = buildOrFilter('John');
      expect(filter).toBe(
        'first_name.ilike.%John%,last_name.ilike.%John%,phone.ilike.%John%'
      );
    });
  });

  describe('PostgREST injection prevention — commas', () => {
    it('strips commas from input', () => {
      // An attacker typing ",phone.eq.+1234567890" would inject a filter condition
      const result = contactsSearchSanitize(',phone.eq.+1234567890');
      expect(result).not.toContain(',');
    });

    it('strips commas in the middle of input', () => {
      const result = contactsSearchSanitize('first,last');
      expect(result).toBe('firstlast');
    });

    it('strips all commas from complex injection attempts', () => {
      const result = contactsSearchSanitize('a%,phone.eq.secret,b');
      expect(result).not.toContain(',');
    });
  });

  describe('PostgREST injection prevention — parentheses', () => {
    it('strips opening parentheses', () => {
      const result = contactsSearchSanitize('test(injection');
      expect(result).not.toContain('(');
    });

    it('strips closing parentheses', () => {
      const result = contactsSearchSanitize('test)injection');
      expect(result).not.toContain(')');
    });

    it('strips nested parentheses from complex injection', () => {
      // PostgREST .or() supports nested conditions with parentheses
      const result = contactsSearchSanitize('x),(email.eq.admin@evil.com');
      expect(result).not.toContain('(');
      expect(result).not.toContain(')');
      expect(result).not.toContain(',');
    });
  });

  describe('ILIKE wildcard escaping — percent', () => {
    it('escapes % to \\% for literal search', () => {
      const result = contactsSearchSanitize('100%');
      expect(result).toBe('100\\%');
    });

    it('escapes multiple % characters', () => {
      const result = contactsSearchSanitize('%admin%');
      expect(result).toBe('\\%admin\\%');
    });

    it('percent in .or() filter is properly escaped', () => {
      const filter = buildOrFilter('100%');
      // The literal search value should contain \% not bare %
      // The surrounding wildcards are the only bare % signs
      expect(filter).toBe(
        'first_name.ilike.%100\\%%,last_name.ilike.%100\\%%,phone.ilike.%100\\%%'
      );
    });
  });

  describe('ILIKE wildcard escaping — underscore', () => {
    it('escapes _ to \\_ for literal search', () => {
      const result = contactsSearchSanitize('user_name');
      expect(result).toBe('user\\_name');
    });

    it('escapes multiple underscores', () => {
      const result = contactsSearchSanitize('__admin__');
      expect(result).toBe('\\_\\_admin\\_\\_');
    });
  });

  describe('Combined ILIKE + PostgREST protection', () => {
    it('escapes % AND strips commas in a single input', () => {
      // This is the critical composition test:
      // Input: "100%,phone.eq.+1234"
      // Step 1 (ILIKE): "100\%,phone.eq.+1234"
      // Step 2 (sanitize): "100\%phone.eq.+1234" (comma stripped)
      const result = contactsSearchSanitize('100%,phone.eq.+1234');
      expect(result).toContain('\\%'); // % escaped
      expect(result).not.toContain(','); // comma stripped
    });

    it('escapes _ AND strips parentheses in a single input', () => {
      const result = contactsSearchSanitize('user_name)(evil');
      expect(result).toContain('\\_'); // _ escaped
      expect(result).not.toContain('(');
      expect(result).not.toContain(')');
    });

    it('handles full injection payload with all dangerous chars', () => {
      const attack = '%_,(phone.eq.+1234567890)';
      const result = contactsSearchSanitize(attack);
      expect(result).toContain('\\%'); // % escaped
      expect(result).toContain('\\_'); // _ escaped
      expect(result).not.toContain(','); // comma stripped
      expect(result).not.toContain('('); // parens stripped
      expect(result).not.toContain(')');
    });
  });

  describe('Backslash handling', () => {
    it('preserves backslashes in input (they are not special to PostgREST filters)', () => {
      const result = contactsSearchSanitize('test\\value');
      expect(result).toBe('test\\value');
    });

    it('does not double-escape the backslash added by ILIKE escaping', () => {
      // When we escape % to \%, the backslash should remain a single backslash
      const result = contactsSearchSanitize('50%');
      expect(result).toBe('50\\%');
      // Should NOT be '50\\\\%'
    });
  });

  describe('Dots and quotes', () => {
    it('preserves dots (safe in ILIKE values)', () => {
      const result = contactsSearchSanitize('john.doe');
      expect(result).toBe('john.doe');
    });

    it('preserves single quotes', () => {
      const result = contactsSearchSanitize("O'Brien");
      expect(result).toBe("O'Brien");
    });

    it('preserves double quotes', () => {
      const result = contactsSearchSanitize('John "Johnny"');
      expect(result).toBe('John "Johnny"');
    });
  });

  describe('Empty and whitespace input', () => {
    it('returns empty string for empty input', () => {
      expect(contactsSearchSanitize('')).toBe('');
    });

    it('returns empty string for whitespace-only input', () => {
      expect(contactsSearchSanitize('   ')).toBe('');
    });

    it('returns empty string for tab/newline input', () => {
      expect(contactsSearchSanitize('\t\n')).toBe('');
    });
  });

  describe('sanitizeFilterValue standalone behavior', () => {
    it('strips commas', () => {
      expect(sanitizeFilterValue('a,b,c')).toBe('abc');
    });

    it('strips parentheses', () => {
      expect(sanitizeFilterValue('a(b)c')).toBe('abc');
    });

    it('strips all filter delimiters at once', () => {
      expect(sanitizeFilterValue('a,(b),c')).toBe('abc');
    });

    it('preserves safe characters', () => {
      expect(sanitizeFilterValue('John Doe +123')).toBe('John Doe +123');
    });
  });
});
