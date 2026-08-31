/**
 * Timezone conversion utilities for promo campaign datetime handling.
 *
 * Handles three input categories:
 * 1. Naive datetime-local (e.g., "2024-10-30T23:59") + IANA timezone → interpret & convert to UTC
 * 2. Already-zoned ISO 8601 (e.g., "2024-10-30T22:59:00Z" or "+05:30") → preserve absolute instant
 * 3. Malformed → reject
 *
 * Uses Node's built-in Intl.DateTimeFormat — no external dependencies.
 */

/** Regex for ISO 8601 with timezone offset (Z or ±HH:MM) at end of string */
const ZONED_ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?([+-]\d{2}:\d{2}|Z)$/;

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
 * Parse an already-zoned ISO 8601 timestamp into a UTC ISO string.
 * Accepts formats like "2024-10-30T22:59:00Z" or "2024-10-30T22:59:00+05:30".
 * Does NOT re-interpret through campaign timezone — preserves the absolute instant.
 *
 * @returns TimezoneConversionResult with the UTC instant, or error if malformed
 */
export function parseZonedTimestamp(
  input: string,
): TimezoneConversionResult | TimezoneConversionError {
  const parsed = new Date(input);
  if (isNaN(parsed.getTime())) {
    return {
      success: false,
      error: `Malformed zoned timestamp: "${input}". Could not parse as valid date.`,
    };
  }
  return { success: true, utcIso: parsed.toISOString() };
}

/**
 * Convert a datetime string to a UTC ISO string. Handles both naive and zoned inputs:
 *
 * - Naive ("2024-10-30T23:59") → interpret in the given IANA timezone → convert to UTC
 * - Zoned ("2024-10-30T22:59:00Z", "2024-10-30T22:59:00+05:30") → parse as absolute instant,
 *   preserve/normalize to UTC, do NOT double-shift through campaign timezone
 * - Malformed → reject
 *
 * @param datetime - A datetime string (naive or zoned)
 * @param timezone - An IANA timezone like "Africa/Lagos" (used only for naive inputs)
 * @returns UTC ISO string or error
 *
 * DST handling (naive inputs only):
 * - Spring-forward gap (nonexistent local time): rejected with error
 * - Fall-back ambiguity (two valid UTC instants): picks EARLIER UTC (= larger offset,
 *   i.e., pre-transition / DST offset). This is the conservative choice —
 *   campaigns end sooner, promotions start earlier.
 *
 * Ambiguity detection uses wide probing (±24 hours from the naive-as-UTC reference)
 * to catch transitions of ANY size — including ±30min (Australia/Lord_Howe),
 * ±45min (Pacific/Chatham), and standard ±60min DST.
 */
export function naiveToUtc(
  datetime: string,
  timezone: string,
): TimezoneConversionResult | TimezoneConversionError {
  if (!isValidTimezone(timezone)) {
    return { success: false, error: `Invalid timezone: ${timezone}` };
  }

  // ── BLOCKER 2: Already-zoned timestamps → preserve as absolute instant ──
  // If the input matches ISO 8601 with Z or ±HH:MM suffix, parse it directly.
  // Do NOT re-interpret through the campaign timezone — that would double-shift.
  if (ZONED_ISO_RE.test(datetime)) {
    return parseZonedTimestamp(datetime);
  }

  // ── Naive datetime: strict format validation ──
  const match = datetime.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) {
    return { success: false, error: `Invalid datetime format: ${datetime}. Expected YYYY-MM-DDTHH:mm or YYYY-MM-DDTHH:mm:ss` };
  }

  const [, yearStr, monthStr, dayStr, hourStr, minuteStr, secondStr] = match;
  const year = parseInt(yearStr, 10);
  const monthRaw = parseInt(monthStr, 10); // 1-based
  const day = parseInt(dayStr, 10);
  const hour = parseInt(hourStr, 10);
  const minute = parseInt(minuteStr, 10);
  const second = secondStr ? parseInt(secondStr, 10) : 0;

  // ── Strict calendar validation ──
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

  // ── BLOCKER 1: Detect ambiguity by probing a wide range of candidate offsets ──
  // Probe at multiple points spanning ±24 hours from the naive-as-UTC reference.
  // This catches transitions of ANY size — not just ±60min.
  // Australia/Lord_Howe has ±30min DST. Pacific/Chatham has ±45min.
  // By probing at 30-minute intervals across ±24h, we discover every distinct
  // offset the timezone uses in the vicinity of this local time.

  const naiveAsUtc = Date.UTC(year, month, day, hour, minute, second);
  const THIRTY_MIN = 1800000;

  // Collect distinct offsets from probes spanning ±24h at 30-min intervals
  const offsets = new Set<number>();
  for (let delta = -48; delta <= 48; delta++) {
    const probeMs = naiveAsUtc + delta * THIRTY_MIN;
    offsets.add(getTimezoneOffsetMinutes(new Date(probeMs), timezone));
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
      error: `The time ${datetime} does not exist in timezone ${timezone} (DST spring-forward gap)`,
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
 * datetime pair through naiveToUtc using the given timezone.
 *
 * Both create and update routes call this EXACT same function to ensure
 * identical conversion semantics.
 *
 * Handles both naive and zoned inputs — zoned inputs are preserved as-is,
 * naive inputs are interpreted in the given timezone.
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
