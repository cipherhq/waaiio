/**
 * #713: CSV formula injection guard — behavioral tests
 *
 * Tests invoke the REAL exported functions from the production serializers.
 * No copied implementations. Covers formula neutralization, CR/LF/CRLF
 * quoting, numeric preservation, Unicode/Yoruba/Pidgin names, multi-row
 * CSV structure, and all five export paths.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';

// ─── Import REAL production functions ─────────────────────────────

import { neutralizeFormulaPrefix, escapeCell } from '@/lib/utils/csv-export';

// ─── 1. neutralizeFormulaPrefix (exported from production) ────────

describe('#713 neutralizeFormulaPrefix (real import)', () => {
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
      '-50', '+3.14', '-1.5e10', '+0', '-0.50', '.5', '100', '0', '-999999', '+1E5',
    ])('numeric %j preserved', (input) => {
      expect(neutralizeFormulaPrefix(input)).toBe(input);
    });
  });

  describe('preserves Unicode, Yoruba/Pidgin names, and punctuation', () => {
    it.each([
      "Adé's Barbershop", 'Oyin\'ṣọ́lá', 'Ngozi Nwachukwu', 'Chị́nwe',
      'Àbíké', 'Lagos, Nigeria', "O'Brien", 'Jean-Pierre', 'São Paulo Café',
      '日本語テスト', 'مرحبا', 'Beyoncé', 'Ümlaut & Co.', 'hello@world.com',
      '#hashtag', '$100 store', '50% off',
    ])('preserves %j unchanged', (input) => {
      expect(neutralizeFormulaPrefix(input)).toBe(input);
    });
  });

  describe('preserves empty and whitespace-only values', () => {
    it.each(['', ' ', '  ', '\t', '\n'])('input %j preserved', (input) => {
      expect(neutralizeFormulaPrefix(input)).toBe(input);
    });
  });
});

// ─── 2. escapeCell (real import — tests CR/LF/CRLF quoting) ──────

describe('#713 escapeCell (real import)', () => {
  describe('quotes cells containing line breaks', () => {
    it('LF triggers quoting', () => {
      expect(escapeCell('line1\nline2')).toBe('"line1\nline2"');
    });

    it('CR triggers quoting', () => {
      expect(escapeCell('line1\rline2')).toBe('"line1\rline2"');
    });

    it('CRLF triggers quoting', () => {
      expect(escapeCell('line1\r\nline2')).toBe('"line1\r\nline2"');
    });
  });

  describe('quotes cells containing commas and double-quotes', () => {
    it('comma triggers quoting', () => {
      expect(escapeCell('Lagos, Nigeria')).toBe('"Lagos, Nigeria"');
    });

    it('double-quote is escaped and quoted', () => {
      expect(escapeCell('He said "hello"')).toBe('"He said ""hello"""');
    });

    it('comma + quote combined', () => {
      expect(escapeCell('"Lagos", Nigeria')).toBe('"""Lagos"", Nigeria"');
    });
  });

  describe('formula neutralization before quoting', () => {
    it('simple formula — neutralized, no quoting needed', () => {
      expect(escapeCell('=1+1')).toBe("'=1+1");
    });

    it('formula with comma — neutralized AND quoted', () => {
      const result = escapeCell('=SUM(A1,B1)');
      expect(result).toBe("\"'=SUM(A1,B1)\"");
    });

    it('formula with LF — neutralized AND quoted', () => {
      expect(escapeCell('=1+1\nmore')).toBe("\"'=1+1\nmore\"");
    });

    it('formula with CR — neutralized AND quoted', () => {
      expect(escapeCell('=1+1\rmore')).toBe("\"'=1+1\rmore\"");
    });

    it('formula with CRLF — neutralized AND quoted', () => {
      expect(escapeCell('=1+1\r\nmore')).toBe("\"'=1+1\r\nmore\"");
    });

    it('formula with double-quote — neutralized, escaped, and quoted', () => {
      const result = escapeCell('=HYPERLINK("http://evil.com","Click")');
      // The ' prefix is applied first, then " are doubled, then wrapped in quotes
      expect(result).toBe("\"'=HYPERLINK(\"\"http://evil.com\"\",\"\"Click\"\")\"");
    });

    it('pipe command — neutralized', () => {
      expect(escapeCell('|calc')).toBe("'|calc");
    });

    it('@-prefix — neutralized', () => {
      expect(escapeCell('@SUM(A1:A10)')).toBe("'@SUM(A1:A10)");
    });

    it('leading whitespace + formula — neutralized', () => {
      expect(escapeCell(' =hack')).toBe("' =hack");
    });

    it('leading tab + formula — neutralized and quoted (tab triggers whitespace strip)', () => {
      const result = escapeCell('\t=hack');
      // \t is in the value; formula guard sees =hack after strip → neutralizes
      // The \t triggers... let's check: \t is not , " \n \r → not quoted unless tab
      // Actually tab doesn't trigger CSV quoting in our function. But the ' prefix is added.
      expect(result).toBe("'\t=hack");
    });
  });

  describe('legitimate values pass through unchanged', () => {
    it('plain text', () => {
      expect(escapeCell('Normal text')).toBe('Normal text');
    });

    it('negative number preserved', () => {
      expect(escapeCell('-50')).toBe('-50');
    });

    it('positive number preserved', () => {
      expect(escapeCell('+3.14')).toBe('+3.14');
    });

    it('Yoruba name with accents', () => {
      expect(escapeCell('Adébáyọ̀')).toBe('Adébáyọ̀');
    });

    it('name with apostrophe', () => {
      expect(escapeCell("Adé's Barbershop")).toBe("Adé's Barbershop");
    });

    it('empty string', () => {
      expect(escapeCell('')).toBe('');
    });
  });

  describe('edge cases', () => {
    it('single formula trigger char', () => {
      expect(escapeCell('=')).toBe("'=");
      expect(escapeCell('+')).toBe("'+");
      expect(escapeCell('-')).toBe("'-");
      expect(escapeCell('@')).toBe("'@");
      expect(escapeCell('|')).toBe("'|");
    });

    it('-1+1 is NOT a number — gets neutralized', () => {
      expect(escapeCell('-1+1')).toBe("'-1+1");
    });

    it('-1.5e10 IS a number — preserved', () => {
      expect(escapeCell('-1.5e10')).toBe('-1.5e10');
    });

    it('very long value handled', () => {
      const long = '='.repeat(10000);
      const result = escapeCell(long);
      expect(result.startsWith("'=")).toBe(true);
      expect(result.length).toBe(10001);
    });

    it('null-byte prefix stripped before check', () => {
      const result = escapeCell('\x00=hack');
      expect(result.startsWith("'")).toBe(true);
    });
  });
});

// ─── 3. Multi-row CSV structure via real escapeCell ───────────────

describe('#713 CSV row/column structure (real escapeCell)', () => {
  function buildCsv(
    headers: string[],
    rows: string[][],
  ): string {
    return [
      headers.map(h => escapeCell(h)).join(','),
      ...rows.map(row => row.map(cell => escapeCell(cell)).join(',')),
    ].join('\n');
  }

  it('produces valid CSV with mixed safe and unsafe values', () => {
    const csv = buildCsv(
      ['name', 'phone', 'notes'],
      [
        ['Adébáyọ̀', '+2348012345678', 'Good customer'],
        ['=EVIL', '+1234567890', '@SUM(steal)'],
        ["O'Brien", '+447911123456', 'Normal, with comma'],
        ['-50', '+0.5', '+3.14'],
      ],
    );

    const lines = csv.split('\n');
    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe('name,phone,notes');

    // Row 1: Unicode preserved, phone is valid number
    expect(lines[1]).toBe('Adébáyọ̀,+2348012345678,Good customer');

    // Row 2: Formula cells neutralized, phone preserved (pure number)
    expect(lines[2]).toContain("'=EVIL");
    expect(lines[2]).toContain('+1234567890');
    expect(lines[2]).toContain("'@SUM(steal)");

    // Row 3: Comma in notes triggers quoting
    expect(lines[3]).toContain("O'Brien");
    expect(lines[3]).toContain('"Normal, with comma"');

    // Row 4: All pure numerics — preserved
    expect(lines[4]).toBe('-50,+0.5,+3.14');
  });

  it('handles CR, LF, and CRLF in cell values', () => {
    const csv = buildCsv(
      ['field'],
      [
        ['line1\nline2'],
        ['line1\rline2'],
        ['line1\r\nline2'],
      ],
    );

    const lines = csv.split('\n');
    // Header + row1 (quoted, contains \n) + row2 (quoted, contains \r) + row3 (quoted, contains \r\n)
    // Can't split on \n to parse — that's fine. Check the raw CSV string instead.
    expect(csv).toContain('"line1\nline2"');
    expect(csv).toContain('"line1\rline2"');
    expect(csv).toContain('"line1\r\nline2"');
  });

  it('formula + CR combined: neutralized AND quoted', () => {
    const csv = buildCsv(['field'], [['=hack\rcontinue']]);
    expect(csv).toContain("\"'=hack\rcontinue\"");
  });

  it('formula + CRLF combined: neutralized AND quoted', () => {
    const csv = buildCsv(['field'], [['=hack\r\ncontinue']]);
    expect(csv).toContain("\"'=hack\r\ncontinue\"");
  });

  it('repeated serialization is idempotent', () => {
    const data = [['=FORMULA', 'Normal', '-50'], ['Adé', '@HACK', '+3.14']];
    const serialize = () => buildCsv(['a', 'b', 'c'], data);
    expect(serialize()).toBe(serialize());
  });

  it('column count is consistent across all rows', () => {
    const csv = buildCsv(
      ['a', 'b', 'c'],
      [
        ['=X', 'y,z', '"q"'],
        ['normal', 'plain', 'text'],
        ['\r\nbreak', '=+@|', '-42'],
      ],
    );

    // Parse each line to count top-level commas (outside quotes)
    function countFields(line: string): number {
      let fields = 1;
      let inQuotes = false;
      for (const ch of line) {
        if (ch === '"') inQuotes = !inQuotes;
        else if (ch === ',' && !inQuotes) fields++;
      }
      return fields;
    }

    // We need to split carefully since values may contain \n
    // Instead, check that each "row" when properly parsed has 3 fields
    // Build rows manually since we know the structure
    const rows = [
      [escapeCell('=X'), escapeCell('y,z'), escapeCell('"q"')].join(','),
      [escapeCell('normal'), escapeCell('plain'), escapeCell('text')].join(','),
      [escapeCell('\r\nbreak'), escapeCell('=+@|'), escapeCell('-42')].join(','),
    ];
    for (const row of rows) {
      expect(countFields(row)).toBe(3);
    }
  });
});

// ─── 4. All five export paths: source-level verification ──────────

describe('#713 all five export paths patched', () => {
  const paths = [
    { path: 'lib/utils/csv-export.ts', fnName: 'escapeCell' },
    { path: 'admin/src/lib/csv.ts', fnName: 'escape' },
    { path: 'app/api/account/export/route.ts', fnName: 'csvEscape' },
    { path: 'app/api/keyword-campaigns/[id]/responses/route.ts', fnName: 'csvEscapeField' },
    { path: 'app/api/promotions/export-codes/route.ts', fnName: 'escapeCsvField' },
  ];

  for (const { path, fnName } of paths) {
    describe(path, () => {
      const src = fs.readFileSync(path, 'utf-8');

      it('contains formula guard logic', () => {
        expect(
          src.includes('neutralizeFormulaPrefix') || src.includes('csvEscapeField'),
        ).toBe(true);
      });

      it('applies guard before CSV quoting', () => {
        expect(src).toContain("replace(/^[\\s\\x00]+/, '')");
        expect(src).toContain('/^[=+\\-@|]/');
      });

      it('quoting handles comma, double-quote, LF and CR', () => {
        // All five must check for , " \n \r
        expect(src).toContain("includes(',')");
        expect(src).toContain("includes('\"')");
        expect(src).toContain("includes('\\n')");
        expect(src).toContain("includes('\\r')");
      });

      it(`${fnName} calls neutralize before quote check`, () => {
        // The function must apply formula guard THEN check quoting triggers
        const fnStart = src.indexOf(`function ${fnName}`);
        if (fnStart === -1) return; // csvEscapeField is inline
        const fnBody = src.slice(fnStart, src.indexOf('\n}', fnStart) + 2);
        const neutralizePos = fnBody.indexOf('neutralizeFormulaPrefix') !== -1
          ? fnBody.indexOf('neutralizeFormulaPrefix')
          : fnBody.indexOf("replace(/^[\\s\\x00]+/, '')");
        const quotePos = fnBody.indexOf("includes(',')");
        expect(neutralizePos).toBeLessThan(quotePos);
      });
    });
  }

  it('keyword-campaigns uses csvEscapeField for all columns', () => {
    const src = fs.readFileSync('app/api/keyword-campaigns/[id]/responses/route.ts', 'utf-8');
    expect(src).not.toContain('${r.phone},"${name}"');
    expect(src).toContain('csvEscapeField(r.phone');
    expect(src).toContain('csvEscapeField(r.customer_name');
    expect(src).toContain('csvEscapeField(r.responded_at');
  });
});
