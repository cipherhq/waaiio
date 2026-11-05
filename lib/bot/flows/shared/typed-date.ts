/**
 * Typed dates for the booking date picker (#916).
 *
 * Reads what customers type, such as "Dec 20", "20 Dec", "December 20",
 * "20th December", "20/12" or "20/12/2026", and returns a calendar date
 * (YYYY-MM-DD). Pure: no clock and no timezone. The caller passes today's
 * date in the business's local calendar, so the result is never shifted
 * through UTC (the old `new Date("Dec 20")` fallback produced 2001-12-20).
 *
 * - No year given: the next occurrence that is not before today.
 * - Slash dates are day/month, unless `monthFirst` (US businesses).
 */

const MONTHS: Record<string, number> = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4,
  may: 5, june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8,
  september: 9, sept: 9, sep: 9, october: 10, oct: 10, november: 11, nov: 11,
  december: 12, dec: 12,
};
// Longest names first so "sept" wins over "sep" and "june" over "jun"
const MONTH_RE = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|');

// Optional weekday in front, as in the list labels ("Sat, 20 Dec")
const WEEKDAY_PREFIX = '(?:(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(?:day|nesday|sday|urday)?\\.?\\s+)?';
const ORDINAL = '(?:st|nd|rd|th)?';

// "Dec 20", "December 20th", "Dec 20 2026" (commas removed first)
const MONTH_FIRST = new RegExp(`\\b(${MONTH_RE})\\.?\\s+(\\d{1,2})${ORDINAL}(?!\\d)(?:\\s+(\\d{4}))?\\b`);
// "20 Dec", "20th of December", "20 December 2026"
const DAY_FIRST = new RegExp(`\\b(\\d{1,2})${ORDINAL}\\s+(?:of\\s+)?(${MONTH_RE})\\b\\.?(?:\\s+(\\d{4})\\b)?`);
// "20/12", "20-12", "20.12", "20/12/2026", "20/12/26" (whole input only)
const NUMERIC = new RegExp(`^(?:on\\s+)?${WEEKDAY_PREFIX}(\\d{1,2})[/.-](\\d{1,2})(?:[/.-](\\d{4}|\\d{2}))?$`);
// "2026/12/20" (whole input only; "2026-12-20" is handled by the caller)
const YEAR_FIRST = /^(\d{4})[/.](\d{1,2})[/.](\d{1,2})$/;

export type TypedDateResult =
  /** A real calendar date */
  | { kind: 'date'; date: string }
  /** Looks like a date but does not exist (31 Feb, 13/13) */
  | { kind: 'invalid' };

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** YYYY-MM-DD when year/month/day form a real date, else null. */
function toDateStr(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** Next occurrence of month/day on or after `today` (YYYY-MM-DD). */
function nextOccurrence(month: number, day: number, today: string): string | null {
  const thisYear = Number(today.slice(0, 4));
  // Up to 8 years ahead covers 29 February; the caller's booking window rejects far dates.
  for (let year = thisYear; year <= thisYear + 8; year++) {
    const candidate = toDateStr(year, month, day);
    if (candidate && candidate >= today) return candidate;
  }
  return null;
}

function resolve(day: number, month: number, yearText: string | undefined, today: string): TypedDateResult {
  if (yearText) {
    const year = yearText.length === 2 ? 2000 + Number(yearText) : Number(yearText);
    const date = toDateStr(year, month, day);
    return date ? { kind: 'date', date } : { kind: 'invalid' };
  }
  const date = nextOccurrence(month, day, today);
  return date ? { kind: 'date', date } : { kind: 'invalid' };
}

/**
 * Parse a typed date. Returns null when the input is not a date format this
 * reader knows (the caller then tries its other rules or shows an error).
 *
 * @param today     today's date in the business's local calendar, YYYY-MM-DD
 * @param monthFirst true for US businesses: "12/20" means 20 December
 */
export function parseTypedDate(
  input: string,
  opts: { today: string; monthFirst: boolean },
): TypedDateResult | null {
  const text = input.toLowerCase().replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return null;

  const yearFirst = YEAR_FIRST.exec(text);
  if (yearFirst) {
    const date = toDateStr(Number(yearFirst[1]), Number(yearFirst[2]), Number(yearFirst[3]));
    return date ? { kind: 'date', date } : { kind: 'invalid' };
  }

  const numeric = NUMERIC.exec(text);
  if (numeric) {
    const first = Number(numeric[1]);
    const second = Number(numeric[2]);
    const [day, month] = opts.monthFirst ? [second, first] : [first, second];
    return resolve(day, month, numeric[3], opts.today);
  }

  const monthFirst = MONTH_FIRST.exec(text);
  if (monthFirst) {
    return resolve(Number(monthFirst[2]), MONTHS[monthFirst[1]], monthFirst[3], opts.today);
  }

  const dayFirst = DAY_FIRST.exec(text);
  if (dayFirst) {
    return resolve(Number(dayFirst[1]), MONTHS[dayFirst[2]], dayFirst[3], opts.today);
  }

  return null;
}

/** True when `value` is a real YYYY-MM-DD calendar date (not 2026-02-31). */
export function isCalendarDate(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return !!m && toDateStr(Number(m[1]), Number(m[2]), Number(m[3])) === value;
}
