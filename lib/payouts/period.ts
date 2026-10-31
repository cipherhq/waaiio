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
