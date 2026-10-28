/**
 * #713: CSV formula injection guard — behavioral tests
 *
 * Tests invoke REAL exported production functions from all testable CSV paths.
 * API route helpers cannot be exported (Next.js Route Module restrictions) so
 * their structural equivalence to the shared escapeCell is verified via source
 * analysis, and behavioral coverage is provided through the shared function.
 *
 * CSV output is validated using an RFC 4180 parser.
 *
 * Covers: formula neutralization, CR/LF/CRLF quoting, numeric preservation,
 * Unicode/Yoruba/Pidgin names, multi-row structure, column integrity, all five
 * export paths, idempotency.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';

// ─── Real production imports ──────────────────────────────────────

import { neutralizeFormulaPrefix, escapeCell, buildCsvString } from '@/lib/utils/csv-export';
import { buildAdminCsvString } from '@/admin/src/lib/csv';

// ─── RFC 4180 CSV parser ─────────────────────────────────────────

function parseCsv(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  while (i < csv.length) {
    const ch = csv[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < csv.length && csv[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i++;
        }
      } else {
        field += ch;
        i++;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
        i++;
      } else if (ch === ',') {
        row.push(field);
        field = '';
        i++;
      } else if (ch === '\r') {
        if (i + 1 < csv.length && csv[i + 1] === '\n') i++;
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
        i++;
      } else if (ch === '\n') {
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
        i++;
      } else {
        field += ch;
        i++;
      }
    }
  }
  if (field || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// ─── Shared test data ─────────────────────────────────────────────

const UNTRUSTED_ROWS = [
  { name: 'Adébáyọ̀', phone: '+2348012345678', notes: 'Good customer' },
  { name: '=EVIL', phone: '+1234567890', notes: '@SUM(steal)' },
  { name: "O'Brien", phone: '+447911123456', notes: 'Normal, with comma' },
  { name: '-50', phone: '+0.5', notes: '+3.14' },
  { name: 'line\nbreak', phone: 'cr\rbreak', notes: 'crlf\r\nbreak' },
  { name: '|calc', phone: '+cmd', notes: '=HYPERLINK("http://evil.com","Click")' },
  { name: 'Oyin\'ṣọ́lá', phone: '+2348099999999', notes: 'Yoruba name' },
];

const COLUMNS = [
  { key: 'name', label: 'Name' },
  { key: 'phone', label: 'Phone' },
  { key: 'notes', label: 'Notes' },
];

function assertNoActiveFormula(cell: string) {
  const trimmed = cell.replace(/^[\s\x00]+/, '');
  if (!trimmed) return;
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(trimmed)) return;
  expect(/^[=+\-@|]/.test(trimmed)).toBe(false);
}

// ─── 1. neutralizeFormulaPrefix ───────────────────────────────────

describe('#713 neutralizeFormulaPrefix', () => {
  it.each([
    ['=1+1', "'=1+1"], ['+1+1', "'+1+1"], ['-1+1', "'-1+1"],
    ['@SUM(1+1)', "'@SUM(1+1)"], ['|calc', "'|calc"],
    [' =1+1', "' =1+1"], ['\t=cmd', "'\t=cmd"], ['\r+cmd', "'\r+cmd"],
    ['\x00=hack', "'\x00=hack"],
  ])('neutralizes %j → %j', (input, expected) => {
    expect(neutralizeFormulaPrefix(input)).toBe(expected);
  });

  it.each(['-50', '+3.14', '-1.5e10', '+0', '100', '.5'])('preserves numeric %j', (n) => {
    expect(neutralizeFormulaPrefix(n)).toBe(n);
  });

  it.each([
    "Adé's Barbershop", 'Oyin\'ṣọ́lá', 'Ngozi Nwachukwu', 'Àbíké',
    'Lagos, Nigeria', 'São Paulo Café', '日本語テスト', 'مرحبا', '',
  ])('preserves %j', (v) => {
    expect(neutralizeFormulaPrefix(v)).toBe(v);
  });
});

// ─── 2. escapeCell CR/LF/CRLF quoting ────────────────────────────

describe('#713 escapeCell CR/LF/CRLF', () => {
  it('LF triggers quoting', () => expect(escapeCell('a\nb')).toBe('"a\nb"'));
  it('CR triggers quoting', () => expect(escapeCell('a\rb')).toBe('"a\rb"'));
  it('CRLF triggers quoting', () => expect(escapeCell('a\r\nb')).toBe('"a\r\nb"'));
  it('formula + CR neutralized and quoted', () => expect(escapeCell('=x\ry')).toBe("\"'=x\ry\""));
  it('formula + CRLF neutralized and quoted', () => expect(escapeCell('=x\r\ny')).toBe("\"'=x\r\ny\""));
  it('comma triggers quoting', () => expect(escapeCell('a,b')).toBe('"a,b"'));
  it('double-quote escaped and quoted', () => expect(escapeCell('a"b')).toBe('"a""b"'));
});

// ─── 3. Path 1: buildCsvString (shared, lib/utils/csv-export.ts) ─

describe('#713 Path 1: buildCsvString', () => {
  it('correct row and column count', () => {
    const parsed = parseCsv(buildCsvString(UNTRUSTED_ROWS, COLUMNS));
    expect(parsed).toHaveLength(8);
    for (const row of parsed) expect(row).toHaveLength(3);
    expect(parsed[0]).toEqual(['Name', 'Phone', 'Notes']);
  });

  it('formula cells neutralized after parsing', () => {
    const parsed = parseCsv(buildCsvString(UNTRUSTED_ROWS, COLUMNS));
    assertNoActiveFormula(parsed[2][0]); // =EVIL
    assertNoActiveFormula(parsed[2][2]); // @SUM(steal)
    assertNoActiveFormula(parsed[6][0]); // |calc
    assertNoActiveFormula(parsed[6][2]); // =HYPERLINK(...)
  });

  it('numeric values preserved', () => {
    const parsed = parseCsv(buildCsvString(UNTRUSTED_ROWS, COLUMNS));
    expect(parsed[4][0]).toBe('-50');
    expect(parsed[4][1]).toBe('+0.5');
    expect(parsed[4][2]).toBe('+3.14');
  });

  it('Unicode and Yoruba names preserved', () => {
    const parsed = parseCsv(buildCsvString(UNTRUSTED_ROWS, COLUMNS));
    expect(parsed[1][0]).toBe('Adébáyọ̀');
    expect(parsed[7][0]).toBe('Oyin\'ṣọ́lá');
  });

  it('CR/LF/CRLF cells parsed correctly', () => {
    const parsed = parseCsv(buildCsvString(UNTRUSTED_ROWS, COLUMNS));
    expect(parsed[5][0]).toContain('\n');
    expect(parsed[5][1]).toContain('\r');
    expect(parsed[5][2]).toContain('\r\n');
  });

  it('idempotent', () => {
    expect(buildCsvString(UNTRUSTED_ROWS, COLUMNS))
      .toBe(buildCsvString(UNTRUSTED_ROWS, COLUMNS));
  });

  it('empty data returns empty string', () => {
    expect(buildCsvString([])).toBe('');
  });
});

// ─── 4. Path 2: buildAdminCsvString (admin/src/lib/csv.ts) ───────

describe('#713 Path 2: buildAdminCsvString', () => {
  it('correct row and column count', () => {
    const parsed = parseCsv(buildAdminCsvString(UNTRUSTED_ROWS, COLUMNS));
    expect(parsed).toHaveLength(8);
    for (const row of parsed) expect(row).toHaveLength(3);
    expect(parsed[0]).toEqual(['Name', 'Phone', 'Notes']);
  });

  it('formula cells neutralized after parsing', () => {
    const parsed = parseCsv(buildAdminCsvString(UNTRUSTED_ROWS, COLUMNS));
    assertNoActiveFormula(parsed[2][0]);
    assertNoActiveFormula(parsed[2][2]);
    assertNoActiveFormula(parsed[6][0]);
  });

  it('numeric and Unicode preserved', () => {
    const parsed = parseCsv(buildAdminCsvString(UNTRUSTED_ROWS, COLUMNS));
    expect(parsed[4][0]).toBe('-50');
    expect(parsed[1][0]).toBe('Adébáyọ̀');
    expect(parsed[7][0]).toBe('Oyin\'ṣọ́lá');
  });

  it('CR/LF/CRLF cells parsed correctly', () => {
    const parsed = parseCsv(buildAdminCsvString(UNTRUSTED_ROWS, COLUMNS));
    expect(parsed[5][0]).toContain('\n');
    expect(parsed[5][1]).toContain('\r');
    expect(parsed[5][2]).toContain('\r\n');
  });

  it('empty data returns empty string', () => {
    expect(buildAdminCsvString([])).toBe('');
  });

  it('produces identical output to shared buildCsvString', () => {
    expect(buildAdminCsvString(UNTRUSTED_ROWS, COLUMNS))
      .toBe(buildCsvString(UNTRUSTED_ROWS, COLUMNS));
  });
});

// ─── 5. Paths 3-5: API route serializers (extracted to csv-serializer.ts) ──
//
// Serializer logic extracted into importable helpers next to each route.
// Routes import from csv-serializer.ts; tests import from the same file
// (see 713-csv-api-routes.test.ts for full behavioral tests).
// Here we verify the route→serializer wiring and serializer guard logic.

describe('#713 Paths 3-5: API route serializer wiring', () => {
  const serializers = [
    { serializerPath: 'app/api/account/export/csv-serializer.ts', routePath: 'app/api/account/export/route.ts', importPattern: './csv-serializer' },
    { serializerPath: 'app/api/keyword-campaigns/csv-serializer.ts', routePath: 'app/api/keyword-campaigns/[id]/responses/route.ts', importPattern: '@/app/api/keyword-campaigns/csv-serializer' },
    { serializerPath: 'app/api/promotions/export-codes/csv-serializer.ts', routePath: 'app/api/promotions/export-codes/route.ts', importPattern: './csv-serializer' },
  ];

  for (const { serializerPath, routePath, importPattern } of serializers) {
    describe(serializerPath, () => {
      const src = fs.readFileSync(serializerPath, 'utf-8');

      it('contains formula guard with whitespace stripping', () => {
        expect(src).toContain("replace(/^[\\s\\x00]+/, '')");
      });

      it('contains formula trigger regex', () => {
        expect(src).toContain('/^[=+\\-@|]/');
      });

      it('quoting handles comma, double-quote, LF and CR', () => {
        expect(src).toContain("includes(',')");
        expect(src).toContain("includes('\"')");
        expect(src).toContain("includes('\\n')");
        expect(src).toContain("includes('\\r')");
      });
    });

    it(`${routePath} imports from serializer`, () => {
      const routeSrc = fs.readFileSync(routePath, 'utf-8');
      expect(routeSrc).toContain(importPattern);
    });
  }

  it('keyword-campaigns route uses buildKeywordResponsesCsv', () => {
    const src = fs.readFileSync('app/api/keyword-campaigns/[id]/responses/route.ts', 'utf-8');
    expect(src).toContain('buildKeywordResponsesCsv');
    expect(src).not.toContain('${r.phone},"${name}"');
  });
});
