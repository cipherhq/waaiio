/**
 * Canonical date/time presentation seam (#561-F).
 *
 * Provides deterministic, locale-aware date/time formatting for
 * customer-visible text. This is a PRESENTATION-ONLY layer that
 * never mutates or reinterprets the authoritative stored value.
 *
 * Locale authority follows Waaiio's existing language policy:
 *   1. Primary: effective response language (already resolved through
 *      certified + entitled + fallback authority by the caller).
 *   2. Secondary: business country code (regional convention —
 *      date order, 12h/24h preference, etc.).
 *
 * The formatter does NOT decide entitlement or certification.
 * It receives the already-authorized effective language.
 *
 * If the effective language is uncertified/unentitled, the caller
 * will have already resolved it to English via the existing
 * language-authority seam — so the formatter never sees uncertified
 * languages in practice.
 *
 * PCM (Nigerian Pidgin) maps to English for calendar formatting
 * since Pidgin uses the same calendar system.
 */
import { CERTIFIED_LANGUAGES } from '@/lib/bot/languages';

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
 * Map an effective response language to its Intl-compatible calendar language.
 * PCM → 'en' (same calendar system). Uncertified languages that somehow reach
 * the formatter also fall back to 'en' as a safety net.
 */
function resolveCalendarLang(effectiveLang: string | undefined): string {
  if (!effectiveLang) return 'en';
  // PCM uses the same calendar formatting as English
  if (effectiveLang === 'pcm') return 'en';
  // If the language is certified and has a valid Intl locale, use it
  if (CERTIFIED_LANGUAGES.includes(effectiveLang)) return effectiveLang;
  // Uncertified languages should not reach here (caller resolves to EN),
  // but safety-net to English
  return 'en';
}

/**
 * Build a BCP47 locale tag from effective language + business country.
 * E.g., ('en', 'CA') → 'en-CA', ('en', 'NG') → 'en-NG'.
 */
function buildLocaleTag(effectiveLang: string | undefined, cc: string): string {
  const lang = resolveCalendarLang(effectiveLang);
  const country = (cc || 'NG').toUpperCase();
  return `${lang}-${country}`;
}

/**
 * Format a date for customer-visible display.
 *
 * @param dateInput - ISO date string (YYYY-MM-DD or full ISO) or Date object.
 *   This is the authoritative value. It is never modified.
 * @param style - Named preset or custom Intl.DateTimeFormatOptions.
 * @param effectiveLang - Already-resolved effective response language ('en', 'pcm', etc.).
 *   This is the PRIMARY locale authority. Must come from the existing language-authority seam.
 * @param cc - Business country code. SECONDARY regional context (date order, 12h/24h, etc.).
 * @returns Formatted date string. On failure, returns the raw input safely.
 */
export function formatDisplayDate(
  dateInput: string | Date,
  style: DateStyle | Intl.DateTimeFormatOptions,
  effectiveLang: string | undefined,
  cc: string,
): string {
  const options = typeof style === 'string' ? DATE_STYLES[style] : style;
  try {
    const d = typeof dateInput === 'string'
      ? new Date(dateInput + (dateInput.includes('T') ? '' : 'T00:00'))
      : dateInput;
    if (isNaN(d.getTime())) return typeof dateInput === 'string' ? dateInput : '';
    return d.toLocaleDateString(buildLocaleTag(effectiveLang, cc), options);
  } catch {
    return typeof dateInput === 'string' ? dateInput : '';
  }
}

/**
 * Format a time string for customer-visible display.
 *
 * @param timeInput - Time string in HH:MM or HH:MM:SS format.
 *   This is the authoritative value. It is never modified.
 * @param effectiveLang - Already-resolved effective response language.
 * @param cc - Business country code (regional context).
 * @returns Formatted time string (e.g. "2:30 PM"). On failure, returns raw input.
 */
export function formatDisplayTime(
  timeInput: string,
  effectiveLang: string | undefined,
  cc: string,
): string {
  try {
    const parts = timeInput.split(':');
    const h = parseInt(parts[0], 10);
    const m = parseInt(parts[1] || '0', 10);
    if (isNaN(h) || isNaN(m)) return timeInput;
    const dt = new Date();
    dt.setHours(h, m, 0, 0);
    return dt.toLocaleTimeString(buildLocaleTag(effectiveLang, cc), TIME_STANDARD);
  } catch {
    return timeInput;
  }
}
