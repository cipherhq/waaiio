-- Add check-in, check-out, and no-show tracking to bookings
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS checked_in_at timestamptz;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS checked_in_by uuid REFERENCES profiles(id);
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS check_in_notes text;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS checked_out_at timestamptz;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS checkout_notes text;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS no_show_at timestamptz;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS no_show_reason text;

-- Track no-show count on customer profiles for repeat offender detection
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS no_show_count int NOT NULL DEFAULT 0;

-- Index for quick lookup of checked-in bookings (for live queue/dashboard views)
CREATE INDEX IF NOT EXISTS idx_bookings_checked_in ON bookings(business_id, checked_in_at)
  WHERE checked_in_at IS NOT NULL AND checked_out_at IS NULL;
