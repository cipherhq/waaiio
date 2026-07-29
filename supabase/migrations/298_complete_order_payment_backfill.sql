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
--
-- PR #72 corrected all five active gateway initializePayment paths
-- to persist top-level order_id and business_id at write time.
-- Production smoke test confirmed zero new linkage failures.
--
-- This migration completes only the order_id linkage for verified
-- historical rows. It does NOT infer or assign payment business_id.

DO $$
DECLARE
  v_pending_count INTEGER;
  v_invalid_uuid_count INTEGER;
  v_missing_order_count INTEGER;
  v_cross_business_count INTEGER;
  v_updated_count INTEGER;
  v_remaining_count INTEGER;
BEGIN
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

  -- ── Validate all canonical UUIDs match existing orders ──
  SELECT COUNT(*) INTO v_missing_order_count
  FROM public.payments p
  WHERE p.order_id IS NULL
    AND p.metadata->>'order_id' IS NOT NULL
    AND TRIM(p.metadata->>'order_id') != ''
    AND TRIM(p.metadata->>'order_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND NOT EXISTS (
      SELECT 1 FROM public.orders o
      WHERE o.id = (TRIM(p.metadata->>'order_id'))::uuid
    );

  IF v_missing_order_count > 0 THEN
    RAISE EXCEPTION 'Migration 298 ABORTED: % metadata order_id values reference non-existent orders.', v_missing_order_count;
  END IF;

  -- ── Validate no cross-business ownership conflict ──
  -- A NULL payments.business_id is allowed (missing, not conflicting).
  SELECT COUNT(*) INTO v_cross_business_count
  FROM public.payments p
  JOIN public.orders o ON o.id = (TRIM(p.metadata->>'order_id'))::uuid
  WHERE p.order_id IS NULL
    AND p.metadata->>'order_id' IS NOT NULL
    AND TRIM(p.metadata->>'order_id') != ''
    AND TRIM(p.metadata->>'order_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND p.business_id IS NOT NULL
    AND p.business_id != o.business_id;

  IF v_cross_business_count > 0 THEN
    RAISE EXCEPTION 'Migration 298 ABORTED: % payments have business_id conflicting with the referenced order. Manual investigation required.', v_cross_business_count;
  END IF;

  -- ── All preflight checks passed — perform the update ──
  UPDATE public.payments p
  SET order_id = o.id
  FROM public.orders o
  WHERE p.order_id IS NULL
    AND p.metadata->>'order_id' IS NOT NULL
    AND TRIM(p.metadata->>'order_id') != ''
    AND TRIM(p.metadata->>'order_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND o.id = (TRIM(p.metadata->>'order_id'))::uuid;

  GET DIAGNOSTICS v_updated_count = ROW_COUNT;

  -- ── Assert exactly 11 rows updated ──
  IF v_updated_count != 11 THEN
    RAISE EXCEPTION 'Migration 298 ABORTED: expected to update 11 rows but updated %. Rolling back.', v_updated_count;
  END IF;

  -- ── Postcondition: zero eligible rows remain ──
  SELECT COUNT(*) INTO v_remaining_count
  FROM public.payments p
  WHERE p.order_id IS NULL
    AND p.metadata->>'order_id' IS NOT NULL
    AND TRIM(p.metadata->>'order_id') != ''
    AND TRIM(p.metadata->>'order_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND EXISTS (
      SELECT 1 FROM public.orders o
      WHERE o.id = (TRIM(p.metadata->>'order_id'))::uuid
    );

  IF v_remaining_count > 0 THEN
    RAISE EXCEPTION 'Migration 298 ABORTED: % eligible rows still have NULL order_id after update. Rolling back.', v_remaining_count;
  END IF;

  RAISE NOTICE 'Migration 298: successfully backfilled order_id for % payments.', v_updated_count;
END;
$$;
