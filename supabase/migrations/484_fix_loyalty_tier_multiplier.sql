-- Migration 484: Fix loyalty tier multiplier lookup (#762 W17)
--
-- The M387 apply_payment_loyalty_once RPC reads from customer_memberships
-- (a table that was never created), silently falling back to multiplier 1.
-- This migration replaces the function with the corrected lookup using
-- customer_profiles.membership_tier_id → membership_tiers, preserving
-- all other M387 behavior: payment resolution, idempotency, balance/earned/
-- visit mutations, transaction insert, atomic marker, and replay semantics.
--
-- Changes from M387:
--   Step 6: customer_memberships → customer_profiles JOIN membership_tiers
--           Canonical cp.membership_tier_id FK (not highest-multiplier ordering)
--           Tenant-bound: mt.business_id = cp.business_id = v_business_id
--           Explicit default 1 via COALESCE wrapper (DECLARE default does not
--           survive no-row SELECT INTO)
--           Removed EXCEPTION WHEN undefined_table handler (both tables exist)

CREATE OR REPLACE FUNCTION apply_payment_loyalty_once(
  p_payment_id UUID
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_payment RECORD;
  v_existing UUID;
  v_business_id UUID;
  v_customer_phone TEXT;
  v_source RECORD;
  v_biz RECORD;
  v_earned_points INTEGER;
  v_points_mode TEXT;
  v_points_per_visit INTEGER;
  v_points_per_currency INTEGER;
  v_multiplier NUMERIC := 1;
  v_reason TEXT := 'visit';
BEGIN
  -- 1. Load payment
  SELECT id, amount, status, booking_id, reservation_id, order_id,
         invoice_id, campaign_id
  INTO v_payment FROM public.payments WHERE id = p_payment_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'payment_not_found');
  END IF;
  IF v_payment.status != 'success' THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'payment_not_successful');
  END IF;

  -- 2. Idempotency check
  SELECT id INTO v_existing FROM public.payment_loyalty_applications
  WHERE payment_id = p_payment_id;
  IF FOUND THEN
    RETURN jsonb_build_object('applied', true, 'already_applied', true);
  END IF;

  -- 3. Derive business_id and customer_phone from entity
  IF v_payment.booking_id IS NOT NULL THEN
    SELECT business_id, guest_phone INTO v_source FROM public.bookings WHERE id = v_payment.booking_id;
  ELSIF v_payment.reservation_id IS NOT NULL THEN
    SELECT business_id, guest_phone INTO v_source FROM public.reservations WHERE id = v_payment.reservation_id;
  ELSIF v_payment.order_id IS NOT NULL THEN
    SELECT business_id, delivery_phone AS guest_phone INTO v_source FROM public.orders WHERE id = v_payment.order_id;
  ELSIF v_payment.invoice_id IS NOT NULL THEN
    SELECT business_id, customer_phone AS guest_phone INTO v_source FROM public.invoices WHERE id = v_payment.invoice_id;
  ELSE
    RETURN jsonb_build_object('applied', false, 'reason', 'no_entity');
  END IF;

  IF NOT FOUND OR v_source.business_id IS NULL THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'entity_not_found');
  END IF;

  v_business_id := v_source.business_id;
  v_customer_phone := v_source.guest_phone;

  IF v_customer_phone IS NULL THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'no_customer_phone');
  END IF;

  -- 4. Load business loyalty config
  SELECT metadata INTO v_biz FROM public.businesses WHERE id = v_business_id;

  v_points_mode := COALESCE(v_biz.metadata->>'loyalty_points_mode', 'per_visit');
  v_points_per_visit := COALESCE((v_biz.metadata->>'loyalty_points_per_visit')::INTEGER, 10);
  v_points_per_currency := COALESCE((v_biz.metadata->>'loyalty_points_per_currency')::INTEGER, 0);

  -- 5. Calculate base points
  IF v_points_mode = 'per_amount' AND v_points_per_currency > 0 AND v_payment.amount > 0 THEN
    v_earned_points := GREATEST(FLOOR(v_payment.amount::NUMERIC / v_points_per_currency), 1);
    v_reason := 'purchase';
  ELSE
    v_earned_points := v_points_per_visit;
  END IF;

  -- 6. Look up membership tier multiplier via canonical customer_profiles FK.
  --    Tenant-bound: both cp.business_id and mt.business_id must match.
  --    Explicit COALESCE wrapper: SELECT INTO returns NULL on no row,
  --    overriding the DECLARE default. is_active guards inactive tiers.
  SELECT COALESCE(mt.points_multiplier, 1) INTO v_multiplier
  FROM public.customer_profiles cp
  JOIN public.membership_tiers mt
    ON mt.id = cp.membership_tier_id
    AND mt.business_id = cp.business_id
  WHERE cp.business_id = v_business_id
    AND cp.phone = v_customer_phone
    AND mt.is_active = true;

  IF NOT FOUND THEN
    v_multiplier := 1;
  END IF;

  IF v_multiplier > 1 THEN
    v_earned_points := FLOOR(v_earned_points * v_multiplier);
  END IF;

  -- 7. Insert marker atomically
  INSERT INTO public.payment_loyalty_applications
    (payment_id, business_id, customer_phone, points_awarded, points_mode)
  VALUES
    (p_payment_id, v_business_id, v_customer_phone, v_earned_points, v_points_mode)
  ON CONFLICT (payment_id) DO NOTHING;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('applied', true, 'already_applied', true);
  END IF;

  -- 8. Apply loyalty points mutation (canonical schema: points_balance, total_earned, visit_count)
  UPDATE public.loyalty_points
  SET points_balance = points_balance + v_earned_points,
      total_earned = total_earned + v_earned_points,
      visit_count = visit_count + 1,
      updated_at = NOW()
  WHERE business_id = v_business_id AND customer_phone = v_customer_phone;

  IF NOT FOUND THEN
    INSERT INTO public.loyalty_points (business_id, customer_phone, points_balance, total_earned, visit_count, updated_at)
    VALUES (v_business_id, v_customer_phone, v_earned_points, v_earned_points, 1, NOW())
    ON CONFLICT (business_id, customer_phone) DO UPDATE SET
      points_balance = public.loyalty_points.points_balance + v_earned_points,
      total_earned = public.loyalty_points.total_earned + v_earned_points,
      visit_count = public.loyalty_points.visit_count + 1,
      updated_at = NOW();
  END IF;

  -- 9. Record transaction (canonical schema: points_change, reason, reference_id, reference_type)
  INSERT INTO public.loyalty_transactions
    (business_id, customer_phone, points_change, reason, reference_id, reference_type, created_at)
  VALUES
    (v_business_id, v_customer_phone, v_earned_points, v_reason,
     p_payment_id::TEXT, 'payment', NOW());

  RETURN jsonb_build_object('applied', true, 'already_applied', false,
    'points_awarded', v_earned_points, 'reason', v_reason);
END;
$$;

-- ── ACL: preserve M387 grants ──
DO $$ BEGIN
  REVOKE ALL ON FUNCTION apply_payment_loyalty_once(UUID) FROM PUBLIC;
EXCEPTION WHEN undefined_function THEN NULL; END $$;

DO $$ BEGIN
  REVOKE ALL ON FUNCTION apply_payment_loyalty_once(UUID) FROM anon;
EXCEPTION WHEN undefined_function THEN NULL; END $$;

DO $$ BEGIN
  REVOKE ALL ON FUNCTION apply_payment_loyalty_once(UUID) FROM authenticated;
EXCEPTION WHEN undefined_function THEN NULL; END $$;

DO $$ BEGIN
  GRANT EXECUTE ON FUNCTION apply_payment_loyalty_once(UUID) TO service_role;
EXCEPTION WHEN undefined_function THEN NULL; END $$;

-- ── Final-state checks ──
DO $$
DECLARE v_has BOOLEAN;
BEGIN
  SELECT has_function_privilege('anon', 'apply_payment_loyalty_once(uuid)', 'EXECUTE') INTO v_has;
  IF v_has THEN RAISE EXCEPTION 'anon can execute apply_payment_loyalty_once'; END IF;

  SELECT has_function_privilege('authenticated', 'apply_payment_loyalty_once(uuid)', 'EXECUTE') INTO v_has;
  IF v_has THEN RAISE EXCEPTION 'authenticated can execute apply_payment_loyalty_once'; END IF;

  SELECT has_function_privilege('service_role', 'apply_payment_loyalty_once(uuid)', 'EXECUTE') INTO v_has;
  IF NOT v_has THEN RAISE EXCEPTION 'service_role cannot execute apply_payment_loyalty_once'; END IF;
END $$;

-- PostgREST schema cache reload
NOTIFY pgrst, 'reload schema';
