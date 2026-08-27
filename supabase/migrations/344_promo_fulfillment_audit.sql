-- Migration 344: Promo Fulfillment Audit
--
-- Adds atomic audit write to transition_promo_fulfillment.
-- Reasserts privilege hardening.

CREATE OR REPLACE FUNCTION transition_promo_fulfillment(
  p_business_id UUID,
  p_redemption_id UUID,
  p_next_status TEXT,
  p_actor_user_id UUID,
  p_fulfillment_reference TEXT DEFAULT NULL,
  p_fulfillment_notes TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_redemption RECORD;
  v_allowed TEXT[];
BEGIN
  -- Lock redemption row
  SELECT * INTO v_redemption
  FROM promo_redemptions
  WHERE id = p_redemption_id AND business_id = p_business_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'reason', 'not_found');
  END IF;

  -- Only winners have fulfillment lifecycle
  IF v_redemption.outcome != 'winner' THEN
    RETURN jsonb_build_object('success', false, 'reason', 'not_winner');
  END IF;

  -- Validate transition
  CASE v_redemption.fulfillment_status
    WHEN 'pending' THEN v_allowed := ARRAY['processing', 'fulfilled', 'rejected', 'cancelled'];
    WHEN 'processing' THEN v_allowed := ARRAY['fulfilled', 'rejected', 'cancelled'];
    ELSE v_allowed := ARRAY[]::TEXT[]; -- terminal
  END CASE;

  IF NOT (p_next_status = ANY(v_allowed)) THEN
    RETURN jsonb_build_object('success', false, 'reason', 'invalid_transition',
      'current', v_redemption.fulfillment_status, 'requested', p_next_status);
  END IF;

  -- Verification gate for fulfillment
  IF p_next_status = 'fulfilled' THEN
    IF v_redemption.verification_mode = 'secure_pickup' AND v_redemption.verification_status != 'verified' THEN
      RETURN jsonb_build_object('success', false, 'reason', 'secure_pickup_verification_required',
        'verification_status', v_redemption.verification_status::text);
    END IF;
    -- Standard winners need at least phone_verified
    IF v_redemption.verification_mode = 'standard' AND v_redemption.verification_status NOT IN ('phone_verified', 'verified') THEN
      RETURN jsonb_build_object('success', false, 'reason', 'verification_required',
        'verification_status', v_redemption.verification_status::text);
    END IF;
  END IF;

  -- Perform transition
  UPDATE promo_redemptions SET
    fulfillment_status = p_next_status::promo_fulfillment_status,
    fulfillment_reference = COALESCE(p_fulfillment_reference, fulfillment_reference),
    fulfillment_notes = COALESCE(p_fulfillment_notes, fulfillment_notes),
    fulfilled_at = CASE WHEN p_next_status = 'fulfilled' THEN now() ELSE fulfilled_at END,
    fulfilled_by = CASE WHEN p_next_status = 'fulfilled' THEN p_actor_user_id ELSE fulfilled_by END,
    updated_at = now()
  WHERE id = p_redemption_id;

  -- Atomic fulfillment audit
  INSERT INTO admin_audit_logs (actor_id, action, entity_type, entity_id, details)
  VALUES (
    p_actor_user_id,
    'promotions.fulfillment_transition',
    'promo_redemption',
    p_redemption_id,
    jsonb_build_object(
      'business_id', v_redemption.business_id,
      'campaign_id', v_redemption.campaign_id,
      'from_status', v_redemption.fulfillment_status,
      'to_status', p_next_status,
      'fulfillment_reference', p_fulfillment_reference
    )
  );

  RETURN jsonb_build_object('success', true, 'previous_status', v_redemption.fulfillment_status,
    'new_status', p_next_status);
END;
$$;

-- Privilege reassertion
REVOKE EXECUTE ON FUNCTION transition_promo_fulfillment(UUID, UUID, TEXT, UUID, TEXT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION transition_promo_fulfillment(UUID, UUID, TEXT, UUID, TEXT, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION transition_promo_fulfillment(UUID, UUID, TEXT, UUID, TEXT, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION transition_promo_fulfillment(UUID, UUID, TEXT, UUID, TEXT, TEXT) TO service_role;

-- Verify privileges
DO $$
DECLARE v_has BOOLEAN;
BEGIN
  SELECT has_function_privilege('service_role', 'transition_promo_fulfillment(uuid, uuid, text, uuid, text, text)', 'EXECUTE') INTO v_has;
  IF NOT v_has THEN RAISE EXCEPTION '344: service_role cannot execute transition_promo_fulfillment'; END IF;
  SELECT has_function_privilege('anon', 'transition_promo_fulfillment(uuid, uuid, text, uuid, text, text)', 'EXECUTE') INTO v_has;
  IF v_has THEN RAISE EXCEPTION '344: anon CAN execute transition_promo_fulfillment'; END IF;
  SELECT has_function_privilege('authenticated', 'transition_promo_fulfillment(uuid, uuid, text, uuid, text, text)', 'EXECUTE') INTO v_has;
  IF v_has THEN RAISE EXCEPTION '344: authenticated CAN execute transition_promo_fulfillment'; END IF;
  RAISE NOTICE '344: All privilege checks passed';
END $$;
