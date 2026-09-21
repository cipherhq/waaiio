-- ════════════════════════════════════════════════════════
-- Migration 392: Inventory reservation capability schema
--
-- Phase 2A: DB foundation only. Zero application callers changed.
--
-- Changes:
--   1. Add reservation_class + expires_at to order_stock_applications
--   2. Deterministic backfill of existing terminal markers
--   3. Fix: cancel_stale_order_atomic unlimited NULL-stock restoration
--      + remove invalid payments.updated_at write (column does not exist)
--   4. Fix: cancel_order_immediate unlimited NULL-stock restoration
--   5. Self-verification
--
-- IMPORTANT: RPC bodies are exact copies of the canonical M333/M383
-- definitions with ONLY the documented corrections applied.
-- No other behavioral drift is permitted.
-- ════════════════════════════════════════════════════════

-- ─── 1. Schema: reservation columns ───────────────────

ALTER TABLE public.order_stock_applications
  ADD COLUMN IF NOT EXISTS reservation_class TEXT NOT NULL DEFAULT 'prepayment'
    CHECK (reservation_class IN ('instant', 'bank_transfer', 'committed', 'prepayment'));

ALTER TABLE public.order_stock_applications
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ DEFAULT NULL;

-- ─── 2. Fail-closed marker classification + backfill ──
--
-- Every pre-existing marker must be safely classifiable.
-- Ambiguous/inconsistent states FAIL the migration.

DO $$
DECLARE
  v_marker RECORD;
  v_order_status TEXT;
  v_has_success_payment BOOLEAN;
  v_has_active_finalization BOOLEAN;
BEGIN
  FOR v_marker IN
    SELECT osa.id, osa.order_id
    FROM public.order_stock_applications osa
  LOOP
    -- Check if order exists
    SELECT o.status::text INTO v_order_status
    FROM public.orders o WHERE o.id = v_marker.order_id;

    IF v_order_status IS NULL THEN
      RAISE EXCEPTION 'M392: orphan stock marker % — no matching order %', v_marker.id, v_marker.order_id;
    END IF;

    IF v_order_status IN ('confirmed', 'shipped', 'delivered') THEN
      -- Terminal order → committed
      UPDATE public.order_stock_applications
      SET reservation_class = 'committed', expires_at = NULL
      WHERE id = v_marker.id;

    ELSIF v_order_status = 'cancelled' THEN
      RAISE EXCEPTION 'M392: cancelled-order stock marker % for order %', v_marker.id, v_marker.order_id;

    ELSIF v_order_status = 'pending' THEN
      -- Check for successful payment
      SELECT EXISTS (
        SELECT 1 FROM public.payments
        WHERE (order_id = v_marker.order_id OR metadata->>'order_id' = v_marker.order_id::text)
          AND status = 'success'
      ) INTO v_has_success_payment;

      IF v_has_success_payment THEN
        RAISE EXCEPTION 'M392: pending order % has stock marker AND successful payment — inconsistent state', v_marker.order_id;
      END IF;

      -- Check for active finalization
      SELECT EXISTS (
        SELECT 1 FROM public.payments
        WHERE (order_id = v_marker.order_id OR metadata->>'order_id' = v_marker.order_id::text)
          AND finalization_processing_at IS NOT NULL
          AND finalization_processing_at > NOW() - INTERVAL '5 minutes'
      ) INTO v_has_active_finalization;

      IF v_has_active_finalization THEN
        RAISE EXCEPTION 'M392: pending order % has stock marker AND active finalization — inconsistent state', v_marker.order_id;
      END IF;

      -- Safe: pending with no successful payment and no active finalization → prepayment
      -- (already the DEFAULT, no UPDATE needed)

    ELSE
      -- draft, processing, ready, or any other unsupported status
      RAISE EXCEPTION 'M392: unsupported order status ''%'' for stock marker %', v_order_status, v_marker.id;
    END IF;
  END LOOP;
END $$;

-- ─── 3. Fix: cancel_stale_order_atomic ────────────────
-- Exact canonical body from M333:412-512 with TWO corrections:
-- (a) Line 490: Added AND stock_quantity IS NOT NULL for product restoration
-- (b) Line 467: Removed payments.updated_at = NOW() (column does not exist)

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
  -- FIX (b): Removed payments.updated_at = NOW() — column does not exist in production
  UPDATE payments
  SET status = 'failed',
      gateway_status = 'stale_order_cancelled'
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
        -- FIX (a): Added AND stock_quantity IS NOT NULL to prevent NULL→finite corruption
        UPDATE products
        SET stock_quantity = COALESCE(stock_quantity, 0) + v_item.quantity
        WHERE id = v_item.product_id
          AND track_inventory = true
          AND stock_quantity IS NOT NULL;
      END IF;
      v_count := v_count + 1;
    END LOOP;

    DELETE FROM order_stock_applications WHERE order_id = p_order_id;
  END IF;

  -- 6. Release promo reservation (PRESERVED from canonical M333)
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

-- Preserve existing ACL (from M333:517-529)
REVOKE ALL ON FUNCTION public.cancel_stale_order_atomic(UUID) FROM PUBLIC;
DO $$ BEGIN
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

-- ─── 4. Fix: cancel_order_immediate ──────────────────
-- Exact canonical body from M383:815-931 with ONE correction:
-- Line 890: Added AND stock_quantity IS NOT NULL for product restoration
-- All other behavior preserved: promo cleanup, finalized-promo accounting,
-- quote reversion, payment fencing, return semantics.

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
  v_quote_id UUID;
BEGIN
  -- 1. Lock order row
  SELECT id, status, promo_code_id, quote_request_id
  INTO v_order FROM orders WHERE id = p_order_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('cancelled', false, 'reason', 'not_found');
  END IF;

  -- 2. Status gate: only pending orders
  IF v_order.status != 'pending' THEN
    RETURN jsonb_build_object('cancelled', false, 'reason', v_order.status);
  END IF;

  -- 3. Payment authority fence: lock payment rows FOR UPDATE, check for success/active finalization
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

  -- 4. Void pending payments
  UPDATE payments
  SET status = 'failed',
      gateway_status = p_reason
  WHERE (order_id = p_order_id OR metadata->>'order_id' = p_order_id::text)
    AND status = 'pending';

  -- 5. Check canonical stock marker and restore if present
  PERFORM id FROM order_stock_applications WHERE order_id = p_order_id;

  IF FOUND THEN
    v_had_marker := true;

    -- Deterministically lock and restore inventory
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
        -- FIX: Added AND stock_quantity IS NOT NULL to prevent NULL→finite corruption
        UPDATE products
        SET stock_quantity = COALESCE(stock_quantity, 0) + v_item.quantity
        WHERE id = v_item.product_id
          AND track_inventory = true
          AND stock_quantity IS NOT NULL;
      END IF;
      v_count := v_count + 1;
    END LOOP;

    -- Delete marker
    DELETE FROM order_stock_applications WHERE order_id = p_order_id;
  END IF;

  -- 6. Release promo reservation (PRESERVED from canonical M383)
  IF v_order.promo_code_id IS NOT NULL THEN
    -- Delete reservation (unreserve)
    DELETE FROM promo_reservations
    WHERE order_id = p_order_id AND state = 'reserved';

    -- If finalized, also decrement current_uses
    IF EXISTS (SELECT 1 FROM promo_reservations WHERE order_id = p_order_id AND state = 'finalized') THEN
      UPDATE promo_codes SET current_uses = GREATEST(current_uses - 1, 0)
      WHERE id = v_order.promo_code_id;
      DELETE FROM promo_reservations WHERE order_id = p_order_id AND state = 'finalized';
    END IF;
  END IF;

  -- 7. Cancel order
  UPDATE orders SET status = 'cancelled', updated_at = NOW() WHERE id = p_order_id;

  -- 8. Revert quote status if quote-origin (PRESERVED from canonical M383)
  IF v_order.quote_request_id IS NOT NULL THEN
    UPDATE quote_requests
    SET status = 'quoted', order_id = NULL, responded_at = NULL
    WHERE id = v_order.quote_request_id
      AND status = 'accepted';
  END IF;

  RETURN jsonb_build_object(
    'cancelled', true,
    'reason', p_reason,
    'stock_restored', v_had_marker,
    'items_restored', v_count
  );
END;
$$;

-- Preserve existing ACL (from M383:1584-1595)
DO $$ BEGIN
  REVOKE ALL ON FUNCTION public.cancel_order_immediate(UUID, TEXT) FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION public.cancel_order_immediate(UUID, TEXT) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION public.cancel_order_immediate(UUID, TEXT) FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.cancel_order_immediate(UUID, TEXT) TO service_role;
  END IF;
END $$;

-- ─── 5. Self-verification ─────────────────────────────

DO $$
BEGIN
  -- Verify reservation_class column exists and is NOT NULL
  PERFORM 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'order_stock_applications'
      AND column_name = 'reservation_class'
      AND is_nullable = 'NO';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'M392: reservation_class NOT NULL column not found on order_stock_applications';
  END IF;

  -- Verify expires_at column exists
  PERFORM 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'order_stock_applications'
      AND column_name = 'expires_at';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'M392: expires_at column not found on order_stock_applications';
  END IF;

  -- Verify DEFAULT is exactly 'prepayment' (exact catalog check)
  PERFORM 1 FROM pg_catalog.pg_attrdef d
    JOIN pg_catalog.pg_attribute a ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    JOIN pg_catalog.pg_class c ON a.attrelid = c.oid
    JOIN pg_catalog.pg_namespace n ON c.relnamespace = n.oid
    WHERE n.nspname = 'public'
      AND c.relname = 'order_stock_applications'
      AND a.attname = 'reservation_class'
      AND pg_get_expr(d.adbin, d.adrelid) = '''prepayment''::text';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'M392: reservation_class default is not exactly prepayment';
  END IF;

  -- Verify CHECK constraint exists for reservation_class
  PERFORM 1 FROM information_schema.check_constraints
    WHERE constraint_name LIKE '%reservation_class%';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'M392: reservation_class CHECK constraint not found';
  END IF;

  -- Verify no terminal markers remain as prepayment after backfill
  PERFORM 1 FROM order_stock_applications osa
  JOIN orders o ON osa.order_id = o.id
  WHERE o.status IN ('confirmed', 'shipped', 'delivered')
    AND osa.reservation_class = 'prepayment';
  IF FOUND THEN
    RAISE EXCEPTION 'M392: backfill incomplete — terminal orders still have prepayment class';
  END IF;

  -- Verify no unclassifiable markers remain (cancelled/orphan would have failed above)
  -- All markers must be either 'committed' (terminal) or 'prepayment' (safe pending)
  PERFORM 1 FROM order_stock_applications
    WHERE reservation_class NOT IN ('committed', 'prepayment');
  IF FOUND THEN
    RAISE EXCEPTION 'M392: unclassifiable marker found with unexpected reservation_class';
  END IF;

  -- Verify both RPCs exist as SECURITY DEFINER
  PERFORM 1 FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public'
      AND p.proname = 'cancel_stale_order_atomic'
      AND p.prosecdef = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'M392: cancel_stale_order_atomic not found or not SECURITY DEFINER';
  END IF;

  PERFORM 1 FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public'
      AND p.proname = 'cancel_order_immediate'
      AND p.prosecdef = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'M392: cancel_order_immediate not found or not SECURITY DEFINER';
  END IF;
END $$;
