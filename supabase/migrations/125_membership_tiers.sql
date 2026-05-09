-- Membership tier definitions per business
CREATE TABLE IF NOT EXISTS membership_tiers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name VARCHAR(50) NOT NULL,
  min_spend NUMERIC NOT NULL DEFAULT 0,
  discount_percent NUMERIC NOT NULL DEFAULT 0,
  points_multiplier NUMERIC NOT NULL DEFAULT 1,
  benefits TEXT,
  color VARCHAR(20) DEFAULT '#6B7280',
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Add tier reference to customer_profiles
ALTER TABLE customer_profiles
  ADD COLUMN IF NOT EXISTS membership_tier_id UUID REFERENCES membership_tiers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS tier_earned_at TIMESTAMPTZ;

-- RLS
ALTER TABLE membership_tiers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Business owners manage tiers" ON membership_tiers
  FOR ALL USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));

-- Indexes
CREATE INDEX IF NOT EXISTS idx_membership_tiers_business ON membership_tiers(business_id) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_customer_profiles_tier ON customer_profiles(membership_tier_id) WHERE membership_tier_id IS NOT NULL;
