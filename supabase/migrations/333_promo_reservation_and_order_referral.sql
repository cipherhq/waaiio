-- ACC-008: Per-order promo reservation + order referral tracking + customer spend marker
--
-- Promo codes use per-order reservation state via promo_reservations table:
--   none → reserved  (atomic with order creation)
--   reserved → finalized  (on authoritative payment success)
--   reserved → released  (on cancellation/expiry)
--   replay from finalized or released = no-op
--
-- Capacity enforcement: inside create_order_atomic, under FOR UPDATE on the
-- promo row, check count of active reservations against max_uses.
--
-- Customer spend tracking: order_spend_applications(order_id UNIQUE)
-- prevents double-counted spend on Payment Authority Stage-2 retry.
--
-- Orders track referral_id for deferred conversion on payment success.

-- ═══════════════════════════════════════════════════════
-- 1. promo_reservations table — per-order durable state
-- ═══════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS promo_reservations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
  promo_code_id UUID NOT NULL REFERENCES promo_codes(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved', 'finalized', 'released')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE promo_reservations ENABLE ROW LEVEL SECURITY;

-- Index for capacity counting queries
CREATE INDEX IF NOT EXISTS idx_promo_reservations_capacity
  ON promo_reservations (promo_code_id, state)
  WHERE state IN ('reserved', 'finalized');

-- ═══════════════════════════════════════════════════════
-- 2. order_spend_applications — exactly-once customer spend
-- ═══════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS order_spend_applications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL UNIQUE,
  payment_id UUID,
  amount INTEGER NOT NULL DEFAULT 0,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE order_spend_applications ENABLE ROW LEVEL SECURITY;

-- ═══════════════════════════════════════════════════════
-- 3. Add referral_id to orders (if not already present)
-- ═══════════════════════════════════════════════════════
ALTER TABLE orders ADD COLUMN IF NOT EXISTS referral_id UUID;

-- ═══════════════════════════════════════════════════════
-- 4. Drop old create_order_atomic overloads, then create canonical version
--    Migration 304 created (21 params with int types).
--    We must drop it explicitly because different param count/types = overload.
-- ═══════════════════════════════════════════════════════
-- Drop the 304 signature (21 params: uuid,uuid,uuid,text,text,text,int,int,int,uuid,text,text,uuid,text,int,int,text,text,text,text,jsonb)
DROP FUNCTION IF EXISTS public.create_order_atomic(
  uuid, uuid, uuid, text, text, text, int, int, int, uuid,
  text, text, uuid, text, int, int, text, text, text, text, jsonb
);
-- Drop any previous 333 overload (20 params with numeric types + referral_id)
DROP FUNCTION IF EXISTS public.create_order_atomic(
  uuid, uuid, uuid, text, text, text, numeric, numeric, numeric, uuid,
  text, uuid, numeric, numeric, text, text, text, text, jsonb, uuid
);

CREATE OR REPLACE FUNCTION public.create_order_atomic(
  p_bot_session_id uuid,
  p_business_id uuid,
  p_user_id uuid,
  p_status text DEFAULT 'pending',
  p_delivery_address text DEFAULT NULL,
  p_delivery_phone text DEFAULT NULL,
  p_total_amount int DEFAULT 0,
  p_discount_amount int DEFAULT 0,
  p_shipping_cost int DEFAULT 0,
  p_promo_code_id uuid DEFAULT NULL,
  p_channel text DEFAULT 'whatsapp',
  p_notes text DEFAULT NULL,
  p_delivery_zone_id uuid DEFAULT NULL,
  p_delivery_zone_name text DEFAULT NULL,
  p_addons_total int DEFAULT 0,
  p_volume_discount_amount int DEFAULT 0,
  p_pickup_address text DEFAULT NULL,
  p_dropoff_address text DEFAULT NULL,
  p_package_description text DEFAULT NULL,
  p_package_photo_url text DEFAULT NULL,
  p_items jsonb DEFAULT '[]'::jsonb,
  p_referral_id uuid DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order_id uuid;
  v_ref text;
  v_item jsonb;
  v_existing_id uuid;
  v_existing_ref text;
  v_promo RECORD;
  v_active_count int;
BEGIN
  -- Advisory lock on bot_session_id: serializes concurrent retries
  PERFORM pg_advisory_xact_lock(abs(hashtext(p_bot_session_id::text)));

  -- Idempotent: check for existing order from same bot session
  SELECT id, reference_code INTO v_existing_id, v_existing_ref
  FROM orders
  WHERE bot_session_id = p_bot_session_id
    AND status IN ('pending', 'confirmed')
  LIMIT 1;

  IF FOUND THEN
    -- Recovery: reconcile items atomically
    DELETE FROM order_items WHERE order_id = v_existing_id;

    FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
    LOOP
      INSERT INTO order_items (order_id, product_id, quantity, unit_price, variant_id, variant_label, addons)
      VALUES (
        v_existing_id,
        (v_item->>'product_id')::uuid,
        (v_item->>'quantity')::int,
        (v_item->>'unit_price')::int,
        NULLIF(v_item->>'variant_id', '')::uuid,
        NULLIF(v_item->>'variant_label', ''),
        CASE WHEN v_item->'addons' IS NOT NULL AND v_item->'addons' != 'null'::jsonb
             THEN v_item->'addons' ELSE NULL END
      );
    END LOOP;

    -- Promo NOT re-reserved on recovery (already done in original creation)
    RETURN jsonb_build_object(
      'order_id', v_existing_id,
      'reference_code', v_existing_ref,
      'created', false
    );
  END IF;

  -- ── Promo capacity enforcement (under lock) ──
  -- Invariant: effective_usage = current_uses + count(reservations WHERE state='reserved')
  -- current_uses includes historical pre-migration-333 uses AND finalized new reservations.
  -- 'reserved' rows are pending orders that haven't paid yet.
  -- 'finalized' rows are NOT counted separately because finalize increments current_uses.
  IF p_promo_code_id IS NOT NULL THEN
    SELECT id, max_uses, current_uses INTO v_promo
    FROM promo_codes WHERE id = p_promo_code_id FOR UPDATE;

    IF NOT FOUND THEN
      RETURN jsonb_build_object('error', 'promo_not_found');
    END IF;

    IF v_promo.max_uses IS NOT NULL THEN
      SELECT count(*) INTO v_active_count
      FROM promo_reservations
      WHERE promo_code_id = p_promo_code_id
        AND state = 'reserved';

      IF (v_promo.current_uses + v_active_count) >= v_promo.max_uses THEN
        RETURN jsonb_build_object('error', 'promo_exhausted');
      END IF;
    END IF;
  END IF;

  -- Create new order
  INSERT INTO orders (
    bot_session_id, business_id, user_id, status,
    delivery_address, delivery_phone, total_amount,
    discount_amount, shipping_cost, promo_code_id, channel, notes,
    delivery_zone_id, delivery_zone_name, addons_total, volume_discount_amount,
    pickup_address, dropoff_address, package_description, package_photo_url,
    referral_id
  ) VALUES (
    p_bot_session_id, p_business_id, p_user_id, p_status::order_status,
    p_delivery_address, p_delivery_phone, p_total_amount,
    p_discount_amount, p_shipping_cost, p_promo_code_id, p_channel, p_notes,
    p_delivery_zone_id, p_delivery_zone_name, p_addons_total, p_volume_discount_amount,
    p_pickup_address, p_dropoff_address, p_package_description, p_package_photo_url,
    p_referral_id
  )
  RETURNING id, reference_code INTO v_order_id, v_ref;

  -- Insert all items atomically
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    INSERT INTO order_items (order_id, product_id, quantity, unit_price, variant_id, variant_label, addons)
    VALUES (
      v_order_id,
      (v_item->>'product_id')::uuid,
      (v_item->>'quantity')::int,
      (v_item->>'unit_price')::int,
      NULLIF(v_item->>'variant_id', '')::uuid,
      NULLIF(v_item->>'variant_label', ''),
      CASE WHEN v_item->'addons' IS NOT NULL AND v_item->'addons' != 'null'::jsonb
           THEN v_item->'addons' ELSE NULL END
    );
  END LOOP;

  -- Insert per-order promo reservation (atomically with order).
  -- For free orders (status='confirmed'), finalize immediately in the same transaction.
  -- For paid orders (status='pending'), leave as 'reserved' until payment success.
  IF p_promo_code_id IS NOT NULL THEN
    IF p_status = 'confirmed' THEN
      -- Free/zero-total order: finalize atomically (order is already complete)
      INSERT INTO promo_reservations (order_id, promo_code_id, state)
      VALUES (v_order_id, p_promo_code_id, 'finalized');
      UPDATE promo_codes SET current_uses = current_uses + 1
      WHERE id = p_promo_code_id;
    ELSE
      -- Paid order: reserve only (finalized on payment success)
      INSERT INTO promo_reservations (order_id, promo_code_id, state)
      VALUES (v_order_id, p_promo_code_id, 'reserved');
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'order_id', v_order_id,
    'reference_code', v_ref,
    'created', true
  );
END;
$$;

-- Privilege hardening for create_order_atomic
DO $$
BEGIN
  REVOKE ALL ON FUNCTION public.create_order_atomic(
    uuid, uuid, uuid, text, text, text, int, int, int, uuid,
    text, text, uuid, text, int, int, text, text, text, text, jsonb, uuid
  ) FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION public.create_order_atomic(
      uuid, uuid, uuid, text, text, text, int, int, int, uuid,
      text, text, uuid, text, int, int, text, text, text, text, jsonb, uuid
    ) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION public.create_order_atomic(
      uuid, uuid, uuid, text, text, text, int, int, int, uuid,
      text, text, uuid, text, int, int, text, text, text, text, jsonb, uuid
    ) FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.create_order_atomic(
      uuid, uuid, uuid, text, text, text, int, int, int, uuid,
      text, text, uuid, text, int, int, text, text, text, text, jsonb, uuid
    ) TO service_role;
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════
-- 5. finalize_promo_reservation — per-order state transition
--    reserved → finalized (on authoritative payment success)
--    Requires order to be confirmed (ties to Payment Authority state)
-- ═══════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.finalize_promo_reservation(p_order_id uuid)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_res RECORD;
  v_order_status text;
BEGIN
  -- Check order exists and is in authoritative completion state.
  -- 'confirmed' = Payment Authority completed (paid orders) or free-order confirmed at creation.
  -- Reject pending/cancelled/draft orders — finalization requires authoritative completion.
  SELECT status INTO v_order_status FROM orders WHERE id = p_order_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('finalized', false, 'reason', 'order_not_found');
  END IF;
  IF v_order_status != 'confirmed' THEN
    RETURN jsonb_build_object('finalized', false, 'reason', 'order_not_confirmed', 'order_status', v_order_status);
  END IF;

  -- Lock the reservation row
  SELECT id, state, promo_code_id INTO v_res
  FROM promo_reservations WHERE order_id = p_order_id FOR UPDATE;

  IF NOT FOUND THEN
    -- No reservation for this order (order had no promo) — valid no-op
    RETURN jsonb_build_object('finalized', false, 'reason', 'no_reservation');
  END IF;

  -- State guard: only reserved → finalized
  IF v_res.state = 'finalized' THEN
    RETURN jsonb_build_object('finalized', true, 'already_finalized', true);
  END IF;
  IF v_res.state = 'released' THEN
    -- Order used a promo but reservation was released (cancellation raced payment).
    -- This is a critical inconsistency for orders with promo — flag it.
    RETURN jsonb_build_object('finalized', false, 'reason', 'already_released');
  END IF;

  -- Transition reserved → finalized
  UPDATE promo_reservations
  SET state = 'finalized', updated_at = NOW()
  WHERE id = v_res.id;

  -- Increment current_uses on the promo code
  UPDATE promo_codes
  SET current_uses = current_uses + 1
  WHERE id = v_res.promo_code_id;

  RETURN jsonb_build_object('finalized', true, 'already_finalized', false);
END;
$$;

-- ═══════════════════════════════════════════════════════
-- 6. release_promo_reservation — per-order state transition
--    reserved → released (on cancellation/expiry)
-- ═══════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.release_promo_reservation(p_order_id uuid)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_res RECORD;
BEGIN
  SELECT id, state INTO v_res
  FROM promo_reservations WHERE order_id = p_order_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('released', false, 'reason', 'no_reservation');
  END IF;

  -- State guard: only reserved → released
  IF v_res.state = 'released' THEN
    RETURN jsonb_build_object('released', true, 'already_released', true);
  END IF;
  IF v_res.state = 'finalized' THEN
    RETURN jsonb_build_object('released', false, 'reason', 'already_finalized');
  END IF;

  UPDATE promo_reservations
  SET state = 'released', updated_at = NOW()
  WHERE id = v_res.id;

  RETURN jsonb_build_object('released', true, 'already_released', false);
END;
$$;

-- ═══════════════════════════════════════════════════════
-- 7. apply_customer_spend_once — exactly-once spend tracking
-- ═══════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.apply_customer_spend_once(
  p_order_id uuid,
  p_payment_id uuid DEFAULT NULL,
  p_amount int DEFAULT 0
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order RECORD;
  v_existing RECORD;
BEGIN
  -- Load order to get business and customer phone
  SELECT id, business_id, delivery_phone, status
  INTO v_order FROM orders WHERE id = p_order_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'order_not_found');
  END IF;

  -- Check idempotency marker
  SELECT id INTO v_existing
  FROM order_spend_applications WHERE order_id = p_order_id;

  IF FOUND THEN
    RETURN jsonb_build_object('applied', true, 'already_applied', true);
  END IF;

  -- Insert marker first (exactly-once gate)
  INSERT INTO order_spend_applications (order_id, payment_id, amount)
  VALUES (p_order_id, p_payment_id, p_amount);

  -- Apply spend via existing upsert_customer_profile
  IF v_order.delivery_phone IS NOT NULL AND v_order.business_id IS NOT NULL THEN
    PERFORM upsert_customer_profile(
      v_order.business_id,
      v_order.delivery_phone,
      NULL,
      p_amount,
      false,
      false
    );
  END IF;

  RETURN jsonb_build_object('applied', true, 'already_applied', false);
END;
$$;

-- ═══════════════════════════════════════════════════════
-- 8. Update cancel_stale_order_atomic to release promo reservation
-- ═══════════════════════════════════════════════════════
-- (This is handled by calling release_promo_reservation inside the existing
--  cancel_stale_order_atomic. The migration 329 version is the canonical one;
--  we just need the release call to happen. Since cancel_stale_order_atomic
--  already exists and calls are made in the cleanup route, we update it.)

-- Note: cancel_stale_order_atomic was last defined in migration 329.
-- We add promo release to it here.
CREATE OR REPLACE FUNCTION public.cancel_stale_order_atomic(
  p_order_id UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order RECORD;
  v_item RECORD;
  v_count INTEGER := 0;
  v_had_marker BOOLEAN := false;
  v_has_payment BOOLEAN := false;
BEGIN
  -- 1. Lock order row
  SELECT id, status, created_at, promo_code_id
  INTO v_order FROM orders WHERE id = p_order_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('cancelled', false, 'reason', 'not_found');
  END IF;

  -- 2. Status gate: only pending orders
  IF v_order.status != 'pending' THEN
    RETURN jsonb_build_object('cancelled', false, 'reason', v_order.status);
  END IF;

  -- 3. Staleness gate: must be older than 48 hours
  IF v_order.created_at >= NOW() - INTERVAL '48 hours' THEN
    RETURN jsonb_build_object('cancelled', false, 'reason', 'not_stale');
  END IF;

  -- 4. Payment gate: lock payment rows + check for success/finalization
  PERFORM id FROM payments
  WHERE (order_id = p_order_id OR metadata->>'order_id' = p_order_id::text)
  FOR UPDATE;

  SELECT EXISTS (
    SELECT 1 FROM payments
    WHERE (order_id = p_order_id OR metadata->>'order_id' = p_order_id::text)
      AND (
        status = 'success'
        OR (finalization_processing_at IS NOT NULL
            AND finalization_processing_at > NOW() - INTERVAL '5 minutes')
      )
  ) INTO v_has_payment;

  IF v_has_payment THEN
    RETURN jsonb_build_object('cancelled', false, 'reason', 'has_successful_payment');
  END IF;

  -- 4b. Void pending payments
  UPDATE payments
  SET status = 'failed',
      gateway_status = 'stale_order_cancelled',
      updated_at = NOW()
  WHERE (order_id = p_order_id OR metadata->>'order_id' = p_order_id::text)
    AND status = 'pending';

  -- 5. Check canonical stock marker
  PERFORM id FROM order_stock_applications WHERE order_id = p_order_id;

  IF FOUND THEN
    v_had_marker := true;

    FOR v_item IN
      SELECT oi.product_id, oi.variant_id, oi.quantity
      FROM order_items oi
      WHERE oi.order_id = p_order_id
      ORDER BY oi.product_id, oi.variant_id NULLS FIRST
    LOOP
      IF v_item.variant_id IS NOT NULL THEN
        UPDATE product_variants
        SET stock_quantity = COALESCE(stock_quantity, 0) + v_item.quantity
        WHERE id = v_item.variant_id AND stock_quantity IS NOT NULL;
      ELSIF v_item.product_id IS NOT NULL THEN
        UPDATE products
        SET stock_quantity = COALESCE(stock_quantity, 0) + v_item.quantity
        WHERE id = v_item.product_id AND track_inventory = true;
      END IF;
      v_count := v_count + 1;
    END LOOP;

    DELETE FROM order_stock_applications WHERE order_id = p_order_id;
  END IF;

  -- 6. Release promo reservation
  IF v_order.promo_code_id IS NOT NULL THEN
    PERFORM release_promo_reservation(p_order_id);
  END IF;

  -- 7. Cancel order
  UPDATE orders SET status = 'cancelled', updated_at = NOW() WHERE id = p_order_id;

  RETURN jsonb_build_object(
    'cancelled', true,
    'stock_restored', v_had_marker,
    'items_restored', v_count
  );
END;
$$;

-- ═══════════════════════════════════════════════════════
-- 9. Privilege hardening
-- ═══════════════════════════════════════════════════════
DO $$
BEGIN
  -- finalize_promo_reservation
  REVOKE ALL ON FUNCTION public.finalize_promo_reservation(UUID) FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION public.finalize_promo_reservation(UUID) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION public.finalize_promo_reservation(UUID) FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.finalize_promo_reservation(UUID) TO service_role;
  END IF;

  -- release_promo_reservation
  REVOKE ALL ON FUNCTION public.release_promo_reservation(UUID) FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION public.release_promo_reservation(UUID) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION public.release_promo_reservation(UUID) FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.release_promo_reservation(UUID) TO service_role;
  END IF;

  -- apply_customer_spend_once
  REVOKE ALL ON FUNCTION public.apply_customer_spend_once(UUID, UUID, INT) FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION public.apply_customer_spend_once(UUID, UUID, INT) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION public.apply_customer_spend_once(UUID, UUID, INT) FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.apply_customer_spend_once(UUID, UUID, INT) TO service_role;
  END IF;

  -- cancel_stale_order_atomic (re-grant after CREATE OR REPLACE)
  REVOKE ALL ON FUNCTION public.cancel_stale_order_atomic(UUID) FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION public.cancel_stale_order_atomic(UUID) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION public.cancel_stale_order_atomic(UUID) FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.cancel_stale_order_atomic(UUID) TO service_role;
  END IF;
END $$;
