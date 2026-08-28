-- Migration 347: Atomic claim with lease/recovery for fulfillment notification dispatch (ACC-204 Blocker 2)
--
-- Adds claim_token + lease expiry + provider_attempted_at for crash recovery.
-- States:
--   A. pending, claim_token=NULL, provider_attempted_at=NULL → never attempted, reclaimable
--   B. pending, claim_token=X, claim_expires_at>now, provider_attempted_at=NULL → claimed, lease active
--   C. pending, provider_attempted_at IS NOT NULL → provider attempted, outcome ambiguous, NOT auto-reclaimable
--   D. sent, provider_message_id=X → successfully sent + correlated
--   E. failed → definite failure

-- Add claim/lease columns
ALTER TABLE promo_fulfillment_notification_intents
  ADD COLUMN IF NOT EXISTS claim_token UUID,
  ADD COLUMN IF NOT EXISTS claim_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS provider_attempted_at TIMESTAMPTZ;

-- Claim RPC with lease
CREATE OR REPLACE FUNCTION claim_fulfillment_notification_dispatch(
  p_intent_id UUID,
  p_lease_seconds INT DEFAULT 30
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_intent RECORD;
  v_token UUID;
BEGIN
  v_token := gen_random_uuid();

  -- Atomic claim: pending + (no claim OR expired claim) + no provider attempt
  SELECT * INTO v_intent FROM promo_fulfillment_notification_intents
    WHERE id = p_intent_id
      AND delivery_status = 'pending'
      AND provider_attempted_at IS NULL
      AND (claim_token IS NULL OR claim_expires_at < now())
    FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'not_available');
  END IF;

  UPDATE promo_fulfillment_notification_intents SET
    claim_token = v_token,
    claim_expires_at = now() + (p_lease_seconds || ' seconds')::interval,
    attempted_at = now()
  WHERE id = p_intent_id;

  RETURN jsonb_build_object('claimed', true, 'claim_token', v_token);
END;
$$;

-- Mark provider_attempted_at — called just before the actual Meta POST (point of no return)
CREATE OR REPLACE FUNCTION mark_fulfillment_notification_attempted(
  p_intent_id UUID,
  p_claim_token UUID
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  UPDATE promo_fulfillment_notification_intents SET
    provider_attempted_at = now()
  WHERE id = p_intent_id AND claim_token = p_claim_token AND delivery_status = 'pending';

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'reason', 'invalid_claim');
  END IF;

  RETURN jsonb_build_object('success', true);
END;
$$;

-- Privilege hardening
REVOKE EXECUTE ON FUNCTION claim_fulfillment_notification_dispatch(UUID, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION claim_fulfillment_notification_dispatch(UUID, INT) TO service_role;

REVOKE EXECUTE ON FUNCTION mark_fulfillment_notification_attempted(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION mark_fulfillment_notification_attempted(UUID, UUID) TO service_role;

-- Drop old single-arg version if it exists (from prior migration iteration)
DROP FUNCTION IF EXISTS claim_fulfillment_notification_dispatch(UUID);

-- Privilege verification
DO $$
DECLARE v_has BOOLEAN;
BEGIN
  SELECT has_function_privilege('service_role', 'claim_fulfillment_notification_dispatch(uuid, int)', 'EXECUTE') INTO v_has;
  IF NOT v_has THEN RAISE EXCEPTION '347: service_role cannot execute claim_fulfillment_notification_dispatch'; END IF;
  SELECT has_function_privilege('anon', 'claim_fulfillment_notification_dispatch(uuid, int)', 'EXECUTE') INTO v_has;
  IF v_has THEN RAISE EXCEPTION '347: anon CAN execute claim_fulfillment_notification_dispatch'; END IF;

  SELECT has_function_privilege('service_role', 'mark_fulfillment_notification_attempted(uuid, uuid)', 'EXECUTE') INTO v_has;
  IF NOT v_has THEN RAISE EXCEPTION '347: service_role cannot execute mark_fulfillment_notification_attempted'; END IF;
  SELECT has_function_privilege('anon', 'mark_fulfillment_notification_attempted(uuid, uuid)', 'EXECUTE') INTO v_has;
  IF v_has THEN RAISE EXCEPTION '347: anon CAN execute mark_fulfillment_notification_attempted'; END IF;

  RAISE NOTICE '347: All privilege checks passed';
END $$;
