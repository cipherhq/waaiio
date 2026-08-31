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
 * DST handling:
 * - Spring-forward gap (nonexistent local time): rejected with error
 * - Fall-back ambiguity: uses earlier offset (conservative — campaign ends sooner)
 */
export function naiveToUtc(
  naiveDatetime: string,
  timezone: string,
): TimezoneConversionResult | TimezoneConversionError {
  if (!isValidTimezone(timezone)) {
    return { success: false, error: `Invalid timezone: ${timezone}` };
  }

  // Parse the naive datetime components
  const match = naiveDatetime.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!match) {
    return { success: false, error: `Invalid datetime format: ${naiveDatetime}. Expected YYYY-MM-DDTHH:mm` };
  }

  const [, yearStr, monthStr, dayStr, hourStr, minuteStr, secondStr] = match;
  const year = parseInt(yearStr, 10);
  const month = parseInt(monthStr, 10) - 1; // JS months are 0-based
  const day = parseInt(dayStr, 10);
  const hour = parseInt(hourStr, 10);
  const minute = parseInt(minuteStr, 10);
  const second = secondStr ? parseInt(secondStr, 10) : 0;

  // Create a UTC date with the naive components, then adjust by offset
  const naiveAsUtc = Date.UTC(year, month, day, hour, minute, second);
  const tempDate = new Date(naiveAsUtc);

  // Get the offset at this approximate time
  const offset = getTimezoneOffsetMinutes(tempDate, timezone);

  // The actual UTC time = naive local - offset
  const utcMs = naiveAsUtc - offset * 60000;
  const utcDate = new Date(utcMs);

  // Verify round-trip: convert UTC back to local and check it matches the input.
  // This catches DST spring-forward gaps where the local time doesn't exist.
  const verifyOffset = getTimezoneOffsetMinutes(utcDate, timezone);
  const roundTripMs = utcDate.getTime() + verifyOffset * 60000;
  const roundTrip = new Date(roundTripMs);

  if (
    roundTrip.getUTCFullYear() !== year ||
    roundTrip.getUTCMonth() !== month ||
    roundTrip.getUTCDate() !== day ||
    roundTrip.getUTCHours() !== hour ||
    roundTrip.getUTCMinutes() !== minute
  ) {
    // DST fall-back ambiguity: the round-trip produces a different time because
    // there are two possible UTC instants for this local time. Use the earlier one.
    // Check if the offset changed (fall-back produces a larger offset for the second occurrence).
    if (verifyOffset !== offset) {
      // Fall-back: use the earlier offset (smaller offset = earlier UTC instant)
      const earlierOffset = Math.min(offset, verifyOffset);
      const earlierUtcMs = naiveAsUtc - earlierOffset * 60000;
      const earlierUtcDate = new Date(earlierUtcMs);

      // Verify the earlier interpretation round-trips correctly
      const earlyVerifyOffset = getTimezoneOffsetMinutes(earlierUtcDate, timezone);
      const earlyRoundTripMs = earlierUtcDate.getTime() + earlyVerifyOffset * 60000;
      const earlyRoundTrip = new Date(earlyRoundTripMs);

      if (
        earlyRoundTrip.getUTCFullYear() === year &&
        earlyRoundTrip.getUTCMonth() === month &&
        earlyRoundTrip.getUTCDate() === day &&
        earlyRoundTrip.getUTCHours() === hour &&
        earlyRoundTrip.getUTCMinutes() === minute
      ) {
        return { success: true, utcIso: earlierUtcDate.toISOString() };
      }
    }

    return {
      success: false,
      error: `The time ${naiveDatetime} does not exist in timezone ${timezone} (likely a DST spring-forward gap)`,
    };
  }

  return { success: true, utcIso: utcDate.toISOString() };
}
