-- Migration 334: Exactly-once customer spend for paid bookings/reservations
--
-- Establishes a durable payment-scoped spend marker with a DB-authoritative
-- atomic RPC that derives all financial facts from the payment row.
--
-- Invariant: each confirmed payment contributes to customer spend at most once.
-- Deposit and balance payments are separate spend events (different payment_ids).

-- ═══════════════════════════════════════════════════════
-- 1. payment_spend_applications — durable per-payment marker
-- ═══════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS payment_spend_applications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id UUID NOT NULL UNIQUE,
  source_type TEXT NOT NULL CHECK (source_type IN ('booking', 'reservation')),
  source_id UUID NOT NULL,
  business_id UUID NOT NULL,
  customer_phone TEXT NOT NULL,
  amount INTEGER NOT NULL DEFAULT 0,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE payment_spend_applications ENABLE ROW LEVEL SECURITY;

-- ═══════════════════════════════════════════════════════
-- 2. apply_payment_spend_once — DB-authoritative atomic spend
--
-- Takes ONLY p_payment_id. All financial facts derived from durable rows.
-- Requires payments.status = 'success'.
-- Derives exactly one source: booking_id XOR reservation_id.
-- Both populated → ambiguous_source (fail closed).
-- Neither → no_supported_source (fail closed).
-- Marker + spend mutation are atomic (same transaction).
-- ═══════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.apply_payment_spend_once(
  p_payment_id UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_payment RECORD;
  v_source RECORD;
  v_source_type TEXT;
  v_source_id UUID;
  v_existing RECORD;
BEGIN
  -- 1. Load durable payment row — sole financial authority
  SELECT id, amount, status, booking_id, reservation_id
  INTO v_payment FROM payments WHERE id = p_payment_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'payment_not_found');
  END IF;

  -- 2. Payment must be confirmed successful
  IF v_payment.status != 'success' THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'payment_not_successful');
  END IF;

  -- 3. Derive source: booking_id XOR reservation_id
  IF v_payment.booking_id IS NOT NULL AND v_payment.reservation_id IS NOT NULL THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'ambiguous_source');
  END IF;

  IF v_payment.booking_id IS NOT NULL THEN
    v_source_type := 'booking';
    v_source_id := v_payment.booking_id;
  ELSIF v_payment.reservation_id IS NOT NULL THEN
    v_source_type := 'reservation';
    v_source_id := v_payment.reservation_id;
  ELSE
    RETURN jsonb_build_object('applied', false, 'reason', 'no_supported_source');
  END IF;

  -- 4. Check idempotency marker
  SELECT id INTO v_existing
  FROM payment_spend_applications WHERE payment_id = p_payment_id;

  IF FOUND THEN
    RETURN jsonb_build_object('applied', true, 'already_applied', true);
  END IF;

  -- 5. Load source row — derive customer + business identity
  IF v_source_type = 'booking' THEN
    SELECT business_id, guest_phone, status
    INTO v_source FROM bookings WHERE id = v_source_id;
  ELSE
    SELECT business_id, guest_phone, status
    INTO v_source FROM reservations WHERE id = v_source_id;
  END IF;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'source_not_found');
  END IF;

  IF v_source.status = 'cancelled' THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'source_cancelled');
  END IF;

  IF v_source.guest_phone IS NULL THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'no_customer_phone');
  END IF;

  -- 6. Insert marker + apply spend atomically
  INSERT INTO payment_spend_applications (payment_id, source_type, source_id, business_id, customer_phone, amount)
  VALUES (p_payment_id, v_source_type, v_source_id, v_source.business_id, v_source.guest_phone, v_payment.amount);

  PERFORM upsert_customer_profile(
    v_source.business_id,
    v_source.guest_phone,
    NULL,
    v_payment.amount,
    false,
    false
  );

  RETURN jsonb_build_object('applied', true, 'already_applied', false, 'amount', v_payment.amount);
END;
$$;

-- ═══════════════════════════════════════════════════════
-- 3. Privilege hardening
-- ═══════════════════════════════════════════════════════
DO $$
BEGIN
  REVOKE ALL ON FUNCTION public.apply_payment_spend_once(UUID) FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION public.apply_payment_spend_once(UUID) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION public.apply_payment_spend_once(UUID) FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.apply_payment_spend_once(UUID) TO service_role;
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════
-- 4. Privilege verification (hard gate)
-- ═══════════════════════════════════════════════════════
DO $$
DECLARE v_has BOOLEAN;
BEGIN
  SELECT has_function_privilege('anon', 'apply_payment_spend_once(uuid)', 'EXECUTE') INTO v_has;
  IF v_has THEN RAISE EXCEPTION 'anon can execute apply_payment_spend_once'; END IF;

  SELECT has_function_privilege('authenticated', 'apply_payment_spend_once(uuid)', 'EXECUTE') INTO v_has;
  IF v_has THEN RAISE EXCEPTION 'authenticated can execute apply_payment_spend_once'; END IF;

  SELECT has_function_privilege('service_role', 'apply_payment_spend_once(uuid)', 'EXECUTE') INTO v_has;
  IF NOT v_has THEN RAISE EXCEPTION 'service_role cannot execute apply_payment_spend_once'; END IF;

  RAISE NOTICE 'All privilege checks passed for apply_payment_spend_once';
END $$;
