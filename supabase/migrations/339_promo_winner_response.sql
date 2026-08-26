-- Migration 339: Winner response block + recipient instructions
--
-- Issue: #199A (GitHub #201) — Winner response block
--
-- A. Add prize_instructions column to promo_prizes
-- B. Update claim_promo_code replay branch for field parity with first-claim branch
-- C. Update default winner_message for new campaigns

-- ═══════════════════════════════════════════════════════
-- A. prize_instructions column
-- ═══════════════════════════════════════════════════════
ALTER TABLE promo_prizes ADD COLUMN IF NOT EXISTS prize_instructions TEXT;

-- ═══════════════════════════════════════════════════════
-- B. claim_promo_code replay branch parity
-- ═══════════════════════════════════════════════════════
-- The replay (idempotent) branch currently omits redemption_id,
-- verification_mode, verification_status, and prize_instructions.
-- First-claim branch returns them. This fixes the asymmetry so the
-- application layer can generate consistent claim blocks for both paths.

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
  v_prize_instructions TEXT;
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
  -- ── Advisory locks (identical to 338) ──
  IF p_inbound_message_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('promo_msg:' || p_inbound_message_id));
  END IF;
  PERFORM pg_advisory_xact_lock(
    hashtext('promo_rate:' || p_campaign_id::text || ':' || p_phone_e164)
  );

  -- ── Idempotency: existing redemption ──
  -- FIX (339): Add verification_mode, verification_status, prize_instructions
  -- to the replay SELECT + return for parity with the first-claim branch.
  IF p_inbound_message_id IS NOT NULL THEN
    SELECT r.id, r.outcome, r.claim_reference, r.prize_id,
           r.verification_mode, r.verification_status,
           pp.name AS prize_name, pp.prize_type, pp.value, pp.currency,
           pp.prize_instructions
    INTO v_existing_redemption
    FROM promo_redemptions r
    LEFT JOIN promo_prizes pp ON pp.id = r.prize_id
    WHERE r.inbound_message_id = p_inbound_message_id;
    IF FOUND THEN
      RETURN jsonb_build_object(
        'success', true, 'result', v_existing_redemption.outcome::text,
        'claim_reference', v_existing_redemption.claim_reference,
        'redemption_id', v_existing_redemption.id,
        'prize_name', v_existing_redemption.prize_name,
        'prize_type', v_existing_redemption.prize_type::text,
        'prize_value', v_existing_redemption.value,
        'prize_currency', v_existing_redemption.currency,
        'verification_mode', v_existing_redemption.verification_mode::text,
        'verification_status', v_existing_redemption.verification_status::text,
        'prize_instructions', v_existing_redemption.prize_instructions,
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

  -- ── Campaign lookup (identical to 338) ──
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

  -- ── Rate limiting (identical to 338) ──
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

  -- ── Eligibility acknowledgment (identical to 338) ──
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

  -- ── Max wins per participant (identical to 338) ──
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

  -- ── Code lookup and lock (identical to 338) ──
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

  -- ── Resolve verification snapshot from prize configuration (identical to 338) ──
  v_prize_verification := 'standard';
  v_prize_instructions := NULL;
  IF v_code.outcome = 'winner' AND v_code.prize_id IS NOT NULL THEN
    SELECT COALESCE(verification_mode, 'standard'), prize_instructions
    INTO v_prize_verification, v_prize_instructions
    FROM promo_prizes WHERE id = v_code.prize_id;
  END IF;

  -- Determine initial verification status
  IF v_code.outcome = 'try_again' THEN
    v_redemption_verification_status := 'not_required';
  ELSE
    v_redemption_verification_status := 'phone_verified';
  END IF;

  -- ── Claim reference with collision retry ──
  -- FIX (#188): schema-qualify extensions.gen_random_bytes to resolve under
  -- SET search_path = public where pgcrypto lives in the extensions schema.
  v_inserted := false;
  FOR v_ref_attempt IN 1..5 LOOP
    v_ref_hex := upper(encode(extensions.gen_random_bytes(8), 'hex'));
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

  -- ── Log attempt (identical to 338) ──
  INSERT INTO promo_verification_attempts (business_id, campaign_id, phone_e164, submitted_code_hash, result, inbound_message_id, promo_code_id)
  VALUES (p_business_id, p_campaign_id, p_phone_e164, p_normalized_code_hash,
    v_code.outcome::text::promo_attempt_result, p_inbound_message_id, v_code.id)
  ON CONFLICT (inbound_message_id) WHERE inbound_message_id IS NOT NULL DO NOTHING;

  -- ── Return result (extended with prize_instructions for claim block) ──
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
      'verification_status', v_redemption_verification_status::text,
      'prize_instructions', v_prize_instructions
    );
  ELSE
    RETURN jsonb_build_object(
      'success', true, 'result', 'try_again',
      'claim_reference', v_claim_ref, 'redemption_id', v_redemption_id
    );
  END IF;
END;
$$;

-- Privilege hardening (identical to 338)
REVOKE EXECUTE ON FUNCTION claim_promo_code(UUID, UUID, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION claim_promo_code(UUID, UUID, TEXT, TEXT, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION claim_promo_code(UUID, UUID, TEXT, TEXT, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION claim_promo_code(UUID, UUID, TEXT, TEXT, TEXT) TO service_role;

-- ═══════════════════════════════════════════════════════
-- C. Update default winner_message for new campaigns
-- ═══════════════════════════════════════════════════════
-- The old default was "Congratulations! ... Our team will contact you with the next steps"
-- which is misleading. The claim block is now appended programmatically.
-- Only affects NEW campaigns; existing ones keep their stored message.
ALTER TABLE promo_campaigns ALTER COLUMN winner_message SET DEFAULT 'Congratulations! 🎉';

-- ═══════════════════════════════════════════════════════
-- Runtime verification
-- ═══════════════════════════════════════════════════════
DO $$
DECLARE v_has BOOLEAN; v_col_exists BOOLEAN;
BEGIN
  -- Verify prize_instructions column exists
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'promo_prizes' AND column_name = 'prize_instructions'
  ) INTO v_col_exists;
  IF NOT v_col_exists THEN RAISE EXCEPTION '339: promo_prizes.prize_instructions column missing'; END IF;

  -- Verify function privileges
  SELECT has_function_privilege('service_role', 'claim_promo_code(uuid, uuid, text, text, text)', 'EXECUTE') INTO v_has;
  IF NOT v_has THEN RAISE EXCEPTION '339: service_role cannot execute claim_promo_code'; END IF;
  SELECT has_function_privilege('anon', 'claim_promo_code(uuid, uuid, text, text, text)', 'EXECUTE') INTO v_has;
  IF v_has THEN RAISE EXCEPTION '339: anon CAN execute claim_promo_code (should be revoked)'; END IF;

  RAISE NOTICE '339: winner response block migration passed all checks';
END $$;
