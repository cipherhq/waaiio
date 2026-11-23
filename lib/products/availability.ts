/**
 * Which days a menu item is on sale (M555; Owner decision 2026-11-23).
 *
 * products.available_days: ISO weekdays (1 = Monday ... 7 = Sunday);
 * NULL or empty = every day. available_from / available_until: first and last
 * day on sale (YYYY-MM-DD); NULL = no limit. An item with none of these set
 * is on sale every day, exactly as before M555.
 *
 * "Today" is the business's local date. Customers only ever see items on sale
 * today. Merchants always see every item. Items already in a cart are never
 * re-checked at checkout, so an order started before midnight still completes.
 */
export const AVAILABILITY_COLUMNS = 'available_days, available_from, available_until';

export const WEEKDAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

export interface ProductAvailability {
  available_days?: number[] | null;
  available_from?: string | null;
  available_until?: string | null;
}

export interface LocalDay {
  /** YYYY-MM-DD in the business timezone */
  date: string;
  /** ISO weekday, 1 = Monday ... 7 = Sunday */
  weekday: number;
}

/** Weekday (1-7) of a YYYY-MM-DD date. */
export function isoWeekday(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
  return day === 0 ? 7 : day;
}

/** True when the item has any day or date limit. */
export function hasAvailabilityLimit(p: ProductAvailability): boolean {
  return (Array.isArray(p.available_days) && p.available_days.length > 0) || !!p.available_from || !!p.available_until;
}

/** True when the item is on sale on `day`. Items with no limit are always on sale. */
export function isAvailableOn(p: ProductAvailability, day: LocalDay): boolean {
  if (Array.isArray(p.available_days) && p.available_days.length > 0 && !p.available_days.includes(day.weekday)) return false;
  if (p.available_from && day.date < p.available_from) return false;
  if (p.available_until && day.date > p.available_until) return false;
  return true;
}

/** Monday (YYYY-MM-DD) of the week containing `date`. */
export function weekStart(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - (isoWeekday(date) - 1))).toISOString().slice(0, 10);
}

/** Sunday (YYYY-MM-DD) of the week containing `date`. */
export function weekEnd(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + (7 - isoWeekday(date)))).toISOString().slice(0, 10);
}

function shortDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

/**
 * Small merchant-facing label, e.g. "Mon, Tue", "this week", "Tue · this week",
 * "from 1 Dec", "until 30 Nov". Null for an every-day item.
 */
export function availabilityLabel(p: ProductAvailability, today: string): string | null {
  const parts: string[] = [];
  const days = Array.isArray(p.available_days) ? [...new Set(p.available_days)].filter(d => d >= 1 && d <= 7).sort((a, b) => a - b) : [];
  if (days.length > 0 && days.length < 7) parts.push(days.map(d => WEEKDAY_SHORT[d - 1]).join(', '));
  const from = p.available_from || null;
  const until = p.available_until || null;
  if (from && until && from === weekStart(today) && until === weekEnd(today)) parts.push('this week');
  else if (from && until) parts.push(from === until ? shortDate(from) : `${shortDate(from)} – ${shortDate(until)}`);
  else if (from) parts.push(`from ${shortDate(from)}`);
  else if (until) parts.push(`until ${shortDate(until)}`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

/**
 * Normalise form input for saving: an empty or all-seven day list is stored
 * as NULL (every day), blank dates as NULL.
 */
export function normaliseAvailability(p: ProductAvailability): Required<ProductAvailability> {
  const days = Array.isArray(p.available_days) ? [...new Set(p.available_days)].filter(d => Number.isInteger(d) && d >= 1 && d <= 7).sort((a, b) => a - b) : [];
  return {
    available_days: days.length === 0 || days.length === 7 ? null : days,
    available_from: p.available_from || null,
    available_until: p.available_until || null,
  };
}
