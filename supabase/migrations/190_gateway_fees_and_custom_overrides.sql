-- Migration 190: Gateway fee tracking and per-business custom platform fee overrides
--
-- 1. Track actual gateway processing fee on platform_fees table
-- 2. Add per-business custom fee override columns on businesses table
-- 3. Track gateway processing fee on payments table (populated by webhooks)

-- Add gateway_fee to platform_fees (tracks actual gateway processing fee per payment)
ALTER TABLE platform_fees ADD COLUMN IF NOT EXISTS gateway_fee INTEGER NOT NULL DEFAULT 0;
ALTER TABLE platform_fees ADD CONSTRAINT chk_platform_fees_gateway_fee_nonneg CHECK (gateway_fee >= 0);

-- Add per-business custom fee override columns
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS custom_fee_percentage DECIMAL(5,2);
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS custom_fee_flat INTEGER;

-- Add gateway_fee to payments table (populated by webhook handlers)
ALTER TABLE payments ADD COLUMN IF NOT EXISTS gateway_fee INTEGER NOT NULL DEFAULT 0;
