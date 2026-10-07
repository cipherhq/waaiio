/**
 * Canonical date/time presentation seam (#561-F).
 *
 * Provides deterministic, locale-aware date/time formatting for
 * customer-visible text. Uses the business country locale via getLocale().
 *
 * This is a PRESENTATION-ONLY layer. It never mutates or reinterprets
 * the authoritative stored date/time/slot/timezone value.
 *
 * For EN and PCM (currently certified), calendar formatting is identical —
 * the surrounding chrome is localized by 561-A through 561-E.
 * The seam accepts copyLang for future certified-language expansion.
 */
import { getLocale, type CountryCode } from '@/lib/constants';

// ── Named format presets ──

/** Short: "Mon, 25 Dec" */
const DATE_SHORT: Intl.DateTimeFormatOptions = { weekday: 'short', day: 'numeric', month: 'short' };

/** Long: "Monday, 25 December" */
const DATE_LONG: Intl.DateTimeFormatOptions = { weekday: 'long', day: 'numeric', month: 'long' };

/** Long with year: "Monday, 25 December 2026" */
const DATE_LONG_YEAR: Intl.DateTimeFormatOptions = { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' };

/** Brief: "25 Dec" */
const DATE_BRIEF: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' };

/** Brief with year: "Dec 25, 2026" */
const DATE_BRIEF_YEAR: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric' };

/** Standard time: "2:30 PM" */
const TIME_STANDARD: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' };

export type DateStyle = 'short' | 'long' | 'long-year' | 'brief' | 'brief-year';

const DATE_STYLES: Record<DateStyle, Intl.DateTimeFormatOptions> = {
  short: DATE_SHORT,
  long: DATE_LONG,
  'long-year': DATE_LONG_YEAR,
  brief: DATE_BRIEF,
  'brief-year': DATE_BRIEF_YEAR,
};

/**
 * Format a date for customer-visible display.
 *
 * @param dateInput - ISO date string (YYYY-MM-DD or full ISO) or Date object.
 *   This is the authoritative value. It is never modified.
 * @param style - Named preset or custom Intl.DateTimeFormatOptions.
 * @param cc - Business country code (determines locale via getLocale).
 * @returns Formatted date string. On failure, returns the raw input safely.
 */
export function formatDisplayDate(
  dateInput: string | Date,
  style: DateStyle | Intl.DateTimeFormatOptions,
  cc: CountryCode | string,
): string {
  const options = typeof style === 'string' ? DATE_STYLES[style] : style;
  try {
    const d = typeof dateInput === 'string'
      ? new Date(dateInput + (dateInput.includes('T') ? '' : 'T00:00'))
      : dateInput;
    if (isNaN(d.getTime())) return typeof dateInput === 'string' ? dateInput : '';
    return d.toLocaleDateString(getLocale((cc || 'NG') as CountryCode), options);
  } catch {
    return typeof dateInput === 'string' ? dateInput : '';
  }
}

/**
 * Format a time string for customer-visible display.
 *
 * @param timeInput - Time string in HH:MM or HH:MM:SS format.
 *   This is the authoritative value. It is never modified.
 * @param cc - Business country code (determines locale via getLocale).
 * @returns Formatted time string (e.g. "2:30 PM"). On failure, returns raw input.
 */
export function formatDisplayTime(
  timeInput: string,
  cc: CountryCode | string,
): string {
  try {
    const parts = timeInput.split(':');
    const h = parseInt(parts[0], 10);
    const m = parseInt(parts[1] || '0', 10);
    if (isNaN(h) || isNaN(m)) return timeInput;
    const dt = new Date();
    dt.setHours(h, m, 0, 0);
    return dt.toLocaleTimeString(getLocale((cc || 'NG') as CountryCode), TIME_STANDARD);
  } catch {
    return timeInput;
  }
}
