/**
 * Business hours helper — checks if the current time falls within
 * a business's configured operating window for the current day.
 */

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;

interface DaySchedule {
  open: string | null;
  close: string | null;
  enabled: boolean;
}

export interface BusinessHours {
  monday?: DaySchedule;
  tuesday?: DaySchedule;
  wednesday?: DaySchedule;
  thursday?: DaySchedule;
  friday?: DaySchedule;
  saturday?: DaySchedule;
  sunday?: DaySchedule;
  timezone?: string;
  [key: string]: DaySchedule | string | undefined;
}

/**
 * Returns true if the current time is within the business's operating hours
 * for the current day-of-week in the business's timezone.
 */
export function isWithinBusinessHours(hours: BusinessHours, timezone?: string): boolean {
  const tz = timezone || hours.timezone || 'UTC';

  let now: Date;
  try {
    // Build a date in the business's timezone
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      weekday: 'long',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const parts = formatter.formatToParts(new Date());
    const weekday = parts.find(p => p.type === 'weekday')?.value?.toLowerCase() || '';
    const hourStr = parts.find(p => p.type === 'hour')?.value || '0';
    const minuteStr = parts.find(p => p.type === 'minute')?.value || '0';
    const currentHour = parseInt(hourStr, 10);
    const currentMinute = parseInt(minuteStr, 10);

    const daySchedule = hours[weekday] as DaySchedule | undefined;

    // If no schedule for this day or day is disabled, business is closed
    if (!daySchedule || !daySchedule.enabled) return false;

    // If no open/close times, treat as closed
    if (!daySchedule.open || !daySchedule.close) return false;

    const [openH, openM] = daySchedule.open.split(':').map(Number);
    const [closeH, closeM] = daySchedule.close.split(':').map(Number);

    const currentMinutes = currentHour * 60 + currentMinute;
    const openMinutes = openH * 60 + openM;
    const closeMinutes = closeH * 60 + closeM;

    return currentMinutes >= openMinutes && currentMinutes < closeMinutes;
  } catch {
    // If timezone is invalid or anything else goes wrong, default to "open"
    // so the bot doesn't accidentally block all messages
    return true;
  }
}
