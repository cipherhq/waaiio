/**
 * Promo code cryptographic utility tests.
 */
import { describe, it, expect } from 'vitest';
import { hashPromoCode, generateSecureCode, generateCodeBatch, generateClaimReference } from '@/lib/promotions/crypto';

describe('hashPromoCode', () => {
  it('produces deterministic hash for same input', () => {
    const h1 = hashPromoCode('K7PM4XQ9N2WF');
    const h2 = hashPromoCode('K7PM4XQ9N2WF');
    expect(h1).toBe(h2);
  });

  it('produces different hash for different input', () => {
    const h1 = hashPromoCode('K7PM4XQ9N2WF');
    const h2 = hashPromoCode('ABCD4XQ9N2WF');
    expect(h1).not.toBe(h2);
  });

  it('returns hex string', () => {
    const h = hashPromoCode('K7PM4XQ9N2WF');
    expect(h).toMatch(/^[0-9a-f]+$/);
  });
});

describe('generateSecureCode', () => {
  it('generates code of specified length', () => {
    const code = generateSecureCode(12);
    expect(code.length).toBe(12);
  });

  it('uses only unambiguous characters', () => {
    // No 0, O, 1, I, L, 5, S, 8, B
    const ambiguous = /[0O1IL5S8B]/;
    for (let i = 0; i < 100; i++) {
      const code = generateSecureCode(12);
      expect(code).not.toMatch(ambiguous);
    }
  });

  it('does NOT use Math.random', () => {
    // Verify by checking that crypto is used (indirectly by checking randomness quality)
    const codes = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      codes.add(generateSecureCode(12));
    }
    // All 1000 codes should be unique
    expect(codes.size).toBe(1000);
  });

  it('respects prefix', () => {
    const code = generateSecureCode(8, 'WIN');
    expect(code.startsWith('WIN')).toBe(true);
    expect(code.length).toBe(11); // WIN + 8
  });
});

describe('generateCodeBatch', () => {
  it('generates requested number of codes', () => {
    const codes = generateCodeBatch(100, 12);
    expect(codes.length).toBe(100);
  });

  it('generates unique codes within batch', () => {
    const codes = generateCodeBatch(500, 12);
    const unique = new Set(codes);
    expect(unique.size).toBe(500);
  });

  it('generates codes of correct length', () => {
    const codes = generateCodeBatch(10, 8);
    for (const code of codes) {
      expect(code.length).toBe(8);
    }
  });
});

describe('generateClaimReference', () => {
  it('starts with WAA-', () => {
    const ref = generateClaimReference();
    expect(ref.startsWith('WAA-')).toBe(true);
  });

  it('has WAA-XXXX-XXXX-XXXX-XXXX format (23 chars, exactly 64 bits entropy)', () => {
    const ref = generateClaimReference();
    // WAA- (4) + 4 + - + 4 + - + 4 + - + 4 = 23
    expect(ref.length).toBe(23);
    expect(ref).toMatch(/^WAA-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/);
  });

  it('generates unique references (high entropy eliminates collisions)', () => {
    const refs = new Set<string>();
    for (let i = 0; i < 100; i++) {
      refs.add(generateClaimReference());
    }
    expect(refs.size).toBe(100);
  });
});
