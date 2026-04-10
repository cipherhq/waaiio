-- ═══════════════════════════════════════════════════════
-- Migration 031: Automation Enhancements
-- Adds fields needed for abandoned cart reminders, birthday campaigns,
-- auto-cancel tracking, no-show reschedule prompts, waitlist expiry
-- ═══════════════════════════════════════════════════════

-- 1. Track abandoned cart reminder on bot_sessions
ALTER TABLE bot_sessions ADD COLUMN IF NOT EXISTS cart_reminder_sent BOOLEAN DEFAULT false;

-- 2. Add date_of_birth to customer_profiles for birthday campaigns
ALTER TABLE customer_profiles ADD COLUMN IF NOT EXISTS date_of_birth DATE;
ALTER TABLE customer_profiles ADD COLUMN IF NOT EXISTS birthday_wished_year INTEGER;

CREATE INDEX IF NOT EXISTS idx_customer_profiles_dob
  ON customer_profiles (date_of_birth) WHERE date_of_birth IS NOT NULL;

-- 3. Track reschedule prompt on bookings (no-show)
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS reschedule_prompted BOOLEAN DEFAULT false;

-- 4. Track consecutive failures for auto-cancel on customer_subscriptions
-- (failure_count already exists, add max threshold tracking)
ALTER TABLE customer_subscriptions ADD COLUMN IF NOT EXISTS auto_cancel_notified BOOLEAN DEFAULT false;

-- 5. Waitlist expiry — add expires_at to waitlist_entries
ALTER TABLE waitlist_entries ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE waitlist_entries ADD COLUMN IF NOT EXISTS expiry_notified BOOLEAN DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_waitlist_entries_expires
  ON waitlist_entries (expires_at, status) WHERE status = 'waiting';

-- 6. Low stock alert tracking on products
ALTER TABLE products ADD COLUMN IF NOT EXISTS low_stock_alerted BOOLEAN DEFAULT false;
ALTER TABLE products ADD COLUMN IF NOT EXISTS low_stock_threshold INTEGER DEFAULT 5;

-- 7. Re-engagement tracking on customer_profiles
ALTER TABLE customer_profiles ADD COLUMN IF NOT EXISTS reengagement_sent_at TIMESTAMPTZ;

-- 8. RPC function to reset low_stock_alerted when stock is restocked above threshold
CREATE OR REPLACE FUNCTION reset_low_stock_alerts()
RETURNS void AS $$
BEGIN
  UPDATE products
  SET low_stock_alerted = false
  WHERE low_stock_alerted = true
    AND stock_quantity IS NOT NULL
    AND stock_quantity > low_stock_threshold
    AND deleted_at IS NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
