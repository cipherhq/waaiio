-- Track individual campaign donations
CREATE TABLE IF NOT EXISTS campaign_donations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  payment_id UUID REFERENCES payments(id) ON DELETE SET NULL,
  donor_phone TEXT NOT NULL,
  donor_name TEXT,
  amount INTEGER NOT NULL,
  currency VARCHAR(3) DEFAULT 'NGN',
  status VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending, success, failed
  reference_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_campaign_donations_campaign ON campaign_donations(campaign_id);
CREATE INDEX IF NOT EXISTS idx_campaign_donations_business ON campaign_donations(business_id);

ALTER TABLE campaign_donations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "admin_all_campaign_donations" ON campaign_donations FOR ALL USING (
  EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
);
CREATE POLICY "owners_view_campaign_donations" ON campaign_donations FOR SELECT USING (
  business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid())
);

-- Add campaign_id to payments table for linking
ALTER TABLE payments ADD COLUMN IF NOT EXISTS campaign_id UUID REFERENCES campaigns(id) ON DELETE SET NULL;
