/**
 * Timezone conversion utilities for promo campaign datetime handling.
 *
 * Converts naive datetime-local strings (from the dashboard) into correct
 * UTC TIMESTAMPTZ by interpreting them in the campaign's IANA timezone.
 *
 * Uses Node's built-in Intl.DateTimeFormat — no external dependencies.
 */

/**
 * Validate that a string is a valid IANA timezone identifier.
 * Uses Intl.DateTimeFormat which throws on invalid zones.
 */
export function isValidTimezone(tz: string): boolean {
  try {
    Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the UTC offset (in minutes) for a given date in a given IANA timezone.
 * Returns the offset such that: UTC = local - offset.
 *
 * Example: Africa/Lagos is UTC+1, so offset = 60.
 */
function getTimezoneOffsetMinutes(date: Date, tz: string): number {
  // Format the date in the target timezone to extract its local components
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  const parts = formatter.formatToParts(date);
  const get = (type: string) => {
    const part = parts.find(p => p.type === type);
    return part ? parseInt(part.value, 10) : 0;
  };

  // Build a UTC date from the formatted local components
  const localAsUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour') === 24 ? 0 : get('hour'), // midnight edge case
    get('minute'),
    get('second'),
  );

  // The difference between the UTC timestamp and the "local-as-UTC" timestamp
  // gives us the offset. offset = localAsUtc - date.getTime()
  return Math.round((localAsUtc - date.getTime()) / 60000);
}

/**
 * Days in month lookup, accounting for leap years.
 */
function daysInMonth(year: number, month: number): number {
  // month is 1-based here (1=Jan, 12=Dec)
  const monthDays = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month === 2) {
    const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return isLeap ? 29 : 28;
  }
  return monthDays[month];
}

export interface TimezoneConversionResult {
  success: true;
  utcIso: string;
}

export interface TimezoneConversionError {
  success: false;
  error: string;
}

/**
 * Convert a naive datetime string (from datetime-local input) to a UTC ISO string,
 * interpreting the naive datetime as local time in the given IANA timezone.
 *
 * @param naiveDatetime - A datetime string like "2024-10-30T23:59" (no timezone suffix)
 * @param timezone - An IANA timezone like "Africa/Lagos"
 * @returns UTC ISO string or error
 *
 * BLOCKER 2 fix: Rejects already-zoned timestamps (Z, +HH:MM, -HH:MM suffix).
 * BLOCKER 2 fix: Validates calendar values (month 1-12, day valid for month/year, etc.).
 * BLOCKER 1 fix: Detects DST fall-back ambiguity by probing TWO candidate offsets.
 *
 * DST handling:
 * - Spring-forward gap (nonexistent local time): rejected with error
 * - Fall-back ambiguity (two valid UTC instants): picks EARLIER UTC (= larger offset,
 *   i.e., pre-transition / DST offset). This is the conservative choice —
 *   campaigns end sooner, promotions start earlier.
 */
export function naiveToUtc(
  naiveDatetime: string,
  timezone: string,
): TimezoneConversionResult | TimezoneConversionError {
  if (!isValidTimezone(timezone)) {
    return { success: false, error: `Invalid timezone: ${timezone}` };
  }

  // ── BLOCKER 2: Reject already-zoned timestamps ──
  // If the input contains Z, +HH:MM, or -HH:MM after the time portion, it's
  // already an absolute timestamp. Reinterpreting it would double-shift.
  if (/[Zz]/.test(naiveDatetime) || /[+-]\d{2}:\d{2}/.test(naiveDatetime)) {
    return {
      success: false,
      error: `Datetime "${naiveDatetime}" already contains a timezone offset (Z or +/-HH:MM). ` +
        'Provide a naive datetime without timezone suffix (e.g., "2024-10-30T23:59").',
    };
  }

  // ── BLOCKER 2: End-anchored regex — strict format ──
  const match = naiveDatetime.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) {
    return { success: false, error: `Invalid datetime format: ${naiveDatetime}. Expected YYYY-MM-DDTHH:mm or YYYY-MM-DDTHH:mm:ss` };
  }

  const [, yearStr, monthStr, dayStr, hourStr, minuteStr, secondStr] = match;
  const year = parseInt(yearStr, 10);
  const monthRaw = parseInt(monthStr, 10); // 1-based
  const day = parseInt(dayStr, 10);
  const hour = parseInt(hourStr, 10);
  const minute = parseInt(minuteStr, 10);
  const second = secondStr ? parseInt(secondStr, 10) : 0;

  // ── BLOCKER 2: Strict calendar validation ──
  if (monthRaw < 1 || monthRaw > 12) {
    return { success: false, error: `Invalid month: ${monthRaw}. Must be 1-12.` };
  }
  const maxDay = daysInMonth(year, monthRaw);
  if (day < 1 || day > maxDay) {
    return { success: false, error: `Invalid day: ${day} for ${year}-${monthStr}. Max is ${maxDay}.` };
  }
  if (hour < 0 || hour > 23) {
    return { success: false, error: `Invalid hour: ${hour}. Must be 0-23.` };
  }
  if (minute < 0 || minute > 59) {
    return { success: false, error: `Invalid minute: ${minute}. Must be 0-59.` };
  }
  if (second < 0 || second > 59) {
    return { success: false, error: `Invalid second: ${second}. Must be 0-59.` };
  }

  const month = monthRaw - 1; // JS months are 0-based

  // ── BLOCKER 1: Detect ambiguity by probing multiple candidate offsets ──
  // For any local time, the offset might differ depending on which "occurrence"
  // we're in (before or after a DST transition). We probe three reference points:
  //   1. The naive time itself (treated as UTC for offset lookup)
  //   2. One hour before
  //   3. One hour after
  // If any of these produce different offsets that both round-trip to the same
  // local time, the input is ambiguous (fall-back).

  const naiveAsUtc = Date.UTC(year, month, day, hour, minute, second);
  const ONE_HOUR = 3600000;

  // Collect distinct offsets from nearby probes
  const probePoints = [
    new Date(naiveAsUtc - ONE_HOUR),
    new Date(naiveAsUtc),
    new Date(naiveAsUtc + ONE_HOUR),
  ];

  const offsets = new Set<number>();
  for (const probe of probePoints) {
    offsets.add(getTimezoneOffsetMinutes(probe, timezone));
  }

  // For each distinct offset, compute the candidate UTC and check round-trip
  const validCandidates: Array<{ utcMs: number; offset: number }> = [];

  for (const candidateOffset of offsets) {
    const candidateUtcMs = naiveAsUtc - candidateOffset * 60000;
    const candidateUtcDate = new Date(candidateUtcMs);

    // Round-trip: convert candidate UTC back to local time
    const rtOffset = getTimezoneOffsetMinutes(candidateUtcDate, timezone);
    const rtMs = candidateUtcDate.getTime() + rtOffset * 60000;
    const rt = new Date(rtMs);

    if (
      rt.getUTCFullYear() === year &&
      rt.getUTCMonth() === month &&
      rt.getUTCDate() === day &&
      rt.getUTCHours() === hour &&
      rt.getUTCMinutes() === minute
    ) {
      // This offset produces a valid round-trip
      validCandidates.push({ utcMs: candidateUtcMs, offset: candidateOffset });
    }
  }

  if (validCandidates.length === 0) {
    // No offset produces a valid round-trip → spring-forward gap
    return {
      success: false,
      error: `The time ${naiveDatetime} does not exist in timezone ${timezone} (DST spring-forward gap)`,
    };
  }

  if (validCandidates.length === 1) {
    // Unambiguous — exactly one valid interpretation
    return { success: true, utcIso: new Date(validCandidates[0].utcMs).toISOString() };
  }

  // Multiple valid candidates → fall-back ambiguity.
  // Policy: pick the EARLIER UTC instant (= smaller utcMs = larger offset).
  // "Earlier offset" means the first occurrence of the repeated local time,
  // which is the DST (summer) side before clocks fall back.
  validCandidates.sort((a, b) => a.utcMs - b.utcMs);
  return { success: true, utcIso: new Date(validCandidates[0].utcMs).toISOString() };
}

/**
 * Shared conversion for route handlers. Converts a start_at and/or end_at
 * naive datetime pair through naiveToUtc using the given timezone.
 *
 * Both create and update routes call this EXACT same function to ensure
 * identical conversion semantics.
 *
 * @returns Resolved start/end values, or an error string prefixed with the field name.
 */
export function convertDatetimePair(
  startAt: string | null | undefined,
  endAt: string | null | undefined,
  timezone: string,
): { success: true; resolvedStartAt: string | null; resolvedEndAt: string | null }
  | { success: false; error: string } {

  let resolvedStartAt: string | null = startAt || null;
  let resolvedEndAt: string | null = endAt || null;

  if (startAt && timezone !== 'UTC') {
    const result = naiveToUtc(startAt, timezone);
    if (!result.success) {
      return { success: false, error: `start_at: ${result.error}` };
    }
    resolvedStartAt = result.utcIso;
  }

  if (endAt && timezone !== 'UTC') {
    const result = naiveToUtc(endAt, timezone);
    if (!result.success) {
      return { success: false, error: `end_at: ${result.error}` };
    }
    resolvedEndAt = result.utcIso;
  }

  return { success: true, resolvedStartAt, resolvedEndAt };
}
