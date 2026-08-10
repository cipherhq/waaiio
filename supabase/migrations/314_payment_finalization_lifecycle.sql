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

-- Restrict all RPCs to service_role only
DO $$ BEGIN
  REVOKE ALL ON FUNCTION claim_payment_finalization(UUID) FROM PUBLIC;
  REVOKE ALL ON FUNCTION complete_payment_finalization(UUID, UUID) FROM PUBLIC;
  REVOKE ALL ON FUNCTION release_payment_finalization(UUID, UUID) FROM PUBLIC;
  EXECUTE 'GRANT EXECUTE ON FUNCTION claim_payment_finalization(UUID) TO service_role';
  EXECUTE 'GRANT EXECUTE ON FUNCTION complete_payment_finalization(UUID, UUID) TO service_role';
  EXECUTE 'GRANT EXECUTE ON FUNCTION release_payment_finalization(UUID, UUID) TO service_role';
EXCEPTION WHEN undefined_object THEN NULL;
END $$;
