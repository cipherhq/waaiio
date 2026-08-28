-- Migration 347: Atomic claim for fulfillment notification dispatch (ACC-204 Blocker 2)
--
-- Single-winner dispatch: SELECT FOR UPDATE + pending check + set attempted_at atomically.
-- Prevents two concurrent dispatchers from both calling the WhatsApp provider.

CREATE OR REPLACE FUNCTION claim_fulfillment_notification_dispatch(
  p_intent_id UUID
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_intent RECORD;
BEGIN
  -- Atomic claim: SELECT FOR UPDATE + check pending + check not already attempted
  SELECT * INTO v_intent FROM promo_fulfillment_notification_intents
    WHERE id = p_intent_id AND delivery_status = 'pending' AND attempted_at IS NULL
    FOR UPDATE;

  IF NOT FOUND THEN
    -- Already claimed or not pending
    RETURN jsonb_build_object('claimed', false, 'reason', 'not_available');
  END IF;

  -- Mark as claimed/attempted
  UPDATE promo_fulfillment_notification_intents SET attempted_at = now() WHERE id = p_intent_id;

  RETURN jsonb_build_object('claimed', true, 'intent_id', p_intent_id);
END;
$$;

REVOKE EXECUTE ON FUNCTION claim_fulfillment_notification_dispatch(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION claim_fulfillment_notification_dispatch(UUID) TO service_role;

-- Privilege verification
DO $$
DECLARE v_has BOOLEAN;
BEGIN
  SELECT has_function_privilege('service_role', 'claim_fulfillment_notification_dispatch(uuid)', 'EXECUTE') INTO v_has;
  IF NOT v_has THEN RAISE EXCEPTION '347: service_role cannot execute claim_fulfillment_notification_dispatch'; END IF;
  SELECT has_function_privilege('anon', 'claim_fulfillment_notification_dispatch(uuid)', 'EXECUTE') INTO v_has;
  IF v_has THEN RAISE EXCEPTION '347: anon CAN execute claim_fulfillment_notification_dispatch'; END IF;
  SELECT has_function_privilege('authenticated', 'claim_fulfillment_notification_dispatch(uuid)', 'EXECUTE') INTO v_has;
  IF v_has THEN RAISE EXCEPTION '347: authenticated CAN execute claim_fulfillment_notification_dispatch'; END IF;

  RAISE NOTICE '347: All privilege checks passed';
END $$;
