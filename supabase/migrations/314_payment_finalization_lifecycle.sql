-- Migration 314: Payment business-finalization claim/complete lifecycle
--
-- Separates "provider paid" from "business finalization completed".
-- Modeled on migration 307's confirmation claim lifecycle.
--
-- Why required:
--   - status='success' means provider confirmed payment (fact from gateway)
--   - confirmation_sent_at means customer notification sent (migration 307)
--   - NO existing column tracks whether processSuccessfulPayment completed
--   - Without this, a webhook retry after processSuccessfulPayment failure
--     sees status='success' and skips finalization permanently
--
-- State machine:
--   Not started:  finalization_completed_at=NULL, finalization_processing_at=NULL
--   Processing:   finalization_completed_at=NULL, finalization_processing_at=ts, finalization_claim_token=uuid
--   Complete:     finalization_completed_at=ts, finalization_processing_at=NULL, finalization_claim_token=NULL
--   Released:     finalization_completed_at=NULL, finalization_processing_at=NULL (retry allowed)

ALTER TABLE payments ADD COLUMN IF NOT EXISTS finalization_completed_at TIMESTAMPTZ;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS finalization_processing_at TIMESTAMPTZ;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS finalization_claim_token UUID;
-- confirmation_terminal_reason: set when confirmation cannot/should not be retried
-- e.g. 'not_deliverable' — no phone/email for customer delivery
ALTER TABLE payments ADD COLUMN IF NOT EXISTS confirmation_terminal_reason TEXT;

-- ═══════════════════════════════════════════════════════
-- Claim: atomically win business-finalization processing rights
-- ═══════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION claim_payment_finalization(
  p_payment_id UUID
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_payment RECORD;
  v_token UUID;
BEGIN
  SELECT id, amount, status, booking_id, invoice_id, campaign_id,
         reservation_id, order_id, metadata, gateway_fee,
         finalization_completed_at, finalization_processing_at
  INTO v_payment FROM payments WHERE id = p_payment_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'not_found');
  END IF;
  IF v_payment.status != 'success' THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'not_successful');
  END IF;
  IF v_payment.finalization_completed_at IS NOT NULL THEN
    RETURN jsonb_build_object('claimed', false, 'already_completed', true, 'reason', 'already_finalized');
  END IF;
  IF v_payment.finalization_processing_at IS NOT NULL
     AND v_payment.finalization_processing_at > NOW() - INTERVAL '5 minutes' THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'processing_in_progress');
  END IF;

  v_token := gen_random_uuid();
  UPDATE payments
  SET finalization_processing_at = NOW(), finalization_claim_token = v_token
  WHERE id = p_payment_id;

  RETURN jsonb_build_object(
    'claimed', true, 'claim_token', v_token,
    'payment_id', v_payment.id, 'amount', v_payment.amount,
    'booking_id', v_payment.booking_id, 'invoice_id', v_payment.invoice_id,
    'campaign_id', v_payment.campaign_id, 'reservation_id', v_payment.reservation_id,
    'order_id', v_payment.order_id, 'gateway_fee', v_payment.gateway_fee
  );
END;
$$;

-- ═══════════════════════════════════════════════════════
-- Complete: mark business finalization as durably done
-- ═══════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION complete_payment_finalization(
  p_payment_id UUID,
  p_claim_token UUID
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_payment RECORD;
BEGIN
  SELECT finalization_completed_at, finalization_claim_token
  INTO v_payment FROM payments WHERE id = p_payment_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('completed', false, 'reason', 'not_found');
  END IF;
  IF v_payment.finalization_completed_at IS NOT NULL THEN
    RETURN jsonb_build_object('completed', true, 'already_completed', true);
  END IF;
  IF v_payment.finalization_claim_token IS NULL
     OR v_payment.finalization_claim_token != p_claim_token THEN
    RETURN jsonb_build_object('completed', false, 'reason', 'token_mismatch');
  END IF;

  UPDATE payments
  SET finalization_completed_at = NOW(),
      finalization_processing_at = NULL,
      finalization_claim_token = NULL
  WHERE id = p_payment_id;

  RETURN jsonb_build_object('completed', true, 'already_completed', false);
END;
$$;

-- ═══════════════════════════════════════════════════════
-- Release: clear finalization claim on failure (allows retry)
-- ═══════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION release_payment_finalization(
  p_payment_id UUID,
  p_claim_token UUID
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_payment RECORD;
BEGIN
  SELECT finalization_completed_at, finalization_claim_token
  INTO v_payment FROM payments WHERE id = p_payment_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('released', false, 'reason', 'not_found');
  END IF;
  IF v_payment.finalization_completed_at IS NOT NULL THEN
    RETURN jsonb_build_object('released', false, 'reason', 'already_completed');
  END IF;
  IF v_payment.finalization_claim_token IS NULL
     OR v_payment.finalization_claim_token != p_claim_token THEN
    RETURN jsonb_build_object('released', false, 'reason', 'token_mismatch');
  END IF;

  UPDATE payments
  SET finalization_processing_at = NULL, finalization_claim_token = NULL
  WHERE id = p_payment_id;

  RETURN jsonb_build_object('released', true);
END;
$$;

-- Restrict claim/complete/release RPCs to service_role only
DO $$ BEGIN
  REVOKE ALL ON FUNCTION claim_payment_finalization(UUID) FROM PUBLIC;
  REVOKE ALL ON FUNCTION complete_payment_finalization(UUID, UUID) FROM PUBLIC;
  REVOKE ALL ON FUNCTION release_payment_finalization(UUID, UUID) FROM PUBLIC;
  EXECUTE 'GRANT EXECUTE ON FUNCTION claim_payment_finalization(UUID) TO service_role';
  EXECUTE 'GRANT EXECUTE ON FUNCTION complete_payment_finalization(UUID, UUID) TO service_role';
  EXECUTE 'GRANT EXECUTE ON FUNCTION release_payment_finalization(UUID, UUID) TO service_role';
EXCEPTION WHEN undefined_object THEN NULL;
END $$;

-- ═══════════════════════════════════════════════════════
-- Legacy fence: mark pre-authority successful payments as legacy.
-- payment_authority_version distinguishes:
--   NULL = legacy (pre-authority, business-finalization state unknown)
--   1    = new-authority payment (normal Stage 1/2/3 lifecycle)
-- Legacy payments entering the authority are safely rejected.
-- ═══════════════════════════════════════════════════════
-- payment_authority_version:
--   NULL = historical pre-authority state (legacy fence for already-successful)
--   0    = adopted cutover payment (pre-authority pending, paid after rollout)
--   1    = strict new-authority payment (exact persisted connection identity)
ALTER TABLE payments ADD COLUMN IF NOT EXISTS payment_authority_version INTEGER;

-- ═══════════════════════════════════════════════════════
-- Order stock application ledger: exactly-once stock decrement
--
-- Prevents the crash gap where:
--   1. order confirmed
--   2. crash before stock decrement
--   3. retry skips stock (order already confirmed)
--
-- UNIQUE(payment_id, order_id) ensures exactly one application.
-- ═══════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS order_stock_applications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id UUID NOT NULL,
  order_id UUID NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  item_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE(payment_id, order_id)
);

ALTER TABLE order_stock_applications ENABLE ROW LEVEL SECURITY;

-- ═══════════════════════════════════════════════════════
-- apply_order_stock_once: atomic exactly-once stock decrement
-- ═══════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION apply_order_stock_once(
  p_payment_id UUID,
  p_order_id UUID
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_existing RECORD;
  v_item RECORD;
  v_count INTEGER := 0;
  v_order RECORD;
BEGIN
  -- 1. Acquire transaction-scoped serialization lock on the order row.
  -- This guarantees two callers for the same order serialize, preventing
  -- concurrent stock application before the UNIQUE marker is visible.
  SELECT id INTO v_order FROM orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'order_not_found');
  END IF;

  -- 1b. Validate payment→order relationship
  PERFORM id FROM payments WHERE id = p_payment_id AND (order_id = p_order_id OR metadata->>'order_id' = p_order_id::text);
  IF NOT FOUND THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'payment_order_mismatch');
  END IF;

  -- 2. Re-check under lock: already applied?
  SELECT id INTO v_existing
  FROM order_stock_applications
  WHERE payment_id = p_payment_id AND order_id = p_order_id;

  IF FOUND THEN
    RETURN jsonb_build_object('applied', true, 'already_applied', true);
  END IF;

  -- 3. Apply ALL stock decrements atomically (single transaction)
  FOR v_item IN
    SELECT product_id, variant_id, quantity
    FROM order_items WHERE order_id = p_order_id
  LOOP
    IF v_item.variant_id IS NOT NULL THEN
      UPDATE product_variants SET stock = GREATEST(0, stock - v_item.quantity) WHERE id = v_item.variant_id;
    ELSIF v_item.product_id IS NOT NULL THEN
      UPDATE products SET stock = GREATEST(0, stock - v_item.quantity) WHERE id = v_item.product_id;
    END IF;
    v_count := v_count + 1;
  END LOOP;

  -- 4. Insert durable marker (UNIQUE is defense-in-depth, not primary sync)
  INSERT INTO order_stock_applications (payment_id, order_id, item_count)
  VALUES (p_payment_id, p_order_id, v_count);

  RETURN jsonb_build_object('applied', true, 'already_applied', false, 'items', v_count);
END;
$$;

DO $$ BEGIN
  REVOKE ALL ON FUNCTION apply_order_stock_once(UUID, UUID) FROM PUBLIC;
  EXECUTE 'GRANT EXECUTE ON FUNCTION apply_order_stock_once(UUID, UUID) TO service_role';
EXCEPTION WHEN undefined_object THEN NULL;
END $$;
