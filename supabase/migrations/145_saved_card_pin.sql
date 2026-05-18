-- Add PIN hash and attempt tracking for saved card security
ALTER TABLE saved_payment_methods ADD COLUMN IF NOT EXISTS pin_hash TEXT;
ALTER TABLE saved_payment_methods ADD COLUMN IF NOT EXISTS pin_attempts INT NOT NULL DEFAULT 0;
ALTER TABLE saved_payment_methods ADD COLUMN IF NOT EXISTS pin_locked_until TIMESTAMPTZ;
