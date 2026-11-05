/** CSV serializer extracted from keyword campaign responses route for testability. */

function neutralizeFormulaPrefix(value: string): string {
  const trimmed = value.replace(/^[\s\x00]+/, '');
  if (!trimmed) return value;
  if (!/^[=+\-@|]/.test(trimmed)) return value;
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(trimmed)) return value;
  return "'" + value;
}

export function csvEscapeField(value: string): string {
  const trimmed = value.replace(/^[\s\x00]+/, '');
  let safe = value;
  if (trimmed && /^[=+\-@|]/.test(trimmed) && !/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(trimmed)) {
    safe = "'" + value;
  }
  if (safe.includes(',') || safe.includes('"') || safe.includes('\n') || safe.includes('\r')) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}

export function buildKeywordResponsesCsv(
  rows: Array<{ phone: string | null; customer_name: string | null; responded_at: string | null }>,
): string {
  const csvHeader = 'phone,customer_name,responded_at';
  const csvRows = rows.map((r) =>
    [
      csvEscapeField(r.phone || ''),
      csvEscapeField(r.customer_name || ''),
      csvEscapeField(r.responded_at || ''),
    ].join(','),
  );
  return [csvHeader, ...csvRows].join('\n');
}
