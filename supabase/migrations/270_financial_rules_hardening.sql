-- ═══════════════════════════════════════════════════════
-- 270: Financial rules hardening
--   1. Overpayment tracking in apply_invoice_payment
--   2. Destination snapshot columns on business_payouts
--   3. Auto-hold trigger when payout account deactivated
-- ═══════════════════════════════════════════════════════

-- ── 1. Destination snapshot columns ──
ALTER TABLE public.business_payouts
  ADD COLUMN IF NOT EXISTS destination_bank_name VARCHAR(100),
  ADD COLUMN IF NOT EXISTS destination_account_number_masked VARCHAR(10),
  ADD COLUMN IF NOT EXISTS destination_bank_code VARCHAR(10),
  ADD COLUMN IF NOT EXISTS destination_account_name VARCHAR(200);
