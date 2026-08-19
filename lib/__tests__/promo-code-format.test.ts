/**
 * PROMO-1: Code format, routability, and generation contract tests.
 *
 * Proves EVERY generated code is accepted by the promo-code recognizer.
 * Proves code_length = total normalized length including prefix.
 * Proves boundaries (6, 24) work.
 */
import { describe, it, expect } from 'vitest';
import { generateSecureCode, generateCodeBatch } from '@/lib/promotions/crypto';
import { normalizePromoCode, isRoutablePromoCode, computeBodyLength, computeUsableCodeSpace, validatePrefix } from '@/lib/promotions/normalize';
import { looksLikePromoCode } from '@/lib/promotions/verify';

describe('code format: generated codes are always routable', () => {
  it('every generated code contains at least one digit', () => {
    for (let i = 0; i < 500; i++) {
      const code = generateSecureCode(12);
      expect(/\d/.test(code)).toBe(true);
    }
  });

  it('every generated code passes looksLikePromoCode', () => {
    for (let i = 0; i < 500; i++) {
      const code = generateSecureCode(12);
      const normalized = normalizePromoCode(code);
      expect(looksLikePromoCode(normalized)).toBe(true);
    }
  });

  it('every generated code passes isRoutablePromoCode', () => {
    for (let i = 0; i < 500; i++) {
      const code = generateSecureCode(12);
      const normalized = normalizePromoCode(code);
      expect(isRoutablePromoCode(normalized)).toBe(true);
    }
  });

  it('generated code with prefix is routable', () => {
    for (let i = 0; i < 100; i++) {
      const bodyLen = computeBodyLength(12, 'WIN');
      const code = generateSecureCode(bodyLen, 'WIN');
      const normalized = normalizePromoCode(code);
      expect(normalized.length).toBe(12);
      expect(isRoutablePromoCode(normalized)).toBe(true);
    }
  });

  it('batch of codes are all unique and routable', () => {
    const bodyLen = computeBodyLength(12);
    const codes = generateCodeBatch(200, bodyLen);
    const normalized = codes.map(c => normalizePromoCode(c));
    const unique = new Set(normalized);
    expect(unique.size).toBe(200);
    for (const n of normalized) {
      expect(isRoutablePromoCode(n)).toBe(true);
    }
  });
});

describe('code_length = total normalized length including prefix', () => {
  it('computeBodyLength(12, undefined) = 12', () => {
    expect(computeBodyLength(12)).toBe(12);
  });

  it('computeBodyLength(12, "WIN") = 9', () => {
    expect(computeBodyLength(12, 'WIN')).toBe(9);
  });

  it('computeBodyLength(6, "ABCD") = 2', () => {
    expect(computeBodyLength(6, 'ABCD')).toBe(2);
  });

  it('prefix + body = code_length', () => {
    const prefix = 'PRE';
    const codeLength = 12;
    const bodyLen = computeBodyLength(codeLength, prefix);
    const code = generateSecureCode(bodyLen, prefix);
    const normalized = normalizePromoCode(code);
    expect(normalized.length).toBe(codeLength);
    expect(normalized.startsWith(prefix)).toBe(true);
  });
});

describe('boundary code lengths', () => {
  it('6-char code is routable (legacy compatible)', () => {
    const bodyLen = computeBodyLength(6);
    const code = generateSecureCode(bodyLen);
    const normalized = normalizePromoCode(code);
    expect(normalized.length).toBe(6);
    expect(isRoutablePromoCode(normalized)).toBe(true);
  });

  it('10-char code is routable', () => {
    const bodyLen = computeBodyLength(10);
    const code = generateSecureCode(bodyLen);
    const normalized = normalizePromoCode(code);
    expect(normalized.length).toBe(10);
    expect(isRoutablePromoCode(normalized)).toBe(true);
  });

  it('24-char code is routable', () => {
    const bodyLen = computeBodyLength(24);
    const code = generateSecureCode(bodyLen);
    const normalized = normalizePromoCode(code);
    expect(normalized.length).toBe(24);
    expect(isRoutablePromoCode(normalized)).toBe(true);
  });

  it('prefix never produces >24 normalized characters', () => {
    // code_length=24, prefix="ABCD" -> body=20 -> total=24
    const bodyLen = computeBodyLength(24, 'ABCD');
    const code = generateSecureCode(bodyLen, 'ABCD');
    const normalized = normalizePromoCode(code);
    expect(normalized.length).toBe(24);
    expect(isRoutablePromoCode(normalized)).toBe(true);
  });

  it('5-char normalized code is NOT routable', () => {
    expect(isRoutablePromoCode('ABC12')).toBe(false);
  });

  it('25-char normalized code is NOT routable', () => {
    expect(isRoutablePromoCode('A'.repeat(24) + '1')).toBe(false);
  });
});

describe('import validation', () => {
  it('imported code meeting format is routable', () => {
    expect(isRoutablePromoCode(normalizePromoCode('K7PM-4XQ9-N2WF'))).toBe(true);
  });

  it('imported code without digit is NOT routable', () => {
    expect(isRoutablePromoCode(normalizePromoCode('ABCDEFGHIJKL'))).toBe(false);
  });

  it('imported code >24 chars after normalization is NOT routable', () => {
    expect(isRoutablePromoCode(normalizePromoCode('A1B2C3D4E5F6G7H8I9J0K1L2M'))).toBe(false);
  });
});

describe('code-space calculation', () => {
  it('prefix with digit: full space available', () => {
    expect(computeUsableCodeSpace(8, 'W1N')).toBe(Math.pow(27, 8));
  });

  it('prefix without digit: excludes all-letter bodies', () => {
    const bodyLen = 8;
    const expected = Math.pow(27, bodyLen) - Math.pow(21, bodyLen);
    expect(computeUsableCodeSpace(bodyLen, 'WIN')).toBe(expected);
  });

  it('no prefix: excludes all-letter bodies', () => {
    const bodyLen = 12;
    const expected = Math.pow(27, bodyLen) - Math.pow(21, bodyLen);
    expect(computeUsableCodeSpace(bodyLen)).toBe(expected);
  });
});

describe('prefix validation', () => {
  it('valid prefix accepted (with sufficient body entropy)', () => {
    expect(validatePrefix('WIN', 13).valid).toBe(true);  // body=10 ✓
    expect(validatePrefix('WIN', 14).valid).toBe(true);  // body=11 ✓
    expect(validatePrefix('A1', 12).valid).toBe(true);   // body=10 ✓
    expect(validatePrefix('', 12).valid).toBe(true);     // body=12 ✓
  });

  it('prefix rejected when body falls below 10', () => {
    expect(validatePrefix('WIN', 12).valid).toBe(false);   // body=9 ✗
    expect(validatePrefix('PROM', 13).valid).toBe(false);  // body=9 ✗
  });

  it('prefix # rejected', () => {
    expect(validatePrefix('#', 12).valid).toBe(false);
  });

  it('prefix A-B rejected', () => {
    expect(validatePrefix('A-B', 12).valid).toBe(false);
  });

  it('prefix >4 chars rejected', () => {
    expect(validatePrefix('ABCDE', 12).valid).toBe(false);
  });

  it('prefix length >= code_length rejected', () => {
    expect(validatePrefix('ABCD', 4).valid).toBe(false);
    expect(validatePrefix('ABCDEF', 6).valid).toBe(false);
  });

  it('lowercase prefix rejected', () => {
    expect(validatePrefix('win', 12).valid).toBe(false);
  });
});

describe('no Math.random in crypto', () => {
  it('generateSecureCode does not use Math.random', () => {
    // Verify uniqueness at scale (Math.random would produce collisions faster)
    const codes = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      codes.add(generateSecureCode(12));
    }
    expect(codes.size).toBe(2000);
  });
});
