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
-- Historical backfill: mark all existing successful payments as finalized
-- so the authority does not re-process them.
-- ═══════════════════════════════════════════════════════
UPDATE payments
SET finalization_completed_at = COALESCE(paid_at, NOW())
WHERE status = 'success'
  AND finalization_completed_at IS NULL;

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
BEGIN
  -- Check if already applied (idempotent guard)
  SELECT id INTO v_existing
  FROM order_stock_applications
  WHERE payment_id = p_payment_id AND order_id = p_order_id;

  IF FOUND THEN
    RETURN jsonb_build_object('applied', true, 'already_applied', true);
  END IF;

  -- Apply stock decrements for all order items
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

  -- Record durable application marker (UNIQUE prevents concurrent duplicate)
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
