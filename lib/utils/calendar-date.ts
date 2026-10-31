/** Format a SQL DATE without shifting its calendar day to the viewer's timezone. */
export function formatCalendarDate(date: string, includeYear = true): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return '—';
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) return '—';
  return parsed.toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', ...(includeYear ? { year: 'numeric' } : {}), timeZone: 'UTC',
  });
}
