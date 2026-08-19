-- Migration 329: Atomic stale-order cleanup
--
-- cancel_stale_order_atomic(p_order_id):
--   - Lock order FOR UPDATE
--   - Require status='pending' and age >48h
--   - Check for successful payment linked to order; if found, skip cancellation
--   - Check order_stock_applications marker:
--     - EXISTS → deterministically restore inventory + delete marker
--     - NOT EXISTS → skip inventory (stock was never deducted)
--   - Set order cancelled
--   - All in one transaction
--
-- No restoration-marker table needed. The order row status transition
-- plus the canonical stock marker provide full crash/race safety.

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
  --
  -- Lock all payment rows FOR UPDATE, then check for success/finalization.
  -- apply_order_stock_once is the sole authority for order confirmation
  -- (pending→confirmed) AND stock application, both under a FOR UPDATE
  -- lock on the order row. This creates two-point serialization:
  --   Point 1: Order row FOR UPDATE (both cleanup and apply_order_stock_once)
  --   Point 2: Payment rows FOR UPDATE (cleanup locks, webhook blocks)
  --
  -- Race A (cleanup holds locks, webhook arrives):
  --   Cleanup holds order + payment row locks → payment authority's
  --   UPDATE on payment row BLOCKS → cleanup checks (no success) →
  --   cancels → commits → payment authority resumes → marks payment
  --   'success' → processSuccessfulPayment → apply_order_stock_once
  --   acquires order FOR UPDATE → status='cancelled' → rejects.
  --   Stock remains restored. Order stays cancelled.
  --
  -- Race B (payment authority commits payment='success' first):
  --   Payment authority commits payment.status='success' → cleanup
  --   FOR UPDATE on payment row → reads 'success' → refuses to cancel.
  --
  -- Race C (payment authority UPDATE in-flight):
  --   Payment authority holds implicit lock on payment row → cleanup
  --   FOR UPDATE blocks → authority commits (success) → cleanup reads
  --   'success' → refuses to cancel.
  --
  -- Also check finalization_processing_at: if a finalization claim is
  -- active (< 5 min old), a payment webhook is actively processing.
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

  -- 4b. Void all pending payments — serialization contract with payment authority.
  --
  -- Payment authority requires status='pending' to transition to 'success',
  -- so voiding here prevents a late payment from being authorized after
  -- cleanup commits. Without this, the payment authority's UPDATE to
  -- status='success' can resume after our FOR UPDATE lock releases,
  -- creating paid+cancelled inconsistency.
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
        SET stock_quantity = COALESCE(stock_quantity, 0) + v_item.quantity
        WHERE id = v_item.variant_id AND stock_quantity IS NOT NULL;
      ELSIF v_item.product_id IS NOT NULL THEN
        UPDATE products
        SET stock_quantity = COALESCE(stock_quantity, 0) + v_item.quantity
        WHERE id = v_item.product_id AND track_inventory = true;
      END IF;
      v_count := v_count + 1;
    END LOOP;

    -- 6b. Delete marker
    DELETE FROM order_stock_applications WHERE order_id = p_order_id;
  END IF;
  -- If marker DOES NOT EXIST: stock was never deducted → DO NOT alter inventory

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
-- Privilege hardening
-- ═══════════════════════════════════════════════════════
DO $$
BEGIN
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

-- ═══════════════════════════════════════════════════════
-- Executable privilege tests (hard gate)
-- ═══════════════════════════════════════════════════════
DO $$
DECLARE v_has BOOLEAN;
BEGIN
  SELECT has_function_privilege('anon', 'cancel_stale_order_atomic(uuid)', 'EXECUTE') INTO v_has;
  IF v_has THEN RAISE EXCEPTION 'PRIVILEGE VIOLATION: anon can execute cancel_stale_order_atomic'; END IF;

  SELECT has_function_privilege('authenticated', 'cancel_stale_order_atomic(uuid)', 'EXECUTE') INTO v_has;
  IF v_has THEN RAISE EXCEPTION 'PRIVILEGE VIOLATION: authenticated can execute cancel_stale_order_atomic'; END IF;

  SELECT has_function_privilege('service_role', 'cancel_stale_order_atomic(uuid)', 'EXECUTE') INTO v_has;
  IF NOT v_has THEN RAISE EXCEPTION 'PRIVILEGE VIOLATION: service_role cannot execute cancel_stale_order_atomic'; END IF;

  RAISE NOTICE 'All privilege checks passed for cancel_stale_order_atomic';
END $$;
