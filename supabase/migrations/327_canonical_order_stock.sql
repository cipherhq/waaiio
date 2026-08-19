-- Migration 327: Canonical order-stock authority
--
-- Establishes the invariant: for any order, stock is deducted at most once,
-- enforced by UNIQUE(order_id) on order_stock_applications.
--
-- Changes:
--   1. Verify order_stock_applications is empty (column bug in 314 means
--      apply_order_stock_once has always errored at runtime → zero rows).
--   2. Drop UNIQUE(payment_id, order_id) → add UNIQUE(order_id).
--   3. Make payment_id nullable (audit metadata, not uniqueness key).
--   4. CREATE OR REPLACE apply_order_stock_once with:
--      - Fixed stock_quantity columns (was incorrectly 'stock')
--      - Order-level marker check (not payment-level)
--      - Deterministic inventory locking (ORDER BY product_id, variant_id)
--      - Cancelled-order rejection
--      - Optional stock-sufficiency validation (p_validate_sufficient)
--      - Nullable p_payment_id for pre-payment reservation
--   5. Privilege hardening (service_role only) with executable tests.

-- ═══════════════════════════════════════════════════════
-- Step 1: Verify table is empty
-- ═══════════════════════════════════════════════════════
DO $$
DECLARE v_count INTEGER;
BEGIN
  SELECT count(*) INTO v_count FROM order_stock_applications;
  IF v_count > 0 THEN
    RAISE EXCEPTION 'order_stock_applications has % unexpected rows — manual review required before migration', v_count;
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════
-- Step 2: Drop old constraint, add order-level constraint
-- ═══════════════════════════════════════════════════════
ALTER TABLE order_stock_applications
  DROP CONSTRAINT IF EXISTS order_stock_applications_payment_id_order_id_key;

ALTER TABLE order_stock_applications
  ADD CONSTRAINT order_stock_applications_order_id_key UNIQUE (order_id);

-- ═══════════════════════════════════════════════════════
-- Step 3: Make payment_id nullable
-- ═══════════════════════════════════════════════════════
ALTER TABLE order_stock_applications
  ALTER COLUMN payment_id DROP NOT NULL;

-- ═══════════════════════════════════════════════════════
-- Step 4: Revised canonical apply_order_stock_once
-- ═══════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.apply_order_stock_once(
  p_order_id UUID,
  p_payment_id UUID DEFAULT NULL,
  p_validate_sufficient BOOLEAN DEFAULT false
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order RECORD;
  v_existing RECORD;
  v_item RECORD;
  v_product RECORD;
  v_variant RECORD;
  v_count INTEGER := 0;
  v_out_of_stock TEXT[] := '{}';
BEGIN
  -- 1. Lock order row (serializes all stock operations for this order)
  SELECT id, status
  INTO v_order FROM orders WHERE id = p_order_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'order_not_found');
  END IF;

  -- 2. Reject cancelled orders (cleanup already restored stock)
  IF v_order.status = 'cancelled' THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'order_cancelled');
  END IF;

  -- 3. Validate payment→order relationship when payment_id is supplied
  IF p_payment_id IS NOT NULL THEN
    PERFORM id FROM payments
    WHERE id = p_payment_id
      AND (order_id = p_order_id OR metadata->>'order_id' = p_order_id::text);
    IF NOT FOUND THEN
      RETURN jsonb_build_object('applied', false, 'reason', 'payment_order_mismatch');
    END IF;
  END IF;

  -- 4. Check order-level marker
  SELECT id INTO v_existing
  FROM order_stock_applications
  WHERE order_id = p_order_id;

  IF FOUND THEN
    -- Stock was already deducted. Do NOT decrement again.
    -- But if a payment_id is provided (payment-confirmed context), the order
    -- may still need confirmation (pending→confirmed). This happens when
    -- quote acceptance reserved stock (inserted marker) and payment arrives later.
    IF p_payment_id IS NOT NULL AND v_order.status = 'pending' THEN
      -- Validate payment belongs to this order
      PERFORM id FROM payments
      WHERE id = p_payment_id
        AND (order_id = p_order_id OR metadata->>'order_id' = p_order_id::text);
      IF NOT FOUND THEN
        RETURN jsonb_build_object('applied', true, 'already_applied', true,
          'order_confirmed', false, 'reason', 'payment_order_mismatch');
      END IF;
      -- Verify payment is actually successful before confirming order
      PERFORM id FROM payments
      WHERE id = p_payment_id AND status = 'success';
      IF FOUND THEN
        UPDATE orders SET status = 'confirmed', updated_at = NOW()
        WHERE id = p_order_id AND status = 'pending';
        RETURN jsonb_build_object('applied', true, 'already_applied', true,
          'order_confirmed', true);
      END IF;
      -- Payment exists but not success — do not confirm
      RETURN jsonb_build_object('applied', true, 'already_applied', true,
        'order_confirmed', false);
    END IF;
    RETURN jsonb_build_object('applied', true, 'already_applied', true,
      'order_confirmed', false);
  END IF;

  -- 5. Lock inventory deterministically + validate + decrement
  FOR v_item IN
    SELECT oi.product_id, oi.variant_id, oi.quantity
    FROM order_items oi
    WHERE oi.order_id = p_order_id
    ORDER BY oi.product_id, oi.variant_id NULLS FIRST
  LOOP
    IF v_item.variant_id IS NOT NULL THEN
      -- Lock variant row
      SELECT pv.id, pv.stock_quantity
      INTO v_variant
      FROM product_variants pv
      WHERE pv.id = v_item.variant_id
      FOR UPDATE;

      IF FOUND AND v_variant.stock_quantity IS NOT NULL THEN
        -- Validate sufficiency if requested
        IF p_validate_sufficient AND v_variant.stock_quantity < v_item.quantity THEN
          -- Collect name for error reporting
          v_out_of_stock := array_append(v_out_of_stock,
            COALESCE((SELECT name FROM products WHERE id = v_item.product_id), 'Unknown'));
        ELSE
          UPDATE product_variants
          SET stock_quantity = GREATEST(0, stock_quantity - v_item.quantity)
          WHERE id = v_item.variant_id;
        END IF;
      END IF;
    ELSIF v_item.product_id IS NOT NULL THEN
      -- Lock product row
      SELECT p.id, p.stock_quantity, p.track_inventory, p.name
      INTO v_product
      FROM products p
      WHERE p.id = v_item.product_id
      FOR UPDATE;

      IF FOUND AND v_product.track_inventory AND v_product.stock_quantity IS NOT NULL THEN
        IF p_validate_sufficient AND v_product.stock_quantity < v_item.quantity THEN
          v_out_of_stock := array_append(v_out_of_stock, COALESCE(v_product.name, 'Unknown'));
        ELSE
          UPDATE products
          SET stock_quantity = GREATEST(0, stock_quantity - v_item.quantity)
          WHERE id = v_item.product_id;
        END IF;
      END IF;
    END IF;

    v_count := v_count + 1;
  END LOOP;

  -- 6. If stock validation was requested and items are out of stock, roll back
  IF p_validate_sufficient AND array_length(v_out_of_stock, 1) > 0 THEN
    RAISE EXCEPTION 'insufficient_stock:%', array_to_string(v_out_of_stock, ',');
  END IF;

  -- 7. Insert order-level marker (atomic with stock decrement)
  INSERT INTO order_stock_applications (order_id, payment_id, item_count)
  VALUES (p_order_id, p_payment_id, v_count);

  -- 8. When called with a payment_id (payment-confirmed context), also transition
  --    order from pending→confirmed INSIDE this same transaction/lock. This creates
  --    a real serialization contract with cancel_stale_order_atomic: both hold the
  --    order row FOR UPDATE, so only one can transition the status.
  --    Without this, the order status update in processSuccessfulPayment runs
  --    outside the FOR UPDATE lock and can race with cleanup.
  IF p_payment_id IS NOT NULL AND v_order.status = 'pending' THEN
    UPDATE orders SET status = 'confirmed', updated_at = NOW()
    WHERE id = p_order_id AND status = 'pending';
  END IF;

  RETURN jsonb_build_object('applied', true, 'already_applied', false, 'items', v_count,
    'order_confirmed', (p_payment_id IS NOT NULL AND v_order.status = 'pending'));
END;
$$;

-- ═══════════════════════════════════════════════════════
-- Step 5: Drop old function signature, revoke/grant new one
-- ═══════════════════════════════════════════════════════
-- Drop the old (UUID, UUID) signature that no longer matches
DROP FUNCTION IF EXISTS public.apply_order_stock_once(UUID, UUID);

DO $$
BEGIN
  REVOKE ALL ON FUNCTION public.apply_order_stock_once(UUID, UUID, BOOLEAN) FROM PUBLIC;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION public.apply_order_stock_once(UUID, UUID, BOOLEAN) FROM anon;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION public.apply_order_stock_once(UUID, UUID, BOOLEAN) FROM authenticated;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.apply_order_stock_once(UUID, UUID, BOOLEAN) TO service_role;
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════
-- Step 6: Executable privilege tests (hard gate)
-- ═══════════════════════════════════════════════════════
DO $$
DECLARE v_has BOOLEAN;
BEGIN
  -- anon must NOT execute
  SELECT has_function_privilege('anon', 'apply_order_stock_once(uuid, uuid, boolean)', 'EXECUTE')
  INTO v_has;
  IF v_has THEN
    RAISE EXCEPTION 'PRIVILEGE VIOLATION: anon can execute apply_order_stock_once';
  END IF;

  -- authenticated must NOT execute
  SELECT has_function_privilege('authenticated', 'apply_order_stock_once(uuid, uuid, boolean)', 'EXECUTE')
  INTO v_has;
  IF v_has THEN
    RAISE EXCEPTION 'PRIVILEGE VIOLATION: authenticated can execute apply_order_stock_once';
  END IF;

  -- service_role MUST execute
  SELECT has_function_privilege('service_role', 'apply_order_stock_once(uuid, uuid, boolean)', 'EXECUTE')
  INTO v_has;
  IF NOT v_has THEN
    RAISE EXCEPTION 'PRIVILEGE VIOLATION: service_role cannot execute apply_order_stock_once';
  END IF;

  RAISE NOTICE 'All privilege checks passed for apply_order_stock_once';
END $$;
