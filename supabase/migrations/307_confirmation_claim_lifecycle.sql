-- 307: Fix payment confirmation claim/send lifecycle
--
-- The confirmation dedup used .update({ confirmation_sent_at }) without
-- { count: 'exact' }, causing count to always be null and all confirmations
-- to be silently skipped. Additionally, confirmation_sent_at was set BEFORE
-- the send, so a failure would permanently poison the payment.
--
-- This migration adds a processing claim field to distinguish:
--   NULL/NULL        → not started, eligible for claim
--   processing/NULL  → claimed, send in progress
--   processing/set   → successfully completed
--   NULL (cleared)   → failed, eligible for retry (stale claim recovery)

ALTER TABLE payments ADD COLUMN IF NOT EXISTS confirmation_processing_at TIMESTAMPTZ;

-- Atomic claim RPC: only one caller wins the processing claim.
-- Stale claims (>5 min without completion) are recoverable.
-- Returns: claimed (bool), already_completed (bool), payment row data.
CREATE OR REPLACE FUNCTION claim_payment_confirmation(
  p_payment_id UUID
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_payment RECORD;
BEGIN
  -- Lock the payment row to serialize concurrent callers
  SELECT id, amount, status, booking_id, invoice_id, campaign_id,
         reservation_id, order_id,
         confirmation_sent_at, confirmation_processing_at
  INTO v_payment
  FROM payments
  WHERE id = p_payment_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'not_found');
  END IF;

  -- Only confirmed/successful payments should send confirmations
  IF v_payment.status != 'success' THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'not_successful', 'status', v_payment.status);
  END IF;

  -- Already completed — idempotent return
  IF v_payment.confirmation_sent_at IS NOT NULL THEN
    RETURN jsonb_build_object('claimed', false, 'already_completed', true, 'reason', 'already_sent');
  END IF;

  -- Currently being processed by another worker — check for stale claim
  IF v_payment.confirmation_processing_at IS NOT NULL THEN
    IF v_payment.confirmation_processing_at > NOW() - INTERVAL '5 minutes' THEN
      -- Active claim — another worker is processing
      RETURN jsonb_build_object('claimed', false, 'reason', 'processing_in_progress');
    END IF;
    -- Stale claim (>5 min) — previous worker likely crashed. Reclaim.
  END IF;

  -- Win the claim
  UPDATE payments
  SET confirmation_processing_at = NOW()
  WHERE id = p_payment_id;

  RETURN jsonb_build_object(
    'claimed', true,
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

-- Finalize: mark confirmation as successfully sent.
-- Only the winner (with an active processing claim) can finalize.
CREATE OR REPLACE FUNCTION finalize_payment_confirmation(
  p_payment_id UUID
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_payment RECORD;
BEGIN
  SELECT confirmation_sent_at, confirmation_processing_at
  INTO v_payment
  FROM payments
  WHERE id = p_payment_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('finalized', false, 'reason', 'not_found');
  END IF;

  -- Already finalized — idempotent
  IF v_payment.confirmation_sent_at IS NOT NULL THEN
    RETURN jsonb_build_object('finalized', true, 'already_finalized', true);
  END IF;

  -- Must have an active processing claim
  IF v_payment.confirmation_processing_at IS NULL THEN
    RETURN jsonb_build_object('finalized', false, 'reason', 'not_processing');
  END IF;

  UPDATE payments
  SET confirmation_sent_at = NOW()
  WHERE id = p_payment_id;

  RETURN jsonb_build_object('finalized', true, 'already_finalized', false);
END;
$$;

-- Release: clear processing claim on failure (allows retry).
CREATE OR REPLACE FUNCTION release_payment_confirmation(
  p_payment_id UUID
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE payments
  SET confirmation_processing_at = NULL
  WHERE id = p_payment_id
    AND confirmation_sent_at IS NULL;

  RETURN jsonb_build_object('released', true);
END;
$$;

-- Restrict to service_role only
DO $$ BEGIN
  REVOKE ALL ON FUNCTION claim_payment_confirmation(UUID) FROM PUBLIC;
  REVOKE ALL ON FUNCTION finalize_payment_confirmation(UUID) FROM PUBLIC;
  REVOKE ALL ON FUNCTION release_payment_confirmation(UUID) FROM PUBLIC;
  EXECUTE 'GRANT EXECUTE ON FUNCTION claim_payment_confirmation(UUID) TO service_role';
  EXECUTE 'GRANT EXECUTE ON FUNCTION finalize_payment_confirmation(UUID) TO service_role';
  EXECUTE 'GRANT EXECUTE ON FUNCTION release_payment_confirmation(UUID) TO service_role';
EXCEPTION WHEN undefined_object THEN NULL;
END $$;
