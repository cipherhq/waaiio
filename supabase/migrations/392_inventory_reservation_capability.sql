-- ════════════════════════════════════════════════════════
-- Migration 392: Inventory reservation capability schema
--
-- Phase 2A: DB foundation only. Zero application callers changed.
--
-- Changes:
--   1. Add reservation_class + expires_at to order_stock_applications
--   2. Deterministic backfill of existing terminal markers
--   3. Fix unlimited NULL-stock restoration in cancel_stale_order_atomic
--   4. Fix unlimited NULL-stock restoration in cancel_order_immediate
--   5. Self-verification
-- ════════════════════════════════════════════════════════

-- ─── 1. Schema: reservation columns ───────────────────

ALTER TABLE public.order_stock_applications
  ADD COLUMN IF NOT EXISTS reservation_class TEXT NOT NULL DEFAULT 'prepayment'
    CHECK (reservation_class IN ('instant', 'bank_transfer', 'committed', 'prepayment'));

ALTER TABLE public.order_stock_applications
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ DEFAULT NULL;

-- ─── 2. Backfill: terminal orders → committed ─────────
--
-- Production evidence (2026-09-21): 11 existing markers,
-- all for orders in terminal states (confirmed/shipped/delivered).
-- These must never expire. Non-terminal markers (if any) remain
-- as 'prepayment' (the DEFAULT), preserving existing 48h cleanup.

UPDATE public.order_stock_applications osa
SET reservation_class = 'committed', expires_at = NULL
FROM public.orders o
WHERE osa.order_id = o.id
  AND o.status IN ('confirmed', 'shipped', 'delivered')
  AND osa.reservation_class = 'prepayment';

-- ─── 3. Fix: cancel_stale_order_atomic unlimited NULL stock ──
--
-- Bug: product restoration uses track_inventory = true but not
-- stock_quantity IS NOT NULL. A tracked product with NULL stock
-- (unlimited) gets COALESCE(NULL,0) + qty = finite, corrupting
-- unlimited inventory. Variant restoration already has this guard.

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
  SELECT id, status, created_at
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

  -- 4. Payment gate: serialization contract with payment authority.
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

  -- 4b. Void all pending payments
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

    -- 6a. Deterministically lock and restore inventory
    FOR v_item IN
      SELECT oi.product_id, oi.variant_id, oi.quantity
      FROM order_items oi
      WHERE oi.order_id = p_order_id
      ORDER BY oi.product_id, oi.variant_id NULLS FIRST
    LOOP
      IF v_item.variant_id IS NOT NULL THEN
        UPDATE product_variants
        SET stock_quantity = stock_quantity + v_item.quantity
        WHERE id = v_item.variant_id AND stock_quantity IS NOT NULL;
      ELSIF v_item.product_id IS NOT NULL THEN
        -- FIX: Added stock_quantity IS NOT NULL to prevent NULL→finite corruption
        UPDATE products
        SET stock_quantity = stock_quantity + v_item.quantity
        WHERE id = v_item.product_id
          AND track_inventory = true
          AND stock_quantity IS NOT NULL;
      END IF;
      v_count := v_count + 1;
    END LOOP;

    -- 6b. Delete marker
    DELETE FROM order_stock_applications WHERE order_id = p_order_id;
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

-- Preserve existing ACL
REVOKE ALL ON FUNCTION public.cancel_stale_order_atomic(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cancel_stale_order_atomic(UUID) FROM anon;
REVOKE ALL ON FUNCTION public.cancel_stale_order_atomic(UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_stale_order_atomic(UUID) TO service_role;

-- ─── 4. Fix: cancel_order_immediate unlimited NULL stock ──

CREATE OR REPLACE FUNCTION public.cancel_order_immediate(
  p_order_id UUID,
  p_reason TEXT DEFAULT 'customer_cancel'
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
  -- 1. Lock order
  SELECT id, status
  INTO v_order FROM orders WHERE id = p_order_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('cancelled', false, 'reason', 'not_found');
  END IF;

  IF v_order.status != 'pending' THEN
    RETURN jsonb_build_object('cancelled', false, 'reason', v_order.status);
  END IF;

  -- 2. Payment gate
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

  -- 3. Void pending payments
  UPDATE payments
  SET status = 'failed',
      gateway_status = p_reason,
      updated_at = NOW()
  WHERE (order_id = p_order_id OR metadata->>'order_id' = p_order_id::text)
    AND status = 'pending';

  -- 4. Stock restoration
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
        SET stock_quantity = stock_quantity + v_item.quantity
        WHERE id = v_item.variant_id AND stock_quantity IS NOT NULL;
      ELSIF v_item.product_id IS NOT NULL THEN
        -- FIX: Added stock_quantity IS NOT NULL to prevent NULL→finite corruption
        UPDATE products
        SET stock_quantity = stock_quantity + v_item.quantity
        WHERE id = v_item.product_id
          AND track_inventory = true
          AND stock_quantity IS NOT NULL;
      END IF;
      v_count := v_count + 1;
    END LOOP;

    DELETE FROM order_stock_applications WHERE order_id = p_order_id;
  END IF;

  -- 5. Release promo reservation
  UPDATE promo_reservations
  SET state = 'released', updated_at = NOW()
  WHERE order_id = p_order_id AND state = 'reserved';

  -- 6. Cancel order
  UPDATE orders SET status = 'cancelled', updated_at = NOW() WHERE id = p_order_id;

  RETURN jsonb_build_object(
    'cancelled', true,
    'stock_restored', v_had_marker,
    'items_restored', v_count
  );
END;
$$;

-- Preserve existing ACL
REVOKE ALL ON FUNCTION public.cancel_order_immediate(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cancel_order_immediate(UUID, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.cancel_order_immediate(UUID, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_order_immediate(UUID, TEXT) TO service_role;

-- ─── 5. Self-verification ─────────────────────────────

DO $$
BEGIN
  -- Verify reservation_class column exists
  PERFORM 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'order_stock_applications'
      AND column_name = 'reservation_class';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'M392: reservation_class column not found on order_stock_applications';
  END IF;

  -- Verify expires_at column exists
  PERFORM 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'order_stock_applications'
      AND column_name = 'expires_at';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'M392: expires_at column not found on order_stock_applications';
  END IF;

  -- Verify no terminal markers remain as prepayment after backfill
  PERFORM 1 FROM order_stock_applications osa
  JOIN orders o ON osa.order_id = o.id
  WHERE o.status IN ('confirmed', 'shipped', 'delivered')
    AND osa.reservation_class = 'prepayment';
  IF FOUND THEN
    RAISE EXCEPTION 'M392: backfill incomplete — terminal orders still have prepayment class';
  END IF;

  -- Verify cancel_stale_order_atomic exists as SECURITY DEFINER
  PERFORM 1 FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public'
      AND p.proname = 'cancel_stale_order_atomic'
      AND p.prosecdef = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'M392: cancel_stale_order_atomic not found or not SECURITY DEFINER';
  END IF;

  -- Verify cancel_order_immediate exists as SECURITY DEFINER
  PERFORM 1 FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public'
      AND p.proname = 'cancel_order_immediate'
      AND p.prosecdef = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'M392: cancel_order_immediate not found or not SECURITY DEFINER';
  END IF;
END $$;
