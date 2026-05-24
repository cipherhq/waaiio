-- Clean up duplicate subscriptions: keep only the most recent per business
DELETE FROM subscriptions
WHERE id NOT IN (
  SELECT DISTINCT ON (business_id) id
  FROM subscriptions
  ORDER BY business_id, created_at DESC
);

-- One subscription per business
CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_business_unique
  ON subscriptions (business_id);
