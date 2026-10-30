/** CSV serializer extracted from promo export-codes route for testability. */

function neutralizeFormulaPrefix(value: string): string {
  const trimmed = value.replace(/^[\s\x00]+/, '');
  if (!trimmed) return value;
  if (!/^[=+\-@|]/.test(trimmed)) return value;
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(trimmed)) return value;
  return "'" + value;
}

export function escapeCsvField(value: string | null | undefined): string {
  if (value === null || value === undefined) return '';
  const str = String(value);
  const safe = neutralizeFormulaPrefix(str);
  if (safe.includes(',') || safe.includes('"') || safe.includes('\n') || safe.includes('\r')) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}

export function buildPromoMaskedCsvRow(code: {
  display_suffix: string;
  outcome?: string;
  status: string;
  claimed_at?: string | null;
  claimed_by_phone?: string | null;
}): string {
  const isClaimed = code.status === 'claimed';
  return [
    escapeCsvField(code.display_suffix),
    escapeCsvField(isClaimed ? (code.outcome ?? '') : ''),
    escapeCsvField(code.status),
    escapeCsvField(code.claimed_at),
    escapeCsvField(code.claimed_by_phone),
  ].join(',');
}

export function buildPromoFullCsvRow(code: {
  decryptedCode: string;
  display_suffix: string;
  status: string;
}): string {
  return [
    escapeCsvField(code.decryptedCode),
    escapeCsvField(code.display_suffix),
    escapeCsvField(code.status),
  ].join(',');
}
