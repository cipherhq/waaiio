-- Add Square OAuth columns to payout_accounts
ALTER TABLE public.payout_accounts
  ADD COLUMN IF NOT EXISTS square_merchant_id VARCHAR(100),
  ADD COLUMN IF NOT EXISTS square_access_token TEXT;

-- Allow 'square' as a gateway value (already VARCHAR, just documenting)
COMMENT ON COLUMN public.payout_accounts.square_merchant_id IS 'Square seller/merchant ID from OAuth';
COMMENT ON COLUMN public.payout_accounts.square_access_token IS 'Square OAuth access token for the connected seller';
