-- Add campaign_id to pending_transfers for crowdfunding bank transfers
ALTER TABLE pending_transfers ADD COLUMN IF NOT EXISTS campaign_id UUID REFERENCES campaigns(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_pending_transfers_campaign_id ON pending_transfers (campaign_id) WHERE campaign_id IS NOT NULL;
