-- Backfill customer_profiles from existing payment bookings
-- This covers payments made before the bot started auto-creating customer profiles

INSERT INTO customer_profiles (business_id, phone, name, total_visits, total_spent, first_seen_at, last_seen_at)
SELECT
  agg.business_id,
  agg.guest_phone,
  agg.guest_name,
  agg.visit_count,
  agg.spent,
  agg.first_at,
  agg.last_at
FROM (
  SELECT
    b.business_id,
    b.guest_phone,
    MAX(b.guest_name) AS guest_name,
    COUNT(*)::integer AS visit_count,
    COALESCE(SUM(b.total_amount), 0) AS spent,
    MIN(b.created_at) AS first_at,
    MAX(b.created_at) AS last_at
  FROM bookings b
  WHERE b.flow_type = 'payment'
    AND b.guest_phone IS NOT NULL
    AND b.guest_phone != ''
  GROUP BY b.business_id, b.guest_phone
) agg
ON CONFLICT (business_id, phone) DO UPDATE SET
  name = COALESCE(EXCLUDED.name, customer_profiles.name),
  total_visits = customer_profiles.total_visits + EXCLUDED.total_visits,
  total_spent = customer_profiles.total_spent + EXCLUDED.total_spent,
  last_seen_at = GREATEST(customer_profiles.last_seen_at, EXCLUDED.last_seen_at);
