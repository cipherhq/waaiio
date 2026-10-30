/** CSV serializer extracted from account export route for testability. */

function neutralizeFormulaPrefix(value: string): string {
  const trimmed = value.replace(/^[\s\x00]+/, '');
  if (!trimmed) return value;
  if (!/^[=+\-@|]/.test(trimmed)) return value;
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(trimmed)) return value;
  return "'" + value;
}

export function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return '';
  const str = typeof value === 'object' ? JSON.stringify(value) : String(value);
  const safe = neutralizeFormulaPrefix(str);
  if (safe.includes(',') || safe.includes('"') || safe.includes('\n') || safe.includes('\r')) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}

export function arrayToCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return '';
  const headers = Object.keys(rows[0]);
  const lines = [
    headers.join(','),
    ...rows.map((row) => headers.map((h) => csvEscape(row[h])).join(',')),
  ];
  return lines.join('\n');
}
