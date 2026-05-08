-- Self check-in toggle per event
-- When enabled, attendees can check in via QR code scan or WhatsApp message
-- Check-in is restricted to event day only (1hr buffer before start)
ALTER TABLE events ADD COLUMN IF NOT EXISTS self_checkin_enabled boolean NOT NULL DEFAULT false;
