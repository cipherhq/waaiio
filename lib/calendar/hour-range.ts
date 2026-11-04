/**
 * Hour rows for the dashboard calendar's week and day grids, from a business's
 * operating_hours ({ monday: { open: 'HH:MM', close: 'HH:MM', ... }, ... }).
 *
 * - Default 08:00–20:00 when no usable hours exist.
 * - The grid runs from the earliest opening hour to the latest closing hour,
 *   rounding a part-hour close up (17:30 keeps the 17:00 row).
 * - If any day closes at or before it opens (e.g. 18:00–02:00, or a 00:00
 *   close), the business is open past midnight. The grid then covers the
 *   whole day (00:00–24:00), so late-evening and after-midnight bookings
 *   are visible.
 */
export interface CalendarHourRange {
  start: number;
  end: number;
  hours: number[];
}

function toMinutes(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

export function calendarHourRange(operatingHours: unknown): CalendarHourRange {
  let earliest = 8;
  let latest = 20;
  let found = false;
  let overnight = false;

  if (operatingHours && typeof operatingHours === 'object') {
    for (const slot of Object.values(operatingHours as Record<string, unknown>)) {
      if (!slot || typeof slot !== 'object') continue;
      const { open, close } = slot as { open?: unknown; close?: unknown };
      const openMin = toMinutes(open);
      const closeMin = toMinutes(close);
      if (openMin === null || closeMin === null) continue;
      if (closeMin <= openMin) overnight = true;
      const openHour = Math.floor(openMin / 60);
      const closeHour = Math.ceil(closeMin / 60);
      if (!found) {
        earliest = openHour;
        latest = closeHour;
        found = true;
      } else {
        earliest = Math.min(earliest, openHour);
        latest = Math.max(latest, closeHour);
      }
    }
  }

  if (overnight) {
    earliest = 0;
    latest = 24;
  }
  earliest = Math.max(0, Math.min(23, earliest));
  latest = Math.max(earliest + 1, Math.min(24, latest));
  return { start: earliest, end: latest, hours: Array.from({ length: latest - earliest }, (_, i) => earliest + i) };
}
