-- M443: Dedicated Flutterwave webhook secret hash for BYO integrations
--
-- Flutterwave BYO webhooks must verify the verif-hash header against a
-- per-business webhook secret configured in the Flutterwave dashboard,
-- NOT the API secret key. This column stores the encrypted value.

ALTER TABLE public.business_payment_credentials
ADD COLUMN IF NOT EXISTS webhook_secret_hash TEXT;

-- Verify column exists
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'business_payment_credentials'
      AND column_name = 'webhook_secret_hash'
  ) THEN
    RAISE EXCEPTION 'M443: webhook_secret_hash column missing after ALTER';
  END IF;
END $$;
