-- ══ Group Bookings + Waitlist Conversion ══

-- 1. Add guest_list JSONB to bookings for multi-person bookings
-- Format: [{"name": "John", "email": "john@...", "phone": "+1..."}, ...]
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS guest_list JSONB DEFAULT '[]';

-- 2. Add booking_id FK to waitlist_entries for conversion tracking
ALTER TABLE waitlist_entries ADD COLUMN IF NOT EXISTS booking_id UUID REFERENCES bookings(id) ON DELETE SET NULL;
ALTER TABLE waitlist_entries ADD COLUMN IF NOT EXISTS converted_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_waitlist_entries_booking_id ON waitlist_entries(booking_id);
