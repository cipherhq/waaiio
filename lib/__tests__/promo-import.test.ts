/**
 * PROMO-1: CSV import tests.
 */
import { describe, it, expect } from 'vitest';
import { parsePromoCsv, generateCsvTemplate } from '@/lib/promotions/import';

describe('parsePromoCsv', () => {
  it('parses basic CSV with header', () => {
    const csv = 'code,outcome,prize\nABCD1234EFGH,winner,Grand Prize\nIJKL5678MNOP,try_again,';
    const rows = parsePromoCsv(csv);
    expect(rows).toHaveLength(2);
    expect(rows[0].code).toBe('ABCD1234EFGH');
    expect(rows[0].outcome).toBe('winner');
    expect(rows[0].prize).toBe('Grand Prize');
    expect(rows[1].code).toBe('IJKL5678MNOP');
    expect(rows[1].outcome).toBe('try_again');
  });

  it('parses CSV without header', () => {
    const csv = 'ABCD1234EFGH\nIJKL5678MNOP';
    const rows = parsePromoCsv(csv);
    expect(rows).toHaveLength(2);
    expect(rows[0].code).toBe('ABCD1234EFGH');
  });

  it('handles code-only CSV', () => {
    const csv = 'code\nAABBCCDDEEFF\nGGHHIIJJKKLL';
    const rows = parsePromoCsv(csv);
    expect(rows).toHaveLength(2);
    expect(rows[0].outcome).toBeUndefined();
  });

  it('handles Windows line endings', () => {
    const csv = 'code\r\nABCDEFGH1234\r\nIJKLMNOP5678\r\n';
    const rows = parsePromoCsv(csv);
    expect(rows).toHaveLength(2);
  });

  it('handles quoted fields', () => {
    const csv = 'code,outcome,prize\n"ABCD-1234-EFGH","winner","Grand Prize"';
    const rows = parsePromoCsv(csv);
    expect(rows[0].code).toBe('ABCD-1234-EFGH');
    expect(rows[0].prize).toBe('Grand Prize');
  });

  it('skips empty lines', () => {
    const csv = 'code\nABCDEFGH1234\n\nIJKLMNOP5678\n\n';
    const rows = parsePromoCsv(csv);
    expect(rows).toHaveLength(2);
  });

  it('returns empty for empty input', () => {
    expect(parsePromoCsv('')).toHaveLength(0);
    expect(parsePromoCsv('   ')).toHaveLength(0);
  });
});

describe('generateCsvTemplate', () => {
  it('returns valid CSV template', () => {
    const template = generateCsvTemplate();
    expect(template).toContain('code,outcome,prize');
    expect(template).toContain('winner');
    expect(template).toContain('try_again');
  });

  it('template is parseable', () => {
    const template = generateCsvTemplate();
    const rows = parsePromoCsv(template);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].code).toBeTruthy();
  });
});
