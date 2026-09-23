-- Migration 398: Saved-card session phone normalization (#370 P0)
--
-- Root cause: saved-card PIN sessions created with +E.164 phone (e.g. +15712746425)
-- but Meta inbound messages arrive digits-only (e.g. 15712746425). Session lookup
-- is exact-match, so PIN sessions were invisible.
--
-- Fix: All saved-card sessions now use digits-only phone. Legacy +E.164 rows are
-- deactivated atomically by establish_saved_card_session().
--
-- Also adds confirmation delivery lifecycle (claim/fence/complete) for Card Saved
-- messages, ensuring exactly-once delivery with proven WAMID before state transition.

-- ═══════════════════════════════════════════════════════
-- A. establish_saved_card_session() — atomic session normalization
-- ═══════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION establish_saved_card_session(
  p_canon_phone TEXT,
  p_business_id UUID,
  p_current_step TEXT,
  p_session_data JSONB,
  p_ttl_seconds INT DEFAULT 600
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE
  v_session_phone TEXT;
  v_session_id UUID;
  v_version INT;
BEGIN
  -- Validate E.164
  IF p_canon_phone !~ '^\+[1-9]\d{7,14}$' THEN
    RAISE EXCEPTION 'Invalid E.164 phone: %', p_canon_phone;
  END IF;

  -- Validate step
  IF p_current_step NOT IN ('save_card_pin', 'replace_card_pin') THEN
    RAISE EXCEPTION 'Invalid step: %', p_current_step;
  END IF;

  -- Validate TTL
  IF p_ttl_seconds < 60 OR p_ttl_seconds > 3600 THEN
    RAISE EXCEPTION 'TTL must be 60..3600, got %', p_ttl_seconds;
  END IF;

  -- Derive digits-only session phone
  v_session_phone := ltrim(p_canon_phone, '+');

  -- Advisory lock prevents concurrent establish for same phone+business
  PERFORM pg_advisory_xact_lock(hashtext(p_canon_phone || '::' || p_business_id::text));

  -- Deactivate any active legacy +E.164 row for this business
  UPDATE bot_sessions
  SET is_active = false, updated_at = NOW()
  WHERE whatsapp_number = p_canon_phone
    AND business_id = p_business_id
    AND is_active = true;

  -- UPSERT the digits-only row using the partial unique index
  INSERT INTO bot_sessions (
    whatsapp_number, business_id, current_step, session_data,
    is_active, expires_at, version
  ) VALUES (
    v_session_phone, p_business_id, p_current_step, p_session_data,
    true, NOW() + (p_ttl_seconds || ' seconds')::INTERVAL, 1
  )
  ON CONFLICT (whatsapp_number, business_id) WHERE business_id IS NOT NULL
  DO UPDATE SET
    is_active = true,
    current_step = EXCLUDED.current_step,
    session_data = EXCLUDED.session_data,
    expires_at = EXCLUDED.expires_at,
    version = bot_sessions.version + 1,
    updated_at = NOW()
  RETURNING id, version INTO v_session_id, v_version;

  RETURN jsonb_build_object(
    'session_id', v_session_id,
    'version', v_version,
    'session_phone', v_session_phone
  );
END;
$$;

REVOKE ALL ON FUNCTION establish_saved_card_session(TEXT, UUID, TEXT, JSONB, INT) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION establish_saved_card_session(TEXT, UUID, TEXT, JSONB, INT) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION establish_saved_card_session(TEXT, UUID, TEXT, JSONB, INT) FROM authenticated;
  END IF;
END $$;
GRANT EXECUTE ON FUNCTION establish_saved_card_session(TEXT, UUID, TEXT, JSONB, INT) TO service_role;


-- ═══════════════════════════════════════════════════════
-- B. claim_exact_activation_delivery() — exact offer activation claim
-- ═══════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION claim_exact_activation_delivery(
  p_offer_id UUID,
  p_lease_seconds INT DEFAULT 120
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_token UUID := gen_random_uuid();
  v_offer payment_saved_card_offers%ROWTYPE;
BEGIN
  SELECT * INTO v_offer
  FROM payment_saved_card_offers
  WHERE id = p_offer_id
    AND state = 'accepted'
    AND consent_source = 'provider_checkout'
    AND activation_prompt_sent_at IS NULL
    AND activation_send_started_at IS NULL
    AND (claim_token IS NULL OR claim_expires_at < NOW())
  FOR UPDATE;

  IF NOT FOUND THEN RETURN NULL; END IF;

  UPDATE payment_saved_card_offers
  SET claim_token = v_token,
      claim_expires_at = NOW() + (p_lease_seconds || ' seconds')::INTERVAL
  WHERE id = v_offer.id;

  RETURN jsonb_build_object(
    'offer_id', v_offer.id,
    'claim_token', v_token,
    'customer_phone', v_offer.customer_phone,
    'business_id', v_offer.business_id,
    'card_display', v_offer.card_display,
    'channel_id', v_offer.channel_id
  );
END;
$$;

REVOKE ALL ON FUNCTION claim_exact_activation_delivery(UUID, INT) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION claim_exact_activation_delivery(UUID, INT) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION claim_exact_activation_delivery(UUID, INT) FROM authenticated;
  END IF;
END $$;
GRANT EXECUTE ON FUNCTION claim_exact_activation_delivery(UUID, INT) TO service_role;


-- ═══════════════════════════════════════════════════════
-- C. release_activation_pre_emission() — clear claim + send_started on proven pre-emission
-- ═══════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION release_activation_pre_emission(
  p_offer_id UUID,
  p_claim_token UUID
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE payment_saved_card_offers
  SET claim_token = NULL,
      claim_expires_at = NULL,
      activation_send_started_at = NULL
  WHERE id = p_offer_id
    AND claim_token = p_claim_token;
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION release_activation_pre_emission(UUID, UUID) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION release_activation_pre_emission(UUID, UUID) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION release_activation_pre_emission(UUID, UUID) FROM authenticated;
  END IF;
END $$;
GRANT EXECUTE ON FUNCTION release_activation_pre_emission(UUID, UUID) TO service_role;


-- ═══════════════════════════════════════════════════════
-- D. Confirmation delivery columns
-- ═══════════════════════════════════════════════════════

ALTER TABLE payment_saved_card_offers
  ADD COLUMN IF NOT EXISTS confirmation_send_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS confirmation_claim_token UUID,
  ADD COLUMN IF NOT EXISTS confirmation_claim_expires_at TIMESTAMPTZ;


-- ═══════════════════════════════════════════════════════
-- E. claim_confirmation_delivery() — claim a committed offer for Card Saved send
-- ═══════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION claim_confirmation_delivery(
  p_offer_id UUID,
  p_lease_seconds INT DEFAULT 120
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_token UUID := gen_random_uuid();
  v_offer payment_saved_card_offers%ROWTYPE;
BEGIN
  SELECT * INTO v_offer
  FROM payment_saved_card_offers
  WHERE id = p_offer_id
    AND state = 'committed'
    AND confirmation_delivered_at IS NULL
    AND confirmation_send_started_at IS NULL
    AND (confirmation_claim_token IS NULL OR confirmation_claim_expires_at < NOW())
  FOR UPDATE;

  IF NOT FOUND THEN RETURN NULL; END IF;

  UPDATE payment_saved_card_offers
  SET confirmation_claim_token = v_token,
      confirmation_claim_expires_at = NOW() + (p_lease_seconds || ' seconds')::INTERVAL
  WHERE id = v_offer.id;

  RETURN jsonb_build_object(
    'offer_id', v_offer.id,
    'claim_token', v_token,
    'customer_phone', v_offer.customer_phone,
    'business_id', v_offer.business_id,
    'channel_id', v_offer.channel_id,
    'committed_card_display', v_offer.committed_card_display
  );
END;
$$;

REVOKE ALL ON FUNCTION claim_confirmation_delivery(UUID, INT) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION claim_confirmation_delivery(UUID, INT) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION claim_confirmation_delivery(UUID, INT) FROM authenticated;
  END IF;
END $$;
GRANT EXECUTE ON FUNCTION claim_confirmation_delivery(UUID, INT) TO service_role;


-- ═══════════════════════════════════════════════════════
-- F. mark_confirmation_send_started() — fenced by confirmation_claim_token
-- ═══════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION mark_confirmation_send_started(
  p_offer_id UUID,
  p_claim_token UUID
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE payment_saved_card_offers
  SET confirmation_send_started_at = NOW()
  WHERE id = p_offer_id
    AND confirmation_claim_token = p_claim_token
    AND confirmation_send_started_at IS NULL;
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION mark_confirmation_send_started(UUID, UUID) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION mark_confirmation_send_started(UUID, UUID) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION mark_confirmation_send_started(UUID, UUID) FROM authenticated;
  END IF;
END $$;
GRANT EXECUTE ON FUNCTION mark_confirmation_send_started(UUID, UUID) TO service_role;


-- ═══════════════════════════════════════════════════════
-- G. complete_confirmation_delivery() — committed → confirmed with WAMID proof
-- ═══════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION complete_confirmation_delivery(
  p_offer_id UUID,
  p_claim_token UUID,
  p_customer_phone TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE payment_saved_card_offers
  SET state = 'confirmed',
      confirmation_delivered_at = NOW(),
      confirmation_claim_token = NULL,
      confirmation_claim_expires_at = NULL
  WHERE id = p_offer_id
    AND confirmation_claim_token = p_claim_token
    AND customer_phone = p_customer_phone
    AND state = 'committed';
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION complete_confirmation_delivery(UUID, UUID, TEXT) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION complete_confirmation_delivery(UUID, UUID, TEXT) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION complete_confirmation_delivery(UUID, UUID, TEXT) FROM authenticated;
  END IF;
END $$;
GRANT EXECUTE ON FUNCTION complete_confirmation_delivery(UUID, UUID, TEXT) TO service_role;


-- ═══════════════════════════════════════════════════════
-- H. release_confirmation_pre_emission() — clear claim + send_started on proven pre-emission
-- ═══════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION release_confirmation_pre_emission(
  p_offer_id UUID,
  p_claim_token UUID
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE payment_saved_card_offers
  SET confirmation_claim_token = NULL,
      confirmation_claim_expires_at = NULL,
      confirmation_send_started_at = NULL
  WHERE id = p_offer_id
    AND confirmation_claim_token = p_claim_token;
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION release_confirmation_pre_emission(UUID, UUID) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION release_confirmation_pre_emission(UUID, UUID) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION release_confirmation_pre_emission(UUID, UUID) FROM authenticated;
  END IF;
END $$;
GRANT EXECUTE ON FUNCTION release_confirmation_pre_emission(UUID, UUID) TO service_role;


-- ═══════════════════════════════════════════════════════
-- I. discover_pending_confirmation() — global oldest-first claim for recovery
-- ═══════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION discover_pending_confirmation(
  p_lease_seconds INT DEFAULT 120
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_token UUID := gen_random_uuid();
  v_offer payment_saved_card_offers%ROWTYPE;
BEGIN
  SELECT * INTO v_offer
  FROM payment_saved_card_offers
  WHERE state = 'committed'
    AND confirmation_delivered_at IS NULL
    AND confirmation_send_started_at IS NULL
    AND (confirmation_claim_token IS NULL OR confirmation_claim_expires_at < NOW())
  ORDER BY credential_committed_at ASC
  LIMIT 1
  FOR UPDATE SKIP LOCKED;

  IF NOT FOUND THEN RETURN NULL; END IF;

  UPDATE payment_saved_card_offers
  SET confirmation_claim_token = v_token,
      confirmation_claim_expires_at = NOW() + (p_lease_seconds || ' seconds')::INTERVAL
  WHERE id = v_offer.id;

  RETURN jsonb_build_object(
    'offer_id', v_offer.id,
    'claim_token', v_token,
    'customer_phone', v_offer.customer_phone,
    'business_id', v_offer.business_id,
    'channel_id', v_offer.channel_id,
    'committed_card_display', v_offer.committed_card_display
  );
END;
$$;

REVOKE ALL ON FUNCTION discover_pending_confirmation(INT) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION discover_pending_confirmation(INT) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION discover_pending_confirmation(INT) FROM authenticated;
  END IF;
END $$;
GRANT EXECUTE ON FUNCTION discover_pending_confirmation(INT) TO service_role;


-- ═══════════════════════════════════════════════════════
-- J. Self-verification
-- ═══════════════════════════════════════════════════════

DO $$
DECLARE
  v_fn TEXT;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'establish_saved_card_session',
    'claim_exact_activation_delivery',
    'release_activation_pre_emission',
    'claim_confirmation_delivery',
    'mark_confirmation_send_started',
    'complete_confirmation_delivery',
    'release_confirmation_pre_emission',
    'discover_pending_confirmation'
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p
      JOIN pg_namespace n ON p.pronamespace = n.oid
      WHERE n.nspname = 'public' AND p.proname = v_fn
    ) THEN
      RAISE EXCEPTION 'M398 self-verification FAILED: function % not found', v_fn;
    END IF;
  END LOOP;

  -- Verify confirmation columns exist
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'payment_saved_card_offers'
      AND column_name = 'confirmation_send_started_at'
  ) THEN
    RAISE EXCEPTION 'M398 self-verification FAILED: confirmation_send_started_at column missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'payment_saved_card_offers'
      AND column_name = 'confirmation_claim_token'
  ) THEN
    RAISE EXCEPTION 'M398 self-verification FAILED: confirmation_claim_token column missing';
  END IF;

  RAISE NOTICE 'M398 self-verification PASSED: all 8 RPCs + 3 columns verified';
END $$;
