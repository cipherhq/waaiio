-- Migration 298: Complete the Migration 167 historical order_id backfill
--
-- Background:
--   Migration 167 added payments.order_id and intended to backfill from
--   metadata->>'order_id'. However, 11 legacy rows were not backfilled
--   because their metadata order IDs were written after the migration ran.
--
-- Read-only production verification found:
--   - 11 incomplete legacy rows with payments.order_id IS NULL
--   - All 11 metadata order IDs are canonical UUIDs
--   - All 11 match existing orders
--   - All 11 have payments.business_id IS NULL
--   - No cross-business ownership conflict was found
--   - All 11 rows were created before 2026-07-29T04:21:48.741960+00:00
--
-- PR #72 corrected all five active gateway initializePayment paths
-- to persist top-level order_id and business_id at write time.
-- Production smoke test confirmed zero new linkage failures.
--
-- This migration completes only the order_id linkage for verified
-- historical rows. It does NOT infer or assign payment business_id.
--
-- Safety:
--   - Locks orders (SHARE) then payments (SHARE ROW EXCLUSIVE) to
--     prevent concurrent changes during the verified cohort check.
--     Orders locked first because the application's normal write order
--     is: create/update order, then create payment. Locking in the same
--     order reduces deadlock risk.
--   - SHARE on orders prevents concurrent INSERT, UPDATE and DELETE
--     during the short migration transaction. Normal reads remain allowed.
--   - SHARE ROW EXCLUSIVE on payments prevents concurrent INSERT, UPDATE
--     and DELETE. Normal reads remain allowed.
--   - Both locks preserve the verified 11-row cohort and referenced order
--     state throughout preflight, update and postcondition checks.
--   - Captures a complete JSONB snapshot of target rows (excluding
--     order_id) before and after the UPDATE to prove no other payment
--     column was changed by triggers or side effects.
--   - Enforces a timestamp boundary: only rows created before the
--     original verification timestamp may be updated
--   - Repeats ownership guard in the actual UPDATE
--   - Asserts exactly 11 rows updated
--   - Verifies no pending rows remain
--   - Uses safe text comparison (no metadata UUID cast)
--   - Idempotent: exits cleanly when already complete

DO $$
DECLARE
  v_verification_boundary TIMESTAMPTZ := '2026-07-29T04:21:48.741960+00:00';
  v_pending_count INTEGER;
  v_null_created_at_count INTEGER;
  v_post_boundary_count INTEGER;
  v_invalid_uuid_count INTEGER;
  v_missing_order_count INTEGER;
  v_cross_business_count INTEGER;
  v_target_ids UUID[];
  v_target_count INTEGER;
  v_before_snapshot JSONB;
  v_after_snapshot JSONB;
  v_updated_count INTEGER;
  v_remaining_count INTEGER;
  v_verified_order_id_count INTEGER;
BEGIN
  -- ── Lock tables to preserve verified cohort ──
  -- Orders locked first: matches application write order (order → payment),
  -- reducing deadlock risk.
  -- SHARE on orders: prevents concurrent INSERT, UPDATE, DELETE.
  -- SHARE ROW EXCLUSIVE on payments: prevents concurrent INSERT, UPDATE, DELETE.
  -- Both allow normal reads.
  LOCK TABLE public.orders IN SHARE MODE;
  LOCK TABLE public.payments IN SHARE ROW EXCLUSIVE MODE;

  -- ── Count pending rows ──
  SELECT COUNT(*) INTO v_pending_count
  FROM public.payments
  WHERE order_id IS NULL
    AND metadata->>'order_id' IS NOT NULL
    AND TRIM(metadata->>'order_id') != '';

  -- ── Idempotent: if already completed, exit cleanly ──
  IF v_pending_count = 0 THEN
    RAISE NOTICE 'Migration 298: 0 pending rows — already complete, no changes made.';
    RETURN;
  END IF;

  -- ── Fail-closed: only the verified 11-row state may proceed ──
  IF v_pending_count != 11 THEN
    RAISE EXCEPTION 'Migration 298 ABORTED: expected 11 pending rows but found %. Manual investigation required.', v_pending_count;
  END IF;

  -- ── Enforce timestamp boundary: all pending rows must predate verification ──
  SELECT COUNT(*) INTO v_null_created_at_count
  FROM public.payments
  WHERE order_id IS NULL
    AND metadata->>'order_id' IS NOT NULL
    AND TRIM(metadata->>'order_id') != ''
    AND created_at IS NULL;

  IF v_null_created_at_count > 0 THEN
    RAISE EXCEPTION 'Migration 298 ABORTED: % pending rows have NULL created_at. Cannot verify temporal boundary.', v_null_created_at_count;
  END IF;

  SELECT COUNT(*) INTO v_post_boundary_count
  FROM public.payments
  WHERE order_id IS NULL
    AND metadata->>'order_id' IS NOT NULL
    AND TRIM(metadata->>'order_id') != ''
    AND created_at > v_verification_boundary;

  IF v_post_boundary_count > 0 THEN
    RAISE EXCEPTION 'Migration 298 ABORTED: % pending rows were created after the verification boundary (%). These are not part of the verified cohort.', v_post_boundary_count, v_verification_boundary;
  END IF;

  -- ── Validate all metadata order IDs are canonical UUIDs ──
  SELECT COUNT(*) INTO v_invalid_uuid_count
  FROM public.payments
  WHERE order_id IS NULL
    AND metadata->>'order_id' IS NOT NULL
    AND TRIM(metadata->>'order_id') != ''
    AND TRIM(metadata->>'order_id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

  IF v_invalid_uuid_count > 0 THEN
    RAISE EXCEPTION 'Migration 298 ABORTED: % pending metadata order_id values are not canonical UUIDs.', v_invalid_uuid_count;
  END IF;

  -- ── Validate all canonical UUIDs match existing orders (safe text comparison) ──
  SELECT COUNT(*) INTO v_missing_order_count
  FROM public.payments p
  WHERE p.order_id IS NULL
    AND p.metadata->>'order_id' IS NOT NULL
    AND TRIM(p.metadata->>'order_id') != ''
    AND TRIM(p.metadata->>'order_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND NOT EXISTS (
      SELECT 1 FROM public.orders o
      WHERE o.id::text = TRIM(p.metadata->>'order_id')
    );

  IF v_missing_order_count > 0 THEN
    RAISE EXCEPTION 'Migration 298 ABORTED: % metadata order_id values reference non-existent orders.', v_missing_order_count;
  END IF;

  -- ── Validate no cross-business ownership conflict ──
  SELECT COUNT(*) INTO v_cross_business_count
  FROM public.payments p
  JOIN public.orders o ON o.id::text = TRIM(p.metadata->>'order_id')
  WHERE p.order_id IS NULL
    AND p.metadata->>'order_id' IS NOT NULL
    AND TRIM(p.metadata->>'order_id') != ''
    AND TRIM(p.metadata->>'order_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND p.business_id IS NOT NULL
    AND p.business_id IS DISTINCT FROM o.business_id;

  IF v_cross_business_count > 0 THEN
    RAISE EXCEPTION 'Migration 298 ABORTED: % payments have business_id conflicting with the referenced order.', v_cross_business_count;
  END IF;

  -- ── Capture target IDs and pre-update snapshot ──
  -- Uses the same complete eligibility predicates as the UPDATE.
  SELECT ARRAY_AGG(p.id ORDER BY p.id)
  INTO v_target_ids
  FROM public.payments p
  WHERE p.order_id IS NULL
    AND p.metadata->>'order_id' IS NOT NULL
    AND TRIM(p.metadata->>'order_id') != ''
    AND TRIM(p.metadata->>'order_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND EXISTS (
      SELECT 1 FROM public.orders o
      WHERE o.id::text = TRIM(p.metadata->>'order_id')
    )
    AND p.created_at <= v_verification_boundary
    AND (p.business_id IS NULL OR p.business_id IS NOT DISTINCT FROM (
      SELECT o.business_id FROM public.orders o
      WHERE o.id::text = TRIM(p.metadata->>'order_id')
    ));

  v_target_count := COALESCE(array_length(v_target_ids, 1), 0);

  IF v_target_count != 11 THEN
    RAISE EXCEPTION 'Migration 298 ABORTED: expected 11 target IDs but captured %. Manual investigation required.', v_target_count;
  END IF;

  -- Snapshot every column except order_id, in deterministic ID order
  SELECT jsonb_agg(to_jsonb(p) - 'order_id' ORDER BY p.id)
  INTO v_before_snapshot
  FROM public.payments p
  WHERE p.id = ANY(v_target_ids);

  -- ── All preflight checks passed — perform the update ──
  -- The UPDATE repeats the ownership guard: only update when
  -- business_id IS NULL or business_id matches the order.
  UPDATE public.payments p
  SET order_id = o.id
  FROM public.orders o
  WHERE p.order_id IS NULL
    AND p.metadata->>'order_id' IS NOT NULL
    AND TRIM(p.metadata->>'order_id') != ''
    AND TRIM(p.metadata->>'order_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND o.id::text = TRIM(p.metadata->>'order_id')
    AND p.created_at <= v_verification_boundary
    AND (p.business_id IS NULL OR p.business_id IS NOT DISTINCT FROM o.business_id);

  GET DIAGNOSTICS v_updated_count = ROW_COUNT;

  -- ── Postcondition 1: Exactly 11 rows updated ──
  IF v_updated_count != 11 THEN
    RAISE EXCEPTION 'Migration 298 ABORTED: expected to update 11 rows but updated %. Rolling back.', v_updated_count;
  END IF;

  -- ── Postcondition 2: All target IDs now have non-null order_id ──
  SELECT COUNT(*) INTO v_verified_order_id_count
  FROM public.payments
  WHERE id = ANY(v_target_ids)
    AND order_id IS NOT NULL;

  IF v_verified_order_id_count != 11 THEN
    RAISE EXCEPTION 'Migration 298 ABORTED: expected 11 target IDs with non-null order_id but found %. Rolling back.', v_verified_order_id_count;
  END IF;

  -- ── Postcondition 3: order_id matches trimmed metadata order ID ──
  SELECT COUNT(*) INTO v_verified_order_id_count
  FROM public.payments p
  WHERE p.id = ANY(v_target_ids)
    AND p.order_id::text = TRIM(p.metadata->>'order_id');

  IF v_verified_order_id_count != 11 THEN
    RAISE EXCEPTION 'Migration 298 ABORTED: % of 11 target payments have order_id matching metadata. Expected all 11.', v_verified_order_id_count;
  END IF;

  -- ── Postcondition 4: Zero pending rows with non-empty metadata order_id remain ──
  SELECT COUNT(*) INTO v_remaining_count
  FROM public.payments p
  WHERE p.order_id IS NULL
    AND p.metadata->>'order_id' IS NOT NULL
    AND TRIM(p.metadata->>'order_id') != ''
    AND TRIM(p.metadata->>'order_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND EXISTS (
      SELECT 1 FROM public.orders o
      WHERE o.id::text = TRIM(p.metadata->>'order_id')
    );

  IF v_remaining_count > 0 THEN
    RAISE EXCEPTION 'Migration 298 ABORTED: % eligible rows still have NULL order_id after update.', v_remaining_count;
  END IF;

  -- ── Postcondition 5: Complete-row immutability — only order_id changed ──
  -- Re-read the exact target IDs and build the same snapshot excluding order_id.
  SELECT jsonb_agg(to_jsonb(p) - 'order_id' ORDER BY p.id)
  INTO v_after_snapshot
  FROM public.payments p
  WHERE p.id = ANY(v_target_ids);

  IF v_before_snapshot IS DISTINCT FROM v_after_snapshot THEN
    RAISE EXCEPTION 'Migration 298 ABORTED: immutability violation — payment columns other than order_id were changed. Before and after snapshots differ. Rolling back.';
  END IF;

  RAISE NOTICE 'Migration 298: successfully backfilled order_id for % payments. Timestamp boundary: %. All non-order_id columns verified unchanged.', v_updated_count, v_verification_boundary;
END;
$$;
