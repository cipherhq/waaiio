-- Payment channel configuration per business
-- Allows businesses to choose which payment methods their customers can use
-- Default: all channels enabled (null = all)
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS payment_channels JSONB;
-- payment_channels: ["card", "bank_transfer", "ussd", "qr", "mobile_money"]
-- null = all channels (backward compatible)

-- Index for non-null channel configs
CREATE INDEX IF NOT EXISTS idx_businesses_payment_channels
  ON businesses USING gin (payment_channels) WHERE payment_channels IS NOT NULL;
