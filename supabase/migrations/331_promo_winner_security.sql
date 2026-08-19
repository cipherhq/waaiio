-- Migration 331: Promotions Winner Security
--
-- 1. Prize-level verification_mode (standard | secure_pickup)
-- 2. Redemption verification snapshot (mode, status, verified_at/by)
-- 3. Campaign max_wins_per_participant
-- 4. Secure pickup token table (promo_pickup_verifications)
-- 5. Extended claim_promo_code with max-wins + verification snapshot
-- 6. Atomic fulfillment RPC (transition_promo_fulfillment)
-- 7. Secure pickup issue/verify RPCs

-- ═══════════════════════════════════════════════════════
-- Step 1: Enums
-- ═══════════════════════════════════════════════════════
DO $$ BEGIN
  CREATE TYPE promo_verification_mode AS ENUM ('standard', 'secure_pickup');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE promo_verification_status AS ENUM ('not_required', 'phone_verified', 'verified', 'locked');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ═══════════════════════════════════════════════════════
-- Step 2: Prize verification_mode
-- ═══════════════════════════════════════════════════════
ALTER TABLE promo_prizes
  ADD COLUMN IF NOT EXISTS verification_mode promo_verification_mode NOT NULL DEFAULT 'standard';

-- ═══════════════════════════════════════════════════════
-- Step 3: Campaign max_wins_per_participant
-- ═══════════════════════════════════════════════════════
ALTER TABLE promo_campaigns
  ADD COLUMN IF NOT EXISTS max_wins_per_participant INT;
-- NULL = unlimited. Positive integer = max wins per phone.

-- ═══════════════════════════════════════════════════════
-- Step 4: Redemption verification snapshot
-- ═══════════════════════════════════════════════════════
ALTER TABLE promo_redemptions
  ADD COLUMN IF NOT EXISTS verification_mode promo_verification_mode NOT NULL DEFAULT 'standard',
  ADD COLUMN IF NOT EXISTS verification_status promo_verification_status NOT NULL DEFAULT 'not_required',
  ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS verified_by UUID REFERENCES auth.users(id);

-- Backfill existing rows:
-- Winners get phone_verified (they proved identity via WhatsApp claim)
-- Try-again gets not_required
UPDATE promo_redemptions
SET verification_status = 'phone_verified'
WHERE outcome = 'winner' AND verification_status = 'not_required';

-- ═══════════════════════════════════════════════════════
-- Step 5: Secure pickup verifications table
-- ═══════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS promo_pickup_verifications (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id       UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  redemption_id     UUID NOT NULL REFERENCES promo_redemptions(id) ON DELETE CASCADE,
  phone_e164        TEXT NOT NULL,

  token_hmac        TEXT NOT NULL,
  expires_at        TIMESTAMPTZ NOT NULL,

  attempt_count     INT NOT NULL DEFAULT 0,
  max_attempts      INT NOT NULL DEFAULT 5,

  send_count        INT NOT NULL DEFAULT 1,
  send_window_start TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_sent_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  used_at           TIMESTAMPTZ,
  verified_by       UUID REFERENCES auth.users(id),

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One active verification per redemption
CREATE UNIQUE INDEX IF NOT EXISTS idx_promo_pickup_one_per_redemption
  ON promo_pickup_verifications (redemption_id) WHERE used_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_promo_pickup_business
  ON promo_pickup_verifications (business_id);

ALTER TABLE promo_pickup_verifications ENABLE ROW LEVEL SECURITY;

-- RLS: service_role only
DO $$ BEGIN
  DROP POLICY IF EXISTS promo_pickup_service_only ON promo_pickup_verifications;
  CREATE POLICY promo_pickup_service_only ON promo_pickup_verifications
    FOR ALL TO service_role USING (true) WITH CHECK (true);
EXCEPTION WHEN undefined_object THEN NULL;
END $$;

-- Grant service_role full access
GRANT ALL ON promo_pickup_verifications TO service_role;

-- ═══════════════════════════════════════════════════════
-- Step 6: Extended claim_promo_code
-- ═══════════════════════════════════════════════════════
-- Additions vs migration 330:
-- A. max_wins_per_participant enforcement (before code lookup)
-- B. Redemption verification snapshot from prize config
CREATE OR REPLACE FUNCTION claim_promo_code(
  p_business_id UUID,
  p_campaign_id UUID,
  p_normalized_code_hash TEXT,
  p_phone_e164 TEXT,
  p_inbound_message_id TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_campaign RECORD;
  v_code RECORD;
  v_existing_redemption RECORD;
  v_existing_attempt RECORD;
  v_attempt_count INT;
  v_claim_ref TEXT;
  v_redemption_id UUID;
  v_prize_name TEXT;
  v_prize_type TEXT;
  v_prize_value NUMERIC;
  v_prize_currency TEXT;
  v_elig_ack BOOLEAN;
  v_ref_hex TEXT;
  v_ref_attempt INT;
  v_inserted BOOLEAN;
  v_constraint_name TEXT;
  -- Winner security additions
  v_win_count INT;
  v_prize_verification promo_verification_mode;
  v_redemption_verification_status promo_verification_status;
BEGIN
  -- ── Advisory locks (identical to 330) ──
  IF p_inbound_message_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('promo_msg:' || p_inbound_message_id));
  END IF;
  PERFORM pg_advisory_xact_lock(
    hashtext('promo_rate:' || p_campaign_id::text || ':' || p_phone_e164)
  );

  -- ── Idempotency: existing redemption (identical to 330) ──
  IF p_inbound_message_id IS NOT NULL THEN
    SELECT r.id, r.outcome, r.claim_reference, r.prize_id,
           pp.name AS prize_name, pp.prize_type, pp.value, pp.currency
    INTO v_existing_redemption
    FROM promo_redemptions r
    LEFT JOIN promo_prizes pp ON pp.id = r.prize_id
    WHERE r.inbound_message_id = p_inbound_message_id;
    IF FOUND THEN
      RETURN jsonb_build_object(
        'success', true, 'result', v_existing_redemption.outcome::text,
        'claim_reference', v_existing_redemption.claim_reference,
        'prize_name', v_existing_redemption.prize_name,
        'prize_type', v_existing_redemption.prize_type::text,
        'prize_value', v_existing_redemption.value,
        'prize_currency', v_existing_redemption.currency,
        'idempotent_replay', true
      );
    END IF;
    SELECT id, result INTO v_existing_attempt
    FROM promo_verification_attempts
    WHERE inbound_message_id = p_inbound_message_id LIMIT 1;
    IF FOUND THEN
      RETURN jsonb_build_object('success', false, 'result', v_existing_attempt.result::text, 'idempotent_replay', true);
    END IF;
  END IF;

  -- ── Campaign lookup (identical to 330) ──
  SELECT * INTO v_campaign FROM promo_campaigns WHERE id = p_campaign_id AND business_id = p_business_id;
  IF NOT FOUND THEN
    INSERT INTO promo_verification_attempts (business_id, campaign_id, phone_e164, submitted_code_hash, result, inbound_message_id)
    VALUES (p_business_id, p_campaign_id, p_phone_e164, p_normalized_code_hash, 'campaign_inactive', p_inbound_message_id) ON CONFLICT (inbound_message_id) WHERE inbound_message_id IS NOT NULL DO NOTHING;
    RETURN jsonb_build_object('success', false, 'result', 'campaign_inactive');
  END IF;
  IF v_campaign.status != 'active' THEN
    INSERT INTO promo_verification_attempts (business_id, campaign_id, phone_e164, submitted_code_hash, result, inbound_message_id)
    VALUES (p_business_id, p_campaign_id, p_phone_e164, p_normalized_code_hash, 'campaign_inactive', p_inbound_message_id) ON CONFLICT (inbound_message_id) WHERE inbound_message_id IS NOT NULL DO NOTHING;
    RETURN jsonb_build_object('success', false, 'result', 'campaign_inactive');
  END IF;
  IF v_campaign.start_at IS NOT NULL AND now() < v_campaign.start_at THEN
    INSERT INTO promo_verification_attempts (business_id, campaign_id, phone_e164, submitted_code_hash, result, inbound_message_id)
    VALUES (p_business_id, p_campaign_id, p_phone_e164, p_normalized_code_hash, 'campaign_inactive', p_inbound_message_id) ON CONFLICT (inbound_message_id) WHERE inbound_message_id IS NOT NULL DO NOTHING;
    RETURN jsonb_build_object('success', false, 'result', 'campaign_inactive');
  END IF;
  IF v_campaign.end_at IS NOT NULL AND now() > v_campaign.end_at THEN
    INSERT INTO promo_verification_attempts (business_id, campaign_id, phone_e164, submitted_code_hash, result, inbound_message_id)
    VALUES (p_business_id, p_campaign_id, p_phone_e164, p_normalized_code_hash, 'campaign_inactive', p_inbound_message_id) ON CONFLICT (inbound_message_id) WHERE inbound_message_id IS NOT NULL DO NOTHING;
    RETURN jsonb_build_object('success', false, 'result', 'campaign_inactive');
  END IF;

  -- ── Rate limiting (identical to 330) ──
  SELECT COUNT(*) INTO v_attempt_count FROM promo_verification_attempts
  WHERE campaign_id = p_campaign_id AND phone_e164 = p_phone_e164
    AND created_at > now() - (v_campaign.rate_limit_window_minutes || ' minutes')::interval;
  IF v_attempt_count >= v_campaign.rate_limit_max_attempts THEN
    INSERT INTO promo_verification_attempts (business_id, campaign_id, phone_e164, submitted_code_hash, result, inbound_message_id)
    VALUES (p_business_id, p_campaign_id, p_phone_e164, p_normalized_code_hash, 'rate_limited', p_inbound_message_id) ON CONFLICT (inbound_message_id) WHERE inbound_message_id IS NOT NULL DO NOTHING;
    RETURN jsonb_build_object('success', false, 'result', 'rate_limited');
  END IF;
  SELECT COUNT(*) INTO v_attempt_count FROM promo_verification_attempts
  WHERE campaign_id = p_campaign_id AND phone_e164 = p_phone_e164;
  IF v_attempt_count >= v_campaign.max_attempts_per_phone THEN
    INSERT INTO promo_verification_attempts (business_id, campaign_id, phone_e164, submitted_code_hash, result, inbound_message_id)
    VALUES (p_business_id, p_campaign_id, p_phone_e164, p_normalized_code_hash, 'not_eligible', p_inbound_message_id) ON CONFLICT (inbound_message_id) WHERE inbound_message_id IS NOT NULL DO NOTHING;
    RETURN jsonb_build_object('success', false, 'result', 'not_eligible');
  END IF;

  -- ── Eligibility acknowledgment (identical to 330) ──
  IF v_campaign.eligibility_mode != 'none' THEN
    SELECT EXISTS (
      SELECT 1 FROM promo_eligibility_acks WHERE campaign_id = p_campaign_id AND phone_e164 = p_phone_e164
    ) INTO v_elig_ack;
    IF NOT v_elig_ack THEN
      INSERT INTO promo_verification_attempts (business_id, campaign_id, phone_e164, submitted_code_hash, result, inbound_message_id)
      VALUES (p_business_id, p_campaign_id, p_phone_e164, p_normalized_code_hash, 'not_eligible', p_inbound_message_id) ON CONFLICT (inbound_message_id) WHERE inbound_message_id IS NOT NULL DO NOTHING;
      RETURN jsonb_build_object('success', false, 'result', 'not_eligible',
        'eligibility_required', true, 'eligibility_mode', v_campaign.eligibility_mode, 'eligibility_prompt', v_campaign.eligibility_prompt);
    END IF;
  END IF;

  -- ══ NEW: Max wins per participant (BEFORE code lookup) ══
  -- Checked after rate-limit/eligibility but BEFORE consuming the code.
  -- This prevents a max-capped participant from consuming a winning code.
  IF v_campaign.max_wins_per_participant IS NOT NULL THEN
    SELECT COUNT(*) INTO v_win_count
    FROM promo_redemptions
    WHERE campaign_id = p_campaign_id
      AND phone_e164 = p_phone_e164
      AND outcome = 'winner';

    IF v_win_count >= v_campaign.max_wins_per_participant THEN
      INSERT INTO promo_verification_attempts
        (business_id, campaign_id, phone_e164, submitted_code_hash, result, inbound_message_id, metadata)
      VALUES
        (p_business_id, p_campaign_id, p_phone_e164, p_normalized_code_hash, 'not_eligible', p_inbound_message_id,
         jsonb_build_object('reason', 'max_wins_reached', 'current_wins', v_win_count, 'max_allowed', v_campaign.max_wins_per_participant))
      ON CONFLICT (inbound_message_id) WHERE inbound_message_id IS NOT NULL DO NOTHING;
      RETURN jsonb_build_object('success', false, 'result', 'not_eligible', 'reason', 'max_wins_reached');
    END IF;
  END IF;

  -- ── Code lookup and lock (identical to 330) ──
  SELECT * INTO v_code FROM promo_campaign_codes
  WHERE business_id = p_business_id AND campaign_id = p_campaign_id AND normalized_code_hash = p_normalized_code_hash FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO promo_verification_attempts (business_id, campaign_id, phone_e164, submitted_code_hash, result, inbound_message_id)
    VALUES (p_business_id, p_campaign_id, p_phone_e164, p_normalized_code_hash, 'invalid', p_inbound_message_id) ON CONFLICT (inbound_message_id) WHERE inbound_message_id IS NOT NULL DO NOTHING;
    RETURN jsonb_build_object('success', false, 'result', 'invalid');
  END IF;
  IF v_code.status = 'void' THEN
    INSERT INTO promo_verification_attempts (business_id, campaign_id, phone_e164, submitted_code_hash, result, inbound_message_id)
    VALUES (p_business_id, p_campaign_id, p_phone_e164, p_normalized_code_hash, 'invalid', p_inbound_message_id) ON CONFLICT (inbound_message_id) WHERE inbound_message_id IS NOT NULL DO NOTHING;
    RETURN jsonb_build_object('success', false, 'result', 'invalid');
  END IF;
  IF v_code.status = 'claimed' THEN
    INSERT INTO promo_verification_attempts (business_id, campaign_id, phone_e164, submitted_code_hash, result, inbound_message_id)
    VALUES (p_business_id, p_campaign_id, p_phone_e164, p_normalized_code_hash, 'already_claimed', p_inbound_message_id) ON CONFLICT (inbound_message_id) WHERE inbound_message_id IS NOT NULL DO NOTHING;
    RETURN jsonb_build_object('success', false, 'result', 'already_claimed');
  END IF;

  -- ── Code is unused — claim atomically ──
  UPDATE promo_campaign_codes SET status = 'claimed', claimed_at = now(), claimed_by_phone = p_phone_e164 WHERE id = v_code.id;
  UPDATE promo_campaigns SET integrity_locked = true, updated_at = now() WHERE id = p_campaign_id AND integrity_locked = false;

  -- ══ NEW: Resolve verification snapshot from prize configuration ══
  v_prize_verification := 'standard';
  IF v_code.outcome = 'winner' AND v_code.prize_id IS NOT NULL THEN
    SELECT COALESCE(verification_mode, 'standard') INTO v_prize_verification
    FROM promo_prizes WHERE id = v_code.prize_id;
  END IF;

  -- Determine initial verification status
  IF v_code.outcome = 'try_again' THEN
    v_redemption_verification_status := 'not_required';
  ELSE
    v_redemption_verification_status := 'phone_verified';
  END IF;

  -- ── Claim reference with collision retry (identical to 330) ──
  v_inserted := false;
  FOR v_ref_attempt IN 1..5 LOOP
    v_ref_hex := upper(encode(gen_random_bytes(8), 'hex'));
    v_claim_ref := 'WAA-' || substr(v_ref_hex, 1, 4) || '-' || substr(v_ref_hex, 5, 4) || '-' || substr(v_ref_hex, 9, 4) || '-' || substr(v_ref_hex, 13, 4);

    BEGIN
      INSERT INTO promo_redemptions (
        id, business_id, campaign_id, promo_code_id,
        phone_e164, inbound_message_id, outcome, prize_id,
        claim_reference, claimed_at, fulfillment_status,
        verification_mode, verification_status
      ) VALUES (
        gen_random_uuid(), p_business_id, p_campaign_id, v_code.id,
        p_phone_e164, p_inbound_message_id, v_code.outcome, v_code.prize_id,
        v_claim_ref, now(),
        CASE WHEN v_code.outcome = 'winner' THEN 'pending'::promo_fulfillment_status ELSE 'fulfilled'::promo_fulfillment_status END,
        v_prize_verification,
        v_redemption_verification_status
      )
      RETURNING id INTO v_redemption_id;
      v_inserted := true;
      EXIT;
    EXCEPTION WHEN unique_violation THEN
      GET STACKED DIAGNOSTICS v_constraint_name = CONSTRAINT_NAME;
      IF v_constraint_name IS NOT NULL AND v_constraint_name = 'idx_promo_redemptions_claim_ref_unique' THEN
        IF v_ref_attempt = 5 THEN
          RAISE EXCEPTION 'claim_reference_collision_exhausted: failed after 5 attempts';
        END IF;
      ELSE
        RAISE;
      END IF;
    END;
  END LOOP;

  -- ── Log attempt (identical to 330) ──
  INSERT INTO promo_verification_attempts (business_id, campaign_id, phone_e164, submitted_code_hash, result, inbound_message_id, promo_code_id)
  VALUES (p_business_id, p_campaign_id, p_phone_e164, p_normalized_code_hash,
    v_code.outcome::text::promo_attempt_result, p_inbound_message_id, v_code.id)
  ON CONFLICT (inbound_message_id) WHERE inbound_message_id IS NOT NULL DO NOTHING;

  -- ── Return result (extended with verification info) ──
  IF v_code.outcome = 'winner' THEN
    SELECT pp.name, pp.prize_type::text, pp.value, pp.currency
    INTO v_prize_name, v_prize_type, v_prize_value, v_prize_currency
    FROM promo_prizes pp WHERE pp.id = v_code.prize_id;
    RETURN jsonb_build_object(
      'success', true, 'result', 'winner',
      'claim_reference', v_claim_ref, 'redemption_id', v_redemption_id,
      'prize_name', v_prize_name, 'prize_type', v_prize_type,
      'prize_value', v_prize_value, 'prize_currency', v_prize_currency,
      'verification_mode', v_prize_verification::text,
      'verification_status', v_redemption_verification_status::text
    );
  ELSE
    RETURN jsonb_build_object(
      'success', true, 'result', 'try_again',
      'claim_reference', v_claim_ref, 'redemption_id', v_redemption_id
    );
  END IF;
END;
$$;

-- Privilege hardening for claim_promo_code
REVOKE EXECUTE ON FUNCTION claim_promo_code(UUID, UUID, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION claim_promo_code(UUID, UUID, TEXT, TEXT, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION claim_promo_code(UUID, UUID, TEXT, TEXT, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION claim_promo_code(UUID, UUID, TEXT, TEXT, TEXT) TO service_role;

-- ═══════════════════════════════════════════════════════
-- Step 7: Atomic fulfillment RPC
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

  RETURN jsonb_build_object('success', true, 'previous_status', v_redemption.fulfillment_status,
    'new_status', p_next_status);
END;
$$;

REVOKE EXECUTE ON FUNCTION transition_promo_fulfillment(UUID, UUID, TEXT, UUID, TEXT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION transition_promo_fulfillment(UUID, UUID, TEXT, UUID, TEXT, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION transition_promo_fulfillment(UUID, UUID, TEXT, UUID, TEXT, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION transition_promo_fulfillment(UUID, UUID, TEXT, UUID, TEXT, TEXT) TO service_role;

-- ═══════════════════════════════════════════════════════
-- Step 8: Secure pickup verification RPC
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

  -- Already verified — idempotent success
  IF v_redemption.verification_status = 'verified' THEN
    RETURN jsonb_build_object('success', true, 'already_verified', true);
  END IF;

  IF v_redemption.verification_status = 'locked' THEN
    RETURN jsonb_build_object('success', false, 'reason', 'verification_locked');
  END IF;

  -- Find active (unused, unexpired) verification record
  SELECT * INTO v_verification
  FROM promo_pickup_verifications
  WHERE redemption_id = p_redemption_id AND used_at IS NULL
  FOR UPDATE;

  IF NOT FOUND THEN
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

  -- ── Token matches — mark verified ──
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

REVOKE EXECUTE ON FUNCTION verify_promo_pickup(UUID, UUID, TEXT, UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION verify_promo_pickup(UUID, UUID, TEXT, UUID) FROM anon;
REVOKE EXECUTE ON FUNCTION verify_promo_pickup(UUID, UUID, TEXT, UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION verify_promo_pickup(UUID, UUID, TEXT, UUID) TO service_role;

-- ═══════════════════════════════════════════════════════
-- Step 9: Privilege verification
-- ═══════════════════════════════════════════════════════
DO $$
DECLARE v_has BOOLEAN;
BEGIN
  -- claim_promo_code
  SELECT has_function_privilege('service_role', 'claim_promo_code(uuid, uuid, text, text, text)', 'EXECUTE') INTO v_has;
  IF NOT v_has THEN RAISE EXCEPTION '331: service_role cannot execute claim_promo_code'; END IF;
  SELECT has_function_privilege('anon', 'claim_promo_code(uuid, uuid, text, text, text)', 'EXECUTE') INTO v_has;
  IF v_has THEN RAISE EXCEPTION '331: anon CAN execute claim_promo_code'; END IF;

  -- transition_promo_fulfillment
  SELECT has_function_privilege('service_role', 'transition_promo_fulfillment(uuid, uuid, text, uuid, text, text)', 'EXECUTE') INTO v_has;
  IF NOT v_has THEN RAISE EXCEPTION '331: service_role cannot execute transition_promo_fulfillment'; END IF;
  SELECT has_function_privilege('anon', 'transition_promo_fulfillment(uuid, uuid, text, uuid, text, text)', 'EXECUTE') INTO v_has;
  IF v_has THEN RAISE EXCEPTION '331: anon CAN execute transition_promo_fulfillment'; END IF;

  -- verify_promo_pickup
  SELECT has_function_privilege('service_role', 'verify_promo_pickup(uuid, uuid, text, uuid)', 'EXECUTE') INTO v_has;
  IF NOT v_has THEN RAISE EXCEPTION '331: service_role cannot execute verify_promo_pickup'; END IF;
  SELECT has_function_privilege('anon', 'verify_promo_pickup(uuid, uuid, text, uuid)', 'EXECUTE') INTO v_has;
  IF v_has THEN RAISE EXCEPTION '331: anon CAN execute verify_promo_pickup'; END IF;

  RAISE NOTICE '331: All privilege checks passed';
END $$;
