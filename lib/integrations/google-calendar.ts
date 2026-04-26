import { logger } from '@/lib/logger';

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CALENDAR_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CALENDAR_CLIENT_SECRET || '';

interface CalendarEvent {
  summary: string;
  description?: string;
  location?: string;
  start: { dateTime: string; timeZone?: string };
  end: { dateTime: string; timeZone?: string };
}

/**
 * Exchange authorization code for tokens
 */
export async function exchangeGoogleCode(code: string, redirectUri: string): Promise<{
  access_token: string;
  refresh_token: string;
  expires_in: number;
} | null> {
  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });
    const data = await res.json();
    if (data.error) {
      logger.error('[GCAL] Token exchange failed:', data.error);
      return null;
    }
    return data;
  } catch (err) {
    logger.error('[GCAL] Token exchange error:', err);
    return null;
  }
}

/**
 * Refresh an expired access token
 */
export async function refreshGoogleToken(refreshToken: string): Promise<string | null> {
  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        refresh_token: refreshToken,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        grant_type: 'refresh_token',
      }),
    });
    const data = await res.json();
    return data.access_token || null;
  } catch {
    return null;
  }
}

/**
 * Create a Google Calendar event for a booking
 */
export async function createCalendarEvent(
  accessToken: string,
  calendarId: string,
  event: CalendarEvent,
): Promise<string | null> {
  try {
    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(event),
      },
    );
    const data = await res.json();
    if (data.error) {
      logger.error('[GCAL] Create event failed:', data.error.message);
      return null;
    }
    return data.id;
  } catch (err) {
    logger.error('[GCAL] Create event error:', err);
    return null;
  }
}

/**
 * Update an existing Google Calendar event
 */
export async function updateCalendarEvent(
  accessToken: string,
  calendarId: string,
  eventId: string,
  event: Partial<CalendarEvent>,
): Promise<boolean> {
  try {
    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(event),
      },
    );
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Delete a Google Calendar event
 */
export async function deleteCalendarEvent(
  accessToken: string,
  calendarId: string,
  eventId: string,
): Promise<boolean> {
  try {
    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    );
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Sync a booking to Google Calendar (create or update)
 */
export async function syncBookingToCalendar(
  supabase: any,
  businessId: string,
  booking: {
    id: string;
    service_name: string;
    customer_name: string;
    customer_phone: string;
    booking_date: string;
    booking_time: string;
    duration_minutes?: number;
    reference_code: string;
    google_calendar_event_id?: string;
  },
): Promise<void> {
  try {
    const { data: business } = await supabase
      .from('businesses')
      .select('google_calendar_token, google_calendar_refresh_token, google_calendar_id, name, address')
      .eq('id', businessId)
      .single();

    if (!business?.google_calendar_refresh_token) return;

    // Get fresh access token
    let accessToken = business.google_calendar_token;
    const freshToken = await refreshGoogleToken(business.google_calendar_refresh_token);
    if (freshToken) {
      accessToken = freshToken;
      await supabase.from('businesses')
        .update({ google_calendar_token: freshToken })
        .eq('id', businessId);
    }

    if (!accessToken) return;

    const calendarId = business.google_calendar_id || 'primary';
    const startDateTime = `${booking.booking_date}T${booking.booking_time}:00`;
    const duration = booking.duration_minutes || 60;
    const endDate = new Date(new Date(startDateTime).getTime() + duration * 60 * 1000);

    const event = {
      summary: `${booking.service_name} — ${booking.customer_name}`,
      description: `Customer: ${booking.customer_name}\nPhone: ${booking.customer_phone}\nRef: ${booking.reference_code}\n\nBooked via Waaiio`,
      location: business.address || undefined,
      start: { dateTime: new Date(startDateTime).toISOString() },
      end: { dateTime: endDate.toISOString() },
    };

    if (booking.google_calendar_event_id) {
      await updateCalendarEvent(accessToken, calendarId, booking.google_calendar_event_id, event);
    } else {
      const eventId = await createCalendarEvent(accessToken, calendarId, event);
      if (eventId) {
        await supabase.from('bookings')
          .update({ google_calendar_event_id: eventId })
          .eq('id', booking.id);
      }
    }
  } catch (err) {
    logger.error('[GCAL] Sync error:', err);
  }
}
