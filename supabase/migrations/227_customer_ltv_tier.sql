-- Add LTV tier column to customer_profiles
ALTER TABLE customer_profiles
  ADD COLUMN IF NOT EXISTS ltv_tier VARCHAR(20) DEFAULT 'new';

-- Index for filtering by LTV tier
CREATE INDEX IF NOT EXISTS idx_customer_profiles_ltv_tier
  ON customer_profiles(business_id, ltv_tier);
