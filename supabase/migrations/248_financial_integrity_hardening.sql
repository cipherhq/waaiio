-- ═══════════════════════════════════════════════════════
-- 248: Financial Integrity Hardening
-- ═══════════════════════════════════════════════════════
-- Fixes:
-- 1. Add payment_id to platform_fees with UNIQUE constraint for idempotency
-- 2. Create atomic payout RPC (payout + adjustment assignment in one TX)
-- 3. Create atomic invoice+items RPC
-- 4. Fix package session deduction: UNIQUE(booking_id), validate booking, search_path=''
-- 5. Document currency units on auto_approve_limits

-- ── 1. Add payment_id to platform_fees ──────────────────
DO $setup$ BEGIN
  ALTER TABLE public.platform_fees
    ADD COLUMN IF NOT EXISTS payment_id UUID REFERENCES public.payments(id) ON DELETE SET NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_fees_payment_unique
    ON public.platform_fees (payment_id)
    WHERE payment_id IS NOT NULL AND refunded_at IS NULL;
  COMMENT ON COLUMN public.platform_fees.payment_id IS 'The payment that generated this fee. Used for per-payment idempotency.';
  COMMENT ON COLUMN public.platform_fees.transaction_amount IS 'The actual amount collected from the customer (payment.amount), NOT the entity total.';

  -- Fix package_session_log constraint (drop constraint first — it owns the index)
  ALTER TABLE public.package_session_log DROP CONSTRAINT IF EXISTS package_session_log_enrollment_id_booking_id_key;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_package_session_log_booking_unique
    ON public.package_session_log (booking_id);

  -- Document auto_approve_limits currency units
  UPDATE public.platform_settings
  SET description = 'Max auto-approve payout amount per country in MAJOR currency units (e.g. NG: 500000 = ₦500,000, US: 1000 = $1,000). Payouts above this threshold require manual admin approval.'
  WHERE key = 'auto_approve_limits';
END $setup$;
-- Creates a payout and assigns adjustments in one transaction.
