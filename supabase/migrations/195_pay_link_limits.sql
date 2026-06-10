-- Add expiry and max uses to payment links
ALTER TABLE payment_links ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE payment_links ADD COLUMN IF NOT EXISTS max_uses INTEGER;
