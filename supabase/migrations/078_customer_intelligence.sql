-- Add customer intelligence fields to customer_profiles
ALTER TABLE customer_profiles
  ADD COLUMN IF NOT EXISTS lifetime_value NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS churn_risk INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS customer_segment TEXT DEFAULT 'new',
  ADD COLUMN IF NOT EXISTS intelligence_updated_at TIMESTAMPTZ;

-- Index for finding at-risk customers
CREATE INDEX IF NOT EXISTS idx_customer_profiles_churn ON customer_profiles(business_id, churn_risk DESC)
  WHERE churn_risk > 50;

-- Index for segment queries
CREATE INDEX IF NOT EXISTS idx_customer_profiles_segment ON customer_profiles(business_id, customer_segment);
