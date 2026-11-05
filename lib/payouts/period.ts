/**
 * Merchant-local preceding-completed-week period calculator.
 *
 * Given a captured instant and a validated IANA timezone, returns the
 * preceding completed Monday–Sunday week as:
 *   - Local DATE labels (periodStart=Monday, periodEnd=Sunday)
 *   - UTC half-open [queryStart, queryEnd) for timestamp-range queries
 *
 * Sunday invocations select the PRECEDING completed week, never the
 * current unfinished Sunday.
 *
 * Reuses isValidTimezone and naiveToUtc from lib/promotions/timezone.ts.
 * No new dependencies or refactoring of existing utilities.
 */

import { isValidTimezone, naiveToUtc } from '@/lib/promotions/timezone';

export interface PayoutPeriod {
  /** Local Monday date label, e.g. '2026-10-19' */
  periodStart: string;
  /** Local Sunday date label, e.g. '2026-10-25' */
  periodEnd: string;
  /** UTC ISO timestamp: Monday 00:00 local → UTC (inclusive) */
  queryStart: string;
  /** UTC ISO timestamp: next Monday 00:00 local → UTC (exclusive) */
  queryEnd: string;
}

export interface PeriodError {
  success: false;
  error: string;
}

export interface PeriodSuccess {
  success: true;
  period: PayoutPeriod;
}

/**
 * Compute the preceding completed Monday–Sunday week for a business.
 *
 * @param now - The captured instant (explicit, not internally generated)
 * @param timezone - IANA timezone string from the business record
 * @returns The period or an error if the timezone is invalid or conversion fails
 */
export function getPrecedingCompletedWeek(
  now: Date,
  timezone: string,
): PeriodSuccess | PeriodError {
  if (!timezone || !isValidTimezone(timezone)) {
    return { success: false, error: `Invalid or missing IANA timezone: ${timezone}` };
  }

  // Determine the local date components at the given instant
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour12: false,
  });

  const parts = formatter.formatToParts(now);
  const get = (type: string) => {
    const part = parts.find(p => p.type === type);
    return part ? part.value : '';
  };

  const localYear = parseInt(get('year'), 10);
  const localMonth = parseInt(get('month'), 10); // 1-based
  const localDay = parseInt(get('day'), 10);

  // Compute day of week (0=Sunday, 1=Monday, ..., 6=Saturday)
  // Using Tomohiko Sakamoto's algorithm
  const dow = dayOfWeek(localYear, localMonth, localDay);

  // Compute days back to the most recent completed Sunday.
  // dow=0 (Sunday): the current day is Sunday and not yet complete → go back 7
  // dow=1 (Monday): yesterday was Sunday → go back 1
  // dow=2 (Tuesday): go back 2, etc.
  const daysBackToSunday = dow === 0 ? 7 : dow;

  // Preceding Sunday (end of the completed week)
  const sundayDate = addDays(localYear, localMonth, localDay, -daysBackToSunday);
  // Preceding Monday (start of the completed week) = Sunday - 6
  const mondayDate = addDays(sundayDate.year, sundayDate.month, sundayDate.day, -6);
  // Next Monday after Sunday (for half-open upper bound) = Sunday + 1
  const nextMondayDate = addDays(sundayDate.year, sundayDate.month, sundayDate.day, 1);

  const periodStart = formatDate(mondayDate);
  const periodEnd = formatDate(sundayDate);

  // Convert local Monday 00:00 → UTC
  const startResult = naiveToUtc(`${periodStart}T00:00:00`, timezone);
  if (!startResult.success) {
    return { success: false, error: `Failed to convert period start to UTC: ${startResult.error}` };
  }

  // Convert next Monday 00:00 → UTC (exclusive upper bound)
  const endResult = naiveToUtc(`${formatDate(nextMondayDate)}T00:00:00`, timezone);
  if (!endResult.success) {
    return { success: false, error: `Failed to convert period end to UTC: ${endResult.error}` };
  }

  return {
    success: true,
    period: {
      periodStart,
      periodEnd,
      queryStart: startResult.utcIso,
      queryEnd: endResult.utcIso,
    },
  };
}

/**
 * Returns a lookup that computes each timezone's period once for one captured
 * instant and reuses it. One week calculation creates a few hundred Intl
 * formatters (DST probing in naiveToUtc), so per-business calls would be slow
 * for runs over many merchants that mostly share a few timezones.
 */
export function createPrecedingWeekResolver(
  now: Date,
): (timezone: string) => PeriodSuccess | PeriodError {
  const cache = new Map<string, PeriodSuccess | PeriodError>();
  return (timezone: string) => {
    const key = String(timezone);
    let result = cache.get(key);
    if (!result) {
      result = getPrecedingCompletedWeek(now, timezone);
      cache.set(key, result);
    }
    return result;
  };
}

/** A payout row as needed to anchor the next range (M521 columns may be NULL on older rows). */
export interface CoveredPayoutRow {
  period_start: string;
  period_end: string;
  covered_from: string | null;
  covered_to: string | null;
}

export type CoveredRangeResult =
  | { success: true; coveredFrom: string; coveredTo: string }
  | { success: false; error: string };

/**
 * How far back anchorCoveredRange looks for the business's last recorded payout:
 * 53 weeks. A quiet stretch longer than that (no payout row for over a year)
 * restarts at local Monday 00:00.
 */
export const PAYOUT_HISTORY_LOOKBACK_DAYS = 371;

/**
 * Rows a single payout-history read may return before it is treated as not
 * reliably enumerable. PostgREST caps responses at 1000 rows (max_rows), so a
 * full page may be silently truncated: callers fail closed at this size.
 */
export const PAYOUT_HISTORY_MAX_ROWS = 1000;

/** Lower bound (DATE label) for the payout rows anchorCoveredRange needs to see. */
export function recentPayoutRowsFrom(period: PayoutPeriod): string {
  return shiftDateLabel(period.periodStart, -PAYOUT_HISTORY_LOOKBACK_DAYS);
}

/**
 * Exact half-open UTC range of platform_fees.created_at a payout for `period`
 * may count, given the business's payout rows with period_end on or after
 * recentPayoutRowsFrom(period). Owner decisions 2026-11-05 (#796, Option A, and
 * "fix it in #796 now"):
 *   - a week that already has a payout row (another currency) reuses that range;
 *   - otherwise the range starts exactly at the latest recorded end (covered_to)
 *     of any earlier week, so a timezone change can neither double-count nor skip
 *     fees, and fees from weeks that made no payout (no sales, below the minimum,
 *     accounting hold) roll into this one;
 *   - with no recorded earlier payout, it starts at local Monday 00:00 (period.queryStart).
 * It always ends at the next local Monday 00:00 (period.queryEnd). Fails
 * closed when the range would be empty or overlap any other recorded payout.
 */
export function anchorCoveredRange(period: PayoutPeriod, rows: CoveredPayoutRow[]): CoveredRangeResult {
  const recorded = rows.filter(r => r.covered_from && r.covered_to);
  const sameWeek = recorded.filter(r => r.period_start === period.periodStart && r.period_end === period.periodEnd);
  const others = recorded.filter(r => !(r.period_start === period.periodStart && r.period_end === period.periodEnd));

  let fromMs: number;
  let toMs: number;
  if (sameWeek.length > 0) {
    fromMs = Date.parse(sameWeek[0].covered_from!);
    toMs = Date.parse(sameWeek[0].covered_to!);
    if (sameWeek.some(r => Date.parse(r.covered_from!) !== fromMs || Date.parse(r.covered_to!) !== toMs)) {
      return { success: false, error: `Payout rows for ${period.periodStart}..${period.periodEnd} record different ranges` };
    }
  } else {
    const earlier = others.filter(r => r.period_end < period.periodStart);
    fromMs = earlier.length > 0
      ? Math.max(...earlier.map(r => Date.parse(r.covered_to!)))
      : Date.parse(period.queryStart);
    toMs = Date.parse(period.queryEnd);
  }

  if (!(Number.isFinite(fromMs) && Number.isFinite(toMs) && fromMs < toMs)) {
    return { success: false, error: `Empty or invalid payout range for ${period.periodStart}..${period.periodEnd}` };
  }
  const overlap = others.find(r => Date.parse(r.covered_from!) < toMs && Date.parse(r.covered_to!) > fromMs);
  if (overlap) {
    return {
      success: false,
      error: `Payout range for ${period.periodStart}..${period.periodEnd} overlaps the payout for ${overlap.period_start}..${overlap.period_end}`,
    };
  }
  return { success: true, coveredFrom: new Date(fromMs).toISOString(), coveredTo: new Date(toMs).toISOString() };
}

/** Shift a 'YYYY-MM-DD' label by whole days (pure calendar arithmetic). */
function shiftDateLabel(label: string, days: number): string {
  const [y, m, d] = label.split('-').map(Number);
  return formatDate(addDays(y, m, d, days));
}

// ── Internal helpers ──

/** Day of week: 0=Sunday, 1=Monday, ..., 6=Saturday (Tomohiko Sakamoto) */
function dayOfWeek(y: number, m: number, d: number): number {
  const t = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4];
  const yr = m < 3 ? y - 1 : y;
  return (yr + Math.floor(yr / 4) - Math.floor(yr / 100) + Math.floor(yr / 400) + t[m - 1] + d) % 7;
}

/** Add days to a date, handling month/year overflow */
function addDays(y: number, m: number, d: number, delta: number): { year: number; month: number; day: number } {
  // Use UTC Date for pure calendar arithmetic (no host-timezone influence)
  const date = new Date(Date.UTC(y, m - 1, d + delta));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

/** Format {year, month, day} as 'YYYY-MM-DD' */
function formatDate(d: { year: number; month: number; day: number }): string {
  return `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
}
