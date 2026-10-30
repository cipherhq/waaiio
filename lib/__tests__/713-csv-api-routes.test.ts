/**
 * #713: API route CSV serializer behavioral tests
 *
 * Tests the REAL extracted production serializers from all three API routes.
 * Each test builds CSV using the actual function the route handler calls,
 * then parses the output with an RFC 4180 parser to verify cell boundaries,
 * formula neutralization, quoting, numerics, and Unicode preservation.
 */
import { describe, it, expect } from 'vitest';

// ─── Real production imports from extracted route serializers ──────

import { csvEscape, arrayToCsv } from '@/app/api/account/export/csv-serializer';
import { csvEscapeField, buildKeywordResponsesCsv } from '@/app/api/keyword-campaigns/csv-serializer';
import { escapeCsvField, buildPromoMaskedCsvRow, buildPromoFullCsvRow } from '@/app/api/promotions/export-codes/csv-serializer';

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
        if (i + 1 < csv.length && csv[i + 1] === '"') { field += '"'; i += 2; }
        else { inQuotes = false; i++; }
      } else { field += ch; i++; }
    } else {
      if (ch === '"') { inQuotes = true; i++; }
      else if (ch === ',') { row.push(field); field = ''; i++; }
      else if (ch === '\r') {
        if (i + 1 < csv.length && csv[i + 1] === '\n') i++;
        row.push(field); rows.push(row); row = []; field = ''; i++;
      } else if (ch === '\n') {
        row.push(field); rows.push(row); row = []; field = ''; i++;
      } else { field += ch; i++; }
    }
  }
  if (field || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

function assertNoActiveFormula(cell: string) {
  const trimmed = cell.replace(/^[\s\x00]+/, '');
  if (!trimmed) return;
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(trimmed)) return;
  expect(/^[=+\-@|]/.test(trimmed)).toBe(false);
}

// ─── 1. Account data export (arrayToCsv + csvEscape) ──────────────

describe('#713 API Path: account export serializer', () => {
  const rows: Record<string, unknown>[] = [
    { email: 'ade@example.com', name: 'Adébáyọ̀', phone: '+2348012345678' },
    { email: '=EVIL@hack.com', name: '@SUM(steal)', phone: '|calc' },
    { email: 'normal@test.com', name: "O'Brien", phone: '+447911123456' },
    { email: 'cr@test.com', name: 'line\rbreak', phone: 'crlf\r\nvalue' },
    { email: 'num@test.com', name: '-50', phone: '+3.14' },
  ];

  it('produces correct row and column count', () => {
    const parsed = parseCsv(arrayToCsv(rows));
    expect(parsed).toHaveLength(6); // header + 5 data rows
    for (const row of parsed) expect(row).toHaveLength(3);
  });

  it('headers match object keys', () => {
    const parsed = parseCsv(arrayToCsv(rows));
    expect(parsed[0]).toEqual(['email', 'name', 'phone']);
  });

  it('neutralizes formula payloads', () => {
    const parsed = parseCsv(arrayToCsv(rows));
    assertNoActiveFormula(parsed[2][0]); // =EVIL@hack.com
    assertNoActiveFormula(parsed[2][1]); // @SUM(steal)
    assertNoActiveFormula(parsed[2][2]); // |calc
  });

  it('preserves Unicode and apostrophes', () => {
    const parsed = parseCsv(arrayToCsv(rows));
    expect(parsed[1][1]).toBe('Adébáyọ̀');
    expect(parsed[3][1]).toBe("O'Brien");
  });

  it('preserves numeric values', () => {
    const parsed = parseCsv(arrayToCsv(rows));
    expect(parsed[5][1]).toBe('-50');
    expect(parsed[5][2]).toBe('+3.14');
  });

  it('handles CR and CRLF in cells', () => {
    const parsed = parseCsv(arrayToCsv(rows));
    expect(parsed[4][1]).toContain('\r');
    expect(parsed[4][2]).toContain('\r\n');
  });

  it('csvEscape handles null, undefined, and objects', () => {
    expect(csvEscape(null)).toBe('');
    expect(csvEscape(undefined)).toBe('');
    expect(csvEscape({ k: 'v' })).toBe('"{""k"":""v""}"');
  });

  it('empty input returns empty string', () => {
    expect(arrayToCsv([])).toBe('');
  });
});

// ─── 2. Keyword campaign responses (buildKeywordResponsesCsv) ─────

describe('#713 API Path: keyword campaign responses serializer', () => {
  const responses = [
    { phone: '+2348012345678', customer_name: 'Adébáyọ̀', responded_at: '2026-10-28T10:00:00Z' },
    { phone: '+1234567890', customer_name: '=EVIL', responded_at: '2026-10-28T11:00:00Z' },
    { phone: null, customer_name: '@SUM(hack)', responded_at: null },
    { phone: '+447911123456', customer_name: "Oyin'ṣọ́lá", responded_at: '2026-10-28T12:00:00Z' },
    { phone: '+0.5', customer_name: '-50', responded_at: '2026-10-28T13:00:00Z' },
    { phone: '+cmd', customer_name: 'line\rbreak', responded_at: 'crlf\r\nvalue' },
    { phone: '|calc', customer_name: 'Lagos, Nigeria', responded_at: '2026-10-28T14:00:00Z' },
  ];

  it('produces correct row and column count', () => {
    const parsed = parseCsv(buildKeywordResponsesCsv(responses));
    expect(parsed).toHaveLength(8); // header + 7 rows
    for (const row of parsed) expect(row).toHaveLength(3);
  });

  it('header row matches expected columns', () => {
    const parsed = parseCsv(buildKeywordResponsesCsv(responses));
    expect(parsed[0]).toEqual(['phone', 'customer_name', 'responded_at']);
  });

  it('neutralizes formula payloads', () => {
    const parsed = parseCsv(buildKeywordResponsesCsv(responses));
    assertNoActiveFormula(parsed[2][1]); // =EVIL
    assertNoActiveFormula(parsed[3][1]); // @SUM(hack)
    assertNoActiveFormula(parsed[7][0]); // |calc
  });

  it('preserves Unicode and Yoruba names', () => {
    const parsed = parseCsv(buildKeywordResponsesCsv(responses));
    expect(parsed[1][1]).toBe('Adébáyọ̀');
    expect(parsed[4][1]).toBe("Oyin'ṣọ́lá");
  });

  it('preserves numeric values', () => {
    const parsed = parseCsv(buildKeywordResponsesCsv(responses));
    expect(parsed[5][1]).toBe('-50');
    expect(parsed[5][0]).toBe('+0.5');
  });

  it('handles null fields as empty strings', () => {
    const parsed = parseCsv(buildKeywordResponsesCsv(responses));
    expect(parsed[3][0]).toBe(''); // null phone
    expect(parsed[3][2]).toBe(''); // null responded_at
  });

  it('handles CR and CRLF in cells', () => {
    const parsed = parseCsv(buildKeywordResponsesCsv(responses));
    expect(parsed[6][1]).toContain('\r');
    expect(parsed[6][2]).toContain('\r\n');
  });

  it('comma in value is quoted correctly', () => {
    const parsed = parseCsv(buildKeywordResponsesCsv(responses));
    expect(parsed[7][1]).toBe('Lagos, Nigeria');
  });
});

// ─── 3. Promo codes export (masked + full row builders) ──────────

describe('#713 API Path: promo codes export serializer', () => {
  describe('masked CSV rows', () => {
    it('builds correct row for claimed code', () => {
      const row = buildPromoMaskedCsvRow({
        display_suffix: 'ABCD',
        outcome: 'winner',
        status: 'claimed',
        claimed_at: '2026-10-28T10:00:00Z',
        claimed_by_phone: '+2348012345678',
      });
      const parsed = parseCsv(row);
      expect(parsed).toHaveLength(1);
      expect(parsed[0]).toHaveLength(5);
      expect(parsed[0][0]).toBe('ABCD');
      expect(parsed[0][1]).toBe('winner');
      expect(parsed[0][2]).toBe('claimed');
    });

    it('redacts outcome for unclaimed codes', () => {
      const row = buildPromoMaskedCsvRow({
        display_suffix: 'WXYZ',
        outcome: 'winner',
        status: 'unused',
        claimed_at: null,
        claimed_by_phone: null,
      });
      const parsed = parseCsv(row);
      expect(parsed[0][1]).toBe(''); // outcome redacted
      expect(parsed[0][4]).toBe(''); // phone empty
    });

    it('neutralizes formula in display_suffix', () => {
      const row = buildPromoMaskedCsvRow({
        display_suffix: '=EVIL',
        status: 'claimed',
        outcome: 'try_again',
        claimed_at: '2026-01-01',
        claimed_by_phone: '|calc',
      });
      const parsed = parseCsv(row);
      assertNoActiveFormula(parsed[0][0]); // =EVIL
      assertNoActiveFormula(parsed[0][4]); // |calc
    });

    it('handles CR in claimed_by_phone', () => {
      const row = buildPromoMaskedCsvRow({
        display_suffix: 'TEST',
        status: 'claimed',
        outcome: 'winner',
        claimed_at: '2026-01-01',
        claimed_by_phone: 'phone\rbreak',
      });
      const parsed = parseCsv(row);
      expect(parsed[0][4]).toContain('\r');
    });
  });

  describe('full CSV rows', () => {
    it('builds correct row', () => {
      const row = buildPromoFullCsvRow({
        decryptedCode: 'PROMO-1234',
        display_suffix: '1234',
        status: 'unused',
      });
      const parsed = parseCsv(row);
      expect(parsed).toHaveLength(1);
      expect(parsed[0]).toHaveLength(3);
      expect(parsed[0][0]).toBe('PROMO-1234');
      expect(parsed[0][2]).toBe('unused');
    });

    it('neutralizes formula in decrypted code', () => {
      const row = buildPromoFullCsvRow({
        decryptedCode: '=CMD|hack',
        display_suffix: 'HACK',
        status: 'unused',
      });
      const parsed = parseCsv(row);
      assertNoActiveFormula(parsed[0][0]);
    });

    it('handles commas in decrypted code', () => {
      const row = buildPromoFullCsvRow({
        decryptedCode: 'CODE,WITH,COMMAS',
        display_suffix: 'TEST',
        status: 'claimed',
      });
      const parsed = parseCsv(row);
      expect(parsed[0]).toHaveLength(3);
      expect(parsed[0][0]).toBe('CODE,WITH,COMMAS');
    });

    it('handles CRLF in code', () => {
      const row = buildPromoFullCsvRow({
        decryptedCode: 'line\r\nbreak',
        display_suffix: 'TEST',
        status: 'unused',
      });
      const parsed = parseCsv(row);
      expect(parsed[0][0]).toContain('\r\n');
    });
  });

  describe('escapeCsvField edge cases', () => {
    it('null returns empty', () => expect(escapeCsvField(null)).toBe(''));
    it('undefined returns empty', () => expect(escapeCsvField(undefined)).toBe(''));
    it('preserves Yoruba', () => expect(escapeCsvField('Àbíké')).toBe('Àbíké'));
    it('preserves numeric', () => expect(escapeCsvField('-50')).toBe('-50'));
  });
});
