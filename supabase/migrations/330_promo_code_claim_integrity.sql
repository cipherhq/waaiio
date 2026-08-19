-- Migration 330: Promo code + claim integrity hardening
--
-- 1. Update code_length constraint: minimum 10 (was 6)
--    Existing campaigns with code_length < 10 are preserved — API/generation
--    enforce minimum body entropy independently.
--
-- 2. Claim reference uniqueness: add UNIQUE index on claim_reference.
--    Old format: WAA-XXXXXX (6 hex chars, ~16M values)
--    New format: WAA-XXXX-XXXX-XXXX (12 from 27-char alphabet, ~1.5×10^17)
--    Existing references preserved. If historical duplicates exist,
--    use a partial unique index on new-format references only.
--
-- 3. Update claim function to use higher-entropy references with
--    bounded retry on collision.

-- ═══════════════════════════════════════════════════════
-- Step 1: Update code_length minimum to 10
-- ═══════════════════════════════════════════════════════
-- Drop old constraint, add new one. Existing rows with code_length < 10
-- are left as-is (backward compat). The API enforces minimum 10 for new
-- campaigns, and the generation route enforces minimum body entropy
-- independently from any stored value.
ALTER TABLE promo_campaigns DROP CONSTRAINT IF EXISTS chk_code_length;
ALTER TABLE promo_campaigns ADD CONSTRAINT chk_code_length
  CHECK (code_length >= 10 AND code_length <= 24);

-- ═══════════════════════════════════════════════════════
-- Step 2: Claim reference uniqueness
-- ═══════════════════════════════════════════════════════
-- New-format references are WAA-XXXX-XXXX-XXXX (16 chars with hyphens).
-- Old-format references are WAA-XXXXXX (10 chars).
-- Use a global unique index — claim references should be globally unique
-- for unambiguous customer support lookup.
-- If historical duplicates exist among old-format refs, use partial index
-- on length > 10 (new format only). Otherwise, full unique index.
DO $$
DECLARE
  v_dups INT;
BEGIN
  SELECT count(*) INTO v_dups FROM (
    SELECT claim_reference FROM promo_redemptions
    GROUP BY claim_reference HAVING count(*) > 1
  ) sub;

  IF v_dups = 0 THEN
    -- No historical duplicates — safe to add full unique index
    CREATE UNIQUE INDEX IF NOT EXISTS idx_promo_redemptions_claim_ref_unique
      ON promo_redemptions (claim_reference);
    RAISE NOTICE 'Added global UNIQUE index on claim_reference (no historical duplicates)';
  ELSE
    -- Historical duplicates exist — only enforce uniqueness on new format
    CREATE UNIQUE INDEX IF NOT EXISTS idx_promo_redemptions_claim_ref_unique
      ON promo_redemptions (claim_reference) WHERE length(claim_reference) > 10;
    RAISE NOTICE 'Added partial UNIQUE index on claim_reference (% historical duplicates preserved)', v_dups;
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════
-- Step 3: Update claim function — higher entropy + collision retry
-- ═══════════════════════════════════════════════════════
-- Replace the claim_reference generation section in claim_promo_code.
-- The full function is CREATE OR REPLACE so we redefine it.
-- We must include the complete function body.
CREATE OR REPLACE FUNCTION public.claim_promo_code(
  p_business_id UUID,
  p_campaign_id UUID,
  p_normalized_code_hash TEXT,
  p_phone_e164 TEXT,
  p_inbound_message_id TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
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
  v_prize_value INT;
  v_prize_currency TEXT;
  v_elig_ack RECORD;
  v_ref_attempt INT;
  -- Claim-reference alphabet (matches app-layer CODE_ALPHABET)
  v_alphabet TEXT := '234679ACDEFGHJKMNPQRTUVWXYZ';
  v_alpha_len INT := 27;
BEGIN
  -- ── Advisory locks for idempotency + rate-limit serialization ──

  -- 1a. Full idempotency: check if same inbound message already has a redemption
  IF p_inbound_message_id IS NOT NULL THEN
    SELECT r.id, r.outcome, r.claim_reference, r.prize_id,
           pp.name AS prize_name, pp.prize_type, pp.value, pp.currency
    INTO v_existing_redemption
    FROM promo_redemptions r
    LEFT JOIN promo_prizes pp ON pp.id = r.prize_id
    WHERE r.inbound_message_id = p_inbound_message_id;

    IF FOUND THEN
      RETURN jsonb_build_object(
        'success', true,
        'result', v_existing_redemption.outcome::text,
        'claim_reference', v_existing_redemption.claim_reference,
        'prize_name', v_existing_redemption.prize_name,
        'prize_type', v_existing_redemption.prize_type::text,
        'prize_value', v_existing_redemption.value,
        'prize_currency', v_existing_redemption.currency,
        'redemption_id', v_existing_redemption.id,
        'idempotent', true
      );
    END IF;
  END IF;

  -- 1b. Serialize on inbound message ID
  IF p_inbound_message_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('promo_msg:' || p_inbound_message_id));
  END IF;

  -- 1c. Serialize on campaign + phone (rate-limit serialization)
  PERFORM pg_advisory_xact_lock(
    hashtext('promo_rate:' || p_campaign_id::text || ':' || p_phone_e164)
  );

  -- 2. Load and validate campaign
  SELECT * INTO v_campaign
  FROM promo_campaigns
  WHERE id = p_campaign_id AND business_id = p_business_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'result', 'invalid');
  END IF;

  -- 3. Campaign status gate
  IF v_campaign.status != 'active' THEN
    RETURN jsonb_build_object('success', false, 'result', 'campaign_inactive');
  END IF;

  -- 4. Time window gate
  IF v_campaign.start_at IS NOT NULL AND now() < v_campaign.start_at THEN
    RETURN jsonb_build_object('success', false, 'result', 'campaign_inactive');
  END IF;
  IF v_campaign.end_at IS NOT NULL AND now() > v_campaign.end_at THEN
    RETURN jsonb_build_object('success', false, 'result', 'campaign_inactive');
  END IF;

  -- 5. Record verification attempt (before rate-limit check for accurate counting)
  INSERT INTO promo_verification_attempts (
    business_id, campaign_id, phone_e164, normalized_code_hash,
    inbound_message_id, result
  ) VALUES (
    p_business_id, p_campaign_id, p_phone_e164, p_normalized_code_hash,
    p_inbound_message_id, 'pending'
  );

  -- 6. Sliding-window rate limit
  SELECT count(*) INTO v_attempt_count
  FROM promo_verification_attempts
  WHERE campaign_id = p_campaign_id
    AND phone_e164 = p_phone_e164
    AND created_at > now() - (v_campaign.rate_limit_window_minutes || ' minutes')::interval;

  IF v_attempt_count > v_campaign.rate_limit_max_attempts THEN
    UPDATE promo_verification_attempts
    SET result = 'rate_limited'
    WHERE campaign_id = p_campaign_id
      AND phone_e164 = p_phone_e164
      AND inbound_message_id = p_inbound_message_id;
    RETURN jsonb_build_object('success', false, 'result', 'rate_limited');
  END IF;

  -- 7. Lifetime attempt limit
  SELECT count(*) INTO v_attempt_count
  FROM promo_verification_attempts
  WHERE campaign_id = p_campaign_id
    AND phone_e164 = p_phone_e164;

  IF v_attempt_count > v_campaign.max_attempts_per_phone THEN
    UPDATE promo_verification_attempts
    SET result = 'not_eligible'
    WHERE campaign_id = p_campaign_id
      AND phone_e164 = p_phone_e164
      AND inbound_message_id = p_inbound_message_id;
    RETURN jsonb_build_object('success', false, 'result', 'not_eligible');
  END IF;

  -- 8. Eligibility acknowledgment check
  IF v_campaign.eligibility_mode != 'none' THEN
    SELECT * INTO v_elig_ack
    FROM promo_eligibility_acks
    WHERE campaign_id = p_campaign_id AND phone_e164 = p_phone_e164;

    IF NOT FOUND THEN
      UPDATE promo_verification_attempts
      SET result = 'not_eligible'
      WHERE campaign_id = p_campaign_id
        AND phone_e164 = p_phone_e164
        AND inbound_message_id = p_inbound_message_id;
      RETURN jsonb_build_object('success', false, 'result', 'not_eligible',
        'reason', 'eligibility_not_acknowledged');
    END IF;
  END IF;

  -- 9. Look up code (locked)
  SELECT * INTO v_code
  FROM promo_campaign_codes
  WHERE business_id = p_business_id
    AND campaign_id = p_campaign_id
    AND normalized_code_hash = p_normalized_code_hash
  FOR UPDATE;

  IF NOT FOUND THEN
    UPDATE promo_verification_attempts
    SET result = 'invalid'
    WHERE campaign_id = p_campaign_id
      AND phone_e164 = p_phone_e164
      AND inbound_message_id = p_inbound_message_id;
    RETURN jsonb_build_object('success', false, 'result', 'invalid');
  END IF;

  IF v_code.status = 'claimed' THEN
    UPDATE promo_verification_attempts
    SET result = 'already_claimed'
    WHERE campaign_id = p_campaign_id
      AND phone_e164 = p_phone_e164
      AND inbound_message_id = p_inbound_message_id;
    RETURN jsonb_build_object('success', false, 'result', 'already_claimed');
  END IF;

  IF v_code.status = 'void' THEN
    UPDATE promo_verification_attempts
    SET result = 'invalid'
    WHERE campaign_id = p_campaign_id
      AND phone_e164 = p_phone_e164
      AND inbound_message_id = p_inbound_message_id;
    RETURN jsonb_build_object('success', false, 'result', 'invalid');
  END IF;

  -- 10. Code is unused — claim it atomically
  -- Generate high-entropy claim reference: WAA-XXXX-XXXX-XXXX
  -- 12 chars from 27-char alphabet ≈ 60 bits of entropy
  -- Bounded retry on collision (fail-closed after 3 attempts)
  v_claim_ref := NULL;
  FOR v_ref_attempt IN 1..3 LOOP
    v_claim_ref := 'WAA-'
      || chr(ascii(substr(v_alphabet, 1 + floor(random() * v_alpha_len)::int, 1)))
      || chr(ascii(substr(v_alphabet, 1 + floor(random() * v_alpha_len)::int, 1)))
      || chr(ascii(substr(v_alphabet, 1 + floor(random() * v_alpha_len)::int, 1)))
      || chr(ascii(substr(v_alphabet, 1 + floor(random() * v_alpha_len)::int, 1)))
      || '-'
      || chr(ascii(substr(v_alphabet, 1 + floor(random() * v_alpha_len)::int, 1)))
      || chr(ascii(substr(v_alphabet, 1 + floor(random() * v_alpha_len)::int, 1)))
      || chr(ascii(substr(v_alphabet, 1 + floor(random() * v_alpha_len)::int, 1)))
      || chr(ascii(substr(v_alphabet, 1 + floor(random() * v_alpha_len)::int, 1)))
      || '-'
      || chr(ascii(substr(v_alphabet, 1 + floor(random() * v_alpha_len)::int, 1)))
      || chr(ascii(substr(v_alphabet, 1 + floor(random() * v_alpha_len)::int, 1)))
      || chr(ascii(substr(v_alphabet, 1 + floor(random() * v_alpha_len)::int, 1)))
      || chr(ascii(substr(v_alphabet, 1 + floor(random() * v_alpha_len)::int, 1)));

    -- Check uniqueness
    PERFORM 1 FROM promo_redemptions WHERE claim_reference = v_claim_ref;
    IF NOT FOUND THEN
      EXIT; -- unique reference found
    END IF;
    v_claim_ref := NULL; -- collision, retry
  END LOOP;

  IF v_claim_ref IS NULL THEN
    -- All retries collided — fail closed rather than proceed without a reference
    RAISE EXCEPTION 'claim_reference_collision_exhausted: failed to generate unique claim reference after 3 attempts';
  END IF;

  -- Update code status
  UPDATE promo_campaign_codes
  SET status = 'claimed',
      claimed_at = now(),
      claimed_by_phone = p_phone_e164
  WHERE id = v_code.id AND status = 'unused';

  -- Lock integrity
  UPDATE promo_campaigns
  SET integrity_locked = true
  WHERE id = p_campaign_id AND integrity_locked = false;

  -- Create redemption
  INSERT INTO promo_redemptions (
    id, business_id, campaign_id, promo_code_id,
    phone_e164, inbound_message_id, outcome, prize_id,
    claim_reference, claimed_at, fulfillment_status
  ) VALUES (
    gen_random_uuid(), p_business_id, p_campaign_id, v_code.id,
    p_phone_e164, p_inbound_message_id, v_code.outcome, v_code.prize_id,
    v_claim_ref, now(),
    CASE WHEN v_code.outcome = 'winner' THEN 'pending'::promo_fulfillment_status
         ELSE 'fulfilled'::promo_fulfillment_status END
  )
  RETURNING id INTO v_redemption_id;

  -- Look up prize details if winner
  IF v_code.outcome = 'winner' AND v_code.prize_id IS NOT NULL THEN
    SELECT name, prize_type::text, value, currency
    INTO v_prize_name, v_prize_type, v_prize_value, v_prize_currency
    FROM promo_prizes WHERE id = v_code.prize_id;
  END IF;

  -- Update attempt result
  UPDATE promo_verification_attempts
  SET result = v_code.outcome::text
  WHERE campaign_id = p_campaign_id
    AND phone_e164 = p_phone_e164
    AND inbound_message_id = p_inbound_message_id;

  -- Return result
  IF v_code.outcome = 'winner' THEN
    RETURN jsonb_build_object(
      'success', true,
      'result', 'winner',
      'claim_reference', v_claim_ref,
      'redemption_id', v_redemption_id,
      'prize_name', v_prize_name,
      'prize_type', v_prize_type,
      'prize_value', v_prize_value,
      'prize_currency', v_prize_currency
    );
  ELSE
    RETURN jsonb_build_object(
      'success', true,
      'result', 'try_again',
      'claim_reference', v_claim_ref,
      'redemption_id', v_redemption_id
    );
  END IF;
END;
$fn$;

-- Privilege hardening (same as original)
DO $$
BEGIN
  REVOKE ALL ON FUNCTION public.claim_promo_code(UUID, UUID, TEXT, TEXT, TEXT) FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION public.claim_promo_code(UUID, UUID, TEXT, TEXT, TEXT) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION public.claim_promo_code(UUID, UUID, TEXT, TEXT, TEXT) FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.claim_promo_code(UUID, UUID, TEXT, TEXT, TEXT) TO service_role;
  END IF;
END $$;
