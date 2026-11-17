// Friendly dates for Custom Flow date questions (#1085, Owner rule on #1079):
// customers tap a short date ("Sat 21 Nov") from a list of upcoming days, or
// "Another date" to type one; the bot confirms in full ("Saturday, 21
// November 2026"). Presentation goes through the existing formatDisplayDate
// seam, so language/country authority is unchanged. Stored values are always
// plain ISO dates (YYYY-MM-DD).
import { formatDisplayDate } from '@/lib/bot/format-date';

export const DATE_OPTION_PREFIX = 'date:';
export const ANOTHER_DATE_ID = 'date:other';
/** WhatsApp lists hold 10 rows: up to 9 days plus "Another date". */
export const MAX_UPCOMING_DAYS = 9;
const ROW_TITLE_MAX = 24;

export interface DateContext {
  timezone: string;
  /** Effective response language, already resolved by the language policy. */
  language?: string;
  /** Business country code (regional date order). */
  country?: string;
}

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real calendar date in ISO form, or null (rejects 2026-02-31). */
export function isoDate(year: number, month: number, day: number): string | null {
  if (!Number.isInteger(year) || year < 1900 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return d.toISOString().slice(0, 10);
}

/** Today's date in the business timezone (falls back to UTC for a bad zone). */
export function todayIn(timezone: string, now = new Date()): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

export function addDays(iso: string, days: number): string {
  const [, y, m, d] = ISO.exec(iso)!.map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** "Sat 21 Nov" style label for a list row. */
export function formatShortDate(iso: string, ctx: Omit<DateContext, 'timezone'>): string {
  return formatDisplayDate(iso, 'short', ctx.language, ctx.country ?? 'GB').slice(0, ROW_TITLE_MAX);
}

/** "Saturday, 21 November 2026" style confirmation. */
export function formatFullDate(iso: string, ctx: Omit<DateContext, 'timezone'>): string {
  return formatDisplayDate(iso, 'long-year', ctx.language, ctx.country ?? 'GB');
}

/** Upcoming days from today (business timezone) plus an "Another date" row. */
export function upcomingDateOptions(ctx: DateContext & { count?: number; anotherLabel?: string; now?: Date }) {
  const count = Math.min(Math.max(Math.trunc(ctx.count ?? 7), 1), MAX_UPCOMING_DAYS);
  const today = todayIn(ctx.timezone, ctx.now);
  const days = Array.from({ length: count }, (_, i) => {
    const iso = addDays(today, i);
    return { id: `${DATE_OPTION_PREFIX}${iso}`, title: formatShortDate(iso, ctx) };
  });
  return [...days, { id: ANOTHER_DATE_ID, title: (ctx.anotherLabel ?? 'Another date').slice(0, ROW_TITLE_MAX) }];
}

/** The ISO date carried by a tapped list row, or null. */
export function tappedDate(id: string): string | null {
  if (!id.startsWith(DATE_OPTION_PREFIX) || id === ANOTHER_DATE_ID) return null;
  const match = ISO.exec(id.slice(DATE_OPTION_PREFIX.length));
  return match ? isoDate(Number(match[1]), Number(match[2]), Number(match[3])) : null;
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
/** 1–12 for a full month name or its 3-letter (or "sept") short form; else 0. */
const monthNumber = (word: string) => {
  const w = word.replace(/\.$/, '');
  return MONTHS.findIndex(m => w === m || w === m.slice(0, 3) || (m === 'september' && w === 'sept')) + 1;
};

/**
 * Parse a date the customer typed. Accepts "21 Nov", "21st November 2026",
 * "Nov 21, 2026", "2026-11-21", "21/11/2026" (month first only for US),
 * "today" and "tomorrow". Without a year, the next such date from today is
 * used. Returns an ISO date or null — never a guess for impossible dates.
 */
export function parseTypedDate(text: string, ctx: DateContext & { now?: Date }): string | null {
  const today = todayIn(ctx.timezone, ctx.now);
  const raw = text.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!raw || raw.length > 40) return null;
  if (raw === 'today') return today;
  if (raw === 'tomorrow') return addDays(today, 1);
  const thisYear = Number(today.slice(0, 4));
  const withYear = (month: number, day: number, year?: number) => {
    if (year !== undefined) return isoDate(year < 100 ? 2000 + year : year, month, day);
    const candidate = isoDate(thisYear, month, day);
    if (candidate && candidate >= today) return candidate;
    return isoDate(thisYear + 1, month, day);
  };

  const iso = ISO.exec(raw);
  if (iso) return isoDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const numeric = /^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2}|\d{4}))?$/.exec(raw);
  if (numeric) {
    const [a, b] = [Number(numeric[1]), Number(numeric[2])];
    const monthFirst = (ctx.country ?? '').toUpperCase() === 'US';
    return withYear(monthFirst ? a : b, monthFirst ? b : a, numeric[3] ? Number(numeric[3]) : undefined);
  }

  // Words: optional weekday, then "21 nov [2026]" or "nov 21[,] [2026]".
  const words = raw.replace(/^(mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\s+/, '').replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
  const dayFirst = /^(\d{1,2})(?:st|nd|rd|th)?(?: of)? ([a-z]+\.?)(?: (\d{4}))?$/.exec(words);
  if (dayFirst) {
    const month = monthNumber(dayFirst[2]);
    return month ? withYear(month, Number(dayFirst[1]), dayFirst[3] ? Number(dayFirst[3]) : undefined) : null;
  }
  const monthFirst = /^([a-z]+\.?) (\d{1,2})(?:st|nd|rd|th)?(?: (\d{4}))?$/.exec(words);
  if (monthFirst) {
    const month = monthNumber(monthFirst[1]);
    return month ? withYear(month, Number(monthFirst[2]), monthFirst[3] ? Number(monthFirst[3]) : undefined) : null;
  }
  return null;
}
