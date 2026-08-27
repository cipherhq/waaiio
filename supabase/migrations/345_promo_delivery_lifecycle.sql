-- Migration 345: Promo Delivery Lifecycle (#203)
--
-- 1. Expand promo_pickup_verifications with sent_at, read_at, invalidated_at
-- 2. Expand delivery_status CHECK to include 'delivered' and 'read'
-- 3. Create advance_promo_pickup_status RPC (monotonic delivery state machine)
-- 4. Update verify_promo_pickup to accept sent/delivered/read
-- 5. Update finalize_promo_pickup_delivery to set sent_at
-- 6. Create promo_winner_contacts table
-- 7. Create advance_promo_winner_contact_status RPC
-- 8. Privilege hardening

-- ═══════════════════════════════════════════════════════
-- Step 1: Expand promo_pickup_verifications columns
-- ═══════════════════════════════════════════════════════
ALTER TABLE promo_pickup_verifications ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ;
ALTER TABLE promo_pickup_verifications ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ;
ALTER TABLE promo_pickup_verifications ADD COLUMN IF NOT EXISTS invalidated_at TIMESTAMPTZ;

-- Migrate historical: old delivered_at was set on API acceptance, move to sent_at
UPDATE promo_pickup_verifications SET sent_at = delivered_at WHERE delivery_status = 'sent' AND sent_at IS NULL;

-- ═══════════════════════════════════════════════════════
-- Step 2: Expand delivery_status CHECK
-- ═══════════════════════════════════════════════════════
ALTER TABLE promo_pickup_verifications DROP CONSTRAINT IF EXISTS promo_pickup_verifications_delivery_status_check;
ALTER TABLE promo_pickup_verifications ADD CONSTRAINT promo_pickup_verifications_delivery_status_check
  CHECK (delivery_status IN ('pending', 'sent', 'delivered', 'read', 'failed'));

-- ═══════════════════════════════════════════════════════
-- Step 3: Monotonic delivery advance RPC
-- ═══════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION advance_promo_pickup_status(
  p_provider_message_id TEXT,
  p_status TEXT,
  p_timestamp TIMESTAMPTZ
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_verification RECORD;
  v_status_order INT;
  v_current_order INT;
BEGIN
  -- Status ordering for monotonic transitions
  -- pending=0, sent=1, delivered=2, read=3, failed=-1 (terminal)

  SELECT * INTO v_verification FROM promo_pickup_verifications
    WHERE provider_message_id = p_provider_message_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('advanced', false, 'reason', 'unknown_message');
  END IF;

  -- Determine order values
  v_current_order := CASE v_verification.delivery_status
    WHEN 'pending' THEN 0 WHEN 'sent' THEN 1 WHEN 'delivered' THEN 2 WHEN 'read' THEN 3 WHEN 'failed' THEN -1 END;
  v_status_order := CASE p_status
    WHEN 'sent' THEN 1 WHEN 'delivered' THEN 2 WHEN 'read' THEN 3 WHEN 'failed' THEN -1 ELSE -2 END;

  -- Terminal: already failed -> no-op
  IF v_current_order = -1 THEN
    RETURN jsonb_build_object('advanced', false, 'reason', 'already_terminal');
  END IF;

  -- Late failed after delivered/read -> no-op (don't regress)
  IF p_status = 'failed' AND v_current_order >= 2 THEN
    RETURN jsonb_build_object('advanced', false, 'reason', 'late_failure_ignored');
  END IF;

  -- Failed from pending/sent -> terminal + invalidate
  -- Must be checked BEFORE the general ordering check because failed has order -1
  -- which would be caught by the "already_at_or_past" check otherwise
  IF p_status = 'failed' THEN
    UPDATE promo_pickup_verifications SET
      delivery_status = 'failed',
      invalidated_at = COALESCE(p_timestamp, now())
    WHERE id = v_verification.id;
    RETURN jsonb_build_object('advanced', true, 'new_status', 'failed');
  END IF;

  -- Duplicate/older callback -> no-op
  IF v_status_order <= v_current_order THEN
    RETURN jsonb_build_object('advanced', false, 'reason', 'already_at_or_past');
  END IF;

  -- Advance forward
  UPDATE promo_pickup_verifications SET
    delivery_status = p_status,
    delivered_at = CASE WHEN p_status = 'delivered' THEN COALESCE(p_timestamp, now()) ELSE delivered_at END,
    read_at = CASE WHEN p_status = 'read' THEN COALESCE(p_timestamp, now()) ELSE read_at END
  WHERE id = v_verification.id;

  RETURN jsonb_build_object('advanced', true, 'new_status', p_status);
END;
$$;

REVOKE EXECUTE ON FUNCTION advance_promo_pickup_status(TEXT, TEXT, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION advance_promo_pickup_status(TEXT, TEXT, TIMESTAMPTZ) TO service_role;

-- ═══════════════════════════════════════════════════════
-- Step 4: Update verify_promo_pickup — accept sent/delivered/read
-- ═══════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION verify_promo_pickup(
  p_business_id UUID,
  p_redemption_id UUID,
  p_token_hmac TEXT,
  p_actor_user_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_redemption RECORD;
  v_verification RECORD;
BEGIN
  -- Lock redemption
  SELECT * INTO v_redemption
  FROM promo_redemptions
  WHERE id = p_redemption_id AND business_id = p_business_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'reason', 'not_found');
  END IF;

  IF v_redemption.verification_mode != 'secure_pickup' THEN
    RETURN jsonb_build_object('success', false, 'reason', 'not_secure_pickup');
  END IF;

  -- Block verification after terminal fulfillment
  IF v_redemption.fulfillment_status IN ('fulfilled', 'rejected', 'cancelled') THEN
    RETURN jsonb_build_object('success', false, 'reason', 'terminal_fulfillment');
  END IF;

  -- Already verified — idempotent success
  IF v_redemption.verification_status = 'verified' THEN
    RETURN jsonb_build_object('success', true, 'already_verified', true);
  END IF;

  IF v_redemption.verification_status = 'locked' THEN
    RETURN jsonb_build_object('success', false, 'reason', 'verification_locked');
  END IF;

  -- Find active (unused) verification record that was successfully delivered
  -- Accept sent, delivered, or read — all mean the OTP reached the user
  SELECT * INTO v_verification
  FROM promo_pickup_verifications
  WHERE redemption_id = p_redemption_id AND used_at IS NULL
    AND delivery_status IN ('sent', 'delivered', 'read')
    AND invalidated_at IS NULL
  FOR UPDATE;

  IF NOT FOUND THEN
    -- Check if there's a pending/failed token instead
    PERFORM 1 FROM promo_pickup_verifications
    WHERE redemption_id = p_redemption_id AND used_at IS NULL AND delivery_status IN ('pending', 'failed');
    IF FOUND THEN
      RETURN jsonb_build_object('success', false, 'reason', 'token_not_delivered');
    END IF;
    RETURN jsonb_build_object('success', false, 'reason', 'no_active_token');
  END IF;

  -- Check expiry
  IF v_verification.expires_at < now() THEN
    RETURN jsonb_build_object('success', false, 'reason', 'token_expired');
  END IF;

  -- Check attempts
  IF v_verification.attempt_count >= v_verification.max_attempts THEN
    -- Lock the redemption verification
    UPDATE promo_redemptions SET verification_status = 'locked', updated_at = now()
    WHERE id = p_redemption_id;
    RETURN jsonb_build_object('success', false, 'reason', 'max_attempts_exceeded');
  END IF;

  -- Compare HMAC
  IF v_verification.token_hmac != p_token_hmac THEN
    -- Increment attempts
    UPDATE promo_pickup_verifications SET attempt_count = attempt_count + 1, updated_at = now()
    WHERE id = v_verification.id;

    -- Check if this attempt exhausted the limit
    IF v_verification.attempt_count + 1 >= v_verification.max_attempts THEN
      UPDATE promo_redemptions SET verification_status = 'locked', updated_at = now()
      WHERE id = p_redemption_id;
    END IF;

    RETURN jsonb_build_object('success', false, 'reason', 'invalid_token',
      'attempts_remaining', v_verification.max_attempts - v_verification.attempt_count - 1);
  END IF;

  -- Token matches — mark verified
  UPDATE promo_pickup_verifications SET
    used_at = now(), verified_by = p_actor_user_id, updated_at = now()
  WHERE id = v_verification.id;

  UPDATE promo_redemptions SET
    verification_status = 'verified',
    verified_at = now(),
    verified_by = p_actor_user_id,
    updated_at = now()
  WHERE id = p_redemption_id;

  RETURN jsonb_build_object('success', true, 'verified', true);
END;
$$;

REVOKE EXECUTE ON FUNCTION verify_promo_pickup(UUID, UUID, TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION verify_promo_pickup(UUID, UUID, TEXT, UUID) TO service_role;

-- ═══════════════════════════════════════════════════════
-- Step 5: Update finalize_promo_pickup_delivery — set sent_at
-- ═══════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION finalize_promo_pickup_delivery(
  p_verification_id UUID,
  p_status TEXT,
  p_provider_message_id TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_status NOT IN ('sent', 'failed') THEN
    RETURN jsonb_build_object('success', false, 'reason', 'invalid_status');
  END IF;

  UPDATE promo_pickup_verifications SET
    delivery_status = p_status,
    provider_message_id = COALESCE(p_provider_message_id, provider_message_id),
    delivered_at = CASE WHEN p_status = 'sent' THEN now() ELSE NULL END,
    sent_at = CASE WHEN p_status = 'sent' THEN now() ELSE NULL END,
    updated_at = now()
  WHERE id = p_verification_id AND delivery_status = 'pending';

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'reason', 'no_pending_verification');
  END IF;

  RETURN jsonb_build_object('success', true);
END;
$$;

REVOKE EXECUTE ON FUNCTION finalize_promo_pickup_delivery(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION finalize_promo_pickup_delivery(UUID, TEXT, TEXT) TO service_role;

-- ═══════════════════════════════════════════════════════
-- Step 6: promo_winner_contacts table
-- ═══════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS promo_winner_contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  redemption_id UUID NOT NULL REFERENCES promo_redemptions(id),
  business_id UUID NOT NULL,
  campaign_id UUID NOT NULL,
  actor_id UUID NOT NULL,
  template_name TEXT NOT NULL,
  provider_message_id TEXT,
  delivery_status TEXT NOT NULL DEFAULT 'pending' CHECK (delivery_status IN ('pending', 'sent', 'delivered', 'read', 'failed')),
  sent_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_promo_winner_contacts_redemption ON promo_winner_contacts(redemption_id);
CREATE INDEX IF NOT EXISTS idx_promo_winner_contacts_provider_msg ON promo_winner_contacts(provider_message_id) WHERE provider_message_id IS NOT NULL;

ALTER TABLE promo_winner_contacts ENABLE ROW LEVEL SECURITY;
CREATE POLICY promo_winner_contacts_service ON promo_winner_contacts FOR ALL TO service_role USING (true);

-- ═══════════════════════════════════════════════════════
-- Step 7: Monotonic advance RPC for winner contacts
-- ═══════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION advance_promo_winner_contact_status(
  p_provider_message_id TEXT,
  p_status TEXT,
  p_timestamp TIMESTAMPTZ
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_contact RECORD;
  v_status_order INT;
  v_current_order INT;
BEGIN
  SELECT * INTO v_contact FROM promo_winner_contacts
    WHERE provider_message_id = p_provider_message_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('advanced', false, 'reason', 'unknown_message');
  END IF;

  v_current_order := CASE v_contact.delivery_status
    WHEN 'pending' THEN 0 WHEN 'sent' THEN 1 WHEN 'delivered' THEN 2 WHEN 'read' THEN 3 WHEN 'failed' THEN -1 END;
  v_status_order := CASE p_status
    WHEN 'sent' THEN 1 WHEN 'delivered' THEN 2 WHEN 'read' THEN 3 WHEN 'failed' THEN -1 ELSE -2 END;

  IF v_current_order = -1 THEN
    RETURN jsonb_build_object('advanced', false, 'reason', 'already_terminal');
  END IF;

  IF p_status = 'failed' AND v_current_order >= 2 THEN
    RETURN jsonb_build_object('advanced', false, 'reason', 'late_failure_ignored');
  END IF;

  -- Failed from pending/sent -> terminal (check before general ordering)
  IF p_status = 'failed' THEN
    UPDATE promo_winner_contacts SET delivery_status = 'failed'
    WHERE id = v_contact.id;
    RETURN jsonb_build_object('advanced', true, 'new_status', 'failed');
  END IF;

  IF v_status_order <= v_current_order THEN
    RETURN jsonb_build_object('advanced', false, 'reason', 'already_at_or_past');
  END IF;

  UPDATE promo_winner_contacts SET
    delivery_status = p_status,
    sent_at = CASE WHEN p_status IN ('sent', 'delivered', 'read') AND sent_at IS NULL THEN COALESCE(p_timestamp, now()) ELSE sent_at END,
    delivered_at = CASE WHEN p_status = 'delivered' THEN COALESCE(p_timestamp, now()) ELSE delivered_at END,
    read_at = CASE WHEN p_status = 'read' THEN COALESCE(p_timestamp, now()) ELSE read_at END
  WHERE id = v_contact.id;

  RETURN jsonb_build_object('advanced', true, 'new_status', p_status);
END;
$$;

REVOKE EXECUTE ON FUNCTION advance_promo_winner_contact_status(TEXT, TEXT, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION advance_promo_winner_contact_status(TEXT, TEXT, TIMESTAMPTZ) TO service_role;

-- ═══════════════════════════════════════════════════════
-- Step 8: Privilege verification
-- ═══════════════════════════════════════════════════════
DO $$
DECLARE v_has BOOLEAN;
BEGIN
  -- advance_promo_pickup_status
  SELECT has_function_privilege('service_role', 'advance_promo_pickup_status(text, text, timestamptz)', 'EXECUTE') INTO v_has;
  IF NOT v_has THEN RAISE EXCEPTION '345: service_role cannot execute advance_promo_pickup_status'; END IF;
  SELECT has_function_privilege('anon', 'advance_promo_pickup_status(text, text, timestamptz)', 'EXECUTE') INTO v_has;
  IF v_has THEN RAISE EXCEPTION '345: anon CAN execute advance_promo_pickup_status'; END IF;

  -- verify_promo_pickup (re-asserted after CREATE OR REPLACE)
  SELECT has_function_privilege('service_role', 'verify_promo_pickup(uuid, uuid, text, uuid)', 'EXECUTE') INTO v_has;
  IF NOT v_has THEN RAISE EXCEPTION '345: service_role cannot execute verify_promo_pickup'; END IF;
  SELECT has_function_privilege('anon', 'verify_promo_pickup(uuid, uuid, text, uuid)', 'EXECUTE') INTO v_has;
  IF v_has THEN RAISE EXCEPTION '345: anon CAN execute verify_promo_pickup'; END IF;

  -- finalize_promo_pickup_delivery (re-asserted after CREATE OR REPLACE)
  SELECT has_function_privilege('service_role', 'finalize_promo_pickup_delivery(uuid, text, text)', 'EXECUTE') INTO v_has;
  IF NOT v_has THEN RAISE EXCEPTION '345: service_role cannot execute finalize_promo_pickup_delivery'; END IF;
  SELECT has_function_privilege('anon', 'finalize_promo_pickup_delivery(uuid, text, text)', 'EXECUTE') INTO v_has;
  IF v_has THEN RAISE EXCEPTION '345: anon CAN execute finalize_promo_pickup_delivery'; END IF;

  -- advance_promo_winner_contact_status
  SELECT has_function_privilege('service_role', 'advance_promo_winner_contact_status(text, text, timestamptz)', 'EXECUTE') INTO v_has;
  IF NOT v_has THEN RAISE EXCEPTION '345: service_role cannot execute advance_promo_winner_contact_status'; END IF;
  SELECT has_function_privilege('anon', 'advance_promo_winner_contact_status(text, text, timestamptz)', 'EXECUTE') INTO v_has;
  IF v_has THEN RAISE EXCEPTION '345: anon CAN execute advance_promo_winner_contact_status'; END IF;

  RAISE NOTICE '345: All privilege checks passed';
END $$;
