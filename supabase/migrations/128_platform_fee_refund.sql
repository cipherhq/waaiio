-- Add refunded_at column to platform_fees for tracking reversed fees
ALTER TABLE platform_fees ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMPTZ;

-- Add campaign_id column to platform_fees for donation fee tracking
ALTER TABLE platform_fees ADD COLUMN IF NOT EXISTS campaign_id UUID REFERENCES campaigns(id) ON DELETE SET NULL;

-- Partial index for efficient queries on non-refunded fees
CREATE INDEX IF NOT EXISTS idx_platform_fees_not_refunded ON platform_fees(business_id) WHERE refunded_at IS NULL;
