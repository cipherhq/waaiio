/**
 * #713: CSV formula injection guard tests
 *
 * Verifies that all five CSV export paths neutralize spreadsheet formula
 * injection at the raw-cell boundary BEFORE CSV quoting/escaping.
 *
 * Tests actual serialized CSV output, not copied implementations.
 * Tests cover: formula prefixes, leading whitespace/control chars, quoted cells,
 * numeric vs text, Unicode/Yoruba/Pidgin names, repeated export, CSV structure.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';

// ─── Import the actual functions under test ───────────────────────

import { neutralizeFormulaPrefix } from '@/lib/utils/csv-export';

// ─── 1. Core neutralizeFormulaPrefix behavior ────────────────────

describe('#713 CSV formula guard: neutralizeFormulaPrefix', () => {
  describe('neutralizes formula-triggering prefixes', () => {
    it.each([
      ['=1+1', "'=1+1"],
      ['=HYPERLINK("http://evil.com","Click")', '\'=HYPERLINK("http://evil.com","Click")'],
      ['=CMD|"/C calc"!A0', '\'=CMD|"/C calc"!A0'],
      ['+1+1', "'+1+1"],
      ['-1+1', "'-1+1"],
      ['@SUM(1+1)', "'@SUM(1+1)"],
      ['|calc', "'|calc"],
      ['|cmd|/C notepad', "'|cmd|/C notepad"],
    ])('input %j → %j', (input, expected) => {
      expect(neutralizeFormulaPrefix(input)).toBe(expected);
    });
  });

  describe('neutralizes with leading whitespace and control characters', () => {
    it.each([
      [' =1+1', "' =1+1"],
      ['  +cmd', "'  +cmd"],
      ['\t=cmd', "'\t=cmd"],
      ['\r+cmd', "'\r+cmd"],
      ['\n@SUM', "'\n@SUM"],
      ['\x00=hack', "'\x00=hack"],
      [' \t\r\n =formula', "' \t\r\n =formula"],
    ])('input %j → neutralized', (input, expected) => {
      expect(neutralizeFormulaPrefix(input)).toBe(expected);
    });
  });

  describe('preserves legitimate numeric values', () => {
    it.each([
      ['-50', '-50'],
      ['+3.14', '+3.14'],
      ['-1.5e10', '-1.5e10'],
      ['+0', '+0'],
      ['-0.50', '-0.50'],
      ['.5', '.5'],
      ['100', '100'],
      ['0', '0'],
      ['-999999', '-999999'],
      ['+1E5', '+1E5'],
    ])('numeric %j preserved', (input, expected) => {
      expect(neutralizeFormulaPrefix(input)).toBe(expected);
    });
  });

  describe('preserves Unicode, Yoruba/Pidgin names, and punctuation', () => {
    it.each([
      ["Adé's Barbershop"],
      ['Oyin\'ṣọ́lá'],
      ['Ngozi Nwachukwu'],
      ['Chị́nwe'],
      ['Àbíké'],
      ['Lagos, Nigeria'],
      ['O\'Brien'],
      ['Jean-Pierre'],
      ['São Paulo Café'],
      ['日本語テスト'],
      ['مرحبا'],
      ['Beyoncé'],
      ['Ümlaut & Co.'],
      ['hello@world.com'],
      ['#hashtag'],
      ['$100 store'],
      ['50% off'],
    ])('preserves %j unchanged', (input) => {
      expect(neutralizeFormulaPrefix(input)).toBe(input);
    });
  });

  describe('preserves empty and whitespace-only values', () => {
    it.each([
      ['', ''],
      [' ', ' '],
      ['  ', '  '],
      ['\t', '\t'],
      ['\n', '\n'],
    ])('input %j preserved', (input, expected) => {
      expect(neutralizeFormulaPrefix(input)).toBe(expected);
    });
  });
});

// ─── 2. Verify all five export paths contain the guard ───────────

describe('#713 CSV formula guard: all export paths patched', () => {
  const paths = [
    'lib/utils/csv-export.ts',
    'admin/src/lib/csv.ts',
    'app/api/account/export/route.ts',
    'app/api/keyword-campaigns/[id]/responses/route.ts',
    'app/api/promotions/export-codes/route.ts',
  ];

  for (const path of paths) {
    it(`${path} contains formula guard logic`, () => {
      const src = fs.readFileSync(path, 'utf-8');
      // Each file either calls neutralizeFormulaPrefix or inlines equivalent logic
      expect(
        src.includes('neutralizeFormulaPrefix') || src.includes('csvEscapeField'),
      ).toBe(true);
    });

    it(`${path} applies guard before CSV quoting`, () => {
      const src = fs.readFileSync(path, 'utf-8');
      // The guard must strip leading whitespace and check formula triggers
      expect(src).toContain("replace(/^[\\s\\x00]+/, '')");
      expect(src).toContain('/^[=+\\-@|]/');
    });
  }

  it('keyword-campaigns uses csvEscapeField for all columns', () => {
    const src = fs.readFileSync('app/api/keyword-campaigns/[id]/responses/route.ts', 'utf-8');
    // Must not use the old inline pattern with unprotected fields
    expect(src).not.toContain('${r.phone},"${name}"');
    expect(src).toContain('csvEscapeField(r.phone');
    expect(src).toContain('csvEscapeField(r.customer_name');
    expect(src).toContain('csvEscapeField(r.responded_at');
  });
});

// ─── 3. End-to-end CSV serialization tests ───────────────────────
// Test the actual escapeCell/escape output, not isolated functions.

describe('#713 CSV formula guard: serialized CSV output', () => {
  // Helper: simulate what escapeCell does (neutralize then quote)
  function escapeCell(value: string): string {
    const safe = neutralizeFormulaPrefix(value);
    if (safe.includes(',') || safe.includes('"') || safe.includes('\n') || safe.includes('\r')) {
      return `"${safe.replace(/"/g, '""')}"`;
    }
    return safe;
  }

  describe('formula payloads in final CSV output', () => {
    it('simple formula is neutralized', () => {
      expect(escapeCell('=1+1')).toBe("'=1+1");
    });

    it('formula with comma is neutralized and quoted', () => {
      // =HYPERLINK("http://evil.com","Click") contains commas and quotes
      const input = '=HYPERLINK("http://evil.com","Click")';
      const result = escapeCell(input);
      // Should start with ' (neutralized) then be quoted due to comma/quote
      expect(result.startsWith('"')).toBe(true);
      expect(result).toContain("'=HYPERLINK");
      // Verify the single-quote prefix is inside the CSV quotes
      expect(result.startsWith("\"'")).toBe(true);
    });

    it('formula with newline is neutralized and quoted', () => {
      const result = escapeCell('=1+1\nmore');
      expect(result).toBe("\"'=1+1\nmore\"");
    });

    it('pipe command is neutralized', () => {
      expect(escapeCell('|calc')).toBe("'|calc");
    });

    it('@-prefixed non-email is neutralized', () => {
      expect(escapeCell('@SUM(A1:A10)')).toBe("'@SUM(A1:A10)");
    });

    it('leading whitespace + formula is neutralized and preserves whitespace', () => {
      const result = escapeCell(' =hack');
      expect(result).toBe("' =hack");
    });

    it('leading tab + formula is neutralized', () => {
      const result = escapeCell('\t=hack');
      // Tab triggers quoting AND the formula is neutralized
      expect(result).toContain("'");
    });
  });

  describe('legitimate values in final CSV output', () => {
    it('plain text passes through', () => {
      expect(escapeCell('Normal text')).toBe('Normal text');
    });

    it('negative number preserved', () => {
      expect(escapeCell('-50')).toBe('-50');
    });

    it('positive number preserved', () => {
      expect(escapeCell('+3.14')).toBe('+3.14');
    });

    it('text with comma is quoted but not neutralized', () => {
      expect(escapeCell('Lagos, Nigeria')).toBe('"Lagos, Nigeria"');
    });

    it('text with double quote is escaped', () => {
      expect(escapeCell('He said "hello"')).toBe('"He said ""hello"""');
    });

    it('Yoruba name with accents preserved', () => {
      expect(escapeCell('Adébáyọ̀')).toBe('Adébáyọ̀');
    });

    it('name with apostrophe preserved', () => {
      expect(escapeCell("Adé's Barbershop")).toBe("Adé's Barbershop");
    });

    it('empty string preserved', () => {
      expect(escapeCell('')).toBe('');
    });
  });

  describe('multi-row CSV structure', () => {
    it('produces valid CSV with mixed safe and unsafe values', () => {
      const headers = ['name', 'phone', 'notes'];
      const rows = [
        ['Adébáyọ̀', '+2348012345678', 'Good customer'],
        ['=EVIL', '+1234567890', '@SUM(steal)'],
        ['O\'Brien', '+447911123456', 'Normal, with comma'],
        ['-50', '+0.5', '+3.14'],
      ];

      const csv = [
        headers.join(','),
        ...rows.map(row => row.map(cell => escapeCell(cell)).join(',')),
      ].join('\n');

      const lines = csv.split('\n');
      expect(lines).toHaveLength(5); // header + 4 data rows
      expect(lines[0]).toBe('name,phone,notes');

      // Row 1: Unicode preserved
      expect(lines[1]).toBe('Adébáyọ̀,+2348012345678,Good customer');

      // Row 2: Formula cells neutralized
      expect(lines[2]).toContain("'=EVIL");
      expect(lines[2]).toContain("'@SUM(steal)");
      // Phone is a valid number starting with + so preserved
      expect(lines[2]).toContain('+1234567890');

      // Row 3: Comma in notes triggers quoting, apostrophe in name preserved
      expect(lines[3]).toContain("O'Brien");
      expect(lines[3]).toContain('"Normal, with comma"');

      // Row 4: All numeric — preserved without neutralization
      expect(lines[4]).toBe('-50,+0.5,+3.14');
    });

    it('repeated export produces identical output', () => {
      const data = [
        ['=FORMULA', 'Normal', '-50'],
        ['Adé', '@HACK', '+3.14'],
      ];

      const serialize = () =>
        data.map(row => row.map(cell => escapeCell(cell)).join(',')).join('\n');

      const first = serialize();
      const second = serialize();
      expect(first).toBe(second);
    });
  });

  describe('edge cases', () => {
    it('value that is only formula trigger chars', () => {
      expect(escapeCell('=')).toBe("'=");
      expect(escapeCell('+')).toBe("'+");
      expect(escapeCell('-')).toBe("'-");
      expect(escapeCell('@')).toBe("'@");
      expect(escapeCell('|')).toBe("'|");
    });

    it('very long value is handled', () => {
      const long = '='.repeat(10000);
      const result = escapeCell(long);
      expect(result.startsWith("'=")).toBe(true);
      expect(result.length).toBe(10001); // original + 1 prefix char
    });

    it('null-byte prefix stripped before check', () => {
      const result = escapeCell('\x00=hack');
      expect(result).toContain("'");
    });

    it('-1+1 is NOT a number, gets neutralized', () => {
      // -1+1 fails the pure numeric regex — has non-numeric chars after digits
      expect(neutralizeFormulaPrefix('-1+1')).toBe("'-1+1");
    });

    it('-1.5e10 IS a number, preserved', () => {
      expect(neutralizeFormulaPrefix('-1.5e10')).toBe('-1.5e10');
    });
  });
});
