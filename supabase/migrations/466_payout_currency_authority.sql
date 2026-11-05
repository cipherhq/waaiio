-- ══════════════════════════════════════════════════════════
-- 466: Payout Currency Authority
--
-- Adds authoritative currency to business_payouts and payout_adjustments.
-- All three monetary inputs to payout calculations become currency-scoped:
--   1. platform_fees (via payments.currency) — already has currency
--   2. payout_adjustments.currency — NEW
--   3. business_payouts.currency — NEW
--
-- Legacy rows retain NULL currency. New payouts and adjustments must
-- provide currency (enforced in application code). The approval route
-- rejects any payout where currency IS NULL, making legacy ambiguous
-- payouts permanently unapprovable without manual reconciliation.
--
-- Stripe transfer uses payout.currency instead of business country.
-- Paystack transfer does not send currency (provider infers from account).
-- ══════════════════════════════════════════════════════════

-- Step 1: Add currency to business_payouts
ALTER TABLE business_payouts
  ADD COLUMN IF NOT EXISTS currency VARCHAR(3);

-- Step 2: Add currency to payout_adjustments
ALTER TABLE payout_adjustments
  ADD COLUMN IF NOT EXISTS currency VARCHAR(3);

-- Step 3: Verification
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'business_payouts' AND column_name = 'currency'
  ) THEN
    RAISE EXCEPTION 'M466: business_payouts.currency column missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'payout_adjustments' AND column_name = 'currency'
  ) THEN
    RAISE EXCEPTION 'M466: payout_adjustments.currency column missing';
  END IF;

  RAISE NOTICE 'M466: Payout currency authority columns added';
END $$;
