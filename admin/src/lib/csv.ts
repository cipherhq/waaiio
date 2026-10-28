/**
 * Neutralize spreadsheet formula injection in a raw cell value.
 * See lib/utils/csv-export.ts for full documentation.
 */
function neutralizeFormulaPrefix(value: string): string {
  const trimmed = value.replace(/^[\s\x00]+/, '');
  if (!trimmed) return value;
  if (!/^[=+\-@|]/.test(trimmed)) return value;
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(trimmed)) return value;
  return "'" + value;
}

function escapeCsvCell(val: unknown): string {
  const str = val == null ? '' : String(val);
  const safe = neutralizeFormulaPrefix(str);
  if (safe.includes(',') || safe.includes('"') || safe.includes('\n') || safe.includes('\r')) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}

/** Build a CSV string from rows. Exported for testability. */
export function buildAdminCsvString(
  rows: Record<string, unknown>[],
  columns?: { key: string; label: string }[],
): string {
  if (rows.length === 0) return '';
  const cols = columns || Object.keys(rows[0]).map(k => ({ key: k, label: k }));
  const header = cols.map(c => escapeCsvCell(c.label)).join(',');
  const body = rows.map(row => cols.map(c => escapeCsvCell(row[c.key])).join(',')).join('\n');
  return header + '\n' + body;
}

/** Export an array of objects as a CSV file download. */
export function downloadCSV(
  rows: Record<string, unknown>[],
  filename: string,
  columns?: { key: string; label: string }[],
) {
  if (rows.length === 0) return;

  const csv = buildAdminCsvString(rows, columns);

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.csv') ? filename : `${filename}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
