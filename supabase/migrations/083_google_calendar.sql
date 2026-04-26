-- Google Calendar integration for businesses
ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS google_calendar_token TEXT,
  ADD COLUMN IF NOT EXISTS google_calendar_refresh_token TEXT,
  ADD COLUMN IF NOT EXISTS google_calendar_id VARCHAR(255),
  ADD COLUMN IF NOT EXISTS google_place_id VARCHAR(255);

COMMENT ON COLUMN public.businesses.google_calendar_token IS 'Google OAuth access token for Calendar API';
COMMENT ON COLUMN public.businesses.google_calendar_refresh_token IS 'Google OAuth refresh token (long-lived)';
COMMENT ON COLUMN public.businesses.google_calendar_id IS 'Google Calendar ID to sync bookings to (default: primary)';
COMMENT ON COLUMN public.businesses.google_place_id IS 'Google Business Profile Place ID for review management';
