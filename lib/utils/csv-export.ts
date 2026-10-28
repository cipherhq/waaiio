/**
 * Neutralize spreadsheet formula injection in a raw cell value.
 *
 * Spreadsheet software (Excel, Google Sheets, LibreOffice) interprets cells
 * starting with =, +, -, @, or | as formulas — even inside quoted CSV fields.
 * Leading whitespace and control characters (\t, \r, \0) are stripped before
 * the check because they do not prevent formula execution.
 *
 * Pure numeric values (e.g. -50, +3.14) are preserved to avoid corrupting
 * legitimate financial/quantity data.
 *
 * A single-quote prefix (') forces the cell into text mode in all major
 * spreadsheet applications.
 */
export function neutralizeFormulaPrefix(value: string): string {
  const trimmed = value.replace(/^[\s\x00]+/, '');
  if (!trimmed) return value;
  if (!/^[=+\-@|]/.test(trimmed)) return value;
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(trimmed)) return value;
  return "'" + value;
}

/**
 * Convert an array of objects to CSV string and trigger download.
 */
export function exportToCsv(
  data: Record<string, unknown>[],
  filename: string,
  columns?: { key: string; label: string }[],
): void {
  if (data.length === 0) return;

  const cols = columns || Object.keys(data[0]).map(key => ({ key, label: key }));
  const headers = cols.map(c => escapeCell(c.label));
  const rows = data.map(row =>
    cols.map(c => escapeCell(String(row[c.key] ?? ''))),
  );

  const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.href = url;
  link.download = `${filename}-${new Date().toISOString().split('T')[0]}.csv`;
  link.click();

  URL.revokeObjectURL(url);
}

function escapeCell(value: string): string {
  const safe = neutralizeFormulaPrefix(value);
  if (safe.includes(',') || safe.includes('"') || safe.includes('\n')) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}
