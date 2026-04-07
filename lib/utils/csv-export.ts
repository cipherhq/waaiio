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
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
