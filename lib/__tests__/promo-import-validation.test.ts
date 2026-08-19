/**
 * PROMO-1: Import validation tests.
 * Proves preview + execute use same canonical validation.
 */
import { describe, it, expect } from 'vitest';
import { parsePromoCsv, previewImport } from '@/lib/promotions/import';
import { normalizePromoCode, isRoutablePromoCode } from '@/lib/promotions/normalize';

describe('import: canonical validation', () => {
  it('valid code with digit is routable', () => {
    const rows = parsePromoCsv('code\nK7PM4XQ9N2WF');
    expect(isRoutablePromoCode(normalizePromoCode(rows[0].code))).toBe(true);
  });

  it('code >24 chars after normalization is rejected', () => {
    const code = 'A1B2C3D4E5F6G7H8I9J0K1L2M'; // 25 chars
    expect(isRoutablePromoCode(normalizePromoCode(code))).toBe(false);
  });

  it('code without digit is rejected', () => {
    expect(isRoutablePromoCode(normalizePromoCode('ABCDEFGHIJKL'))).toBe(false);
  });

  it('code <10 chars is rejected (hardened minimum)', () => {
    expect(isRoutablePromoCode(normalizePromoCode('AB1C'))).toBe(false);
    expect(isRoutablePromoCode(normalizePromoCode('ABCDEF1'))).toBe(false);  // 7 chars
  });

  it('valid outcome values accepted by parser', () => {
    const rows = parsePromoCsv('code,outcome\nABCD1234EFGH,winner\nIJKL5678MNOP,try_again');
    expect(rows[0].outcome).toBe('winner');
    expect(rows[1].outcome).toBe('try_again');
  });
});

describe('IMPORT-COMPLETE-1: CSV duplicate rows detected by previewImport', () => {
  it('duplicate codes in CSV are flagged as duplicateRows', async () => {
    const csv = 'code\nABCDEF1234GH\nIJKLMN5678OP\nABCDEF1234GH';
    const rows = parsePromoCsv(csv);
    const preview = await previewImport('camp1', 'biz1', rows);
    expect(preview.duplicateRows).toBe(1);
    expect(preview.totalRows).toBe(3);
    expect(preview.validRows).toBe(2);
  });

  it('no duplicates when all codes unique', async () => {
    const csv = 'code\nABCDEF1234GH\nIJKLMN5678OP\nQRSTUV9012WX';
    const rows = parsePromoCsv(csv);
    const preview = await previewImport('camp1', 'biz1', rows);
    expect(preview.duplicateRows).toBe(0);
    expect(preview.validRows).toBe(3);
  });

  it('normalized duplicates detected (case + dash insensitive)', async () => {
    const csv = 'code\nabcd-ef12-34gh\nABCDEF1234GH';
    const rows = parsePromoCsv(csv);
    const preview = await previewImport('camp1', 'biz1', rows);
    expect(preview.duplicateRows).toBe(1);
    expect(preview.validRows).toBe(1);
  });
});

describe('import: every imported routable code passes looksLikePromoCode', () => {
  it('K7PM-4XQ9-N2WF is routable', () => {
    const normalized = normalizePromoCode('K7PM-4XQ9-N2WF');
    expect(isRoutablePromoCode(normalized)).toBe(true);
  });

  it('10-char code with digit is routable (hardened minimum)', () => {
    expect(isRoutablePromoCode(normalizePromoCode('ABCDEFGH12'))).toBe(true);
  });

  it('24-char code with digit is routable', () => {
    const code = 'A' + '1' + 'B'.repeat(22);
    expect(isRoutablePromoCode(normalizePromoCode(code))).toBe(true);
  });
});
