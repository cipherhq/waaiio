/** Export an array of objects as a CSV file download. */
export function downloadCSV(
  rows: Record<string, unknown>[],
  filename: string,
  columns?: { key: string; label: string }[],
) {
  if (rows.length === 0) return;

  const cols = columns || Object.keys(rows[0]).map(k => ({ key: k, label: k }));

  const escape = (val: unknown): string => {
    const str = val == null ? '' : String(val);
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const header = cols.map(c => escape(c.label)).join(',');
  const body = rows.map(row => cols.map(c => escape(row[c.key])).join(',')).join('\n');
  const csv = header + '\n' + body;

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.csv') ? filename : `${filename}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
