-- 184: Campaign soft delete — preserve donation/payment audit trail

-- Add deleted_at column for soft delete
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS deleted_by UUID;

-- Change campaign_donations FK from CASCADE to RESTRICT
-- This prevents hard deletion when donations exist
ALTER TABLE campaign_donations DROP CONSTRAINT IF EXISTS campaign_donations_campaign_id_fkey;
ALTER TABLE campaign_donations ADD CONSTRAINT campaign_donations_campaign_id_fkey
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE RESTRICT;

-- Index for filtering active campaigns
CREATE INDEX IF NOT EXISTS idx_campaigns_active ON campaigns(business_id) WHERE deleted_at IS NULL;
