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

  -- Fix package_session_log constraint
  DROP INDEX IF EXISTS public.package_session_log_enrollment_id_booking_id_key;
  ALTER TABLE public.package_session_log DROP CONSTRAINT IF EXISTS package_session_log_enrollment_id_booking_id_key;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_package_session_log_booking_unique
    ON public.package_session_log (booking_id);

  -- Document auto_approve_limits currency units
  UPDATE public.platform_settings
  SET description = 'Max auto-approve payout amount per country in MAJOR currency units (e.g. NG: 500000 = ₦500,000, US: 1000 = $1,000). Payouts above this threshold require manual admin approval.'
  WHERE key = 'auto_approve_limits';
END $setup$;
-- Creates a payout and assigns adjustments in one transaction.
-- Returns the payout ID or NULL on failure.
CREATE OR REPLACE FUNCTION public.create_payout_with_adjustments(
  p_business_id UUID,
  p_period_start DATE,
  p_period_end DATE,
  p_gross_amount NUMERIC(12,2),
  p_platform_fee NUMERIC(12,2),
  p_gateway_fee NUMERIC(12,2),
  p_net_amount NUMERIC(12,2),
  p_status TEXT,
  p_payout_account_id UUID,
  p_flags JSONB,
  p_adjustment_ids UUID[]
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_payout_id UUID;
BEGIN
  -- Insert payout
  INSERT INTO public.business_payouts (
    business_id, period_start, period_end,
    gross_amount, platform_fee, gateway_fee, net_amount,
    status, payout_account_id, flags, auto_generated
  ) VALUES (
    p_business_id, p_period_start, p_period_end,
    p_gross_amount, p_platform_fee, p_gateway_fee, p_net_amount,
    p_status, p_payout_account_id, p_flags, true
  )
  RETURNING id INTO v_payout_id;

  -- Assign adjustments atomically (same transaction)
  IF p_adjustment_ids IS NOT NULL AND array_length(p_adjustment_ids, 1) > 0 THEN
    UPDATE public.payout_adjustments
    SET applied_to_payout_id = v_payout_id,
        applied_at = NOW()
    WHERE id = ANY(p_adjustment_ids)
      AND applied_to_payout_id IS NULL;
  END IF;

  RETURN v_payout_id;
END;
$$;


-- ── 3. Atomic invoice + items RPC ───────────────────────
CREATE OR REPLACE FUNCTION public.create_invoice_with_items(
  p_invoice JSONB,
  p_items JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_invoice_id UUID;
  v_reference_code TEXT;
  v_item JSONB;
  v_sort INTEGER := 0;
BEGIN
  -- Insert invoice
  INSERT INTO public.invoices (
    business_id, customer_name, customer_phone, customer_email, customer_address,
    subtotal, tax_rate, tax_amount, discount_type, discount_value, discount_amount,
    total_amount, currency, issue_date, due_date, notes, terms,
    is_recurring, recurring_frequency, recurring_next_date, recurring_end_date, status
  ) VALUES (
    (p_invoice->>'business_id')::UUID,
    p_invoice->>'customer_name',
    p_invoice->>'customer_phone',
    p_invoice->>'customer_email',
    p_invoice->>'customer_address',
    (p_invoice->>'subtotal')::NUMERIC,
    (p_invoice->>'tax_rate')::NUMERIC,
    (p_invoice->>'tax_amount')::NUMERIC,
    p_invoice->>'discount_type',
    (p_invoice->>'discount_value')::NUMERIC,
    (p_invoice->>'discount_amount')::NUMERIC,
    (p_invoice->>'total_amount')::NUMERIC,
    p_invoice->>'currency',
    (p_invoice->>'issue_date')::DATE,
    (p_invoice->>'due_date')::DATE,
    p_invoice->>'notes',
    p_invoice->>'terms',
    COALESCE((p_invoice->>'is_recurring')::BOOLEAN, false),
    p_invoice->>'recurring_frequency',
    (p_invoice->>'recurring_next_date')::DATE,
    (p_invoice->>'recurring_end_date')::DATE,
    COALESCE(p_invoice->>'status', 'draft')
  )
  RETURNING id, reference_code INTO v_invoice_id, v_reference_code;

  -- Insert all items in the same transaction
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    INSERT INTO public.invoice_items (
      invoice_id, description, quantity, unit_price, amount, sort_order
    ) VALUES (
      v_invoice_id,
      v_item->>'description',
      (v_item->>'quantity')::NUMERIC,
      (v_item->>'unit_price')::NUMERIC,
      (v_item->>'amount')::NUMERIC,
      v_sort
    );
    v_sort := v_sort + 1;
  END LOOP;

  RETURN jsonb_build_object('id', v_invoice_id, 'reference_code', v_reference_code);
END;
$$;


-- ── 4. Replace package session deduction RPC ────────────
-- Fixes from migration 247:
-- - UNIQUE(booking_id) not UNIQUE(enrollment_id, booking_id) — prevents replay selecting another enrollment
-- - Validates booking belongs to business and service
-- - Uses search_path='' with schema-qualified refs

-- Replace the RPC with proper validation and search_path
CREATE OR REPLACE FUNCTION public.deduct_package_session(
  p_business_id UUID,
  p_customer_phone TEXT,
  p_service_id UUID,
  p_booking_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_enrollment_id UUID;
  v_rows INTEGER;
  v_booking_biz UUID;
  v_booking_svc UUID;
BEGIN
  -- Validate booking belongs to the supplied business and service
  SELECT business_id, service_id INTO v_booking_biz, v_booking_svc
  FROM public.bookings
  WHERE id = p_booking_id;

  IF v_booking_biz IS NULL OR v_booking_biz != p_business_id THEN
    RETURN false;  -- Booking not found or wrong business
  END IF;

  IF v_booking_svc IS DISTINCT FROM p_service_id THEN
    RETURN false;  -- Service mismatch
  END IF;

  -- Find the soonest-expiring active enrollment for this service, lock it
  SELECT pe.id INTO v_enrollment_id
  FROM public.package_enrollments pe
  JOIN public.service_packages sp ON pe.package_id = sp.id
  WHERE pe.business_id = p_business_id
    AND pe.customer_phone = p_customer_phone
    AND pe.is_active = true
    AND pe.sessions_used < pe.sessions_total
    AND (pe.expires_at IS NULL OR pe.expires_at > NOW())
    AND p_service_id = ANY(sp.service_ids)
  ORDER BY pe.expires_at ASC NULLS LAST
  LIMIT 1
  FOR UPDATE OF pe;

  IF v_enrollment_id IS NULL THEN
    RETURN false;  -- No eligible enrollment
  END IF;

  -- Atomic deduction with guard
  UPDATE public.package_enrollments
  SET sessions_used = sessions_used + 1
  WHERE id = v_enrollment_id
    AND sessions_used < sessions_total;

  GET DIAGNOSTICS v_rows = ROW_COUNT;

  IF v_rows = 0 THEN
    RETURN false;  -- Race: exhausted between SELECT and UPDATE
  END IF;

  -- Log consumption for replay protection — UNIQUE(booking_id) prevents double-deduction
  BEGIN
    INSERT INTO public.package_session_log (enrollment_id, booking_id)
    VALUES (v_enrollment_id, p_booking_id);
  EXCEPTION WHEN unique_violation THEN
    -- Already deducted for this booking — rollback the increment
    UPDATE public.package_enrollments
    SET sessions_used = sessions_used - 1
    WHERE id = v_enrollment_id;
    RETURN false;
  END;

  RETURN true;
END;
$$;


-- auto_approve_limits documentation updated in DO block at top of file
