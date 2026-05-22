-- Prevent double-sending of payment confirmations.
-- The first path (webhook, "I've Paid", payment-success page) to set this wins.
ALTER TABLE payments ADD COLUMN IF NOT EXISTS confirmation_sent_at TIMESTAMPTZ;
