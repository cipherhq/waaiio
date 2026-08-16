-- ══════════════════════════════════════════════════════════════
-- Migration 320: Promotions & Unique Code Verification Schema
-- ══════════════════════════════════════════════════════════════
-- Feature: PROMO-1
-- Purpose: WhatsApp-based consumer promotions with unique codes
--          printed on products, packaging, bottle crowns, etc.
-- ══════════════════════════════════════════════════════════════

-- ── Extensions ──
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ══════════════════════════════════════════════════════════════
-- 1. promo_campaigns
-- ══════════════════════════════════════════════════════════════

CREATE TYPE promo_campaign_status AS ENUM (
  'draft', 'scheduled', 'active', 'paused', 'ended', 'archived'
);

CREATE TYPE promo_code_entry_mode AS ENUM (
  'keyword', 'bare_code', 'both'
);

CREATE TABLE promo_campaigns (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  description     TEXT,
  status          promo_campaign_status NOT NULL DEFAULT 'draft',
  start_at        TIMESTAMPTZ,
  end_at          TIMESTAMPTZ,
  timezone        TEXT NOT NULL DEFAULT 'Africa/Lagos',

  -- WhatsApp routing
  code_entry_mode promo_code_entry_mode NOT NULL DEFAULT 'keyword',
  keyword         TEXT,               -- e.g. 'PROMO'
  accept_bare_codes BOOLEAN NOT NULL DEFAULT false,

  -- Code format
  code_format     TEXT NOT NULL DEFAULT 'XXXX-XXXX-XXXX',
  code_length     INT NOT NULL DEFAULT 12,
  code_prefix     TEXT,

  -- Fraud controls
  max_attempts_per_phone INT NOT NULL DEFAULT 50,
  rate_limit_window_minutes INT NOT NULL DEFAULT 60,
  rate_limit_max_attempts INT NOT NULL DEFAULT 10,

  -- Eligibility
  eligibility_mode TEXT NOT NULL DEFAULT 'none',  -- none, age_confirmation, custom
  eligibility_prompt TEXT,
  eligibility_min_age INT,

  -- Configurable messages
  winner_message    TEXT NOT NULL DEFAULT '🎉 Congratulations!\n\nYour code is a winner.\n\nPrize:\n{prize_name}\n\nClaim reference:\n{claim_ref}\n\nOur team will contact you with the next steps.',
  try_again_message TEXT NOT NULL DEFAULT 'Thanks for participating 🙌\n\nThis code wasn''t a winner this time.\n\nYou can try again with another eligible product.',
  invalid_message   TEXT NOT NULL DEFAULT 'We couldn''t verify that promotion code.\n\nCheck the code and try again.',
  already_used_message TEXT NOT NULL DEFAULT 'This promotion code has already been used.\n\nIf you believe this is an error, contact support.',
  expired_message   TEXT NOT NULL DEFAULT 'This promotion is not currently active.',

  -- Integrity lock: set to true after first redemption
  integrity_locked  BOOLEAN NOT NULL DEFAULT false,

  created_by      UUID REFERENCES auth.users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Only one active bare-code campaign per business
  CONSTRAINT chk_keyword_or_bare CHECK (
    code_entry_mode = 'bare_code' OR code_entry_mode = 'both' OR keyword IS NOT NULL
  ),
  CONSTRAINT chk_dates CHECK (start_at IS NULL OR end_at IS NULL OR end_at > start_at),
  CONSTRAINT chk_code_length CHECK (code_length >= 6 AND code_length <= 24),
  CONSTRAINT chk_code_prefix CHECK (
    code_prefix IS NULL
    OR (length(code_prefix) <= 4
        AND code_prefix ~ '^[A-Z0-9]*$'
        AND length(code_prefix) < code_length)
  )
);

-- Unique partial index: only one active bare-code campaign per business
CREATE UNIQUE INDEX idx_promo_campaigns_bare_code_active
  ON promo_campaigns (business_id)
  WHERE accept_bare_codes = true AND status IN ('active', 'scheduled');

CREATE INDEX idx_promo_campaigns_business ON promo_campaigns (business_id);
CREATE INDEX idx_promo_campaigns_status ON promo_campaigns (status);
-- Unique keyword per business among active campaigns (case-insensitive)
CREATE UNIQUE INDEX idx_promo_campaigns_keyword_unique
  ON promo_campaigns (business_id, lower(keyword))
  WHERE keyword IS NOT NULL AND status IN ('active', 'scheduled');

CREATE INDEX idx_promo_campaigns_keyword ON promo_campaigns (business_id, keyword)
  WHERE keyword IS NOT NULL AND status = 'active';

-- ══════════════════════════════════════════════════════════════
-- 2. promo_prizes
-- ══════════════════════════════════════════════════════════════

CREATE TYPE promo_prize_type AS ENUM (
  'cash', 'airtime', 'product', 'voucher', 'discount', 'custom'
);

CREATE TABLE promo_prizes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id     UUID NOT NULL REFERENCES promo_campaigns(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  prize_type      promo_prize_type NOT NULL DEFAULT 'custom',
  quantity        INT NOT NULL CHECK (quantity > 0),
  allocated_count INT NOT NULL DEFAULT 0,
  value           NUMERIC(12,2),
  currency        TEXT,
  fulfillment_instructions TEXT,
  sort_order      INT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT chk_allocated_count CHECK (allocated_count <= quantity)
);

CREATE INDEX idx_promo_prizes_campaign ON promo_prizes (campaign_id);

-- ══════════════════════════════════════════════════════════════
-- 3. promo_code_batches
-- ══════════════════════════════════════════════════════════════

CREATE TYPE promo_batch_status AS ENUM (
  'pending', 'processing', 'completed', 'failed'
);

CREATE TYPE promo_batch_source AS ENUM (
  'generated', 'imported'
);

CREATE TABLE promo_code_batches (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id     UUID NOT NULL REFERENCES promo_campaigns(id) ON DELETE CASCADE,
  source          promo_batch_source NOT NULL DEFAULT 'generated',
  requested_count INT NOT NULL CHECK (requested_count > 0),
  generated_count INT NOT NULL DEFAULT 0,
  failed_count    INT NOT NULL DEFAULT 0,
  status          promo_batch_status NOT NULL DEFAULT 'pending',
  filename        TEXT,
  error_details   JSONB,
  progress_cursor INT NOT NULL DEFAULT 0,  -- resumable generation
  created_by      UUID REFERENCES auth.users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ
);

CREATE INDEX idx_promo_code_batches_campaign ON promo_code_batches (campaign_id);

-- ══════════════════════════════════════════════════════════════
-- 4. promo_campaign_codes
-- ══════════════════════════════════════════════════════════════

CREATE TYPE promo_code_status AS ENUM ('unused', 'claimed', 'void');
CREATE TYPE promo_code_outcome AS ENUM ('winner', 'try_again');

CREATE TABLE promo_campaign_codes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  campaign_id     UUID NOT NULL REFERENCES promo_campaigns(id) ON DELETE CASCADE,
  batch_id        UUID NOT NULL REFERENCES promo_code_batches(id) ON DELETE CASCADE,

  -- Security: HMAC hash for lookup, encrypted value for recovery
  normalized_code_hash TEXT NOT NULL,
  encrypted_code  TEXT,               -- AES-256-GCM encrypted
  display_suffix  TEXT NOT NULL,      -- last 4 chars for masked display

  -- Outcome (assigned at generation, NOT at redemption)
  outcome         promo_code_outcome NOT NULL DEFAULT 'try_again',
  prize_id        UUID REFERENCES promo_prizes(id),

  -- Claim state
  status          promo_code_status NOT NULL DEFAULT 'unused',
  claimed_at      TIMESTAMPTZ,
  claimed_by_phone TEXT,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Unique hash per business (cross-business isolation)
  CONSTRAINT uq_promo_code_hash UNIQUE (business_id, normalized_code_hash),
  -- Winner must have prize
  CONSTRAINT chk_winner_has_prize CHECK (outcome = 'try_again' OR prize_id IS NOT NULL)
);

-- Index for code lookup (primary hot path)
CREATE INDEX idx_promo_campaign_codes_lookup
  ON promo_campaign_codes (business_id, campaign_id, normalized_code_hash);

CREATE INDEX idx_promo_campaign_codes_campaign ON promo_campaign_codes (campaign_id);
CREATE INDEX idx_promo_campaign_codes_batch ON promo_campaign_codes (batch_id);
CREATE INDEX idx_promo_campaign_codes_status ON promo_campaign_codes (campaign_id, status);
CREATE INDEX idx_promo_campaign_codes_prize ON promo_campaign_codes (prize_id) WHERE prize_id IS NOT NULL;

-- ══════════════════════════════════════════════════════════════
-- 5. promo_redemptions
-- ══════════════════════════════════════════════════════════════

CREATE TYPE promo_fulfillment_status AS ENUM (
  'pending', 'processing', 'fulfilled', 'rejected', 'cancelled'
);

CREATE TABLE promo_redemptions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  campaign_id     UUID NOT NULL REFERENCES promo_campaigns(id) ON DELETE CASCADE,
  promo_code_id   UUID NOT NULL REFERENCES promo_campaign_codes(id),
  phone_e164      TEXT NOT NULL,
  inbound_message_id TEXT,            -- WhatsApp message ID for idempotency
  outcome         promo_code_outcome NOT NULL,
  prize_id        UUID REFERENCES promo_prizes(id),
  claim_reference TEXT NOT NULL,      -- Human-readable claim ref e.g. WAA-82H7PQ
  claimed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Fulfillment
  fulfillment_status promo_fulfillment_status NOT NULL DEFAULT 'pending',
  fulfillment_reference TEXT,
  fulfillment_notes TEXT,
  fulfilled_at    TIMESTAMPTZ,
  fulfilled_by    UUID REFERENCES auth.users(id),

  -- Idempotency: same inbound message can't create two redemptions
  CONSTRAINT uq_promo_redemption_message UNIQUE (inbound_message_id),
  -- Same code can't be redeemed twice
  CONSTRAINT uq_promo_redemption_code UNIQUE (promo_code_id)
);

CREATE INDEX idx_promo_redemptions_campaign ON promo_redemptions (campaign_id);
CREATE INDEX idx_promo_redemptions_phone ON promo_redemptions (phone_e164);
CREATE INDEX idx_promo_redemptions_fulfillment ON promo_redemptions (campaign_id, fulfillment_status);
CREATE INDEX idx_promo_redemptions_business ON promo_redemptions (business_id);

-- ══════════════════════════════════════════════════════════════
-- 6. promo_verification_attempts
-- ══════════════════════════════════════════════════════════════

CREATE TYPE promo_attempt_result AS ENUM (
  'winner', 'try_again', 'invalid', 'already_claimed',
  'campaign_inactive', 'rate_limited', 'not_eligible'
);

CREATE TABLE promo_verification_attempts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  campaign_id     UUID REFERENCES promo_campaigns(id),
  phone_e164      TEXT NOT NULL,
  submitted_code_hash TEXT,           -- Hash of submitted code (never store raw invalid codes)
  result          promo_attempt_result NOT NULL,
  inbound_message_id TEXT,
  promo_code_id   UUID REFERENCES promo_campaign_codes(id),
  metadata        JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_promo_attempts_campaign ON promo_verification_attempts (campaign_id);
CREATE INDEX idx_promo_attempts_phone ON promo_verification_attempts (phone_e164, created_at);
CREATE INDEX idx_promo_attempts_business ON promo_verification_attempts (business_id);
CREATE INDEX idx_promo_attempts_result ON promo_verification_attempts (campaign_id, result);

-- ══════════════════════════════════════════════════════════════
-- 7. Atomic Claim Function (claim_promo_code)
-- ══════════════════════════════════════════════════════════════
-- This is the SINGLE canonical authority for claiming a promo code.
-- It performs all validation, locking, and state transitions atomically.

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
BEGIN
  -- LOCK ORDER: message-id → campaign+phone → code row
  -- This prevents concurrent claim races for the same WhatsApp message
  -- and serializes rate-limit counting.

  -- 0a. Advisory lock on inbound_message_id (serializes same-message delivery)
  IF p_inbound_message_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('promo_msg:' || p_inbound_message_id));
  END IF;

  -- 0b. Advisory lock on campaign+phone (serializes rate-limit counting)
  PERFORM pg_advisory_xact_lock(
    hashtext('promo_rate:' || p_campaign_id::text || ':' || p_phone_e164)
  );

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
        'idempotent_replay', true
      );
    END IF;

    -- 1b. Check if same message already has a verification attempt
    SELECT id, result INTO v_existing_attempt
    FROM promo_verification_attempts
    WHERE inbound_message_id = p_inbound_message_id
    LIMIT 1;

    IF FOUND THEN
      RETURN jsonb_build_object(
        'success', false,
        'result', v_existing_attempt.result::text,
        'idempotent_replay', true
      );
    END IF;
  END IF;

  -- 2. Look up campaign
  SELECT * INTO v_campaign
  FROM promo_campaigns
  WHERE id = p_campaign_id AND business_id = p_business_id;

  IF NOT FOUND THEN
    -- Log attempt
    INSERT INTO promo_verification_attempts
      (business_id, campaign_id, phone_e164, submitted_code_hash, result, inbound_message_id)
    VALUES
      (p_business_id, p_campaign_id, p_phone_e164, p_normalized_code_hash, 'campaign_inactive', p_inbound_message_id) ON CONFLICT (inbound_message_id) WHERE inbound_message_id IS NOT NULL DO NOTHING;
    RETURN jsonb_build_object('success', false, 'result', 'campaign_inactive');
  END IF;

  -- 3. Check campaign status
  IF v_campaign.status != 'active' THEN
    INSERT INTO promo_verification_attempts
      (business_id, campaign_id, phone_e164, submitted_code_hash, result, inbound_message_id)
    VALUES
      (p_business_id, p_campaign_id, p_phone_e164, p_normalized_code_hash, 'campaign_inactive', p_inbound_message_id) ON CONFLICT (inbound_message_id) WHERE inbound_message_id IS NOT NULL DO NOTHING;
    RETURN jsonb_build_object('success', false, 'result', 'campaign_inactive');
  END IF;

  -- 4. Check time window
  IF v_campaign.start_at IS NOT NULL AND now() < v_campaign.start_at THEN
    INSERT INTO promo_verification_attempts
      (business_id, campaign_id, phone_e164, submitted_code_hash, result, inbound_message_id)
    VALUES
      (p_business_id, p_campaign_id, p_phone_e164, p_normalized_code_hash, 'campaign_inactive', p_inbound_message_id) ON CONFLICT (inbound_message_id) WHERE inbound_message_id IS NOT NULL DO NOTHING;
    RETURN jsonb_build_object('success', false, 'result', 'campaign_inactive');
  END IF;

  IF v_campaign.end_at IS NOT NULL AND now() > v_campaign.end_at THEN
    INSERT INTO promo_verification_attempts
      (business_id, campaign_id, phone_e164, submitted_code_hash, result, inbound_message_id)
    VALUES
      (p_business_id, p_campaign_id, p_phone_e164, p_normalized_code_hash, 'campaign_inactive', p_inbound_message_id) ON CONFLICT (inbound_message_id) WHERE inbound_message_id IS NOT NULL DO NOTHING;
    RETURN jsonb_build_object('success', false, 'result', 'campaign_inactive');
  END IF;

  -- 5. Rate limiting: check attempts in window
  SELECT COUNT(*) INTO v_attempt_count
  FROM promo_verification_attempts
  WHERE campaign_id = p_campaign_id
    AND phone_e164 = p_phone_e164
    AND created_at > now() - (v_campaign.rate_limit_window_minutes || ' minutes')::interval;

  IF v_attempt_count >= v_campaign.rate_limit_max_attempts THEN
    INSERT INTO promo_verification_attempts
      (business_id, campaign_id, phone_e164, submitted_code_hash, result, inbound_message_id)
    VALUES
      (p_business_id, p_campaign_id, p_phone_e164, p_normalized_code_hash, 'rate_limited', p_inbound_message_id) ON CONFLICT (inbound_message_id) WHERE inbound_message_id IS NOT NULL DO NOTHING;
    RETURN jsonb_build_object('success', false, 'result', 'rate_limited');
  END IF;

  -- 6. Check total attempts per phone across campaign
  SELECT COUNT(*) INTO v_attempt_count
  FROM promo_verification_attempts
  WHERE campaign_id = p_campaign_id
    AND phone_e164 = p_phone_e164;

  IF v_attempt_count >= v_campaign.max_attempts_per_phone THEN
    INSERT INTO promo_verification_attempts
      (business_id, campaign_id, phone_e164, submitted_code_hash, result, inbound_message_id)
    VALUES
      (p_business_id, p_campaign_id, p_phone_e164, p_normalized_code_hash, 'not_eligible', p_inbound_message_id) ON CONFLICT (inbound_message_id) WHERE inbound_message_id IS NOT NULL DO NOTHING;
    RETURN jsonb_build_object('success', false, 'result', 'not_eligible');
  END IF;

  -- 6b. Check eligibility acknowledgment
  IF v_campaign.eligibility_mode != 'none' THEN
    SELECT EXISTS (
      SELECT 1 FROM promo_eligibility_acks
      WHERE campaign_id = p_campaign_id AND phone_e164 = p_phone_e164
    ) INTO v_elig_ack;

    IF NOT v_elig_ack THEN
      INSERT INTO promo_verification_attempts
        (business_id, campaign_id, phone_e164, submitted_code_hash, result, inbound_message_id)
      VALUES
        (p_business_id, p_campaign_id, p_phone_e164, p_normalized_code_hash, 'not_eligible', p_inbound_message_id) ON CONFLICT (inbound_message_id) WHERE inbound_message_id IS NOT NULL DO NOTHING;
      RETURN jsonb_build_object(
        'success', false,
        'result', 'not_eligible',
        'eligibility_required', true,
        'eligibility_mode', v_campaign.eligibility_mode,
        'eligibility_prompt', v_campaign.eligibility_prompt
      );
    END IF;
  END IF;

  -- 7. Find and lock the code row (FOR UPDATE prevents concurrent claims)
  SELECT * INTO v_code
  FROM promo_campaign_codes
  WHERE business_id = p_business_id
    AND campaign_id = p_campaign_id
    AND normalized_code_hash = p_normalized_code_hash
  FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO promo_verification_attempts
      (business_id, campaign_id, phone_e164, submitted_code_hash, result, inbound_message_id)
    VALUES
      (p_business_id, p_campaign_id, p_phone_e164, p_normalized_code_hash, 'invalid', p_inbound_message_id) ON CONFLICT (inbound_message_id) WHERE inbound_message_id IS NOT NULL DO NOTHING;
    RETURN jsonb_build_object('success', false, 'result', 'invalid');
  END IF;

  -- 8. Check if void
  IF v_code.status = 'void' THEN
    INSERT INTO promo_verification_attempts
      (business_id, campaign_id, phone_e164, submitted_code_hash, result, inbound_message_id)
    VALUES
      (p_business_id, p_campaign_id, p_phone_e164, p_normalized_code_hash, 'invalid', p_inbound_message_id) ON CONFLICT (inbound_message_id) WHERE inbound_message_id IS NOT NULL DO NOTHING;
    RETURN jsonb_build_object('success', false, 'result', 'invalid');
  END IF;

  -- 9. Check if already claimed
  IF v_code.status = 'claimed' THEN
    INSERT INTO promo_verification_attempts
      (business_id, campaign_id, phone_e164, submitted_code_hash, result, inbound_message_id)
    VALUES
      (p_business_id, p_campaign_id, p_phone_e164, p_normalized_code_hash, 'already_claimed', p_inbound_message_id) ON CONFLICT (inbound_message_id) WHERE inbound_message_id IS NOT NULL DO NOTHING;
    RETURN jsonb_build_object('success', false, 'result', 'already_claimed');
  END IF;

  -- 10. Code is unused — claim it atomically
  -- Generate human-readable claim reference
  v_claim_ref := 'WAA-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6));

  -- Update code status
  UPDATE promo_campaign_codes
  SET status = 'claimed',
      claimed_at = now(),
      claimed_by_phone = p_phone_e164
  WHERE id = v_code.id;

  -- Set integrity lock on campaign (first claim locks it)
  UPDATE promo_campaigns
  SET integrity_locked = true,
      updated_at = now()
  WHERE id = p_campaign_id AND integrity_locked = false;

  -- Insert redemption
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

  -- Log the attempt
  INSERT INTO promo_verification_attempts
    (business_id, campaign_id, phone_e164, submitted_code_hash, result, inbound_message_id, promo_code_id)
  VALUES
    (p_business_id, p_campaign_id, p_phone_e164, p_normalized_code_hash,
     v_code.outcome::text::promo_attempt_result, p_inbound_message_id, v_code.id)
  ON CONFLICT (inbound_message_id) WHERE inbound_message_id IS NOT NULL DO NOTHING;

  -- Build result
  IF v_code.outcome = 'winner' THEN
    SELECT pp.name, pp.prize_type::text, pp.value, pp.currency
    INTO v_prize_name, v_prize_type, v_prize_value, v_prize_currency
    FROM promo_prizes pp WHERE pp.id = v_code.prize_id;

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
$$;

-- Lock down claim_promo_code: service_role ONLY
REVOKE EXECUTE ON FUNCTION claim_promo_code(UUID, UUID, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION claim_promo_code(UUID, UUID, TEXT, TEXT, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION claim_promo_code(UUID, UUID, TEXT, TEXT, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION claim_promo_code(UUID, UUID, TEXT, TEXT, TEXT) TO service_role;

-- ══════════════════════════════════════════════════════════════
-- 8. RLS Policies
-- ══════════════════════════════════════════════════════════════

ALTER TABLE promo_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE promo_prizes ENABLE ROW LEVEL SECURITY;
ALTER TABLE promo_code_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE promo_campaign_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE promo_redemptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE promo_verification_attempts ENABLE ROW LEVEL SECURITY;

-- ── Blocker #8: Authenticated users get SELECT ONLY on authority tables.
-- All mutations go through service-role API routes (requireCapability guard).
-- This prevents direct client writes bypassing capability/integrity checks.

-- promo_campaigns: authenticated SELECT only
CREATE POLICY promo_campaigns_select ON promo_campaigns
  FOR SELECT TO authenticated
  USING (
    business_id IN (
      SELECT b.id FROM businesses b WHERE b.owner_id = auth.uid()
      UNION
      SELECT bm.business_id FROM business_members bm WHERE bm.user_id = auth.uid()
    )
  );

-- Service role full access for API routes + bot verification
CREATE POLICY promo_campaigns_service ON promo_campaigns
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- promo_prizes: authenticated SELECT only
CREATE POLICY promo_prizes_select ON promo_prizes
  FOR SELECT TO authenticated
  USING (
    campaign_id IN (
      SELECT pc.id FROM promo_campaigns pc
      WHERE pc.business_id IN (
        SELECT b.id FROM businesses b WHERE b.owner_id = auth.uid()
        UNION
        SELECT bm.business_id FROM business_members bm WHERE bm.user_id = auth.uid()
      )
    )
  );

CREATE POLICY promo_prizes_service ON promo_prizes
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- promo_code_batches: authenticated SELECT only
CREATE POLICY promo_code_batches_select ON promo_code_batches
  FOR SELECT TO authenticated
  USING (
    campaign_id IN (
      SELECT pc.id FROM promo_campaigns pc
      WHERE pc.business_id IN (
        SELECT b.id FROM businesses b WHERE b.owner_id = auth.uid()
        UNION
        SELECT bm.business_id FROM business_members bm WHERE bm.user_id = auth.uid()
      )
    )
  );

CREATE POLICY promo_code_batches_service ON promo_code_batches
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- promo_campaign_codes: NO direct client SELECT (codes are sensitive)
-- Authenticated users can see aggregate counts via API, not raw rows
CREATE POLICY promo_campaign_codes_service ON promo_campaign_codes
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- promo_redemptions: authenticated SELECT only (fulfillment goes through API)
CREATE POLICY promo_redemptions_select ON promo_redemptions
  FOR SELECT TO authenticated
  USING (
    business_id IN (
      SELECT b.id FROM businesses b WHERE b.owner_id = auth.uid()
      UNION
      SELECT bm.business_id FROM business_members bm WHERE bm.user_id = auth.uid()
    )
  );

CREATE POLICY promo_redemptions_service ON promo_redemptions
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- promo_verification_attempts: read-only for business
CREATE POLICY promo_attempts_select ON promo_verification_attempts
  FOR SELECT TO authenticated
  USING (
    business_id IN (
      SELECT b.id FROM businesses b WHERE b.owner_id = auth.uid()
      UNION
      SELECT bm.business_id FROM business_members bm WHERE bm.user_id = auth.uid()
    )
  );

CREATE POLICY promo_attempts_service ON promo_verification_attempts
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ══════════════════════════════════════════════════════════════
-- 9. Updated_at trigger
-- ══════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION update_promo_campaign_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_promo_campaigns_updated_at
  BEFORE UPDATE ON promo_campaigns
  FOR EACH ROW EXECUTE FUNCTION update_promo_campaign_updated_at();

-- ══════════════════════════════════════════════════════════════
-- 10. Campaign status transition validation
-- ══════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION validate_promo_campaign_status_transition()
RETURNS TRIGGER AS $$
BEGIN
  -- Valid transitions:
  -- draft -> scheduled, active
  -- scheduled -> active, draft, paused, ended
  -- active -> paused, ended
  -- paused -> active, ended
  -- ended -> archived
  -- archived -> (nothing)
  IF OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;

  IF OLD.status = 'draft' AND NEW.status NOT IN ('scheduled', 'active') THEN
    RAISE EXCEPTION 'Invalid campaign transition from draft to %', NEW.status;
  END IF;

  IF OLD.status = 'scheduled' AND NEW.status NOT IN ('active', 'draft', 'paused', 'ended') THEN
    RAISE EXCEPTION 'Invalid campaign transition from scheduled to %', NEW.status;
  END IF;

  IF OLD.status = 'active' AND NEW.status NOT IN ('paused', 'ended') THEN
    RAISE EXCEPTION 'Invalid campaign transition from active to %', NEW.status;
  END IF;

  IF OLD.status = 'paused' AND NEW.status NOT IN ('active', 'ended') THEN
    RAISE EXCEPTION 'Invalid campaign transition from paused to %', NEW.status;
  END IF;

  IF OLD.status = 'ended' AND NEW.status NOT IN ('archived') THEN
    RAISE EXCEPTION 'Invalid campaign transition from ended to %', NEW.status;
  END IF;

  IF OLD.status = 'archived' THEN
    RAISE EXCEPTION 'Cannot transition from archived status';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_promo_campaign_status_transition
  BEFORE UPDATE ON promo_campaigns
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION validate_promo_campaign_status_transition();

-- ══════════════════════════════════════════════════════════════
-- 11. Eligibility acknowledgments
-- ══════════════════════════════════════════════════════════════

CREATE TABLE promo_eligibility_acks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id     UUID NOT NULL REFERENCES promo_campaigns(id) ON DELETE CASCADE,
  phone_e164      TEXT NOT NULL,
  eligibility_mode TEXT NOT NULL,
  acknowledged_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_promo_elig_ack UNIQUE (campaign_id, phone_e164)
);

ALTER TABLE promo_eligibility_acks ENABLE ROW LEVEL SECURITY;
CREATE POLICY promo_elig_acks_service ON promo_eligibility_acks
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ══════════════════════════════════════════════════════════════
-- 12. Attempt idempotency: unique on inbound_message_id
-- ══════════════════════════════════════════════════════════════

CREATE UNIQUE INDEX idx_promo_attempts_message_idempotent
  ON promo_verification_attempts (inbound_message_id)
  WHERE inbound_message_id IS NOT NULL;

-- ══════════════════════════════════════════════════════════════
-- 13. Fail-closed campaign activation validation
-- ══════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION validate_promo_campaign_activation(p_campaign_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_campaign RECORD;
  v_errors TEXT[] := '{}';
  v_total_codes INT;
  v_winner_codes INT;
  v_total_prize_qty INT;
  v_incomplete_batches INT;
  v_prize RECORD;
  v_prize_code_count INT;
  v_bare_code_conflict INT;
BEGIN
  SELECT * INTO v_campaign FROM promo_campaigns WHERE id = p_campaign_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('valid', false, 'errors', ARRAY['Campaign not found']);
  END IF;

  -- Check dates
  IF v_campaign.end_at IS NOT NULL AND v_campaign.end_at <= now() THEN
    v_errors := array_append(v_errors, 'Campaign end date is in the past');
  END IF;

  -- Check codes exist
  SELECT count(*) INTO v_total_codes FROM promo_campaign_codes WHERE campaign_id = p_campaign_id;
  IF v_total_codes = 0 THEN
    v_errors := array_append(v_errors, 'No codes have been generated or imported');
  END IF;

  -- Check incomplete/failed batches — ALL must be cleanly completed
  SELECT count(*) INTO v_incomplete_batches FROM promo_code_batches
    WHERE campaign_id = p_campaign_id AND status NOT IN ('completed');
  IF v_incomplete_batches > 0 THEN
    v_errors := array_append(v_errors, v_incomplete_batches || ' batch(es) not completed (pending/processing/failed)');
  END IF;

  -- Check batches with unresolved commit failures
  DECLARE v_failed_batches INT;
  BEGIN
    SELECT count(*) INTO v_failed_batches FROM promo_code_batches
      WHERE campaign_id = p_campaign_id AND status = 'completed' AND failed_count > 0;
    IF v_failed_batches > 0 THEN
      v_errors := array_append(v_errors, v_failed_batches || ' completed batch(es) have unresolved failed rows');
    END IF;
  END;

  -- Check per-prize allocation
  SELECT coalesce(sum(quantity), 0) INTO v_total_prize_qty FROM promo_prizes WHERE campaign_id = p_campaign_id;
  SELECT count(*) INTO v_winner_codes FROM promo_campaign_codes WHERE campaign_id = p_campaign_id AND outcome = 'winner';

  IF v_winner_codes != v_total_prize_qty THEN
    v_errors := array_append(v_errors, 'Winner code count (' || v_winner_codes || ') does not match prize inventory (' || v_total_prize_qty || ')');
  END IF;

  IF v_total_prize_qty > v_total_codes THEN
    v_errors := array_append(v_errors, 'Prize allocation (' || v_total_prize_qty || ') exceeds total codes (' || v_total_codes || ')');
  END IF;

  -- Per-prize quantity check
  FOR v_prize IN SELECT id, name, quantity FROM promo_prizes WHERE campaign_id = p_campaign_id
  LOOP
    SELECT count(*) INTO v_prize_code_count
      FROM promo_campaign_codes WHERE campaign_id = p_campaign_id AND prize_id = v_prize.id;
    IF v_prize_code_count != v_prize.quantity THEN
      v_errors := array_append(v_errors, 'Prize "' || v_prize.name || '": expected ' || v_prize.quantity || ' codes but found ' || v_prize_code_count);
    END IF;
  END LOOP;

  -- Check keyword/routing
  IF v_campaign.code_entry_mode IN ('keyword', 'both') AND (v_campaign.keyword IS NULL OR v_campaign.keyword = '') THEN
    v_errors := array_append(v_errors, 'Keyword mode requires a keyword');
  END IF;

  -- Check bare-code ambiguity
  IF v_campaign.accept_bare_codes THEN
    SELECT count(*) INTO v_bare_code_conflict FROM promo_campaigns
      WHERE business_id = v_campaign.business_id AND accept_bare_codes = true
      AND status = 'active' AND id != p_campaign_id;
    IF v_bare_code_conflict > 0 THEN
      v_errors := array_append(v_errors, 'Another active bare-code campaign exists for this business');
    END IF;
  END IF;

  -- Check required messages
  IF v_campaign.winner_message IS NULL OR v_campaign.winner_message = '' THEN
    v_errors := array_append(v_errors, 'Winner message is required');
  END IF;
  IF v_campaign.try_again_message IS NULL OR v_campaign.try_again_message = '' THEN
    v_errors := array_append(v_errors, 'Try-again message is required');
  END IF;
  IF v_campaign.invalid_message IS NULL OR v_campaign.invalid_message = '' THEN
    v_errors := array_append(v_errors, 'Invalid-code message is required');
  END IF;

  -- Check eligibility config
  IF v_campaign.eligibility_mode IN ('age_confirmation', 'custom') AND (v_campaign.eligibility_prompt IS NULL OR v_campaign.eligibility_prompt = '') THEN
    v_errors := array_append(v_errors, 'Eligibility prompt is required for ' || v_campaign.eligibility_mode || ' mode');
  END IF;

  RETURN jsonb_build_object('valid', array_length(v_errors, 1) IS NULL, 'errors', v_errors);
END;
$$;

REVOKE EXECUTE ON FUNCTION validate_promo_campaign_activation(UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION validate_promo_campaign_activation(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION validate_promo_campaign_activation(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION validate_promo_campaign_activation(UUID) TO service_role;

-- ══════════════════════════════════════════════════════════════
-- 14. Admin governance with atomic audit
-- ══════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION admin_promo_governance(
  p_campaign_id UUID,
  p_target_status TEXT,
  p_actor_id UUID,
  p_actor_role TEXT,
  p_reason TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_campaign RECORD;
  v_from_status TEXT;
BEGIN
  SELECT id, business_id, name, status INTO v_campaign
    FROM promo_campaigns WHERE id = p_campaign_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Campaign not found');
  END IF;

  v_from_status := v_campaign.status;

  -- Update status (trigger validates transition)
  UPDATE promo_campaigns SET status = p_target_status::promo_campaign_status WHERE id = p_campaign_id;

  -- Atomic audit record (same transaction)
  INSERT INTO admin_audit_logs (actor_id, action, entity_type, entity_id, details)
  VALUES (
    p_actor_id,
    'promotions.' || p_target_status,
    'promo_campaign',
    p_campaign_id::text,
    jsonb_build_object(
      'business_id', v_campaign.business_id,
      'campaign_name', v_campaign.name,
      'from_status', v_from_status,
      'to_status', p_target_status,
      'actor_role', p_actor_role,
      'reason', coalesce(p_reason, '')
    )
  );

  RETURN jsonb_build_object('success', true, 'from_status', v_from_status, 'to_status', p_target_status);
END;
$$;

REVOKE EXECUTE ON FUNCTION admin_promo_governance(UUID, TEXT, UUID, TEXT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION admin_promo_governance(UUID, TEXT, UUID, TEXT, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION admin_promo_governance(UUID, TEXT, UUID, TEXT, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION admin_promo_governance(UUID, TEXT, UUID, TEXT, TEXT) TO service_role;

-- ══════════════════════════════════════════════════════════════
-- 15. Atomic code chunk commit RPC
-- ══════════════════════════════════════════════════════════════
-- Serializes batch cursor advancement and prize allocation.
-- Two workers for the same batch cannot both advance from the same cursor.
-- Two batches for the same campaign cannot double-allocate prizes.

CREATE OR REPLACE FUNCTION commit_promo_code_chunk(
  p_batch_id UUID,
  p_expected_cursor INT,
  p_codes JSONB,            -- array of {hash, encrypted, suffix, outcome, prize_id}
  p_chunk_size INT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_batch RECORD;
  v_campaign_id UUID;
  v_business_id UUID;
  v_code JSONB;
  v_prize_id UUID;
  v_inserted INT := 0;
BEGIN
  -- LOCK ORDER: campaign → batch → prize(s)
  -- Lock campaign first to serialize with activation
  DECLARE v_camp_status TEXT; v_camp_locked BOOLEAN;
  BEGIN
    SELECT status, integrity_locked INTO v_camp_status, v_camp_locked
    FROM promo_campaigns WHERE id = (SELECT campaign_id FROM promo_code_batches WHERE id = p_batch_id)
    FOR UPDATE;

    IF v_camp_status NOT IN ('draft', 'scheduled') THEN
      RETURN jsonb_build_object('success', false, 'error', 'Campaign status ' || v_camp_status || ' does not allow inventory mutation');
    END IF;
    IF v_camp_locked THEN
      RETURN jsonb_build_object('success', false, 'error', 'Campaign integrity is locked');
    END IF;
  END;

  -- Lock the batch row
  SELECT b.*, pc.business_id INTO v_batch
  FROM promo_code_batches b
  JOIN promo_campaigns pc ON pc.id = b.campaign_id
  WHERE b.id = p_batch_id
  FOR UPDATE OF b;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Batch not found');
  END IF;

  IF v_batch.status = 'completed' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Batch already completed');
  END IF;

  -- Verify cursor matches — prevents duplicate advancement
  IF v_batch.progress_cursor != p_expected_cursor THEN
    RETURN jsonb_build_object('success', false, 'error', 'Cursor mismatch',
      'expected', p_expected_cursor, 'actual', v_batch.progress_cursor);
  END IF;

  v_campaign_id := v_batch.campaign_id;
  v_business_id := v_batch.business_id;

  -- Validate array length matches declared chunk size
  IF jsonb_array_length(p_codes) != p_chunk_size THEN
    RETURN jsonb_build_object('success', false, 'error', 'Array length mismatch',
      'expected', p_chunk_size, 'actual', jsonb_array_length(p_codes));
  END IF;

  -- Insert codes — any hash collision causes the ENTIRE chunk to fail (no partial commit)
  FOR v_code IN SELECT * FROM jsonb_array_elements(p_codes)
  LOOP
    v_prize_id := CASE WHEN v_code->>'prize_id' = '' OR v_code->>'prize_id' IS NULL
                       THEN NULL ELSE (v_code->>'prize_id')::UUID END;

    IF v_prize_id IS NOT NULL THEN
      -- Lock prize row and check remaining inventory
      PERFORM 1 FROM promo_prizes
        WHERE id = v_prize_id AND campaign_id = v_campaign_id
        AND allocated_count < quantity
        FOR UPDATE;

      IF NOT FOUND THEN
        -- Prize exhausted — downgrade to try_again
        INSERT INTO promo_campaign_codes (business_id, campaign_id, batch_id,
          normalized_code_hash, encrypted_code, display_suffix, outcome, prize_id, status)
        VALUES (v_business_id, v_campaign_id, p_batch_id,
          v_code->>'hash', v_code->>'encrypted', v_code->>'suffix',
          'try_again', NULL, 'unused');
      ELSE
        INSERT INTO promo_campaign_codes (business_id, campaign_id, batch_id,
          normalized_code_hash, encrypted_code, display_suffix, outcome, prize_id, status)
        VALUES (v_business_id, v_campaign_id, p_batch_id,
          v_code->>'hash', v_code->>'encrypted', v_code->>'suffix',
          'winner', v_prize_id, 'unused');

        UPDATE promo_prizes SET allocated_count = allocated_count + 1
          WHERE id = v_prize_id AND campaign_id = v_campaign_id;
      END IF;
    ELSE
      INSERT INTO promo_campaign_codes (business_id, campaign_id, batch_id,
        normalized_code_hash, encrypted_code, display_suffix, outcome, prize_id, status)
      VALUES (v_business_id, v_campaign_id, p_batch_id,
        v_code->>'hash', v_code->>'encrypted', v_code->>'suffix',
        'try_again', NULL, 'unused');
    END IF;

    v_inserted := v_inserted + 1;
  END LOOP;

  -- Verify completion invariant before marking completed
  IF p_expected_cursor + p_chunk_size >= v_batch.requested_count THEN
    DECLARE v_actual_count INT;
    BEGIN
      SELECT count(*) INTO v_actual_count FROM promo_campaign_codes WHERE batch_id = p_batch_id;
      IF v_actual_count != v_batch.requested_count THEN
        RAISE EXCEPTION 'Completion invariant violated: expected % codes but found %',
          v_batch.requested_count, v_actual_count;
      END IF;
    END;
  END IF;

  -- Advance cursor atomically
  UPDATE promo_code_batches SET
    progress_cursor = p_expected_cursor + p_chunk_size,
    generated_count = p_expected_cursor + p_chunk_size,
    status = CASE WHEN p_expected_cursor + p_chunk_size >= v_batch.requested_count
                  THEN 'completed'::promo_batch_status ELSE 'processing'::promo_batch_status END,
    completed_at = CASE WHEN p_expected_cursor + p_chunk_size >= v_batch.requested_count
                        THEN now() ELSE NULL END
  WHERE id = p_batch_id;

  RETURN jsonb_build_object('success', true, 'inserted', v_inserted,
    'new_cursor', p_expected_cursor + p_chunk_size);
END;
$$;

REVOKE EXECUTE ON FUNCTION commit_promo_code_chunk(UUID, INT, JSONB, INT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION commit_promo_code_chunk(UUID, INT, JSONB, INT) FROM anon;
REVOKE EXECUTE ON FUNCTION commit_promo_code_chunk(UUID, INT, JSONB, INT) FROM authenticated;
GRANT EXECUTE ON FUNCTION commit_promo_code_chunk(UUID, INT, JSONB, INT) TO service_role;

-- ══════════════════════════════════════════════════════════════
-- 16. Atomic activation with validation + audit
-- ══════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION activate_promo_campaign(
  p_campaign_id UUID,
  p_actor_id UUID DEFAULT NULL,
  p_actor_role TEXT DEFAULT 'business'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_validation JSONB;
  v_campaign RECORD;
  v_from_status TEXT;
BEGIN
  -- Lock campaign
  SELECT * INTO v_campaign FROM promo_campaigns WHERE id = p_campaign_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Campaign not found');
  END IF;

  v_from_status := v_campaign.status;

  -- Run activation validation
  v_validation := validate_promo_campaign_activation(p_campaign_id);
  IF NOT (v_validation->>'valid')::boolean THEN
    RETURN jsonb_build_object('success', false, 'error', 'Activation validation failed',
      'validation_errors', v_validation->'errors');
  END IF;

  -- Apply status transition (trigger validates the transition itself)
  UPDATE promo_campaigns SET status = 'active' WHERE id = p_campaign_id;

  -- Audit if actor provided
  IF p_actor_id IS NOT NULL THEN
    INSERT INTO admin_audit_logs (actor_id, action, entity_type, entity_id, details)
    VALUES (p_actor_id, 'promotions.activate', 'promo_campaign', p_campaign_id::text,
      jsonb_build_object('from_status', v_from_status, 'actor_role', p_actor_role));
  END IF;

  RETURN jsonb_build_object('success', true, 'from_status', v_from_status, 'to_status', 'active');
END;
$$;

REVOKE EXECUTE ON FUNCTION activate_promo_campaign(UUID, UUID, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION activate_promo_campaign(UUID, UUID, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION activate_promo_campaign(UUID, UUID, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION activate_promo_campaign(UUID, UUID, TEXT) TO service_role;

-- ══════════════════════════════════════════════════════════════
-- 17. Pending eligibility context (consumed once)
-- ══════════════════════════════════════════════════════════════

CREATE TABLE promo_pending_eligibility (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES promo_campaigns(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  phone_e164  TEXT NOT NULL,
  resolved    BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_promo_pending_elig UNIQUE (campaign_id, phone_e164, business_id)
);

ALTER TABLE promo_pending_eligibility ENABLE ROW LEVEL SECURITY;
CREATE POLICY promo_pending_elig_service ON promo_pending_eligibility
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ══════════════════════════════════════════════════════════════
-- 18. Atomic import chunk commit RPC
-- ══════════════════════════════════════════════════════════════
-- Same lock order as generation: campaign → batch → prize(s)
-- Handles winner prize allocation atomically.

CREATE OR REPLACE FUNCTION commit_promo_import_chunk(
  p_batch_id UUID,
  p_codes JSONB  -- array of {hash, encrypted, suffix, outcome, prize_id}
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_batch RECORD;
  v_campaign_id UUID;
  v_business_id UUID;
  v_camp_status TEXT;
  v_camp_locked BOOLEAN;
  v_code JSONB;
  v_prize_id UUID;
  v_imported INT := 0;
  v_duplicates INT := 0;
  v_chunk_size INT;
BEGIN
  v_chunk_size := jsonb_array_length(p_codes);

  -- Lock campaign first (same order as generation)
  SELECT campaign_id INTO v_campaign_id FROM promo_code_batches WHERE id = p_batch_id;
  SELECT status, integrity_locked, business_id INTO v_camp_status, v_camp_locked, v_business_id
    FROM promo_campaigns WHERE id = v_campaign_id FOR UPDATE;

  IF v_camp_status NOT IN ('draft', 'scheduled') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Campaign status does not allow import');
  END IF;
  IF v_camp_locked THEN
    RETURN jsonb_build_object('success', false, 'error', 'Campaign integrity locked');
  END IF;

  -- Lock batch
  SELECT * INTO v_batch FROM promo_code_batches WHERE id = p_batch_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Batch not found');
  END IF;
  IF v_batch.status = 'completed' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Batch already completed');
  END IF;

  -- Process each code
  FOR v_code IN SELECT * FROM jsonb_array_elements(p_codes)
  LOOP
    v_prize_id := CASE WHEN v_code->>'prize_id' = '' OR v_code->>'prize_id' IS NULL
                       THEN NULL ELSE (v_code->>'prize_id')::UUID END;

    -- Validate prize belongs to campaign
    IF v_prize_id IS NOT NULL THEN
      PERFORM 1 FROM promo_prizes WHERE id = v_prize_id AND campaign_id = v_campaign_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Prize % does not belong to campaign %', v_prize_id, v_campaign_id;
      END IF;

      -- Lock prize and check inventory
      PERFORM 1 FROM promo_prizes
        WHERE id = v_prize_id AND campaign_id = v_campaign_id
        AND allocated_count < quantity FOR UPDATE;

      IF NOT FOUND THEN
        -- Prize exhausted — downgrade to try_again
        BEGIN
          INSERT INTO promo_campaign_codes (business_id, campaign_id, batch_id,
            normalized_code_hash, encrypted_code, display_suffix, outcome, prize_id, status)
          VALUES (v_business_id, v_campaign_id, p_batch_id,
            v_code->>'hash', v_code->>'encrypted', v_code->>'suffix',
            'try_again', NULL, 'unused');
          v_imported := v_imported + 1;
        EXCEPTION WHEN unique_violation THEN
          v_duplicates := v_duplicates + 1;
        END;
        CONTINUE;
      END IF;

      -- Insert winner + increment allocated_count atomically
      BEGIN
        INSERT INTO promo_campaign_codes (business_id, campaign_id, batch_id,
          normalized_code_hash, encrypted_code, display_suffix, outcome, prize_id, status)
        VALUES (v_business_id, v_campaign_id, p_batch_id,
          v_code->>'hash', v_code->>'encrypted', v_code->>'suffix',
          'winner', v_prize_id, 'unused');

        UPDATE promo_prizes SET allocated_count = allocated_count + 1
          WHERE id = v_prize_id AND campaign_id = v_campaign_id;

        v_imported := v_imported + 1;
      EXCEPTION WHEN unique_violation THEN
        v_duplicates := v_duplicates + 1;
        -- No prize allocation leaked — both INSERT and UPDATE rolled back
      END;
    ELSE
      -- try_again code
      BEGIN
        INSERT INTO promo_campaign_codes (business_id, campaign_id, batch_id,
          normalized_code_hash, encrypted_code, display_suffix, outcome, prize_id, status)
        VALUES (v_business_id, v_campaign_id, p_batch_id,
          v_code->>'hash', v_code->>'encrypted', v_code->>'suffix',
          'try_again', NULL, 'unused');
        v_imported := v_imported + 1;
      EXCEPTION WHEN unique_violation THEN
        v_duplicates := v_duplicates + 1;
      END;
    END IF;
  END LOOP;

  -- DB duplicate collisions mean unresolved rows — batch cannot be cleanly completed
  IF v_duplicates > 0 THEN
    UPDATE promo_code_batches SET
      generated_count = generated_count + v_imported,
      progress_cursor = progress_cursor + v_chunk_size,
      status = 'failed'::promo_batch_status,
      failed_count = COALESCE(failed_count, 0) + v_duplicates,
      error_details = jsonb_build_object('db_duplicates', v_duplicates,
        'reason', 'Database duplicate collisions — codes already exist')
    WHERE id = p_batch_id;

    RETURN jsonb_build_object('success', false, 'error', 'Database duplicate collisions',
      'imported', v_imported, 'duplicates', v_duplicates);
  END IF;

  -- Update batch progress — only mark completed when no duplicates
  UPDATE promo_code_batches SET
    generated_count = generated_count + v_imported,
    progress_cursor = progress_cursor + v_chunk_size,
    status = CASE WHEN progress_cursor + v_chunk_size >= requested_count
                  THEN 'completed'::promo_batch_status ELSE 'processing'::promo_batch_status END,
    completed_at = CASE WHEN progress_cursor + v_chunk_size >= requested_count
                        THEN now() ELSE NULL END
  WHERE id = p_batch_id;

  RETURN jsonb_build_object('success', true, 'imported', v_imported, 'duplicates', v_duplicates);
END;
$$;

REVOKE EXECUTE ON FUNCTION commit_promo_import_chunk(UUID, JSONB) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION commit_promo_import_chunk(UUID, JSONB) FROM anon;
REVOKE EXECUTE ON FUNCTION commit_promo_import_chunk(UUID, JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION commit_promo_import_chunk(UUID, JSONB) TO service_role;

-- ══════════════════════════════════════════════════════════════
-- 19. Revoke validate_promo_campaign_activation from authenticated
-- ══════════════════════════════════════════════════════════════

REVOKE EXECUTE ON FUNCTION validate_promo_campaign_activation(UUID) FROM authenticated;

-- ══════════════════════════════════════════════════════════════
-- 20. Admin list aggregate RPC (1M-safe)
-- ══════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION get_promo_campaign_aggregates(p_campaign_ids UUID[])
RETURNS TABLE (
  campaign_id UUID,
  total_codes BIGINT,
  total_winners BIGINT,
  total_attempts BIGINT,
  pending_fulfillment BIGINT,
  unique_participants BIGINT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    c.id AS campaign_id,
    (SELECT count(*) FROM promo_campaign_codes WHERE campaign_id = c.id) AS total_codes,
    (SELECT count(*) FROM promo_redemptions WHERE campaign_id = c.id AND outcome = 'winner') AS total_winners,
    (SELECT count(*) FROM promo_verification_attempts WHERE campaign_id = c.id) AS total_attempts,
    (SELECT count(*) FROM promo_redemptions WHERE campaign_id = c.id AND fulfillment_status = 'pending') AS pending_fulfillment,
    (SELECT count(DISTINCT phone_e164) FROM promo_redemptions WHERE campaign_id = c.id) AS unique_participants
  FROM unnest(p_campaign_ids) AS c(id);
$$;

REVOKE EXECUTE ON FUNCTION get_promo_campaign_aggregates(UUID[]) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION get_promo_campaign_aggregates(UUID[]) FROM anon;
REVOKE EXECUTE ON FUNCTION get_promo_campaign_aggregates(UUID[]) FROM authenticated;
GRANT EXECUTE ON FUNCTION get_promo_campaign_aggregates(UUID[]) TO service_role;

-- ══════════════════════════════════════════════════════════════
-- 21. Failed batch recovery RPC
-- ══════════════════════════════════════════════════════════════
-- Atomically resets a failed batch: removes committed codes,
-- decrements prize allocated_count, resets batch state to pending.
-- Campaign must be draft/scheduled and not integrity_locked.

CREATE OR REPLACE FUNCTION reset_promo_failed_batch(p_batch_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_batch RECORD;
  v_campaign RECORD;
  v_prize RECORD;
  v_total_winners INT;
BEGIN
  -- Lock order: campaign → batch → prizes (deterministic by UUID)

  -- 1. Get batch campaign_id first
  SELECT * INTO v_batch FROM promo_code_batches WHERE id = p_batch_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Batch not found');
  END IF;

  -- 2. Lock campaign
  SELECT * INTO v_campaign FROM promo_campaigns WHERE id = v_batch.campaign_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Campaign not found');
  END IF;
  IF v_campaign.status NOT IN ('draft', 'scheduled') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Campaign must be draft or scheduled');
  END IF;
  IF v_campaign.integrity_locked THEN
    RETURN jsonb_build_object('success', false, 'error', 'Campaign integrity is locked');
  END IF;

  -- 3. Lock batch — require failed status
  SELECT * INTO v_batch FROM promo_code_batches WHERE id = p_batch_id FOR UPDATE;
  IF v_batch.status != 'failed' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Only failed batches can be reset');
  END IF;

  -- 4. Verify no code could already have been claimed
  IF EXISTS (SELECT 1 FROM promo_campaign_codes WHERE batch_id = p_batch_id AND status = 'claimed') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Cannot reset — codes already claimed');
  END IF;

  -- 5. Lock affected prizes in deterministic order (by UUID) and count winners
  SELECT count(*) INTO v_total_winners
    FROM promo_campaign_codes WHERE batch_id = p_batch_id AND outcome = 'winner' AND prize_id IS NOT NULL;

  -- 6. Decrement each prize allocated_count by EXACT allocations being removed
  --    Fail closed if allocated_count < amount being rolled back (corruption)
  FOR v_prize IN
    SELECT prize_id, count(*)::INT AS cnt FROM promo_campaign_codes
    WHERE batch_id = p_batch_id AND outcome = 'winner' AND prize_id IS NOT NULL
    GROUP BY prize_id
    ORDER BY prize_id  -- deterministic lock order
  LOOP
    -- Lock prize row
    DECLARE v_current_allocated INT;
    BEGIN
      SELECT allocated_count INTO v_current_allocated
        FROM promo_prizes WHERE id = v_prize.prize_id FOR UPDATE;
      IF v_current_allocated < v_prize.cnt THEN
        RETURN jsonb_build_object('success', false, 'error',
          'Allocation underflow: prize ' || v_prize.prize_id || ' has allocated_count='
          || v_current_allocated || ' but batch has ' || v_prize.cnt || ' winners');
      END IF;
      UPDATE promo_prizes SET allocated_count = allocated_count - v_prize.cnt
      WHERE id = v_prize.prize_id AND campaign_id = v_batch.campaign_id;
    END;
  END LOOP;

  -- 7. Delete codes belonging to this batch
  DELETE FROM promo_campaign_codes WHERE batch_id = p_batch_id;

  -- 8. Reset SAME batch to pending
  UPDATE promo_code_batches SET
    generated_count = 0,
    failed_count = 0,
    progress_cursor = 0,
    status = 'pending',
    completed_at = NULL,
    error_details = NULL
  WHERE id = p_batch_id;

  RETURN jsonb_build_object('success', true, 'winners_removed', v_total_winners);
END;
$$;

REVOKE EXECUTE ON FUNCTION reset_promo_failed_batch(UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION reset_promo_failed_batch(UUID) FROM anon;
REVOKE EXECUTE ON FUNCTION reset_promo_failed_batch(UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION reset_promo_failed_batch(UUID) TO service_role;

-- ══════════════════════════════════════════════════════════════
-- 22. Atomic batch creation with campaign-row serialization
-- ══════════════════════════════════════════════════════════════
-- Serializes batch creation against campaign status changes (activation).
-- Ensures no batch can be created for an active/paused/ended campaign,
-- and activation cannot proceed while a batch creation is in flight.

CREATE OR REPLACE FUNCTION create_promo_batch_atomic(
  p_campaign_id UUID,
  p_source promo_batch_source,
  p_requested_count INT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_campaign RECORD;
  v_batch_id UUID;
BEGIN
  -- Lock campaign first — serializes with activate_promo_campaign
  SELECT id, status, integrity_locked INTO v_campaign
    FROM promo_campaigns WHERE id = p_campaign_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Campaign not found');
  END IF;
  IF v_campaign.status NOT IN ('draft', 'scheduled') THEN
    RETURN jsonb_build_object('success', false, 'error',
      'Campaign status ' || v_campaign.status || ' does not allow batch creation');
  END IF;
  IF v_campaign.integrity_locked THEN
    RETURN jsonb_build_object('success', false, 'error', 'Campaign integrity is locked');
  END IF;

  INSERT INTO promo_code_batches (campaign_id, source, requested_count, generated_count, failed_count, status, progress_cursor)
  VALUES (p_campaign_id, p_source, p_requested_count, 0, 0, 'pending', 0)
  RETURNING id INTO v_batch_id;

  RETURN jsonb_build_object('success', true, 'batch_id', v_batch_id);
END;
$$;

REVOKE EXECUTE ON FUNCTION create_promo_batch_atomic(UUID, promo_batch_source, INT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION create_promo_batch_atomic(UUID, promo_batch_source, INT) FROM anon;
REVOKE EXECUTE ON FUNCTION create_promo_batch_atomic(UUID, promo_batch_source, INT) FROM authenticated;
GRANT EXECUTE ON FUNCTION create_promo_batch_atomic(UUID, promo_batch_source, INT) TO service_role;
