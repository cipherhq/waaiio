-- Prevent duplicate platform fee recording (webhook + "I've Paid" + payment-success race)
-- Use partial unique indexes so only one fee per entity (excluding refunded fees)
CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_fees_booking_unique
  ON platform_fees (booking_id)
  WHERE booking_id IS NOT NULL AND refunded_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_fees_invoice_unique
  ON platform_fees (invoice_id)
  WHERE invoice_id IS NOT NULL AND refunded_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_fees_campaign_unique
  ON platform_fees (campaign_id)
  WHERE campaign_id IS NOT NULL AND refunded_at IS NULL;

-- Atomic campaign donation increment (prevents double-counting under race)
CREATE OR REPLACE FUNCTION increment_campaign_donation(
  p_campaign_id uuid,
  p_amount numeric,
  p_donor_count integer DEFAULT 1
)
RETURNS void AS $$
BEGIN
  UPDATE campaigns
  SET raised_amount = raised_amount + p_amount,
      donor_count = donor_count + p_donor_count
  WHERE id = p_campaign_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
