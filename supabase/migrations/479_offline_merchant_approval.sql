-- ═══════════════════════════════════════════════════════════════════════════
-- M475: Offline Merchant Approval — Payment vs Fulfillment Separation
--
-- Owner policy (#721/#736): All offline bank-transfer orders/bookings/
-- reservations require explicit merchant approval after funds verification.
-- "Confirm Payment Only" vs "Confirm Payment & Approve".
-- Bank transfer OFF by default (Owner Option B).
-- Refund via existing ledger (Owner Option X).
--
-- Changes:
--   1. order_status enum: add 'paid_pending_approval'
--   2. pending_transfers: add proof_submitted_at, proof_protected columns
--   3. refunds status CHECK: add merchant_obligation/settled/admin_resolved
--   4. refunds unique index: lifetime merchant obligation per payment
--   5. submit_transfer_proof: atomic proof submission with consistent locks
--   6. confirm_order_transfer_atomic: 5-arg with approval control
--   7. cancel_stale_order_atomic: proof protection (preserves deadlines)
--   8. finalize_promo_reservation: paid_pending_approval awareness
--   9. confirm_nonorder_transfer_atomic: atomic non-order confirmation
--  10. approve_paid_order: second-step fulfillment approval
--  11. reject_paid_order: cancellation with refund obligation
--
-- Lock order everywhere: order → transfer → marker (consistent with M394).
-- Does NOT modify: apply_order_stock_once, online payment paths, old 4-arg RPC.
-- Old 4-arg confirm_order_transfer_atomic is retained for deployment compat.
-- Migration B (separate, post-deploy) drops the old 4-arg overload.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Order status enum ─────────────────────────────────────────────────
ALTER TYPE order_status ADD VALUE IF NOT EXISTS 'paid_pending_approval' AFTER 'pending';

-- ── 2. Pending transfers: proof tracking ─────────────────────────────────
-- proof_submitted_at: DB-authoritative timestamp, set only by submit_transfer_proof RPC.
-- proof_protected: set only by cancel_stale_order_atomic when timely proof is found.
--   Confirmation RPC independently validates proof chain — does NOT blindly trust the flag.
--   The flag exists so cleanup can skip already-protected transfers idempotently.
--   Authenticated RLS allows owner UPDATE on pending_transfers, but the confirmation
--   RPC validates: proof_submitted_at < original expires_at (DB time authority),
--   transfer status, marker class, payment winner — not just this boolean.
ALTER TABLE pending_transfers ADD COLUMN IF NOT EXISTS proof_submitted_at TIMESTAMPTZ;
ALTER TABLE pending_transfers ADD COLUMN IF NOT EXISTS proof_protected BOOLEAN NOT NULL DEFAULT FALSE;

-- ── 3. Refunds: merchant obligation lifecycle (Owner Option X) ───────────
ALTER TABLE refunds DROP CONSTRAINT IF EXISTS refunds_status_check;
ALTER TABLE refunds ADD CONSTRAINT refunds_status_check
  CHECK (status IN (
    'pending', 'provider_pending', 'provider_ambiguous',
    'provider_success_unfinalized', 'success', 'failed',
    'merchant_obligation', 'merchant_settled', 'admin_resolved'
  ));

-- ── 4. Lifetime unique: one merchant obligation per direct payment ───────
-- Covers all three merchant-obligation states: prevents re-insertion after settlement.
CREATE UNIQUE INDEX IF NOT EXISTS idx_refunds_merchant_obligation_lifetime
  ON refunds (payment_id)
  WHERE status IN ('merchant_obligation', 'merchant_settled', 'admin_resolved');


-- ═══════════════════════════════════════════════════════════════════════════
-- 5. submit_transfer_proof — atomic proof submission
--    Lock order: order → transfer → marker (consistent with M394/cleanup)
--    Enforces 24h deadline using DB time, immutable first timestamp.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.submit_transfer_proof(
  p_transfer_id UUID,
  p_business_id UUID,
  p_proof_type TEXT,
  p_proof_image_url TEXT,
  p_proof_text TEXT,
  p_ocr_result JSONB,
  p_verified_by_ocr BOOLEAN DEFAULT FALSE
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_transfer RECORD;
  v_order RECORD;
  v_order_id UUID;
  v_marker RECORD;
  v_now TIMESTAMPTZ := NOW();
  v_rows INTEGER;
BEGIN
  -- Discover only; never take a transfer lock before its associated order.
  SELECT order_id INTO v_order_id
  FROM pending_transfers WHERE id = p_transfer_id;
  IF NOT FOUND THEN
    RETURN '{"submitted":false,"reason":"not_found"}'::jsonb;
  END IF;

  -- 1. Lock the discovered order first, matching confirmation and cleanup.
  IF v_order_id IS NOT NULL THEN
    SELECT id, business_id, status INTO v_order
    FROM orders WHERE id = v_order_id FOR UPDATE;
    IF NOT FOUND THEN
      RETURN '{"submitted":false,"reason":"order_not_found"}'::jsonb;
    END IF;
  END IF;

  -- 2. Lock and re-read the transfer; discovery was not authoritative.
  SELECT id, business_id, status, order_id, expires_at, proof_submitted_at
  INTO v_transfer
  FROM pending_transfers WHERE id = p_transfer_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN '{"submitted":false,"reason":"not_found"}'::jsonb;
  END IF;
  IF v_transfer.order_id IS DISTINCT FROM v_order_id THEN
    RETURN '{"submitted":false,"reason":"transfer_order_changed"}'::jsonb;
  END IF;
  IF v_transfer.business_id IS DISTINCT FROM p_business_id THEN
    RETURN '{"submitted":false,"reason":"business_mismatch"}'::jsonb;
  END IF;
  IF v_transfer.status != 'pending' THEN
    RETURN jsonb_build_object('submitted', false, 'reason', 'status_' || v_transfer.status);
  END IF;

  -- Deadline and first-proof timestamp retain the existing DB-time semantics.
  IF v_transfer.expires_at <= v_now THEN
    RETURN '{"submitted":false,"reason":"transfer_expired"}'::jsonb;
  END IF;

  -- 3. Validate the locked order and then lock its stock marker.
  IF v_order_id IS NOT NULL THEN
    IF v_order.business_id IS DISTINCT FROM p_business_id THEN
      RETURN '{"submitted":false,"reason":"business_mismatch"}'::jsonb;
    END IF;
    IF v_order.status != 'pending' THEN
      RETURN jsonb_build_object('submitted', false, 'reason', 'order_' || v_order.status);
    END IF;
    SELECT reservation_class INTO v_marker
    FROM order_stock_applications WHERE order_id = v_order_id FOR UPDATE;
    IF FOUND AND v_marker.reservation_class = 'committed' THEN
      RETURN '{"submitted":false,"reason":"online_payment_won"}'::jsonb;
    END IF;
  END IF;

  -- 4. Write proof with DB-authoritative timestamp (immutable first submission)
  UPDATE pending_transfers SET
    proof_type = p_proof_type,
    proof_image_url = COALESCE(p_proof_image_url, proof_image_url),
    proof_text = COALESCE(p_proof_text, proof_text),
    proof_submitted_at = COALESCE(proof_submitted_at, v_now),
    verified_by_ocr = p_verified_by_ocr,
    ocr_result = p_ocr_result,
    updated_at = v_now
  WHERE id = p_transfer_id AND status = 'pending';

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows < 1 THEN
    RETURN '{"submitted":false,"reason":"update_failed"}'::jsonb;
  END IF;

  RETURN jsonb_build_object('submitted', true, 'transfer_id', p_transfer_id,
    'proof_submitted_at', COALESCE(v_transfer.proof_submitted_at, v_now));
END; $$;

REVOKE ALL ON FUNCTION public.submit_transfer_proof(UUID,UUID,TEXT,TEXT,TEXT,JSONB,BOOLEAN) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION public.submit_transfer_proof(UUID,UUID,TEXT,TEXT,TEXT,JSONB,BOOLEAN) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION public.submit_transfer_proof(UUID,UUID,TEXT,TEXT,TEXT,JSONB,BOOLEAN) FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.submit_transfer_proof(UUID,UUID,TEXT,TEXT,TEXT,JSONB,BOOLEAN) TO service_role;
  END IF;
END $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- 6. confirm_order_transfer_atomic — 5-arg with approval control
--    Coexists with existing M394 4-arg (dropped in Migration B).
--    Preserves all M394 payment authority. Adds p_approve_fulfillment.
--    Proof-protected transfers: skip expiry check if timely proof exists.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.confirm_order_transfer_atomic(
  p_transfer_id UUID,
  p_order_id UUID,
  p_business_id UUID,
  p_confirmed_by UUID,
  p_approve_fulfillment BOOLEAN
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_order RECORD;
  v_transfer RECORD;
  v_marker RECORD;
  v_has_payment BOOLEAN;
  v_new_payment_id UUID;
  v_now TIMESTAMPTZ := NOW();
BEGIN
  -- 1. Lock order (consistent: order → transfer → marker)
  SELECT id, status, business_id, total_amount, promo_code_id
  INTO v_order FROM orders WHERE id = p_order_id FOR UPDATE;

  IF NOT FOUND THEN RETURN '{"confirmed":false,"reason":"order_not_found"}'::jsonb; END IF;
  IF v_order.status = 'confirmed' THEN RETURN '{"confirmed":false,"reason":"already_confirmed"}'::jsonb; END IF;
  IF v_order.status != 'pending' THEN RETURN jsonb_build_object('confirmed', false, 'reason', v_order.status); END IF;
  IF v_order.business_id != p_business_id THEN RETURN '{"confirmed":false,"reason":"business_mismatch"}'::jsonb; END IF;

  -- 2. Lock transfer
  SELECT id, order_id, business_id, expected_amount, currency, reference_code,
         status, expires_at, metadata, customer_phone, customer_name,
         proof_submitted_at, proof_protected
  INTO v_transfer FROM pending_transfers WHERE id = p_transfer_id FOR UPDATE;

  IF NOT FOUND THEN RETURN '{"confirmed":false,"reason":"transfer_not_found"}'::jsonb; END IF;
  IF v_transfer.status = 'confirmed' THEN RETURN '{"confirmed":false,"reason":"transfer_already_confirmed"}'::jsonb; END IF;
  IF v_transfer.status != 'pending' THEN RETURN jsonb_build_object('confirmed', false, 'reason', 'transfer_' || v_transfer.status); END IF;
  IF v_transfer.order_id != p_order_id THEN RETURN '{"confirmed":false,"reason":"transfer_order_mismatch"}'::jsonb; END IF;
  IF v_transfer.business_id != p_business_id THEN RETURN '{"confirmed":false,"reason":"transfer_business_mismatch"}'::jsonb; END IF;

  -- 3. Lock marker
  SELECT id, reservation_class, expires_at, payment_id
  INTO v_marker FROM order_stock_applications WHERE order_id = p_order_id FOR UPDATE;

  IF NOT FOUND THEN RETURN '{"confirmed":false,"reason":"no_stock_marker"}'::jsonb; END IF;
  IF v_marker.reservation_class != 'bank_transfer' THEN
    RETURN jsonb_build_object('confirmed', false, 'reason', 'marker_class_' || v_marker.reservation_class);
  END IF;

  -- Expiry gate: allow if (a) not expired, OR (b) proof-protected with timely proof
  IF v_transfer.proof_protected
     AND v_transfer.proof_submitted_at IS NOT NULL
     AND v_transfer.proof_submitted_at <= v_transfer.expires_at THEN
    -- Proof was submitted before original deadline (DB timestamps).
    -- Original deadlines are preserved — NOT nullified or extended.
    -- Marker and transfer expires_at remain at their original values.
    -- Merchant can confirm because timely proof was submitted.
    -- Additional validation: marker and transfer deadlines must still match.
    IF v_marker.expires_at IS NULL OR v_transfer.expires_at IS NULL
       OR v_marker.expires_at != v_transfer.expires_at THEN
      RETURN '{"confirmed":false,"reason":"deadline_mismatch"}'::jsonb;
    END IF;
    -- Skip the expires_at <= NOW() check (proof-protected)
  ELSE
    -- Standard M394 expiry checks (unchanged)
    IF v_marker.expires_at IS NULL OR v_transfer.expires_at IS NULL
       OR v_marker.expires_at != v_transfer.expires_at THEN
      RETURN '{"confirmed":false,"reason":"deadline_mismatch"}'::jsonb;
    END IF;
    IF v_marker.expires_at <= v_now THEN
      RETURN '{"confirmed":false,"reason":"reservation_expired"}'::jsonb;
    END IF;
  END IF;

  IF v_marker.payment_id IS NOT NULL THEN
    RETURN '{"confirmed":false,"reason":"marker_has_payment"}'::jsonb;
  END IF;

  -- 4. Payment conflict fence (unchanged from M394)
  PERFORM id FROM payments
  WHERE (order_id = p_order_id OR metadata->>'order_id' = p_order_id::text)
  FOR UPDATE;

  SELECT EXISTS (
    SELECT 1 FROM payments
    WHERE (order_id = p_order_id OR metadata->>'order_id' = p_order_id::text)
      AND (status = 'success'
        OR (finalization_processing_at IS NOT NULL
            AND finalization_processing_at > v_now - INTERVAL '5 minutes'))
  ) INTO v_has_payment;

  IF v_has_payment THEN
    RETURN '{"confirmed":false,"reason":"online_payment_won"}'::jsonb;
  END IF;

  -- 5. Amount validation (unchanged from M394)
  IF v_transfer.expected_amount != ROUND(v_order.total_amount * 100) THEN
    RETURN '{"confirmed":false,"reason":"amount_mismatch"}'::jsonb;
  END IF;

  -- 6. Fail-closed: reject non-representable fractional amounts
  IF v_transfer.expected_amount % 100 != 0 THEN
    RETURN '{"confirmed":false,"reason":"fractional_amount_unsupported"}'::jsonb;
  END IF;

  -- ── Winner mutations (atomic, unchanged from M394) ──

  -- 7. Void pending online payments
  UPDATE payments SET status = 'failed', gateway_status = 'bank_transfer_won'
  WHERE (order_id = p_order_id OR metadata->>'order_id' = p_order_id::text)
    AND status = 'pending';

  -- 8. Insert direct payment (major units, matching M394)
  INSERT INTO payments (
    business_id, amount, currency, status, payment_method, gateway,
    gateway_reference, gateway_status, order_id, paid_at,
    payment_authority_version, gateway_fee, fee_policy_version,
    metadata
  ) VALUES (
    p_business_id, v_order.total_amount, v_transfer.currency,
    'success', 'bank_transfer', 'direct',
    'transfer:' || v_transfer.reference_code, 'merchant_confirmed',
    p_order_id, v_now, 1, 0, 0,
    jsonb_build_object(
      'pending_transfer_id', p_transfer_id,
      'confirmed_by', p_confirmed_by,
      'customer_phone', v_transfer.customer_phone,
      'customer_name', v_transfer.customer_name,
      'transfer_reference', v_transfer.reference_code,
      '_direct_transfer', true
    )
  ) RETURNING id INTO v_new_payment_id;

  -- 9. Commit marker
  UPDATE order_stock_applications
  SET reservation_class = 'committed', expires_at = NULL, payment_id = v_new_payment_id
  WHERE order_id = p_order_id;

  -- 10. Confirm transfer
  UPDATE pending_transfers SET status = 'confirmed', confirmed_by = p_confirmed_by, confirmed_at = v_now
  WHERE id = p_transfer_id;

  -- 11. Order status: conditional on approval
  IF p_approve_fulfillment THEN
    UPDATE orders SET status = 'confirmed', updated_at = v_now
    WHERE id = p_order_id;
  ELSE
    UPDATE orders SET status = 'paid_pending_approval', updated_at = v_now
    WHERE id = p_order_id;
  END IF;

  -- 12. Finalize promo (payment-time effect regardless of approval)
  IF v_order.promo_code_id IS NOT NULL THEN
    UPDATE promo_reservations SET state = 'finalized'
    WHERE order_id = p_order_id AND state = 'reserved';
    IF FOUND THEN
      UPDATE promo_codes SET current_uses = current_uses + 1
      WHERE id = v_order.promo_code_id;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'confirmed', true,
    'order_total', v_order.total_amount,
    'payment_id', v_new_payment_id,
    'currency', v_transfer.currency,
    'reference_code', v_transfer.reference_code,
    'approved', p_approve_fulfillment
  );
END; $$;

REVOKE ALL ON FUNCTION public.confirm_order_transfer_atomic(UUID,UUID,UUID,UUID,BOOLEAN) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION public.confirm_order_transfer_atomic(UUID,UUID,UUID,UUID,BOOLEAN) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION public.confirm_order_transfer_atomic(UUID,UUID,UUID,UUID,BOOLEAN) FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.confirm_order_transfer_atomic(UUID,UUID,UUID,UUID,BOOLEAN) TO service_role;
  END IF;
END $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- 7. cancel_stale_order_atomic — proof protection
--    Full function body from staging pg_get_functiondef + proof additions.
--    Lock order: order → transfer → marker (aligned with M394).
--    Preserves original deadlines. proof_protected flag set here only.
--    Also skips paid_pending_approval orders.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.cancel_stale_order_atomic(
  p_order_id UUID
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_order RECORD;
  v_item RECORD;
  v_count INTEGER := 0;
  v_had_marker BOOLEAN := false;
  v_has_payment BOOLEAN := false;
  v_marker RECORD;
  v_proof_transfer RECORD;
BEGIN
  -- 1. Lock order row
  SELECT id, status, created_at, promo_code_id
  INTO v_order FROM orders WHERE id = p_order_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('cancelled', false, 'reason', 'not_found');
  END IF;

  -- 2. Status gate: only pending orders (skip confirmed, paid_pending_approval, etc.)
  IF v_order.status != 'pending' THEN
    RETURN jsonb_build_object('cancelled', false, 'reason', v_order.status);
  END IF;

  -- 2b. M475: Lock linked pending transfer FOR UPDATE (order → transfer → marker)
  -- This serializes with submit_transfer_proof and confirm_order_transfer_atomic.
  SELECT id, proof_submitted_at, proof_protected, proof_image_url, proof_text, expires_at
  INTO v_proof_transfer
  FROM pending_transfers
  WHERE order_id = p_order_id AND status = 'pending'
  ORDER BY created_at DESC LIMIT 1
  FOR UPDATE;

  -- 3. M393: Marker-aware expiry logic
  SELECT reservation_class, expires_at
  INTO v_marker
  FROM order_stock_applications
  WHERE order_id = p_order_id
  FOR UPDATE;

  IF FOUND THEN
    -- Committed markers are never cancellable by stale cleanup
    IF v_marker.reservation_class = 'committed' THEN
      RETURN jsonb_build_object('cancelled', false, 'reason', 'committed_not_cancellable');
    END IF;

    -- Instant/bank_transfer: check expiry
    IF v_marker.reservation_class IN ('instant', 'bank_transfer') THEN
      IF v_marker.expires_at IS NOT NULL AND v_marker.expires_at > NOW() THEN
        RETURN jsonb_build_object('cancelled', false, 'reason',
          v_marker.reservation_class || '_not_expired');
      END IF;
      -- Expired: eligible for cancellation — but check proof first (below)
    END IF;

    -- Prepayment: use legacy 48h staleness
    IF v_marker.reservation_class = 'prepayment' THEN
      IF v_order.created_at >= NOW() - INTERVAL '48 hours' THEN
        RETURN jsonb_build_object('cancelled', false, 'reason', 'prepayment_not_stale');
      END IF;
    END IF;
  ELSE
    -- No marker: legacy 48h staleness
    IF v_order.created_at >= NOW() - INTERVAL '48 hours' THEN
      RETURN jsonb_build_object('cancelled', false, 'reason', 'legacy_no_marker_not_stale');
    END IF;
  END IF;

  -- ── M475: Proof protection check (after expiry determined, before cancellation) ──
  -- If a timely proof was submitted via submit_transfer_proof, protect the order.
  -- Also protect legacy proofs (image/text exists without proof_submitted_at)
  -- for manual reconciliation during deployment transition.
  IF v_proof_transfer.id IS NOT NULL THEN
    -- Already protected: skip cancellation idempotently
    IF v_proof_transfer.proof_protected THEN
      RETURN jsonb_build_object('cancelled', false, 'reason', 'proof_protected');
    END IF;

    -- Timely proof via RPC: proof_submitted_at set by DB, before original expires_at
    IF v_proof_transfer.proof_submitted_at IS NOT NULL
       AND v_proof_transfer.proof_submitted_at <= v_proof_transfer.expires_at THEN
      -- Mark as protected (one-time, idempotent on re-run via check above)
      UPDATE pending_transfers SET proof_protected = TRUE
      WHERE id = v_proof_transfer.id;
      RETURN jsonb_build_object('cancelled', false, 'reason', 'proof_protected');
    END IF;

    -- Legacy proof: image/text exists but no DB timestamp (old bot instance)
    -- Conservatively hold for manual reconciliation rather than auto-cancel.
    IF (v_proof_transfer.proof_image_url IS NOT NULL OR v_proof_transfer.proof_text IS NOT NULL)
       AND v_proof_transfer.proof_submitted_at IS NULL THEN
      UPDATE pending_transfers SET proof_protected = TRUE
      WHERE id = v_proof_transfer.id;
      RETURN jsonb_build_object('cancelled', false, 'reason', 'legacy_proof_held');
    END IF;
  END IF;

  -- ── Standard cancellation (unchanged from M393) ──

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
  SET status = 'failed', gateway_status = 'stale_order_cancelled'
  WHERE (order_id = p_order_id OR metadata->>'order_id' = p_order_id::text)
    AND status = 'pending';

  -- 5. Check canonical stock marker and restore
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
        WHERE id = v_item.product_id
          AND track_inventory = true
          AND stock_quantity IS NOT NULL;
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

  -- 8. M393: Cancel linked pending transfers
  UPDATE pending_transfers SET status = 'expired'
  WHERE order_id = p_order_id AND status = 'pending';

  RETURN jsonb_build_object(
    'cancelled', true,
    'stock_restored', v_had_marker,
    'items_restored', v_count
  );
END; $$;

-- ACL: preserve existing (unchanged signature)
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


-- ═══════════════════════════════════════════════════════════════════════════
-- 8. finalize_promo_reservation — paid_pending_approval awareness
--    Full function body from staging pg_get_functiondef + M475 additions.
--    Check promo state FIRST; accept already-finalized idempotently.
--    Accept 'confirmed' OR 'paid_pending_approval' as valid paid states.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.finalize_promo_reservation(p_order_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_res RECORD;
  v_order_status text;
BEGIN
  -- M475: Check promo reservation state FIRST (before order status).
  -- This allows already-finalized promos (finalized by confirm_order_transfer_atomic
  -- step 12) to return idempotently without hitting the order status check.
  SELECT id, state, promo_code_id INTO v_res
  FROM promo_reservations WHERE order_id = p_order_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('finalized', false, 'reason', 'no_reservation');
  END IF;

  -- Already finalized: idempotent return (e.g. replay from Stage 2 after RPC step 12)
  IF v_res.state = 'finalized' THEN
    RETURN jsonb_build_object('finalized', true, 'already_finalized', true);
  END IF;

  IF v_res.state = 'released' THEN
    RETURN jsonb_build_object('finalized', false, 'reason', 'already_released');
  END IF;

  -- Now check order status: accept 'confirmed' OR 'paid_pending_approval'
  -- paid_pending_approval = payment is real, promo was earned
  SELECT status INTO v_order_status FROM orders WHERE id = p_order_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('finalized', false, 'reason', 'order_not_found');
  END IF;
  IF v_order_status NOT IN ('confirmed', 'paid_pending_approval') THEN
    RETURN jsonb_build_object('finalized', false, 'reason', 'order_not_confirmed', 'order_status', v_order_status);
  END IF;

  -- Transition reserved → finalized
  UPDATE promo_reservations SET state = 'finalized', updated_at = NOW()
  WHERE id = v_res.id;

  UPDATE promo_codes SET current_uses = current_uses + 1
  WHERE id = v_res.promo_code_id;

  RETURN jsonb_build_object('finalized', true, 'already_finalized', false);
END; $$;

-- ACL: preserve existing (unchanged signature)
REVOKE ALL ON FUNCTION public.finalize_promo_reservation(UUID) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION public.finalize_promo_reservation(UUID) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION public.finalize_promo_reservation(UUID) FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.finalize_promo_reservation(UUID) TO service_role;
  END IF;
END $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- 9. confirm_nonorder_transfer_atomic — atomic non-order confirmation
--    Handles booking, reservation, invoice, campaign, standalone payment.
--    Amount in major units (expected_amount / 100). Fail-closed on fractions.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.confirm_nonorder_transfer_atomic(
  p_transfer_id UUID,
  p_business_id UUID,
  p_confirmed_by UUID,
  p_approve_fulfillment BOOLEAN
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_transfer RECORD;
  v_now TIMESTAMPTZ := NOW();
  v_payment_id UUID;
  v_entity_count INTEGER := 0;
  v_entity_type TEXT := 'none';
  v_rows INTEGER;
  v_payment_amount INTEGER;
BEGIN
  -- 1. Lock + validate transfer
  SELECT * INTO v_transfer FROM pending_transfers
  WHERE id = p_transfer_id FOR UPDATE;

  IF NOT FOUND THEN RETURN '{"confirmed":false,"reason":"not_found"}'::jsonb; END IF;
  IF v_transfer.status != 'pending' THEN
    RETURN jsonb_build_object('confirmed', false, 'reason', 'status_' || v_transfer.status);
  END IF;
  IF v_transfer.business_id != p_business_id THEN
    RETURN '{"confirmed":false,"reason":"business_mismatch"}'::jsonb;
  END IF;

  -- 2. Fail-closed: reject non-representable fractional amounts
  IF v_transfer.expected_amount % 100 != 0 THEN
    RETURN '{"confirmed":false,"reason":"fractional_amount_unsupported"}'::jsonb;
  END IF;
  v_payment_amount := v_transfer.expected_amount / 100;

  -- 3. Exactly one linked entity (or standalone payment)
  IF v_transfer.booking_id IS NOT NULL THEN v_entity_count := v_entity_count + 1; v_entity_type := 'booking'; END IF;
  IF v_transfer.invoice_id IS NOT NULL THEN v_entity_count := v_entity_count + 1; v_entity_type := 'invoice'; END IF;
  IF v_transfer.reservation_id IS NOT NULL THEN v_entity_count := v_entity_count + 1; v_entity_type := 'reservation'; END IF;
  IF v_transfer.campaign_id IS NOT NULL THEN v_entity_count := v_entity_count + 1; v_entity_type := 'campaign'; END IF;
  IF v_entity_count > 1 THEN
    RETURN '{"confirmed":false,"reason":"multi_entity_transfer"}'::jsonb;
  END IF;

  -- 4. Validate linked entity: tenant + acceptable state
  IF v_entity_type = 'booking' THEN
    IF NOT EXISTS (SELECT 1 FROM bookings WHERE id = v_transfer.booking_id
        AND business_id = p_business_id AND status = 'pending') THEN
      RETURN '{"confirmed":false,"reason":"booking_not_pending_or_mismatch"}'::jsonb;
    END IF;
  ELSIF v_entity_type = 'reservation' THEN
    IF NOT EXISTS (SELECT 1 FROM reservations WHERE id = v_transfer.reservation_id
        AND business_id = p_business_id AND status = 'pending') THEN
      RETURN '{"confirmed":false,"reason":"reservation_not_pending_or_mismatch"}'::jsonb;
    END IF;
  ELSIF v_entity_type = 'invoice' THEN
    IF NOT EXISTS (SELECT 1 FROM invoices WHERE id = v_transfer.invoice_id
        AND business_id = p_business_id AND status IN ('sent', 'viewed', 'overdue')) THEN
      RETURN '{"confirmed":false,"reason":"invoice_not_payable_or_mismatch"}'::jsonb;
    END IF;
  END IF;

  -- 5. Confirm transfer
  UPDATE pending_transfers SET status = 'confirmed',
    confirmed_by = p_confirmed_by, confirmed_at = v_now
  WHERE id = p_transfer_id AND status = 'pending';

  -- 6. Create payment (major units, M394 provenance conventions)
  -- #736 Finding 5: Set finalization_completed_at to prevent recovery cron
  -- from selecting non-order direct payments for order-only reconciliation.
  INSERT INTO payments (
    business_id, amount, currency, status, payment_method, gateway,
    gateway_reference, gateway_status, paid_at,
    booking_id, invoice_id, reservation_id, campaign_id,
    payment_authority_version, gateway_fee, fee_policy_version,
    finalization_completed_at,
    metadata
  ) VALUES (
    p_business_id, v_payment_amount,
    COALESCE(v_transfer.currency, 'NGN'),
    'success', 'bank_transfer', 'direct',
    'transfer:' || v_transfer.reference_code, 'merchant_confirmed', v_now,
    v_transfer.booking_id, v_transfer.invoice_id,
    v_transfer.reservation_id, v_transfer.campaign_id,
    1, 0, 0,
    v_now,  -- finalization_completed_at: inline-finalized, exclude from recovery cron
    jsonb_build_object(
      'pending_transfer_id', p_transfer_id,
      'confirmed_by', p_confirmed_by,
      'customer_phone', v_transfer.customer_phone,
      'customer_name', v_transfer.customer_name,
      '_direct_transfer', true
    )
  ) RETURNING id INTO v_payment_id;

  -- 7. Zero-fee platform record (minor units for transaction_amount)
  INSERT INTO platform_fees (
    business_id, payment_id,
    booking_id, invoice_id,
    transaction_amount, fee_percentage, fee_flat, fee_total, gateway_fee,
    tier, is_direct_transfer
  ) VALUES (
    p_business_id, v_payment_id,
    v_transfer.booking_id, v_transfer.invoice_id,
    v_transfer.expected_amount, 0, 0, 0, 0,
    (SELECT COALESCE(subscription_tier, 'free') FROM businesses WHERE id = p_business_id),
    true
  );

  -- 8. Entity effects
  IF v_entity_type = 'booking' THEN
    IF p_approve_fulfillment THEN
      UPDATE bookings SET deposit_status = 'paid', status = 'confirmed',
        confirmed_at = v_now, payment_id = v_payment_id
      WHERE id = v_transfer.booking_id AND status = 'pending';
    ELSE
      UPDATE bookings SET deposit_status = 'paid', payment_id = v_payment_id
      WHERE id = v_transfer.booking_id AND status = 'pending';
    END IF;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows < 1 THEN
      RAISE EXCEPTION 'booking_update_failed: booking % no longer pending', v_transfer.booking_id;
    END IF;

  ELSIF v_entity_type = 'reservation' THEN
    IF p_approve_fulfillment THEN
      UPDATE reservations SET status = 'confirmed', deposit_status = 'paid'
      WHERE id = v_transfer.reservation_id AND status = 'pending';
    ELSE
      UPDATE reservations SET deposit_status = 'paid'
      WHERE id = v_transfer.reservation_id AND status = 'pending';
    END IF;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows < 1 THEN
      RAISE EXCEPTION 'reservation_update_failed: reservation % no longer pending', v_transfer.reservation_id;
    END IF;

  ELSIF v_entity_type = 'invoice' THEN
    -- Invoice: payment IS completion (no separate approval needed)
    UPDATE invoices SET status = 'paid', paid_at = v_now
    WHERE id = v_transfer.invoice_id AND business_id = p_business_id
      AND status IN ('sent', 'viewed', 'overdue');
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows < 1 THEN
      RAISE EXCEPTION 'invoice_update_failed: invoice % not payable', v_transfer.invoice_id;
    END IF;
  END IF;
  -- campaign/standalone: no entity update needed

  RETURN jsonb_build_object(
    'confirmed', true, 'payment_id', v_payment_id,
    'entity_type', v_entity_type, 'approved', p_approve_fulfillment,
    'amount_major', v_payment_amount
  );
END; $$;

REVOKE ALL ON FUNCTION public.confirm_nonorder_transfer_atomic(UUID,UUID,UUID,BOOLEAN) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION public.confirm_nonorder_transfer_atomic(UUID,UUID,UUID,BOOLEAN) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION public.confirm_nonorder_transfer_atomic(UUID,UUID,UUID,BOOLEAN) FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.confirm_nonorder_transfer_atomic(UUID,UUID,UUID,BOOLEAN) TO service_role;
  END IF;
END $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- 10. approve_paid_order — second-step fulfillment approval
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.approve_paid_order(
  p_order_id UUID,
  p_business_id UUID,
  p_approved_by UUID
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_order RECORD; v_payment RECORD; v_now TIMESTAMPTZ := NOW();
BEGIN
  SELECT id, status, business_id INTO v_order
  FROM orders WHERE id = p_order_id FOR UPDATE;

  IF NOT FOUND THEN RETURN '{"approved":false,"reason":"not_found"}'::jsonb; END IF;
  IF v_order.business_id != p_business_id THEN RETURN '{"approved":false,"reason":"business_mismatch"}'::jsonb; END IF;
  IF v_order.status != 'paid_pending_approval' THEN
    RETURN jsonb_build_object('approved', false, 'reason', 'status_' || v_order.status);
  END IF;

  -- Verify successful direct payment exists
  SELECT id INTO v_payment FROM payments
  WHERE order_id = p_order_id AND business_id = p_business_id
    AND gateway = 'direct' AND status = 'success'
    AND (metadata->>'_direct_transfer')::boolean = true
  LIMIT 1;
  IF NOT FOUND THEN RETURN '{"approved":false,"reason":"no_verified_payment"}'::jsonb; END IF;

  -- Verify committed stock marker with matching payment
  IF NOT EXISTS (
    SELECT 1 FROM order_stock_applications
    WHERE order_id = p_order_id AND reservation_class = 'committed'
      AND payment_id = v_payment.id
  ) THEN RETURN '{"approved":false,"reason":"no_committed_stock"}'::jsonb; END IF;

  UPDATE orders SET status = 'confirmed', updated_at = v_now
  WHERE id = p_order_id AND status = 'paid_pending_approval';

  RETURN jsonb_build_object('approved', true, 'order_id', p_order_id, 'payment_id', v_payment.id);
END; $$;

REVOKE ALL ON FUNCTION public.approve_paid_order(UUID,UUID,UUID) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION public.approve_paid_order(UUID,UUID,UUID) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION public.approve_paid_order(UUID,UUID,UUID) FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.approve_paid_order(UUID,UUID,UUID) TO service_role;
  END IF;
END $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- 11. reject_paid_order — cancellation with refund obligation
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.reject_paid_order(
  p_order_id UUID,
  p_business_id UUID,
  p_rejected_by UUID,
  p_reason TEXT DEFAULT 'merchant_rejected'
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_order RECORD; v_payment RECORD; v_item RECORD;
  v_count INTEGER := 0; v_now TIMESTAMPTZ := NOW();
BEGIN
  SELECT id, status, business_id, promo_code_id INTO v_order
  FROM orders WHERE id = p_order_id FOR UPDATE;

  IF NOT FOUND THEN RETURN '{"rejected":false,"reason":"not_found"}'::jsonb; END IF;
  IF v_order.business_id != p_business_id THEN RETURN '{"rejected":false,"reason":"business_mismatch"}'::jsonb; END IF;
  IF v_order.status != 'paid_pending_approval' THEN
    RETURN jsonb_build_object('rejected', false, 'reason', 'status_' || v_order.status);
  END IF;

  -- Find the successful direct payment
  SELECT id, amount, currency INTO v_payment FROM payments
  WHERE order_id = p_order_id AND business_id = p_business_id
    AND gateway = 'direct' AND status = 'success'
    AND (metadata->>'_direct_transfer')::boolean = true
  LIMIT 1;
  IF NOT FOUND THEN RETURN '{"rejected":false,"reason":"no_direct_payment"}'::jsonb; END IF;

  -- Cancel order
  UPDATE orders SET status = 'cancelled', updated_at = v_now
  WHERE id = p_order_id AND status = 'paid_pending_approval';

  -- Restore inventory (same pattern as cancel_stale_order_atomic)
  FOR v_item IN
    SELECT oi.product_id, oi.variant_id, oi.quantity FROM order_items oi
    WHERE oi.order_id = p_order_id ORDER BY oi.product_id, oi.variant_id NULLS FIRST
  LOOP
    IF v_item.variant_id IS NOT NULL THEN
      UPDATE product_variants SET stock_quantity = COALESCE(stock_quantity, 0) + v_item.quantity
      WHERE id = v_item.variant_id AND stock_quantity IS NOT NULL;
    ELSIF v_item.product_id IS NOT NULL THEN
      UPDATE products SET stock_quantity = COALESCE(stock_quantity, 0) + v_item.quantity
      WHERE id = v_item.product_id AND track_inventory = true AND stock_quantity IS NOT NULL;
    END IF;
    v_count := v_count + 1;
  END LOOP;

  -- Remove stock marker
  DELETE FROM order_stock_applications WHERE order_id = p_order_id;

  -- Release promo (undo finalization from confirm step 12)
  IF v_order.promo_code_id IS NOT NULL THEN
    UPDATE promo_reservations SET state = 'released'
    WHERE order_id = p_order_id AND state = 'finalized';
    IF FOUND THEN
      UPDATE promo_codes SET current_uses = GREATEST(0, current_uses - 1)
      WHERE id = v_order.promo_code_id;
    END IF;
  END IF;

  -- Record merchant refund obligation (Option X: existing refunds ledger)
  -- Lifetime unique index prevents duplicates across all obligation states.
  -- Status 'merchant_obligation' is never claimed by claim_refund_dispatch (only 'pending').
  INSERT INTO refunds (
    payment_id, business_id, amount, reason, status, gateway,
    refund_type, initiated_by, initiated_by_role
  ) VALUES (
    v_payment.id, p_business_id,
    v_payment.amount::numeric,
    p_reason, 'merchant_obligation', 'direct',
    'full', p_rejected_by, 'business'
  );

  RETURN jsonb_build_object(
    'rejected', true, 'stock_restored', v_count,
    'promo_released', (v_order.promo_code_id IS NOT NULL),
    'refund_obligation', true, 'payment_id', v_payment.id
  );
END; $$;

REVOKE ALL ON FUNCTION public.reject_paid_order(UUID,UUID,UUID,TEXT) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION public.reject_paid_order(UUID,UUID,UUID,TEXT) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION public.reject_paid_order(UUID,UUID,UUID,TEXT) FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.reject_paid_order(UUID,UUID,UUID,TEXT) TO service_role;
  END IF;
END $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- Validation: verify all new functions exist
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_fns TEXT[] := ARRAY[
    'submit_transfer_proof',
    'confirm_nonorder_transfer_atomic',
    'approve_paid_order',
    'reject_paid_order'
  ];
  v_fn TEXT;
BEGIN
  FOREACH v_fn IN ARRAY v_fns LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
      WHERE n.nspname = 'public' AND p.proname = v_fn
    ) THEN
      RAISE EXCEPTION 'M475 validation failed: function % not found', v_fn;
    END IF;
  END LOOP;

  -- Verify 5-arg confirm_order_transfer_atomic coexists with old 4-arg
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public' AND p.proname = 'confirm_order_transfer_atomic'
      AND p.pronargs = 5
  ) THEN
    RAISE EXCEPTION 'M475 validation: 5-arg confirm_order_transfer_atomic not found';
  END IF;
END $$;
