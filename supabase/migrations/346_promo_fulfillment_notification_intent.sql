-- Migration 346: Promo Fulfillment Notification Intent (ACC-204)
--
-- 1. Create promo_fulfillment_notification_intents table
-- 2. Update transition_promo_fulfillment to atomically insert notification intent
-- 3. Create advance_promo_fulfillment_notification_status RPC (monotonic delivery state machine)
-- 4. Create finalize_promo_fulfillment_notification RPC (pending -> sent/failed)
-- 5. Privilege hardening

-- ═══════════════════════════════════════════════════════
-- Step 1: Notification intents table
-- ═══════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS promo_fulfillment_notification_intents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  redemption_id UUID NOT NULL REFERENCES promo_redemptions(id),
  business_id UUID NOT NULL,
  campaign_id UUID NOT NULL,
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL,
  delivery_status TEXT NOT NULL DEFAULT 'pending' CHECK (delivery_status IN ('pending', 'sent', 'delivered', 'read', 'failed')),
  provider_message_id TEXT,
  sent_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One notification per redemption per status transition
  CONSTRAINT uq_fulfillment_notification_transition UNIQUE (redemption_id, to_status)
);

CREATE INDEX IF NOT EXISTS idx_fulfillment_notif_redemption ON promo_fulfillment_notification_intents(redemption_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_fulfillment_notif_wamid ON promo_fulfillment_notification_intents(provider_message_id) WHERE provider_message_id IS NOT NULL;

-- ACC-204 Blocker 2: Track dispatch attempt for crash-safe idempotency
ALTER TABLE promo_fulfillment_notification_intents ADD COLUMN IF NOT EXISTS attempted_at TIMESTAMPTZ;

ALTER TABLE promo_fulfillment_notification_intents ENABLE ROW LEVEL SECURITY;
CREATE POLICY fulfillment_notif_service ON promo_fulfillment_notification_intents FOR ALL TO service_role USING (true);

-- ═══════════════════════════════════════════════════════
-- Step 2: Update transition_promo_fulfillment — atomic notification intent
-- ═══════════════════════════════════════════════════════
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

  -- ACC-204: Create notification intent atomically (one per transition, idempotent)
  INSERT INTO promo_fulfillment_notification_intents (redemption_id, business_id, campaign_id, from_status, to_status)
  VALUES (p_redemption_id, p_business_id, v_redemption.campaign_id, v_redemption.fulfillment_status, p_next_status)
  ON CONFLICT (redemption_id, to_status) DO NOTHING;

  RETURN jsonb_build_object('success', true, 'previous_status', v_redemption.fulfillment_status,
    'new_status', p_next_status);
END;
$$;

-- Privilege reassertion (CREATE OR REPLACE resets grants)
REVOKE EXECUTE ON FUNCTION transition_promo_fulfillment(UUID, UUID, TEXT, UUID, TEXT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION transition_promo_fulfillment(UUID, UUID, TEXT, UUID, TEXT, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION transition_promo_fulfillment(UUID, UUID, TEXT, UUID, TEXT, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION transition_promo_fulfillment(UUID, UUID, TEXT, UUID, TEXT, TEXT) TO service_role;

-- ═══════════════════════════════════════════════════════
-- Step 3: Monotonic delivery advance RPC for fulfillment notifications
-- ═══════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION advance_promo_fulfillment_notification_status(
  p_provider_message_id TEXT,
  p_status TEXT,
  p_timestamp TIMESTAMPTZ
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_intent RECORD;
  v_status_order INT;
  v_current_order INT;
BEGIN
  SELECT * INTO v_intent FROM promo_fulfillment_notification_intents
    WHERE provider_message_id = p_provider_message_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('advanced', false, 'reason', 'unknown_message');
  END IF;

  v_current_order := CASE v_intent.delivery_status
    WHEN 'pending' THEN 0 WHEN 'sent' THEN 1 WHEN 'delivered' THEN 2 WHEN 'read' THEN 3 WHEN 'failed' THEN -1 END;
  v_status_order := CASE p_status
    WHEN 'sent' THEN 1 WHEN 'delivered' THEN 2 WHEN 'read' THEN 3 WHEN 'failed' THEN -1 ELSE -2 END;

  -- Terminal: already failed -> no-op
  IF v_current_order = -1 THEN
    RETURN jsonb_build_object('advanced', false, 'reason', 'already_terminal');
  END IF;

  -- Late failed after delivered/read -> no-op
  IF p_status = 'failed' AND v_current_order >= 2 THEN
    RETURN jsonb_build_object('advanced', false, 'reason', 'late_failure_ignored');
  END IF;

  -- Failed from pending/sent -> terminal
  IF p_status = 'failed' THEN
    UPDATE promo_fulfillment_notification_intents SET delivery_status = 'failed'
    WHERE id = v_intent.id;
    RETURN jsonb_build_object('advanced', true, 'new_status', 'failed');
  END IF;

  -- Duplicate/older callback -> no-op
  IF v_status_order <= v_current_order THEN
    RETURN jsonb_build_object('advanced', false, 'reason', 'already_at_or_past');
  END IF;

  -- Advance forward
  UPDATE promo_fulfillment_notification_intents SET
    delivery_status = p_status,
    sent_at = CASE WHEN p_status IN ('sent', 'delivered', 'read') AND sent_at IS NULL THEN COALESCE(p_timestamp, now()) ELSE sent_at END,
    delivered_at = CASE WHEN p_status = 'delivered' THEN COALESCE(p_timestamp, now()) ELSE delivered_at END,
    read_at = CASE WHEN p_status = 'read' THEN COALESCE(p_timestamp, now()) ELSE read_at END
  WHERE id = v_intent.id;

  RETURN jsonb_build_object('advanced', true, 'new_status', p_status);
END;
$$;

REVOKE EXECUTE ON FUNCTION advance_promo_fulfillment_notification_status(TEXT, TEXT, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION advance_promo_fulfillment_notification_status(TEXT, TEXT, TIMESTAMPTZ) TO service_role;

-- ═══════════════════════════════════════════════════════
-- Step 4: Finalize RPC — pending -> sent/failed with provider_message_id
-- ═══════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION finalize_promo_fulfillment_notification(
  p_intent_id UUID,
  p_status TEXT,
  p_provider_message_id TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF p_status NOT IN ('sent', 'failed') THEN
    RETURN jsonb_build_object('success', false, 'reason', 'invalid_status');
  END IF;

  UPDATE promo_fulfillment_notification_intents SET
    delivery_status = p_status,
    provider_message_id = COALESCE(p_provider_message_id, provider_message_id),
    sent_at = CASE WHEN p_status = 'sent' THEN now() ELSE NULL END,
    attempted_at = COALESCE(attempted_at, now())
  WHERE id = p_intent_id AND delivery_status = 'pending';

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'reason', 'not_pending');
  END IF;

  RETURN jsonb_build_object('success', true);
END;
$$;

REVOKE EXECUTE ON FUNCTION finalize_promo_fulfillment_notification(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION finalize_promo_fulfillment_notification(UUID, TEXT, TEXT) TO service_role;

-- ═══════════════════════════════════════════════════════
-- Step 5: Privilege verification
-- ═══════════════════════════════════════════════════════
DO $$
DECLARE v_has BOOLEAN;
BEGIN
  -- transition_promo_fulfillment (re-asserted after CREATE OR REPLACE)
  SELECT has_function_privilege('service_role', 'transition_promo_fulfillment(uuid, uuid, text, uuid, text, text)', 'EXECUTE') INTO v_has;
  IF NOT v_has THEN RAISE EXCEPTION '346: service_role cannot execute transition_promo_fulfillment'; END IF;
  SELECT has_function_privilege('anon', 'transition_promo_fulfillment(uuid, uuid, text, uuid, text, text)', 'EXECUTE') INTO v_has;
  IF v_has THEN RAISE EXCEPTION '346: anon CAN execute transition_promo_fulfillment'; END IF;
  SELECT has_function_privilege('authenticated', 'transition_promo_fulfillment(uuid, uuid, text, uuid, text, text)', 'EXECUTE') INTO v_has;
  IF v_has THEN RAISE EXCEPTION '346: authenticated CAN execute transition_promo_fulfillment'; END IF;

  -- advance_promo_fulfillment_notification_status
  SELECT has_function_privilege('service_role', 'advance_promo_fulfillment_notification_status(text, text, timestamptz)', 'EXECUTE') INTO v_has;
  IF NOT v_has THEN RAISE EXCEPTION '346: service_role cannot execute advance_promo_fulfillment_notification_status'; END IF;
  SELECT has_function_privilege('anon', 'advance_promo_fulfillment_notification_status(text, text, timestamptz)', 'EXECUTE') INTO v_has;
  IF v_has THEN RAISE EXCEPTION '346: anon CAN execute advance_promo_fulfillment_notification_status'; END IF;

  -- finalize_promo_fulfillment_notification
  SELECT has_function_privilege('service_role', 'finalize_promo_fulfillment_notification(uuid, text, text)', 'EXECUTE') INTO v_has;
  IF NOT v_has THEN RAISE EXCEPTION '346: service_role cannot execute finalize_promo_fulfillment_notification'; END IF;
  SELECT has_function_privilege('anon', 'finalize_promo_fulfillment_notification(uuid, text, text)', 'EXECUTE') INTO v_has;
  IF v_has THEN RAISE EXCEPTION '346: anon CAN execute finalize_promo_fulfillment_notification'; END IF;

  RAISE NOTICE '346: All privilege checks passed';
END $$;
