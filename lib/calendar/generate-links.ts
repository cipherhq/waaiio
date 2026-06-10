/**
 * Calendar link generation for booking confirmations.
 * Generates Google Calendar URLs and .ics file content from booking data.
 */

export interface CalendarEvent {
  title: string;        // e.g., "Haircut at Fresh Cuts"
  description: string;  // e.g., "Ref: WA-BK-1234"
  location: string;     // business address
  startDate: string;    // ISO date (YYYY-MM-DD)
  startTime: string;    // HH:mm (24hr)
  durationMinutes: number;
}

/**
 * Format date+time into Google/ICS format: YYYYMMDDTHHmmssZ
 * Treats input as UTC to avoid timezone ambiguity in calendar links.
 */
function formatDateTime(date: string, time: string): string {
  const [year, month, day] = date.split('-');
  const [hour, minute] = time.split(':');
  return `${year}${month}${day}T${hour}${minute}00Z`;
}

/**
 * Add minutes to a formatted datetime string (YYYYMMDDTHHmmssZ).
 */
function addMinutesToFormatted(formatted: string, minutes: number): string {
  // Parse the formatted string back to a Date
  const year = parseInt(formatted.slice(0, 4), 10);
  const month = parseInt(formatted.slice(4, 6), 10) - 1;
  const day = parseInt(formatted.slice(6, 8), 10);
  const hour = parseInt(formatted.slice(9, 11), 10);
  const min = parseInt(formatted.slice(11, 13), 10);

  const d = new Date(Date.UTC(year, month, day, hour, min));
  d.setUTCMinutes(d.getUTCMinutes() + minutes);

  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dy = String(d.getUTCDate()).padStart(2, '0');
  const h = String(d.getUTCHours()).padStart(2, '0');
  const m = String(d.getUTCMinutes()).padStart(2, '0');
  return `${y}${mo}${dy}T${h}${m}00Z`;
}

/**
 * Generate a Google Calendar URL for an event.
 * Short enough for WhatsApp messages.
 */
export function generateGoogleCalendarUrl(event: CalendarEvent): string {
  const start = formatDateTime(event.startDate, event.startTime);
  const end = addMinutesToFormatted(start, event.durationMinutes);

  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: event.title,
    dates: `${start}/${end}`,
    details: event.description,
    location: event.location,
  });

  return `https://calendar.google.com/calendar/event?${params.toString()}`;
}

/**
 * Generate .ics file content for an event.
 * Standard iCalendar format compatible with Apple Calendar, Outlook, etc.
 */
export function generateIcsContent(event: CalendarEvent): string {
  const start = formatDateTime(event.startDate, event.startTime);
  const end = addMinutesToFormatted(start, event.durationMinutes);
  const now = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

  // Escape special characters per RFC 5545
  const escapeIcs = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');

  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Waaiio//Booking//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `DTSTART:${start}`,
    `DTEND:${end}`,
    `DTSTAMP:${now}`,
    `UID:${crypto.randomUUID()}@waaiio.com`,
    `SUMMARY:${escapeIcs(event.title)}`,
    `DESCRIPTION:${escapeIcs(event.description)}`,
    `LOCATION:${escapeIcs(event.location)}`,
    'STATUS:CONFIRMED',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
}

/**
 * Build a CalendarEvent from booking data.
 * Returns null if the booking doesn't have a specific date+time (e.g. drop-off, orders).
 */
export function buildCalendarEvent(opts: {
  businessName: string;
  businessAddress?: string;
  serviceName?: string;
  referenceCode: string;
  date: string;         // YYYY-MM-DD
  time: string;         // HH:mm
  durationMinutes?: number;
}): CalendarEvent | null {
  if (!opts.date || !opts.time) return null;

  // Validate date format
  if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.date)) return null;
  // Validate time format
  if (!/^\d{1,2}:\d{2}/.test(opts.time)) return null;

  const title = opts.serviceName
    ? `${opts.serviceName} at ${opts.businessName}`
    : `Appointment at ${opts.businessName}`;

  return {
    title,
    description: `Ref: ${opts.referenceCode}\nBooked via Waaiio`,
    location: opts.businessAddress || opts.businessName,
    startDate: opts.date,
    startTime: opts.time.slice(0, 5), // Ensure HH:mm
    durationMinutes: opts.durationMinutes || 60,
  };
}

/**
 * Generate short calendar link text for WhatsApp messages.
 * Returns empty string if no date/time available.
 */
export function getCalendarLinksText(opts: {
  businessName: string;
  businessAddress?: string;
  serviceName?: string;
  referenceCode: string;
  date: string;
  time: string;
  durationMinutes?: number;
}): string {
  const event = buildCalendarEvent(opts);
  if (!event) return '';

  const shortUrl = `https://www.waaiio.com/cal/${encodeURIComponent(opts.referenceCode)}`;

  return `\n\n📅 Add to calendar: ${shortUrl}`;
}
