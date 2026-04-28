-- Add manual bank details for businesses without gateway accounts
-- Used for US/UK/CA businesses that don't connect Stripe
ALTER TABLE public.payout_accounts
  ADD COLUMN IF NOT EXISTS routing_number VARCHAR(20),
  ADD COLUMN IF NOT EXISTS iban VARCHAR(40),
  ADD COLUMN IF NOT EXISTS swift_code VARCHAR(15),
  ADD COLUMN IF NOT EXISTS country_code VARCHAR(2);

-- Add transfer reference to business_payouts for manual transfers
ALTER TABLE public.business_payouts
  ADD COLUMN IF NOT EXISTS transfer_reference TEXT,
  ADD COLUMN IF NOT EXISTS transfer_notes TEXT,
  ADD COLUMN IF NOT EXISTS auto_generated BOOLEAN DEFAULT false;

COMMENT ON COLUMN public.payout_accounts.routing_number IS 'US/CA bank routing number (for manual transfers)';
COMMENT ON COLUMN public.payout_accounts.iban IS 'UK/EU IBAN (for manual transfers)';
COMMENT ON COLUMN public.payout_accounts.swift_code IS 'SWIFT/BIC code for international transfers';
COMMENT ON COLUMN public.business_payouts.transfer_reference IS 'Bank transfer reference number (for manual payouts)';
