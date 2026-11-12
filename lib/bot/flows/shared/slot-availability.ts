/**
 * Which start times on one date can still be booked (#919).
 *
 * The bot's time list, a typed or pre-filled time and the date list all use
 * this one rule, so the bot only offers times the booking functions accept.
 * A time is open when it passes both:
 *
 * 1. The time list's existing rule: a booking blocks the start times that fall
 *    inside its length (duration + buffer), up to the capacity.
 * 2. The booking function's rule:
 *    - services and appointments, `book_slot_atomic` (M477): fewer bookings
 *      at exactly that time than the capacity and, when the service has a
 *      buffer, no booking at another time overlapping it (buffer both sides);
 *    - tables, `book_table_atomic` (M510): no booking on the table that
 *      overlaps it, including one from the night before that runs past midnight.
 *
 * Rule 2 only removes times; nothing the list hid before is shown now.
 * Pure: the caller fetches the bookings and builds the candidate times.
 */

export interface SlotBookingRow {
  /** YYYY-MM-DD. Rows without a date are taken as being on the date checked. */
  date?: string | null;
  time: string | null;
  metadata?: Record<string, unknown> | null;
  services?: { duration_minutes?: number | null; buffer_minutes?: number | null } | null;
}

export interface OpenTimesOptions {
  /** The date (YYYY-MM-DD) the candidate times are on. */
  date: string;
  isTable: boolean;
  maxCapacity: number;
  /** Length of an existing booking without its own length (time list rule). */
  fallbackDuration: number;
  /** Length sent to the booking function (`p_duration` / `p_duration_minutes`). */
  candidateDuration: number;
  /** Buffer sent to `book_slot_atomic` (`p_buffer_minutes`). Ignored for tables. */
  bufferMinutes: number;
}

export interface OpenTime {
  time: string;
  /** Spots left, as the time list shows them. */
  remaining: number;
}

const DAY_MINUTES = 24 * 60;

function toMinutes(t: string): number {
  const [h, m] = t.slice(0, 5).split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

/** Whole days from `from` to `to` (YYYY-MM-DD), calendar arithmetic. */
function dayDiff(from: string, to: string): number {
  const [y1, m1, d1] = from.split('-').map(Number);
  const [y2, m2, d2] = to.split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000);
}

export function openTimesOnDate(slots: string[], rows: SlotBookingRow[], o: OpenTimesOptions): OpenTime[] {
  // Each booking on one minute axis relative to midnight of o.date
  const bookings = rows
    .filter(r => !!r.time)
    .map(r => {
      const offsetDays = r.date ? dayDiff(o.date, r.date) : 0;
      const meta = r.metadata || null;
      return {
        sameDay: offsetDays === 0,
        offsetDays,
        start: offsetDays * DAY_MINUTES + toMinutes(r.time as string),
        metaDuration: (meta?.duration_minutes as number) || 0,
        listLength: (meta?.duration_minutes as number)
          || (r.services?.duration_minutes || o.fallbackDuration) + (r.services?.buffer_minutes || 0),
      };
    });

  const sameDay = bookings.filter(b => b.sameDay);
  const open: OpenTime[] = [];
  for (const slot of slots) {
    const s = toMinutes(slot);

    // 1. Time list rule (same date only, as before). Bookings at exactly this
    //    time are counted too, so book_slot_atomic's capacity check is covered.
    const booked = sameDay.filter(b => s >= b.start && s < b.start + b.listLength).length;
    const remaining = o.maxCapacity - booked;
    if (remaining <= 0) continue;

    // 2. Booking function rule
    if (o.isTable) {
      const overlaps = bookings.some(b => {
        if (Math.abs(b.offsetDays) > 1) return false;
        const length = b.metaDuration || o.candidateDuration;
        return s < b.start + length && s + o.candidateDuration > b.start;
      });
      if (overlaps) continue;
    } else if (o.bufferMinutes > 0) {
      const buf = o.bufferMinutes;
      const dur = o.candidateDuration;
      const bufferClash = sameDay.some(b =>
        b.start !== s && s < b.start + dur + buf && s + dur > b.start - buf);
      if (bufferClash) continue;
    }

    open.push({ time: slot, remaining });
  }
  return open;
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const HOURS_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Weekday name of `dateStr` (YYYY-MM-DD) plus `offset` days, calendar arithmetic. */
function weekdayOf(dateStr: string, offset: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d + offset)).getUTCDay()];
}

type DayHours = { state: 'open'; start: number; end: number } | { state: 'closed' | 'unknown' };

/** One weekday entry of `businesses.operating_hours`, read exactly as book_table_atomic (M510) reads it. */
function readDayHours(entry: unknown): DayHours {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return { state: 'unknown' };
  const e = entry as Record<string, unknown>;
  if (e.closed === true || e.is_open === false) return { state: 'closed' };
  if (('closed' in e && e.closed !== false) || ('is_open' in e && e.is_open !== true)) return { state: 'unknown' };
  if (typeof e.open !== 'string' || typeof e.close !== 'string') return { state: 'unknown' };
  if (!HOURS_PATTERN.test(e.open) || !HOURS_PATTERN.test(e.close)) return { state: 'unknown' };
  const open = toMinutes(e.open);
  const close = toMinutes(e.close);
  // Closing at or before opening runs into the next day (open == close is 24 hours)
  return { state: 'open', start: open, end: close <= open ? close + DAY_MINUTES : close };
}

/**
 * Whether the business's opening hours let a table booking start at
 * `startMinutes` on `dateStr` and last `durationMinutes` — the business-hours
 * part of `book_table_atomic` (M510, Owner decision 2026-11-04). The table's
 * own days and hours are checked elsewhere; a booking must pass both.
 *
 * The open time of the day before, the day and the day after is placed on one
 * minute axis and touching stretches are joined. When the day's own entry is
 * unusable there is no business-hours check, only "not past midnight".
 */
export function tableTimeInsideBusinessHours(
  dateStr: string,
  startMinutes: number,
  durationMinutes: number,
  operatingHours: unknown,
): boolean {
  if (startMinutes >= DAY_MINUTES) return false;
  const end = startMinutes + durationMinutes;
  // Anything that is not a weekday map (null, an array, a string) gives no day entries: unknown
  const hours = (operatingHours || {}) as Record<string, unknown>;

  const stretches: Array<[number, number]> = [];
  let dayState: DayHours['state'] = 'unknown';
  for (let k = -1; k <= 1; k++) {
    const day = readDayHours(hours[weekdayOf(dateStr, k)]);
    if (k === 0) dayState = day.state;
    if (day.state !== 'open') continue;
    const start = day.start + k * DAY_MINUTES;
    const stop = day.end + k * DAY_MINUTES;
    const last = stretches[stretches.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], stop);
    else stretches.push([start, stop]);
  }

  if (dayState === 'unknown') return end <= DAY_MINUTES;
  const stretch = stretches.find(([s, e]) => s <= startMinutes && startMinutes < e);
  return !!stretch && end <= stretch[1] && end <= 2 * DAY_MINUTES;
}
