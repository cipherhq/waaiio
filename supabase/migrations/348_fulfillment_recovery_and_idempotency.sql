-- Migration 348: ACC-204 R4 — Finalize idempotency, mark_attempted hardening, recovery RPC
--
-- 1. Make finalize_promo_fulfillment_notification idempotent for same WAMID (re-finalize = no-op)
-- 2. Harden mark_fulfillment_notification_attempted: verify lease not expired
-- 3. Add find_recoverable_notification_intents for recovery API

-- ═══════════════════════════════════════════════════════
-- Step 1: Idempotent finalize — same WAMID = success, different WAMID = reject
--         + claim token enforcement for pre-provider failures (R6)
-- ═══════════════════════════════════════════════════════

-- Drop old 3-param overload from migration 346 (CREATE OR REPLACE with new
-- signature creates an overload rather than replacing; we need exactly one version)
DROP FUNCTION IF EXISTS finalize_promo_fulfillment_notification(UUID, TEXT, TEXT);

CREATE OR REPLACE FUNCTION finalize_promo_fulfillment_notification(
  p_intent_id UUID,
  p_status TEXT,
  p_provider_message_id TEXT DEFAULT NULL,
  p_claim_token UUID DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_intent RECORD;
BEGIN
  IF p_status NOT IN ('sent', 'failed') THEN
    RETURN jsonb_build_object('success', false, 'reason', 'invalid_status');
  END IF;

  -- Lock the intent row
  SELECT * INTO v_intent FROM promo_fulfillment_notification_intents
    WHERE id = p_intent_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'reason', 'not_found');
  END IF;

  -- Already finalized — check idempotency
  IF v_intent.delivery_status != 'pending' THEN
    -- Same WAMID = idempotent re-finalize (success)
    IF p_provider_message_id IS NOT NULL
       AND v_intent.provider_message_id = p_provider_message_id
       AND v_intent.delivery_status = p_status THEN
      RETURN jsonb_build_object('success', true, 'reason', 'idempotent');
    END IF;
    -- Different WAMID or different status = reject (fail closed)
    RETURN jsonb_build_object('success', false, 'reason', 'not_pending',
      'current_status', v_intent.delivery_status);
  END IF;

  -- Pre-provider terminal failure: require valid current claim authority.
  -- A stale worker whose lease expired must NOT finalize as 'failed' —
  -- a new claimant may have legitimately reclaimed the intent.
  -- Post-provider (provider_attempted_at IS NOT NULL): the provider attempt
  -- can't be undone, so finalization authority belongs to whoever attempted.
  IF v_intent.provider_attempted_at IS NULL AND p_status = 'failed' THEN
    IF p_claim_token IS NULL
       OR v_intent.claim_token IS NULL
       OR v_intent.claim_token != p_claim_token
       OR v_intent.claim_expires_at < now() THEN
      RETURN jsonb_build_object('success', false, 'reason', 'invalid_claim_for_failure');
    END IF;
  END IF;

  -- Finalize
  UPDATE promo_fulfillment_notification_intents SET
    delivery_status = p_status,
    provider_message_id = COALESCE(p_provider_message_id, provider_message_id),
    sent_at = CASE WHEN p_status = 'sent' THEN now() ELSE NULL END,
    attempted_at = COALESCE(attempted_at, now())
  WHERE id = p_intent_id;

  RETURN jsonb_build_object('success', true);
END;
$$;

-- Privilege reassertion (CREATE OR REPLACE resets grants)
REVOKE EXECUTE ON FUNCTION finalize_promo_fulfillment_notification(UUID, TEXT, TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION finalize_promo_fulfillment_notification(UUID, TEXT, TEXT, UUID) TO service_role;

-- ═══════════════════════════════════════════════════════
-- Step 2: Harden mark_attempted — verify claim_token + pending + NOT already attempted + lease active
-- ═══════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION mark_fulfillment_notification_attempted(
  p_intent_id UUID,
  p_claim_token UUID
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  UPDATE promo_fulfillment_notification_intents SET
    provider_attempted_at = now()
  WHERE id = p_intent_id
    AND claim_token = p_claim_token
    AND delivery_status = 'pending'
    AND provider_attempted_at IS NULL
    AND claim_expires_at > now();

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'reason', 'invalid_claim');
  END IF;

  RETURN jsonb_build_object('success', true);
END;
$$;

-- Privilege reassertion
REVOKE EXECUTE ON FUNCTION mark_fulfillment_notification_attempted(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION mark_fulfillment_notification_attempted(UUID, UUID) TO service_role;

-- ═══════════════════════════════════════════════════════
-- Step 3: Recovery RPC — find reclaimable intents
-- ═══════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION find_recoverable_notification_intents(
  p_limit INT DEFAULT 10
) RETURNS SETOF promo_fulfillment_notification_intents
LANGUAGE sql SECURITY DEFINER SET search_path = public
AS $$
  SELECT * FROM promo_fulfillment_notification_intents
  WHERE delivery_status = 'pending'
    AND provider_attempted_at IS NULL
    AND (claim_token IS NULL OR claim_expires_at < now())
  ORDER BY created_at ASC
  LIMIT p_limit;
$$;

REVOKE EXECUTE ON FUNCTION find_recoverable_notification_intents(INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION find_recoverable_notification_intents(INT) TO service_role;

-- ═══════════════════════════════════════════════════════
-- Step 4: Privilege verification
-- ═══════════════════════════════════════════════════════
DO $$
DECLARE v_has BOOLEAN;
BEGIN
  SELECT has_function_privilege('service_role', 'finalize_promo_fulfillment_notification(uuid, text, text, uuid)', 'EXECUTE') INTO v_has;
  IF NOT v_has THEN RAISE EXCEPTION '348: service_role cannot execute finalize_promo_fulfillment_notification'; END IF;
  SELECT has_function_privilege('anon', 'finalize_promo_fulfillment_notification(uuid, text, text, uuid)', 'EXECUTE') INTO v_has;
  IF v_has THEN RAISE EXCEPTION '348: anon CAN execute finalize_promo_fulfillment_notification'; END IF;

  SELECT has_function_privilege('service_role', 'mark_fulfillment_notification_attempted(uuid, uuid)', 'EXECUTE') INTO v_has;
  IF NOT v_has THEN RAISE EXCEPTION '348: service_role cannot execute mark_fulfillment_notification_attempted'; END IF;
  SELECT has_function_privilege('anon', 'mark_fulfillment_notification_attempted(uuid, uuid)', 'EXECUTE') INTO v_has;
  IF v_has THEN RAISE EXCEPTION '348: anon CAN execute mark_fulfillment_notification_attempted'; END IF;

  SELECT has_function_privilege('service_role', 'find_recoverable_notification_intents(int)', 'EXECUTE') INTO v_has;
  IF NOT v_has THEN RAISE EXCEPTION '348: service_role cannot execute find_recoverable_notification_intents'; END IF;
  SELECT has_function_privilege('anon', 'find_recoverable_notification_intents(int)', 'EXECUTE') INTO v_has;
  IF v_has THEN RAISE EXCEPTION '348: anon CAN execute find_recoverable_notification_intents'; END IF;

  RAISE NOTICE '348: All privilege checks passed';
END $$;
