-- 307: Fix payment confirmation claim/send lifecycle
--
-- State model:
--   NULL/NULL/NULL      → not started, eligible for claim
--   processing/token/NULL → claimed by worker with token (5-min lease)
--   NULL/NULL/sent_at   → successfully completed (finalized)
--   NULL/NULL/NULL      → released after failure (eligible for retry)

ALTER TABLE payments ADD COLUMN IF NOT EXISTS confirmation_processing_at TIMESTAMPTZ;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS confirmation_claim_token UUID;

-- ═══════════════════════════════════════════════════════
-- Claim: atomically win processing rights with ownership token
-- ═══════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION claim_payment_confirmation(
  p_payment_id UUID
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_payment RECORD;
  v_token UUID;
BEGIN
  SELECT id, amount, status, booking_id, invoice_id, campaign_id,
         reservation_id, order_id,
         confirmation_sent_at, confirmation_processing_at, confirmation_claim_token
  INTO v_payment
  FROM payments
  WHERE id = p_payment_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'not_found');
  END IF;

  IF v_payment.status != 'success' THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'not_successful', 'status', v_payment.status);
  END IF;

  IF v_payment.confirmation_sent_at IS NOT NULL THEN
    RETURN jsonb_build_object('claimed', false, 'already_completed', true, 'reason', 'already_sent');
  END IF;

  IF v_payment.confirmation_processing_at IS NOT NULL THEN
    IF v_payment.confirmation_processing_at > NOW() - INTERVAL '5 minutes' THEN
      RETURN jsonb_build_object('claimed', false, 'reason', 'processing_in_progress');
    END IF;
    -- Stale claim (>5 min) — reclaim with new token
  END IF;

  -- Generate unguessable ownership token
  v_token := gen_random_uuid();

  UPDATE payments
  SET confirmation_processing_at = NOW(),
      confirmation_claim_token = v_token
  WHERE id = p_payment_id;

  RETURN jsonb_build_object(
    'claimed', true,
    'claim_token', v_token,
    'payment_id', v_payment.id,
    'amount', v_payment.amount,
    'booking_id', v_payment.booking_id,
    'invoice_id', v_payment.invoice_id,
    'campaign_id', v_payment.campaign_id,
    'reservation_id', v_payment.reservation_id,
    'order_id', v_payment.order_id
  );
END;
$$;

-- ═══════════════════════════════════════════════════════
-- Finalize: mark confirmation as successfully sent
-- Only the token owner can finalize
-- ═══════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION finalize_payment_confirmation(
  p_payment_id UUID,
  p_claim_token UUID
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_payment RECORD;
BEGIN
  SELECT confirmation_sent_at, confirmation_processing_at, confirmation_claim_token
  INTO v_payment
  FROM payments
  WHERE id = p_payment_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('finalized', false, 'reason', 'not_found');
  END IF;

  IF v_payment.confirmation_sent_at IS NOT NULL THEN
    RETURN jsonb_build_object('finalized', true, 'already_finalized', true);
  END IF;

  IF v_payment.confirmation_claim_token IS NULL OR v_payment.confirmation_claim_token != p_claim_token THEN
    RETURN jsonb_build_object('finalized', false, 'reason', 'token_mismatch');
  END IF;

  UPDATE payments
  SET confirmation_sent_at = NOW(),
      confirmation_processing_at = NULL,
      confirmation_claim_token = NULL
  WHERE id = p_payment_id;

  RETURN jsonb_build_object('finalized', true, 'already_finalized', false);
END;
$$;

-- ═══════════════════════════════════════════════════════
-- Release: clear processing claim on failure (allows retry)
-- Only the token owner can release
-- ═══════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION release_payment_confirmation(
  p_payment_id UUID,
  p_claim_token UUID
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_payment RECORD;
BEGIN
  SELECT confirmation_sent_at, confirmation_claim_token
  INTO v_payment
  FROM payments
  WHERE id = p_payment_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('released', false, 'reason', 'not_found');
  END IF;

  IF v_payment.confirmation_sent_at IS NOT NULL THEN
    RETURN jsonb_build_object('released', false, 'reason', 'already_finalized');
  END IF;

  IF v_payment.confirmation_claim_token IS NULL OR v_payment.confirmation_claim_token != p_claim_token THEN
    RETURN jsonb_build_object('released', false, 'reason', 'token_mismatch');
  END IF;

  UPDATE payments
  SET confirmation_processing_at = NULL,
      confirmation_claim_token = NULL
  WHERE id = p_payment_id;

  RETURN jsonb_build_object('released', true);
END;
$$;

-- Restrict to service_role only
DO $$ BEGIN
  REVOKE ALL ON FUNCTION claim_payment_confirmation(UUID) FROM PUBLIC;
  REVOKE ALL ON FUNCTION finalize_payment_confirmation(UUID, UUID) FROM PUBLIC;
  REVOKE ALL ON FUNCTION release_payment_confirmation(UUID, UUID) FROM PUBLIC;
  EXECUTE 'GRANT EXECUTE ON FUNCTION claim_payment_confirmation(UUID) TO service_role';
  EXECUTE 'GRANT EXECUTE ON FUNCTION finalize_payment_confirmation(UUID, UUID) TO service_role';
  EXECUTE 'GRANT EXECUTE ON FUNCTION release_payment_confirmation(UUID, UUID) TO service_role';
EXCEPTION WHEN undefined_object THEN NULL;
END $$;
