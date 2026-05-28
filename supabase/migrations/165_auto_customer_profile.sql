-- Auto-increment customer visit/spend counters atomically
CREATE OR REPLACE FUNCTION increment_customer_visit(
  p_business_id uuid,
  p_phone text,
  p_amount numeric DEFAULT 0
)
RETURNS void AS $$
BEGIN
  UPDATE customer_profiles
  SET total_visits = total_visits + 1,
      total_bookings = total_bookings + 1,
      total_spent = total_spent + p_amount,
      last_seen_at = NOW()
  WHERE business_id = p_business_id AND phone = p_phone;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Ensure unique constraint for upsert
CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_profiles_biz_phone
  ON customer_profiles (business_id, phone);
