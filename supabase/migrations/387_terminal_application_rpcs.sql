-- Migration 387: Exactly-once application RPCs
--
-- Phase A v15: apply_payment_loyalty_once (resolves DEBT-002),
-- apply_payment_customer_visit_once (CRM visit exactly-once).
-- Pattern follows migration 334 (apply_payment_spend_once).

-- ═══════════════════════════════════════════════════════
-- 1. apply_payment_loyalty_once
--
-- Derives business/customer/config/points from payment + business metadata.
-- No arbitrary p_points or p_customer parameter — caller cannot specify values.
-- UNIQUE(payment_id) marker prevents replay.
-- ═══════════════════════════════════════════════════════
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
  INTO v_payment FROM payments WHERE id = p_payment_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'payment_not_found');
  END IF;
  IF v_payment.status != 'success' THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'payment_not_successful');
  END IF;

  -- 2. Idempotency check
  SELECT id INTO v_existing FROM payment_loyalty_applications
  WHERE payment_id = p_payment_id;
  IF FOUND THEN
    RETURN jsonb_build_object('applied', true, 'already_applied', true);
  END IF;

  -- 3. Derive business_id and customer_phone from entity
  IF v_payment.booking_id IS NOT NULL THEN
    SELECT business_id, guest_phone INTO v_source FROM bookings WHERE id = v_payment.booking_id;
  ELSIF v_payment.reservation_id IS NOT NULL THEN
    SELECT business_id, guest_phone INTO v_source FROM reservations WHERE id = v_payment.reservation_id;
  ELSIF v_payment.order_id IS NOT NULL THEN
    SELECT business_id, delivery_phone AS guest_phone INTO v_source FROM orders WHERE id = v_payment.order_id;
  ELSIF v_payment.invoice_id IS NOT NULL THEN
    SELECT business_id, customer_phone AS guest_phone INTO v_source FROM invoices WHERE id = v_payment.invoice_id;
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
  SELECT metadata INTO v_biz FROM businesses WHERE id = v_business_id;

  v_points_mode := COALESCE(v_biz.metadata->>'loyalty_points_mode', 'per_visit');
  v_points_per_visit := COALESCE((v_biz.metadata->>'loyalty_points_per_visit')::INTEGER, 10);
  v_points_per_currency := COALESCE((v_biz.metadata->>'loyalty_points_per_currency')::INTEGER, 0);

  -- 5. Calculate points
  IF v_points_mode = 'per_amount' AND v_points_per_currency > 0 AND v_payment.amount > 0 THEN
    v_earned_points := GREATEST(FLOOR(v_payment.amount::NUMERIC / v_points_per_currency), 1);
    v_reason := 'purchase';
  ELSE
    v_earned_points := v_points_per_visit;
  END IF;

  -- 6. Check membership tier multiplier
  BEGIN
    SELECT COALESCE(mt.points_multiplier, 1) INTO v_multiplier
    FROM customer_memberships cm
    JOIN membership_tiers mt ON mt.id = cm.tier_id
    WHERE cm.business_id = v_business_id
      AND cm.customer_phone = v_customer_phone
      AND cm.status = 'active'
    ORDER BY mt.points_multiplier DESC NULLS LAST
    LIMIT 1;
  EXCEPTION WHEN undefined_table THEN
    v_multiplier := 1;
  END;

  IF v_multiplier > 1 THEN
    v_earned_points := FLOOR(v_earned_points * v_multiplier);
  END IF;

  -- 7. Insert marker atomically
  INSERT INTO payment_loyalty_applications
    (payment_id, business_id, customer_phone, points_awarded, points_mode)
  VALUES
    (p_payment_id, v_business_id, v_customer_phone, v_earned_points, v_points_mode)
  ON CONFLICT (payment_id) DO NOTHING;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('applied', true, 'already_applied', true);
  END IF;

  -- 8. Apply loyalty points mutation
  UPDATE loyalty_points
  SET points = points + v_earned_points, updated_at = NOW()
  WHERE business_id = v_business_id AND customer_phone = v_customer_phone;

  IF NOT FOUND THEN
    INSERT INTO loyalty_points (business_id, customer_phone, points, updated_at)
    VALUES (v_business_id, v_customer_phone, v_earned_points, NOW())
    ON CONFLICT (business_id, customer_phone) DO UPDATE SET
      points = loyalty_points.points + v_earned_points,
      updated_at = NOW();
  END IF;

  -- 9. Record transaction
  INSERT INTO loyalty_transactions
    (business_id, customer_phone, points, type, description, created_at)
  VALUES
    (v_business_id, v_customer_phone, v_earned_points, 'earned',
     'Payment ' || p_payment_id::TEXT, NOW());

  RETURN jsonb_build_object('applied', true, 'already_applied', false,
    'points_awarded', v_earned_points, 'reason', v_reason);
END;
$$;

-- ═══════════════════════════════════════════════════════
-- 2. apply_payment_customer_visit_once
--
-- Exactly-once CRM visit increment. Prevents double-counting that
-- could falsely promote customers to VIP tier (500K threshold).
-- ═══════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION apply_payment_customer_visit_once(
  p_payment_id UUID
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_payment RECORD;
  v_existing UUID;
  v_business_id UUID;
  v_customer_phone TEXT;
  v_source RECORD;
  v_spend_amount INTEGER;
BEGIN
  -- 1. Load payment
  SELECT id, amount, status, booking_id, reservation_id, order_id,
         invoice_id, campaign_id
  INTO v_payment FROM payments WHERE id = p_payment_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'payment_not_found');
  END IF;
  IF v_payment.status != 'success' THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'payment_not_successful');
  END IF;

  -- 2. Idempotency check
  SELECT id INTO v_existing FROM payment_visit_applications
  WHERE payment_id = p_payment_id;
  IF FOUND THEN
    RETURN jsonb_build_object('applied', true, 'already_applied', true);
  END IF;

  -- 3. Derive business_id and customer_phone from entity
  IF v_payment.booking_id IS NOT NULL THEN
    SELECT business_id, guest_phone INTO v_source FROM bookings WHERE id = v_payment.booking_id;
  ELSIF v_payment.reservation_id IS NOT NULL THEN
    SELECT business_id, guest_phone INTO v_source FROM reservations WHERE id = v_payment.reservation_id;
  ELSIF v_payment.order_id IS NOT NULL THEN
    SELECT business_id, delivery_phone AS guest_phone INTO v_source FROM orders WHERE id = v_payment.order_id;
  ELSIF v_payment.invoice_id IS NOT NULL THEN
    SELECT business_id, customer_phone AS guest_phone INTO v_source FROM invoices WHERE id = v_payment.invoice_id;
  ELSIF v_payment.campaign_id IS NOT NULL THEN
    -- Campaign donations: derive business_id from campaign, phone from donation
    SELECT c.business_id, cd.donor_phone AS guest_phone
    INTO v_source
    FROM campaigns c
    LEFT JOIN campaign_donations cd ON cd.payment_id = p_payment_id
    WHERE c.id = v_payment.campaign_id
    LIMIT 1;
  ELSE
    RETURN jsonb_build_object('applied', false, 'reason', 'no_entity');
  END IF;

  IF v_source.business_id IS NULL THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'entity_not_found');
  END IF;

  v_business_id := v_source.business_id;
  v_customer_phone := v_source.guest_phone;

  IF v_customer_phone IS NULL THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'no_customer_phone');
  END IF;

  -- 4. Determine visit spend (booking/reservation spend owned by apply_payment_spend_once)
  v_spend_amount := CASE
    WHEN v_payment.booking_id IS NOT NULL OR v_payment.reservation_id IS NOT NULL THEN 0
    ELSE COALESCE(v_payment.amount, 0)
  END;

  -- 5. Insert marker atomically
  INSERT INTO payment_visit_applications
    (payment_id, business_id, customer_phone, visit_amount)
  VALUES
    (p_payment_id, v_business_id, v_customer_phone, v_spend_amount)
  ON CONFLICT (payment_id) DO NOTHING;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('applied', true, 'already_applied', true);
  END IF;

  -- 6. Apply visit increment + profile upsert atomically
  UPDATE customer_profiles
  SET total_visits = total_visits + 1,
      total_bookings = total_bookings + 1,
      total_spent = total_spent + v_spend_amount,
      last_seen_at = NOW()
  WHERE business_id = v_business_id AND phone = v_customer_phone;

  IF NOT FOUND THEN
    INSERT INTO customer_profiles
      (business_id, phone, total_visits, total_bookings, total_spent, last_seen_at, first_seen_at)
    VALUES
      (v_business_id, v_customer_phone, 1, 1, v_spend_amount, NOW(), NOW())
    ON CONFLICT (business_id, phone) DO UPDATE SET
      total_visits = customer_profiles.total_visits + 1,
      total_bookings = customer_profiles.total_bookings + 1,
      total_spent = customer_profiles.total_spent + v_spend_amount,
      last_seen_at = NOW();
  END IF;

  RETURN jsonb_build_object('applied', true, 'already_applied', false,
    'visit_amount', v_spend_amount);
END;
$$;

-- ═══════════════════════════════════════════════════════
-- 3. Privilege hardening
-- ═══════════════════════════════════════════════════════
DO $$
BEGIN
  REVOKE ALL ON FUNCTION apply_payment_loyalty_once(UUID) FROM PUBLIC;
  REVOKE ALL ON FUNCTION apply_payment_customer_visit_once(UUID) FROM PUBLIC;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION apply_payment_loyalty_once(UUID) FROM anon;
    REVOKE ALL ON FUNCTION apply_payment_customer_visit_once(UUID) FROM anon;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION apply_payment_loyalty_once(UUID) FROM authenticated;
    REVOKE ALL ON FUNCTION apply_payment_customer_visit_once(UUID) FROM authenticated;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION apply_payment_loyalty_once(UUID) TO service_role;
    GRANT EXECUTE ON FUNCTION apply_payment_customer_visit_once(UUID) TO service_role;
  END IF;
END $$;

-- Privilege verification
DO $$
DECLARE v_has BOOLEAN;
BEGIN
  SELECT has_function_privilege('anon', 'apply_payment_loyalty_once(uuid)', 'EXECUTE') INTO v_has;
  IF v_has THEN RAISE EXCEPTION 'anon can execute apply_payment_loyalty_once'; END IF;

  SELECT has_function_privilege('authenticated', 'apply_payment_loyalty_once(uuid)', 'EXECUTE') INTO v_has;
  IF v_has THEN RAISE EXCEPTION 'authenticated can execute apply_payment_loyalty_once'; END IF;

  SELECT has_function_privilege('service_role', 'apply_payment_loyalty_once(uuid)', 'EXECUTE') INTO v_has;
  IF NOT v_has THEN RAISE EXCEPTION 'service_role cannot execute apply_payment_loyalty_once'; END IF;

  SELECT has_function_privilege('anon', 'apply_payment_customer_visit_once(uuid)', 'EXECUTE') INTO v_has;
  IF v_has THEN RAISE EXCEPTION 'anon can execute apply_payment_customer_visit_once'; END IF;

  SELECT has_function_privilege('authenticated', 'apply_payment_customer_visit_once(uuid)', 'EXECUTE') INTO v_has;
  IF v_has THEN RAISE EXCEPTION 'authenticated can execute apply_payment_customer_visit_once'; END IF;

  SELECT has_function_privilege('service_role', 'apply_payment_customer_visit_once(uuid)', 'EXECUTE') INTO v_has;
  IF NOT v_has THEN RAISE EXCEPTION 'service_role cannot execute apply_payment_customer_visit_once'; END IF;

  RAISE NOTICE 'Migration 387: All privilege checks passed';
END $$;
