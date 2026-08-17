-- ══════════════════════════════════════════════════════════════
-- Migration 325: Production Drift Reconciliation
-- ══════════════════════════════════════════════════════════════
-- Purpose: Converge production (with partially-applied 321+322 objects)
--          to the canonical postconditions of migrations 321 and 322.
--
-- This migration is safe to run on BOTH:
--   (A) Clean database (after 321+322 already applied normally)
--   (B) Drifted production (partial schema applied outside migration ledger)
--
-- Every statement uses IF NOT EXISTS / CREATE OR REPLACE / DO $$ guards.
-- No data is dropped. No existing correct objects are recreated.
--
-- Scope: 321 (Promotions) + 322 (Class Session Booking)
-- Does NOT modify migration 324 scope.
-- ══════════════════════════════════════════════════════════════


-- ══════════════════════════════════════════════════════════════
-- PART 1: Migration 321 — Promotions Schema
-- ══════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── 1.1 Enums (guarded) ──

DO $$ BEGIN
  CREATE TYPE promo_campaign_status AS ENUM (
    'draft', 'scheduled', 'active', 'paused', 'ended', 'archived'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE promo_code_entry_mode AS ENUM (
    'keyword', 'bare_code', 'both'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE promo_prize_type AS ENUM (
    'cash', 'airtime', 'product', 'voucher', 'discount', 'custom'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE promo_batch_status AS ENUM (
    'pending', 'processing', 'completed', 'failed'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE promo_batch_source AS ENUM (
    'generated', 'imported'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE promo_code_status AS ENUM ('unused', 'claimed', 'void');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE promo_code_outcome AS ENUM ('winner', 'try_again');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE promo_fulfillment_status AS ENUM (
    'pending', 'processing', 'fulfilled', 'rejected', 'cancelled'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE promo_attempt_result AS ENUM (
    'winner', 'try_again', 'invalid', 'already_claimed',
    'campaign_inactive', 'rate_limited', 'not_eligible'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;


-- ── 1.2 Tables (IF NOT EXISTS) ──

CREATE TABLE IF NOT EXISTS promo_campaigns (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  description     TEXT,
  status          promo_campaign_status NOT NULL DEFAULT 'draft',
  start_at        TIMESTAMPTZ,
  end_at          TIMESTAMPTZ,
  timezone        TEXT NOT NULL DEFAULT 'Africa/Lagos',
  code_entry_mode promo_code_entry_mode NOT NULL DEFAULT 'keyword',
  keyword         TEXT,
  accept_bare_codes BOOLEAN NOT NULL DEFAULT false,
  code_format     TEXT NOT NULL DEFAULT 'XXXX-XXXX-XXXX',
  code_length     INT NOT NULL DEFAULT 12,
  code_prefix     TEXT,
  max_attempts_per_phone INT NOT NULL DEFAULT 50,
  rate_limit_window_minutes INT NOT NULL DEFAULT 60,
  rate_limit_max_attempts INT NOT NULL DEFAULT 10,
  eligibility_mode TEXT NOT NULL DEFAULT 'none',
  eligibility_prompt TEXT,
  eligibility_min_age INT,
  winner_message    TEXT NOT NULL DEFAULT '🎉 Congratulations!\n\nYour code is a winner.\n\nPrize:\n{prize_name}\n\nClaim reference:\n{claim_ref}\n\nOur team will contact you with the next steps.',
  try_again_message TEXT NOT NULL DEFAULT 'Thanks for participating 🙌\n\nThis code wasn''t a winner this time.\n\nYou can try again with another eligible product.',
  invalid_message   TEXT NOT NULL DEFAULT 'We couldn''t verify that promotion code.\n\nCheck the code and try again.',
  already_used_message TEXT NOT NULL DEFAULT 'This promotion code has already been used.\n\nIf you believe this is an error, contact support.',
  expired_message   TEXT NOT NULL DEFAULT 'This promotion is not currently active.',
  integrity_locked  BOOLEAN NOT NULL DEFAULT false,
  created_by      UUID REFERENCES auth.users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
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

CREATE TABLE IF NOT EXISTS promo_prizes (
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

CREATE TABLE IF NOT EXISTS promo_code_batches (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id     UUID NOT NULL REFERENCES promo_campaigns(id) ON DELETE CASCADE,
  source          promo_batch_source NOT NULL DEFAULT 'generated',
  requested_count INT NOT NULL CHECK (requested_count > 0),
  generated_count INT NOT NULL DEFAULT 0,
  failed_count    INT NOT NULL DEFAULT 0,
  status          promo_batch_status NOT NULL DEFAULT 'pending',
  filename        TEXT,
  error_details   JSONB,
  progress_cursor INT NOT NULL DEFAULT 0,
  created_by      UUID REFERENCES auth.users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS promo_campaign_codes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  campaign_id     UUID NOT NULL REFERENCES promo_campaigns(id) ON DELETE CASCADE,
  batch_id        UUID NOT NULL REFERENCES promo_code_batches(id) ON DELETE CASCADE,
  normalized_code_hash TEXT NOT NULL,
  encrypted_code  TEXT,
  display_suffix  TEXT NOT NULL,
  outcome         promo_code_outcome NOT NULL DEFAULT 'try_again',
  prize_id        UUID REFERENCES promo_prizes(id),
  status          promo_code_status NOT NULL DEFAULT 'unused',
  claimed_at      TIMESTAMPTZ,
  claimed_by_phone TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_promo_code_hash UNIQUE (business_id, normalized_code_hash),
  CONSTRAINT chk_winner_has_prize CHECK (outcome = 'try_again' OR prize_id IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS promo_redemptions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  campaign_id     UUID NOT NULL REFERENCES promo_campaigns(id) ON DELETE CASCADE,
  promo_code_id   UUID NOT NULL REFERENCES promo_campaign_codes(id),
  phone_e164      TEXT NOT NULL,
  inbound_message_id TEXT,
  outcome         promo_code_outcome NOT NULL,
  prize_id        UUID REFERENCES promo_prizes(id),
  claim_reference TEXT NOT NULL,
  claimed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  fulfillment_status promo_fulfillment_status NOT NULL DEFAULT 'pending',
  fulfillment_reference TEXT,
  fulfillment_notes TEXT,
  fulfilled_at    TIMESTAMPTZ,
  fulfilled_by    UUID REFERENCES auth.users(id),
  CONSTRAINT uq_promo_redemption_message UNIQUE (inbound_message_id),
  CONSTRAINT uq_promo_redemption_code UNIQUE (promo_code_id)
);

CREATE TABLE IF NOT EXISTS promo_verification_attempts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  campaign_id     UUID REFERENCES promo_campaigns(id),
  phone_e164      TEXT NOT NULL,
  submitted_code_hash TEXT,
  result          promo_attempt_result NOT NULL,
  inbound_message_id TEXT,
  promo_code_id   UUID REFERENCES promo_campaign_codes(id),
  metadata        JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS promo_eligibility_acks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id     UUID NOT NULL REFERENCES promo_campaigns(id) ON DELETE CASCADE,
  phone_e164      TEXT NOT NULL,
  eligibility_mode TEXT NOT NULL,
  acknowledged_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_promo_elig_ack UNIQUE (campaign_id, phone_e164)
);

CREATE TABLE IF NOT EXISTS promo_pending_eligibility (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES promo_campaigns(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  phone_e164  TEXT NOT NULL,
  resolved    BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_promo_pending_elig UNIQUE (campaign_id, phone_e164, business_id)
);


-- ── 1.3 Indexes (IF NOT EXISTS) ──

CREATE UNIQUE INDEX IF NOT EXISTS idx_promo_campaigns_bare_code_active
  ON promo_campaigns (business_id)
  WHERE accept_bare_codes = true AND status IN ('active', 'scheduled');

CREATE INDEX IF NOT EXISTS idx_promo_campaigns_business ON promo_campaigns (business_id);
CREATE INDEX IF NOT EXISTS idx_promo_campaigns_status ON promo_campaigns (status);

CREATE UNIQUE INDEX IF NOT EXISTS idx_promo_campaigns_keyword_unique
  ON promo_campaigns (business_id, lower(keyword))
  WHERE keyword IS NOT NULL AND status IN ('active', 'scheduled');

CREATE INDEX IF NOT EXISTS idx_promo_campaigns_keyword ON promo_campaigns (business_id, keyword)
  WHERE keyword IS NOT NULL AND status = 'active';

CREATE INDEX IF NOT EXISTS idx_promo_prizes_campaign ON promo_prizes (campaign_id);
CREATE INDEX IF NOT EXISTS idx_promo_code_batches_campaign ON promo_code_batches (campaign_id);

CREATE INDEX IF NOT EXISTS idx_promo_campaign_codes_lookup
  ON promo_campaign_codes (business_id, campaign_id, normalized_code_hash);
CREATE INDEX IF NOT EXISTS idx_promo_campaign_codes_campaign ON promo_campaign_codes (campaign_id);
CREATE INDEX IF NOT EXISTS idx_promo_campaign_codes_batch ON promo_campaign_codes (batch_id);
CREATE INDEX IF NOT EXISTS idx_promo_campaign_codes_status ON promo_campaign_codes (campaign_id, status);
CREATE INDEX IF NOT EXISTS idx_promo_campaign_codes_prize ON promo_campaign_codes (prize_id) WHERE prize_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_promo_redemptions_campaign ON promo_redemptions (campaign_id);
CREATE INDEX IF NOT EXISTS idx_promo_redemptions_phone ON promo_redemptions (phone_e164);
CREATE INDEX IF NOT EXISTS idx_promo_redemptions_fulfillment ON promo_redemptions (campaign_id, fulfillment_status);
CREATE INDEX IF NOT EXISTS idx_promo_redemptions_business ON promo_redemptions (business_id);

CREATE INDEX IF NOT EXISTS idx_promo_attempts_campaign ON promo_verification_attempts (campaign_id);
CREATE INDEX IF NOT EXISTS idx_promo_attempts_phone ON promo_verification_attempts (phone_e164, created_at);
CREATE INDEX IF NOT EXISTS idx_promo_attempts_business ON promo_verification_attempts (business_id);
CREATE INDEX IF NOT EXISTS idx_promo_attempts_result ON promo_verification_attempts (campaign_id, result);

CREATE UNIQUE INDEX IF NOT EXISTS idx_promo_attempts_message_idempotent
  ON promo_verification_attempts (inbound_message_id)
  WHERE inbound_message_id IS NOT NULL;


-- ── 1.4 RLS (idempotent: DROP IF EXISTS + CREATE) ──

ALTER TABLE promo_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE promo_prizes ENABLE ROW LEVEL SECURITY;
ALTER TABLE promo_code_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE promo_campaign_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE promo_redemptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE promo_verification_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE promo_eligibility_acks ENABLE ROW LEVEL SECURITY;
ALTER TABLE promo_pending_eligibility ENABLE ROW LEVEL SECURITY;

-- promo_campaigns
DROP POLICY IF EXISTS promo_campaigns_select ON promo_campaigns;
CREATE POLICY promo_campaigns_select ON promo_campaigns
  FOR SELECT TO authenticated
  USING (
    business_id IN (
      SELECT b.id FROM businesses b WHERE b.owner_id = auth.uid()
      UNION
      SELECT bm.business_id FROM business_members bm WHERE bm.user_id = auth.uid()
    )
  );
DROP POLICY IF EXISTS promo_campaigns_service ON promo_campaigns;
CREATE POLICY promo_campaigns_service ON promo_campaigns
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- promo_prizes
DROP POLICY IF EXISTS promo_prizes_select ON promo_prizes;
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
DROP POLICY IF EXISTS promo_prizes_service ON promo_prizes;
CREATE POLICY promo_prizes_service ON promo_prizes
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- promo_code_batches
DROP POLICY IF EXISTS promo_code_batches_select ON promo_code_batches;
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
DROP POLICY IF EXISTS promo_code_batches_service ON promo_code_batches;
CREATE POLICY promo_code_batches_service ON promo_code_batches
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- promo_campaign_codes
DROP POLICY IF EXISTS promo_campaign_codes_service ON promo_campaign_codes;
CREATE POLICY promo_campaign_codes_service ON promo_campaign_codes
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- promo_redemptions
DROP POLICY IF EXISTS promo_redemptions_select ON promo_redemptions;
CREATE POLICY promo_redemptions_select ON promo_redemptions
  FOR SELECT TO authenticated
  USING (
    business_id IN (
      SELECT b.id FROM businesses b WHERE b.owner_id = auth.uid()
      UNION
      SELECT bm.business_id FROM business_members bm WHERE bm.user_id = auth.uid()
    )
  );
DROP POLICY IF EXISTS promo_redemptions_service ON promo_redemptions;
CREATE POLICY promo_redemptions_service ON promo_redemptions
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- promo_verification_attempts
DROP POLICY IF EXISTS promo_attempts_select ON promo_verification_attempts;
CREATE POLICY promo_attempts_select ON promo_verification_attempts
  FOR SELECT TO authenticated
  USING (
    business_id IN (
      SELECT b.id FROM businesses b WHERE b.owner_id = auth.uid()
      UNION
      SELECT bm.business_id FROM business_members bm WHERE bm.user_id = auth.uid()
    )
  );
DROP POLICY IF EXISTS promo_attempts_service ON promo_verification_attempts;
CREATE POLICY promo_attempts_service ON promo_verification_attempts
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- promo_eligibility_acks
DROP POLICY IF EXISTS promo_elig_acks_service ON promo_eligibility_acks;
CREATE POLICY promo_elig_acks_service ON promo_eligibility_acks
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- promo_pending_eligibility
DROP POLICY IF EXISTS promo_pending_elig_service ON promo_pending_eligibility;
CREATE POLICY promo_pending_elig_service ON promo_pending_eligibility
  FOR ALL TO service_role USING (true) WITH CHECK (true);


-- ── 1.5 Triggers (idempotent: DROP + CREATE) ──

CREATE OR REPLACE FUNCTION update_promo_campaign_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_promo_campaigns_updated_at ON promo_campaigns;
CREATE TRIGGER trg_promo_campaigns_updated_at
  BEFORE UPDATE ON promo_campaigns
  FOR EACH ROW EXECUTE FUNCTION update_promo_campaign_updated_at();

CREATE OR REPLACE FUNCTION validate_promo_campaign_status_transition()
RETURNS TRIGGER AS $$
BEGIN
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

DROP TRIGGER IF EXISTS trg_promo_campaign_status_transition ON promo_campaigns;
CREATE TRIGGER trg_promo_campaign_status_transition
  BEFORE UPDATE ON promo_campaigns
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION validate_promo_campaign_status_transition();


-- ── 1.6 Functions (CREATE OR REPLACE) ──

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
  IF p_inbound_message_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('promo_msg:' || p_inbound_message_id));
  END IF;
  PERFORM pg_advisory_xact_lock(
    hashtext('promo_rate:' || p_campaign_id::text || ':' || p_phone_e164)
  );
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
  v_claim_ref := 'WAA-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6));
  UPDATE promo_campaign_codes SET status = 'claimed', claimed_at = now(), claimed_by_phone = p_phone_e164 WHERE id = v_code.id;
  UPDATE promo_campaigns SET integrity_locked = true, updated_at = now() WHERE id = p_campaign_id AND integrity_locked = false;
  INSERT INTO promo_redemptions (id, business_id, campaign_id, promo_code_id, phone_e164, inbound_message_id, outcome, prize_id, claim_reference, claimed_at, fulfillment_status)
  VALUES (gen_random_uuid(), p_business_id, p_campaign_id, v_code.id, p_phone_e164, p_inbound_message_id, v_code.outcome, v_code.prize_id, v_claim_ref, now(),
    CASE WHEN v_code.outcome = 'winner' THEN 'pending'::promo_fulfillment_status ELSE 'fulfilled'::promo_fulfillment_status END)
  RETURNING id INTO v_redemption_id;
  INSERT INTO promo_verification_attempts (business_id, campaign_id, phone_e164, submitted_code_hash, result, inbound_message_id, promo_code_id)
  VALUES (p_business_id, p_campaign_id, p_phone_e164, p_normalized_code_hash, v_code.outcome::text::promo_attempt_result, p_inbound_message_id, v_code.id)
  ON CONFLICT (inbound_message_id) WHERE inbound_message_id IS NOT NULL DO NOTHING;
  IF v_code.outcome = 'winner' THEN
    SELECT pp.name, pp.prize_type::text, pp.value, pp.currency
    INTO v_prize_name, v_prize_type, v_prize_value, v_prize_currency
    FROM promo_prizes pp WHERE pp.id = v_code.prize_id;
    RETURN jsonb_build_object('success', true, 'result', 'winner', 'claim_reference', v_claim_ref, 'redemption_id', v_redemption_id,
      'prize_name', v_prize_name, 'prize_type', v_prize_type, 'prize_value', v_prize_value, 'prize_currency', v_prize_currency);
  ELSE
    RETURN jsonb_build_object('success', true, 'result', 'try_again', 'claim_reference', v_claim_ref, 'redemption_id', v_redemption_id);
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION claim_promo_code(UUID, UUID, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION claim_promo_code(UUID, UUID, TEXT, TEXT, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION claim_promo_code(UUID, UUID, TEXT, TEXT, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION claim_promo_code(UUID, UUID, TEXT, TEXT, TEXT) TO service_role;


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
  IF NOT FOUND THEN RETURN jsonb_build_object('valid', false, 'errors', ARRAY['Campaign not found']); END IF;
  IF v_campaign.end_at IS NOT NULL AND v_campaign.end_at <= now() THEN v_errors := array_append(v_errors, 'Campaign end date is in the past'); END IF;
  SELECT count(*) INTO v_total_codes FROM promo_campaign_codes WHERE campaign_id = p_campaign_id;
  IF v_total_codes = 0 THEN v_errors := array_append(v_errors, 'No codes have been generated or imported'); END IF;
  SELECT count(*) INTO v_incomplete_batches FROM promo_code_batches WHERE campaign_id = p_campaign_id AND status NOT IN ('completed');
  IF v_incomplete_batches > 0 THEN v_errors := array_append(v_errors, v_incomplete_batches || ' batch(es) not completed (pending/processing/failed)'); END IF;
  DECLARE v_failed_batches INT;
  BEGIN
    SELECT count(*) INTO v_failed_batches FROM promo_code_batches WHERE campaign_id = p_campaign_id AND status = 'completed' AND failed_count > 0;
    IF v_failed_batches > 0 THEN v_errors := array_append(v_errors, v_failed_batches || ' completed batch(es) have unresolved failed rows'); END IF;
  END;
  SELECT coalesce(sum(quantity), 0) INTO v_total_prize_qty FROM promo_prizes WHERE campaign_id = p_campaign_id;
  SELECT count(*) INTO v_winner_codes FROM promo_campaign_codes WHERE campaign_id = p_campaign_id AND outcome = 'winner';
  IF v_winner_codes != v_total_prize_qty THEN v_errors := array_append(v_errors, 'Winner code count (' || v_winner_codes || ') does not match prize inventory (' || v_total_prize_qty || ')'); END IF;
  IF v_total_prize_qty > v_total_codes THEN v_errors := array_append(v_errors, 'Prize allocation (' || v_total_prize_qty || ') exceeds total codes (' || v_total_codes || ')'); END IF;
  FOR v_prize IN SELECT id, name, quantity FROM promo_prizes WHERE campaign_id = p_campaign_id
  LOOP
    SELECT count(*) INTO v_prize_code_count FROM promo_campaign_codes WHERE campaign_id = p_campaign_id AND prize_id = v_prize.id;
    IF v_prize_code_count != v_prize.quantity THEN v_errors := array_append(v_errors, 'Prize "' || v_prize.name || '": expected ' || v_prize.quantity || ' codes but found ' || v_prize_code_count); END IF;
  END LOOP;
  IF v_campaign.code_entry_mode IN ('keyword', 'both') AND (v_campaign.keyword IS NULL OR v_campaign.keyword = '') THEN v_errors := array_append(v_errors, 'Keyword mode requires a keyword'); END IF;
  IF v_campaign.accept_bare_codes THEN
    SELECT count(*) INTO v_bare_code_conflict FROM promo_campaigns WHERE business_id = v_campaign.business_id AND accept_bare_codes = true AND status = 'active' AND id != p_campaign_id;
    IF v_bare_code_conflict > 0 THEN v_errors := array_append(v_errors, 'Another active bare-code campaign exists for this business'); END IF;
  END IF;
  IF v_campaign.winner_message IS NULL OR v_campaign.winner_message = '' THEN v_errors := array_append(v_errors, 'Winner message is required'); END IF;
  IF v_campaign.try_again_message IS NULL OR v_campaign.try_again_message = '' THEN v_errors := array_append(v_errors, 'Try-again message is required'); END IF;
  IF v_campaign.invalid_message IS NULL OR v_campaign.invalid_message = '' THEN v_errors := array_append(v_errors, 'Invalid-code message is required'); END IF;
  IF v_campaign.eligibility_mode IN ('age_confirmation', 'custom') AND (v_campaign.eligibility_prompt IS NULL OR v_campaign.eligibility_prompt = '') THEN
    v_errors := array_append(v_errors, 'Eligibility prompt is required for ' || v_campaign.eligibility_mode || ' mode');
  END IF;
  RETURN jsonb_build_object('valid', array_length(v_errors, 1) IS NULL, 'errors', v_errors);
END;
$$;

REVOKE EXECUTE ON FUNCTION validate_promo_campaign_activation(UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION validate_promo_campaign_activation(UUID) FROM anon;
REVOKE EXECUTE ON FUNCTION validate_promo_campaign_activation(UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION validate_promo_campaign_activation(UUID) TO service_role;


CREATE OR REPLACE FUNCTION admin_promo_governance(
  p_campaign_id UUID, p_target_status TEXT, p_actor_id UUID, p_actor_role TEXT, p_reason TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_campaign RECORD; v_from_status TEXT;
BEGIN
  SELECT id, business_id, name, status INTO v_campaign FROM promo_campaigns WHERE id = p_campaign_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'Campaign not found'); END IF;
  v_from_status := v_campaign.status;
  UPDATE promo_campaigns SET status = p_target_status::promo_campaign_status WHERE id = p_campaign_id;
  INSERT INTO admin_audit_logs (actor_id, action, entity_type, entity_id, details)
  VALUES (p_actor_id, 'promotions.' || p_target_status, 'promo_campaign', p_campaign_id::text,
    jsonb_build_object('business_id', v_campaign.business_id, 'campaign_name', v_campaign.name,
      'from_status', v_from_status, 'to_status', p_target_status, 'actor_role', p_actor_role, 'reason', coalesce(p_reason, '')));
  RETURN jsonb_build_object('success', true, 'from_status', v_from_status, 'to_status', p_target_status);
END;
$$;

REVOKE EXECUTE ON FUNCTION admin_promo_governance(UUID, TEXT, UUID, TEXT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION admin_promo_governance(UUID, TEXT, UUID, TEXT, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION admin_promo_governance(UUID, TEXT, UUID, TEXT, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION admin_promo_governance(UUID, TEXT, UUID, TEXT, TEXT) TO service_role;


CREATE OR REPLACE FUNCTION commit_promo_code_chunk(
  p_batch_id UUID, p_expected_cursor INT, p_codes JSONB, p_chunk_size INT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_batch RECORD; v_campaign_id UUID; v_business_id UUID; v_code JSONB; v_prize_id UUID; v_inserted INT := 0;
BEGIN
  DECLARE v_camp_status TEXT; v_camp_locked BOOLEAN;
  BEGIN
    SELECT status, integrity_locked INTO v_camp_status, v_camp_locked
    FROM promo_campaigns WHERE id = (SELECT campaign_id FROM promo_code_batches WHERE id = p_batch_id) FOR UPDATE;
    IF v_camp_status NOT IN ('draft', 'scheduled') THEN RETURN jsonb_build_object('success', false, 'error', 'Campaign status ' || v_camp_status || ' does not allow inventory mutation'); END IF;
    IF v_camp_locked THEN RETURN jsonb_build_object('success', false, 'error', 'Campaign integrity is locked'); END IF;
  END;
  SELECT b.*, pc.business_id INTO v_batch FROM promo_code_batches b JOIN promo_campaigns pc ON pc.id = b.campaign_id WHERE b.id = p_batch_id FOR UPDATE OF b;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'Batch not found'); END IF;
  IF v_batch.status = 'completed' THEN RETURN jsonb_build_object('success', false, 'error', 'Batch already completed'); END IF;
  IF v_batch.progress_cursor != p_expected_cursor THEN
    RETURN jsonb_build_object('success', false, 'error', 'Cursor mismatch', 'expected', p_expected_cursor, 'actual', v_batch.progress_cursor);
  END IF;
  v_campaign_id := v_batch.campaign_id; v_business_id := v_batch.business_id;
  IF jsonb_array_length(p_codes) != p_chunk_size THEN
    RETURN jsonb_build_object('success', false, 'error', 'Array length mismatch', 'expected', p_chunk_size, 'actual', jsonb_array_length(p_codes));
  END IF;
  FOR v_code IN SELECT * FROM jsonb_array_elements(p_codes)
  LOOP
    v_prize_id := CASE WHEN v_code->>'prize_id' = '' OR v_code->>'prize_id' IS NULL THEN NULL ELSE (v_code->>'prize_id')::UUID END;
    IF v_prize_id IS NOT NULL THEN
      PERFORM 1 FROM promo_prizes WHERE id = v_prize_id AND campaign_id = v_campaign_id AND allocated_count < quantity FOR UPDATE;
      IF NOT FOUND THEN
        INSERT INTO promo_campaign_codes (business_id, campaign_id, batch_id, normalized_code_hash, encrypted_code, display_suffix, outcome, prize_id, status)
        VALUES (v_business_id, v_campaign_id, p_batch_id, v_code->>'hash', v_code->>'encrypted', v_code->>'suffix', 'try_again', NULL, 'unused');
      ELSE
        INSERT INTO promo_campaign_codes (business_id, campaign_id, batch_id, normalized_code_hash, encrypted_code, display_suffix, outcome, prize_id, status)
        VALUES (v_business_id, v_campaign_id, p_batch_id, v_code->>'hash', v_code->>'encrypted', v_code->>'suffix', 'winner', v_prize_id, 'unused');
        UPDATE promo_prizes SET allocated_count = allocated_count + 1 WHERE id = v_prize_id AND campaign_id = v_campaign_id;
      END IF;
    ELSE
      INSERT INTO promo_campaign_codes (business_id, campaign_id, batch_id, normalized_code_hash, encrypted_code, display_suffix, outcome, prize_id, status)
      VALUES (v_business_id, v_campaign_id, p_batch_id, v_code->>'hash', v_code->>'encrypted', v_code->>'suffix', 'try_again', NULL, 'unused');
    END IF;
    v_inserted := v_inserted + 1;
  END LOOP;
  IF p_expected_cursor + p_chunk_size >= v_batch.requested_count THEN
    DECLARE v_actual_count INT;
    BEGIN
      SELECT count(*) INTO v_actual_count FROM promo_campaign_codes WHERE batch_id = p_batch_id;
      IF v_actual_count != v_batch.requested_count THEN
        RAISE EXCEPTION 'Completion invariant violated: expected % codes but found %', v_batch.requested_count, v_actual_count;
      END IF;
    END;
  END IF;
  UPDATE promo_code_batches SET progress_cursor = p_expected_cursor + p_chunk_size, generated_count = p_expected_cursor + p_chunk_size,
    status = CASE WHEN p_expected_cursor + p_chunk_size >= v_batch.requested_count THEN 'completed'::promo_batch_status ELSE 'processing'::promo_batch_status END,
    completed_at = CASE WHEN p_expected_cursor + p_chunk_size >= v_batch.requested_count THEN now() ELSE NULL END
  WHERE id = p_batch_id;
  RETURN jsonb_build_object('success', true, 'inserted', v_inserted, 'new_cursor', p_expected_cursor + p_chunk_size);
END;
$$;

REVOKE EXECUTE ON FUNCTION commit_promo_code_chunk(UUID, INT, JSONB, INT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION commit_promo_code_chunk(UUID, INT, JSONB, INT) FROM anon;
REVOKE EXECUTE ON FUNCTION commit_promo_code_chunk(UUID, INT, JSONB, INT) FROM authenticated;
GRANT EXECUTE ON FUNCTION commit_promo_code_chunk(UUID, INT, JSONB, INT) TO service_role;


CREATE OR REPLACE FUNCTION activate_promo_campaign(
  p_campaign_id UUID, p_actor_id UUID DEFAULT NULL, p_actor_role TEXT DEFAULT 'business'
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_validation JSONB; v_campaign RECORD; v_from_status TEXT;
BEGIN
  SELECT * INTO v_campaign FROM promo_campaigns WHERE id = p_campaign_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'Campaign not found'); END IF;
  v_from_status := v_campaign.status;
  v_validation := validate_promo_campaign_activation(p_campaign_id);
  IF NOT (v_validation->>'valid')::boolean THEN
    RETURN jsonb_build_object('success', false, 'error', 'Activation validation failed', 'validation_errors', v_validation->'errors');
  END IF;
  UPDATE promo_campaigns SET status = 'active' WHERE id = p_campaign_id;
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


CREATE OR REPLACE FUNCTION commit_promo_import_chunk(p_batch_id UUID, p_codes JSONB)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_batch RECORD; v_campaign_id UUID; v_business_id UUID;
  v_camp_status TEXT; v_camp_locked BOOLEAN; v_code JSONB;
  v_prize_id UUID; v_imported INT := 0; v_duplicates INT := 0; v_chunk_size INT;
BEGIN
  v_chunk_size := jsonb_array_length(p_codes);
  SELECT campaign_id INTO v_campaign_id FROM promo_code_batches WHERE id = p_batch_id;
  SELECT status, integrity_locked, business_id INTO v_camp_status, v_camp_locked, v_business_id
    FROM promo_campaigns WHERE id = v_campaign_id FOR UPDATE;
  IF v_camp_status NOT IN ('draft', 'scheduled') THEN RETURN jsonb_build_object('success', false, 'error', 'Campaign status does not allow import'); END IF;
  IF v_camp_locked THEN RETURN jsonb_build_object('success', false, 'error', 'Campaign integrity locked'); END IF;
  SELECT * INTO v_batch FROM promo_code_batches WHERE id = p_batch_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'Batch not found'); END IF;
  IF v_batch.status = 'completed' THEN RETURN jsonb_build_object('success', false, 'error', 'Batch already completed'); END IF;
  FOR v_code IN SELECT * FROM jsonb_array_elements(p_codes)
  LOOP
    v_prize_id := CASE WHEN v_code->>'prize_id' = '' OR v_code->>'prize_id' IS NULL THEN NULL ELSE (v_code->>'prize_id')::UUID END;
    IF v_prize_id IS NOT NULL THEN
      PERFORM 1 FROM promo_prizes WHERE id = v_prize_id AND campaign_id = v_campaign_id;
      IF NOT FOUND THEN RAISE EXCEPTION 'Prize % does not belong to campaign %', v_prize_id, v_campaign_id; END IF;
      PERFORM 1 FROM promo_prizes WHERE id = v_prize_id AND campaign_id = v_campaign_id AND allocated_count < quantity FOR UPDATE;
      IF NOT FOUND THEN
        BEGIN
          INSERT INTO promo_campaign_codes (business_id, campaign_id, batch_id, normalized_code_hash, encrypted_code, display_suffix, outcome, prize_id, status)
          VALUES (v_business_id, v_campaign_id, p_batch_id, v_code->>'hash', v_code->>'encrypted', v_code->>'suffix', 'try_again', NULL, 'unused');
          v_imported := v_imported + 1;
        EXCEPTION WHEN unique_violation THEN v_duplicates := v_duplicates + 1;
        END;
        CONTINUE;
      END IF;
      BEGIN
        INSERT INTO promo_campaign_codes (business_id, campaign_id, batch_id, normalized_code_hash, encrypted_code, display_suffix, outcome, prize_id, status)
        VALUES (v_business_id, v_campaign_id, p_batch_id, v_code->>'hash', v_code->>'encrypted', v_code->>'suffix', 'winner', v_prize_id, 'unused');
        UPDATE promo_prizes SET allocated_count = allocated_count + 1 WHERE id = v_prize_id AND campaign_id = v_campaign_id;
        v_imported := v_imported + 1;
      EXCEPTION WHEN unique_violation THEN v_duplicates := v_duplicates + 1;
      END;
    ELSE
      BEGIN
        INSERT INTO promo_campaign_codes (business_id, campaign_id, batch_id, normalized_code_hash, encrypted_code, display_suffix, outcome, prize_id, status)
        VALUES (v_business_id, v_campaign_id, p_batch_id, v_code->>'hash', v_code->>'encrypted', v_code->>'suffix', 'try_again', NULL, 'unused');
        v_imported := v_imported + 1;
      EXCEPTION WHEN unique_violation THEN v_duplicates := v_duplicates + 1;
      END;
    END IF;
  END LOOP;
  IF v_duplicates > 0 THEN
    UPDATE promo_code_batches SET generated_count = generated_count + v_imported, progress_cursor = progress_cursor + v_chunk_size,
      status = 'failed'::promo_batch_status, failed_count = COALESCE(failed_count, 0) + v_duplicates,
      error_details = jsonb_build_object('db_duplicates', v_duplicates, 'reason', 'Database duplicate collisions — codes already exist')
    WHERE id = p_batch_id;
    RETURN jsonb_build_object('success', false, 'error', 'Database duplicate collisions', 'imported', v_imported, 'duplicates', v_duplicates);
  END IF;
  UPDATE promo_code_batches SET generated_count = generated_count + v_imported, progress_cursor = progress_cursor + v_chunk_size,
    status = CASE WHEN progress_cursor + v_chunk_size >= requested_count THEN 'completed'::promo_batch_status ELSE 'processing'::promo_batch_status END,
    completed_at = CASE WHEN progress_cursor + v_chunk_size >= requested_count THEN now() ELSE NULL END
  WHERE id = p_batch_id;
  RETURN jsonb_build_object('success', true, 'imported', v_imported, 'duplicates', v_duplicates);
END;
$$;

REVOKE EXECUTE ON FUNCTION commit_promo_import_chunk(UUID, JSONB) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION commit_promo_import_chunk(UUID, JSONB) FROM anon;
REVOKE EXECUTE ON FUNCTION commit_promo_import_chunk(UUID, JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION commit_promo_import_chunk(UUID, JSONB) TO service_role;


CREATE OR REPLACE FUNCTION get_promo_campaign_aggregates(p_campaign_ids UUID[])
RETURNS TABLE (
  campaign_id UUID, total_codes BIGINT, total_winners BIGINT,
  total_attempts BIGINT, pending_fulfillment BIGINT, unique_participants BIGINT
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT c.id AS campaign_id,
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


CREATE OR REPLACE FUNCTION reset_promo_failed_batch(p_batch_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_batch RECORD; v_campaign RECORD; v_prize RECORD; v_total_winners INT;
BEGIN
  SELECT * INTO v_batch FROM promo_code_batches WHERE id = p_batch_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'Batch not found'); END IF;
  SELECT * INTO v_campaign FROM promo_campaigns WHERE id = v_batch.campaign_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'Campaign not found'); END IF;
  IF v_campaign.status NOT IN ('draft', 'scheduled') THEN RETURN jsonb_build_object('success', false, 'error', 'Campaign must be draft or scheduled'); END IF;
  IF v_campaign.integrity_locked THEN RETURN jsonb_build_object('success', false, 'error', 'Campaign integrity is locked'); END IF;
  SELECT * INTO v_batch FROM promo_code_batches WHERE id = p_batch_id FOR UPDATE;
  IF v_batch.status != 'failed' THEN RETURN jsonb_build_object('success', false, 'error', 'Only failed batches can be reset'); END IF;
  IF EXISTS (SELECT 1 FROM promo_campaign_codes WHERE batch_id = p_batch_id AND status = 'claimed') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Cannot reset — codes already claimed');
  END IF;
  SELECT count(*) INTO v_total_winners FROM promo_campaign_codes WHERE batch_id = p_batch_id AND outcome = 'winner' AND prize_id IS NOT NULL;
  FOR v_prize IN SELECT prize_id, count(*)::INT AS cnt FROM promo_campaign_codes WHERE batch_id = p_batch_id AND outcome = 'winner' AND prize_id IS NOT NULL GROUP BY prize_id ORDER BY prize_id
  LOOP
    DECLARE v_current_allocated INT;
    BEGIN
      SELECT allocated_count INTO v_current_allocated FROM promo_prizes WHERE id = v_prize.prize_id FOR UPDATE;
      IF v_current_allocated < v_prize.cnt THEN
        RETURN jsonb_build_object('success', false, 'error', 'Allocation underflow: prize ' || v_prize.prize_id || ' has allocated_count=' || v_current_allocated || ' but batch has ' || v_prize.cnt || ' winners');
      END IF;
      UPDATE promo_prizes SET allocated_count = allocated_count - v_prize.cnt WHERE id = v_prize.prize_id AND campaign_id = v_batch.campaign_id;
    END;
  END LOOP;
  DELETE FROM promo_campaign_codes WHERE batch_id = p_batch_id;
  UPDATE promo_code_batches SET generated_count = 0, failed_count = 0, progress_cursor = 0, status = 'pending', completed_at = NULL, error_details = NULL WHERE id = p_batch_id;
  RETURN jsonb_build_object('success', true, 'winners_removed', v_total_winners);
END;
$$;

REVOKE EXECUTE ON FUNCTION reset_promo_failed_batch(UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION reset_promo_failed_batch(UUID) FROM anon;
REVOKE EXECUTE ON FUNCTION reset_promo_failed_batch(UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION reset_promo_failed_batch(UUID) TO service_role;


CREATE OR REPLACE FUNCTION create_promo_batch_atomic(
  p_campaign_id UUID, p_source promo_batch_source, p_requested_count INT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_campaign RECORD; v_batch_id UUID;
BEGIN
  SELECT id, status, integrity_locked INTO v_campaign FROM promo_campaigns WHERE id = p_campaign_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'error', 'Campaign not found'); END IF;
  IF v_campaign.status NOT IN ('draft', 'scheduled') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Campaign status ' || v_campaign.status || ' does not allow batch creation');
  END IF;
  IF v_campaign.integrity_locked THEN RETURN jsonb_build_object('success', false, 'error', 'Campaign integrity is locked'); END IF;
  INSERT INTO promo_code_batches (campaign_id, source, requested_count, generated_count, failed_count, status, progress_cursor)
  VALUES (p_campaign_id, p_source, p_requested_count, 0, 0, 'pending', 0) RETURNING id INTO v_batch_id;
  RETURN jsonb_build_object('success', true, 'batch_id', v_batch_id);
END;
$$;

REVOKE EXECUTE ON FUNCTION create_promo_batch_atomic(UUID, promo_batch_source, INT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION create_promo_batch_atomic(UUID, promo_batch_source, INT) FROM anon;
REVOKE EXECUTE ON FUNCTION create_promo_batch_atomic(UUID, promo_batch_source, INT) FROM authenticated;
GRANT EXECUTE ON FUNCTION create_promo_batch_atomic(UUID, promo_batch_source, INT) TO service_role;


-- ══════════════════════════════════════════════════════════════
-- PART 2: Migration 322 — Class Session Booking
-- ══════════════════════════════════════════════════════════════

-- ── 2.1 Tables (IF NOT EXISTS) ──

CREATE TABLE IF NOT EXISTS class_recurrence_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  service_id UUID NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  weekday TEXT NOT NULL CHECK (weekday IN ('mon','tue','wed','thu','fri','sat','sun')),
  start_time TIME NOT NULL,
  staff_id UUID REFERENCES business_staff(id) ON DELETE SET NULL,
  location_id UUID REFERENCES business_locations(id) ON DELETE SET NULL,
  capacity_override INTEGER,
  effective_from DATE NOT NULL DEFAULT CURRENT_DATE,
  effective_until DATE,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS class_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  service_id UUID NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  recurrence_rule_id UUID REFERENCES class_recurrence_rules(id) ON DELETE SET NULL,
  date DATE NOT NULL,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  staff_id UUID REFERENCES business_staff(id) ON DELETE SET NULL,
  location_id UUID REFERENCES business_locations(id) ON DELETE SET NULL,
  capacity INTEGER NOT NULL DEFAULT 10,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'cancelled', 'completed')),
  cancellation_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(recurrence_rule_id, date, start_time)
);

-- ── 2.2 Missing columns on class_sessions (ADD IF NOT EXISTS) ──
-- Production has class_sessions but is missing some columns and has
-- service_id as NOT NULL when it should stay NOT NULL (no change needed).
-- The columns class_id, booked_count, instructor_name, price, currency,
-- max_capacity are NOT in migration 322 canonical schema — they do not exist.
-- Production's old schema may differ in column presence/nullability.

-- ── 2.3 bookings.class_session_id FK ──
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS class_session_id UUID REFERENCES class_sessions(id) ON DELETE SET NULL;

-- ── 2.4 Indexes ──
CREATE INDEX IF NOT EXISTS idx_recurrence_rules_business ON class_recurrence_rules(business_id);
CREATE INDEX IF NOT EXISTS idx_recurrence_rules_service ON class_recurrence_rules(service_id);
CREATE INDEX IF NOT EXISTS idx_recurrence_rules_active ON class_recurrence_rules(business_id, is_active) WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_class_sessions_business ON class_sessions(business_id, date);
CREATE INDEX IF NOT EXISTS idx_class_sessions_service ON class_sessions(service_id, date);
CREATE INDEX IF NOT EXISTS idx_class_sessions_upcoming ON class_sessions(business_id, date, status) WHERE status = 'scheduled';
CREATE INDEX IF NOT EXISTS idx_class_sessions_staff ON class_sessions(staff_id, date) WHERE staff_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bookings_class_session ON bookings(class_session_id) WHERE class_session_id IS NOT NULL;

-- ── 2.5 RLS ──
ALTER TABLE class_recurrence_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE class_sessions ENABLE ROW LEVEL SECURITY;

-- RLS policies (DROP IF EXISTS + CREATE for idempotency)
-- Owner SELECT only (mutations through RPCs)
DROP POLICY IF EXISTS crr_owner_select ON class_recurrence_rules;
CREATE POLICY crr_owner_select ON class_recurrence_rules FOR SELECT
  USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
DROP POLICY IF EXISTS crr_service_all ON class_recurrence_rules;
CREATE POLICY crr_service_all ON class_recurrence_rules FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- Remove any stale write policies (from initial 322 creation)
DROP POLICY IF EXISTS crr_owner_insert ON class_recurrence_rules;
DROP POLICY IF EXISTS crr_owner_update ON class_recurrence_rules;
DROP POLICY IF EXISTS crr_owner_delete ON class_recurrence_rules;

DROP POLICY IF EXISTS cs_owner_select ON class_sessions;
CREATE POLICY cs_owner_select ON class_sessions FOR SELECT
  USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
DROP POLICY IF EXISTS cs_service_all ON class_sessions;
CREATE POLICY cs_service_all ON class_sessions FOR ALL TO service_role
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS cs_owner_insert ON class_sessions;
DROP POLICY IF EXISTS cs_owner_update ON class_sessions;
DROP POLICY IF EXISTS cs_owner_delete ON class_sessions;

-- ── 2.6 Constraints (guarded) ──
DO $$ BEGIN
  ALTER TABLE class_sessions ADD CONSTRAINT class_sessions_capacity_positive CHECK (capacity > 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE class_recurrence_rules ADD CONSTRAINT crr_capacity_positive CHECK (capacity_override IS NULL OR capacity_override > 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE class_recurrence_rules ADD CONSTRAINT crr_dates_valid CHECK (effective_until IS NULL OR effective_until >= effective_from);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── 2.7 Table grants ──
GRANT SELECT ON class_sessions TO authenticated;
GRANT SELECT ON class_recurrence_rules TO authenticated;
GRANT INSERT, UPDATE, DELETE ON class_sessions TO authenticated;
GRANT INSERT, UPDATE, DELETE ON class_recurrence_rules TO authenticated;

-- Force RLS even for table owners
ALTER TABLE class_sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE class_recurrence_rules FORCE ROW LEVEL SECURITY;


-- ── 2.8 Functions (CREATE OR REPLACE — canonical final versions from 322) ──

-- Drop old overloads to avoid ambiguity
DROP FUNCTION IF EXISTS public.book_slot_atomic(
  uuid, uuid, uuid, uuid, date, text, int, int,
  text, int, text, text, text, text, text,
  text, text, date, jsonb, uuid, int, text,
  uuid, uuid, integer, integer, uuid
);
DROP FUNCTION IF EXISTS book_manual_slot_atomic(uuid,uuid,uuid,uuid,date,text,int,int,text,text,text,text,int,text,integer,integer,uuid);
DROP FUNCTION IF EXISTS reschedule_booking_atomic(uuid, uuid, date, text, integer);


-- generate_class_sessions (final version with fresh-read under lock)
CREATE OR REPLACE FUNCTION generate_class_sessions(p_service_id UUID, p_days_ahead INTEGER DEFAULT 28)
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_rule_id UUID; v_rule RECORD;
  v_date DATE; v_end_date DATE; v_dow INTEGER; v_target_dow INTEGER;
  v_svc RECORD; v_capacity INTEGER; v_end_time TIME;
  v_generated INTEGER := 0; v_lock_key bigint;
BEGIN
  SELECT id, business_id, duration_minutes, max_capacity, is_class, requires_staff
  INTO v_svc FROM services WHERE id = p_service_id;
  IF NOT FOUND OR NOT COALESCE(v_svc.is_class, false) THEN RETURN 0; END IF;
  v_end_date := CURRENT_DATE + p_days_ahead;
  FOR v_rule_id IN
    SELECT id FROM class_recurrence_rules
    WHERE service_id = p_service_id AND is_active = true
      AND effective_from <= v_end_date
      AND (effective_until IS NULL OR effective_until >= CURRENT_DATE)
    ORDER BY id
  LOOP
    v_lock_key := abs(hashtext('recurrence_rule:' || v_rule_id::text));
    PERFORM pg_advisory_xact_lock(v_lock_key);
    SELECT * INTO v_rule FROM class_recurrence_rules
    WHERE id = v_rule_id AND service_id = p_service_id AND is_active = true
      AND effective_from <= v_end_date
      AND (effective_until IS NULL OR effective_until >= CURRENT_DATE);
    IF NOT FOUND THEN CONTINUE; END IF;
    IF COALESCE(v_svc.requires_staff, false) AND v_rule.staff_id IS NULL THEN CONTINUE; END IF;
    v_target_dow := CASE v_rule.weekday WHEN 'sun' THEN 0 WHEN 'mon' THEN 1 WHEN 'tue' THEN 2
      WHEN 'wed' THEN 3 WHEN 'thu' THEN 4 WHEN 'fri' THEN 5 WHEN 'sat' THEN 6 END;
    v_capacity := COALESCE(v_rule.capacity_override, v_svc.max_capacity, 10);
    v_end_time := v_rule.start_time + make_interval(mins => COALESCE(v_svc.duration_minutes, 60));
    v_date := GREATEST(v_rule.effective_from, CURRENT_DATE);
    v_dow := EXTRACT(DOW FROM v_date)::INTEGER;
    IF v_dow != v_target_dow THEN v_date := v_date + ((v_target_dow - v_dow + 7) % 7); END IF;
    WHILE v_date <= v_end_date AND (v_rule.effective_until IS NULL OR v_date <= v_rule.effective_until) LOOP
      IF v_rule.staff_id IS NOT NULL THEN
        DECLARE v_staff_ok boolean;
        BEGIN
          SELECT csa.allowed INTO v_staff_ok FROM check_staff_availability(
            v_rule.staff_id, v_svc.business_id, v_date, v_rule.start_time::text,
            COALESCE(v_svc.duration_minutes, 60)) csa;
          IF v_staff_ok IS NOT TRUE THEN v_date := v_date + 7; CONTINUE; END IF;
        END;
      END IF;
      INSERT INTO class_sessions (business_id, service_id, recurrence_rule_id, date, start_time, end_time, staff_id, location_id, capacity, status)
      VALUES (v_svc.business_id, p_service_id, v_rule.id, v_date, v_rule.start_time, v_end_time, v_rule.staff_id, v_rule.location_id, v_capacity, 'scheduled')
      ON CONFLICT (recurrence_rule_id, date, start_time) DO NOTHING;
      IF FOUND THEN v_generated := v_generated + 1; END IF;
      v_date := v_date + 7;
    END LOOP;
  END LOOP;
  RETURN v_generated;
END;
$$;

REVOKE EXECUTE ON FUNCTION generate_class_sessions(UUID, INTEGER) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION generate_class_sessions(UUID, INTEGER) FROM anon;
REVOKE EXECUTE ON FUNCTION generate_class_sessions(UUID, INTEGER) FROM authenticated;
GRANT EXECUTE ON FUNCTION generate_class_sessions(UUID, INTEGER) TO service_role;


-- get_upcoming_class_sessions
CREATE OR REPLACE FUNCTION get_upcoming_class_sessions(
  p_service_id UUID, p_limit INTEGER DEFAULT 10
) RETURNS TABLE(
  session_id UUID, session_date DATE, start_time TIME, end_time TIME,
  capacity INTEGER, spots_taken BIGINT, staff_name TEXT, location_name TEXT, status TEXT
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT cs.id AS session_id, cs.date AS session_date, cs.start_time, cs.end_time, cs.capacity,
    COALESCE((SELECT SUM(b.party_size) FROM bookings b WHERE b.class_session_id = cs.id AND b.status IN ('confirmed', 'pending', 'in_progress')), 0) AS spots_taken,
    bs.name AS staff_name, bl.name AS location_name, cs.status
  FROM class_sessions cs
  LEFT JOIN business_staff bs ON bs.id = cs.staff_id
  LEFT JOIN business_locations bl ON bl.id = cs.location_id
  WHERE cs.service_id = p_service_id AND cs.status = 'scheduled' AND cs.date >= CURRENT_DATE
  ORDER BY cs.date, cs.start_time LIMIT p_limit;
$$;

REVOKE EXECUTE ON FUNCTION get_upcoming_class_sessions(UUID, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_upcoming_class_sessions(UUID, INTEGER) TO anon;
GRANT EXECUTE ON FUNCTION get_upcoming_class_sessions(UUID, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION get_upcoming_class_sessions(UUID, INTEGER) TO service_role;


-- book_slot_atomic (28-arg, final canonical version with class XOR authority)
CREATE OR REPLACE FUNCTION public.book_slot_atomic(
  p_business_id uuid, p_user_id uuid, p_service_id uuid, p_staff_id uuid,
  p_date date, p_time text, p_party_size int, p_max_capacity int,
  p_flow_type text, p_deposit_amount int, p_deposit_status text, p_status text,
  p_guest_name text, p_guest_phone text, p_guest_email text,
  p_special_requests text, p_venue_address text, p_end_date date,
  p_addons_snapshot jsonb, p_promo_code_id uuid, p_total_amount int, p_staff_name text,
  p_location_id uuid DEFAULT NULL, p_appointment_id uuid DEFAULT NULL,
  p_buffer_minutes integer DEFAULT 0, p_duration integer DEFAULT 30,
  p_bot_session_id uuid DEFAULT NULL, p_class_session_id uuid DEFAULT NULL
) RETURNS TABLE(booking_id uuid, reference_code text, slot_available boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count int; v_buffer_count int; v_booking_id uuid; v_ref text;
  v_lock_key bigint; v_sched_allowed boolean; v_sched_reason text;
  v_requires_staff boolean; v_cs record; v_occupied bigint;
  v_cs_duration integer; v_canonical_staff_name text;
BEGIN
  IF p_bot_session_id IS NOT NULL THEN
    SELECT id, bookings.reference_code INTO v_booking_id, v_ref
    FROM bookings WHERE bot_session_id = p_bot_session_id AND status IN ('pending', 'confirmed') LIMIT 1;
    IF FOUND THEN RETURN QUERY SELECT v_booking_id, v_ref, true; RETURN; END IF;
  END IF;
  IF p_class_session_id IS NOT NULL THEN
    IF p_service_id IS NULL THEN RETURN QUERY SELECT NULL::uuid, NULL::text, false; RETURN; END IF;
    IF p_appointment_id IS NOT NULL THEN RETURN QUERY SELECT NULL::uuid, NULL::text, false; RETURN; END IF;
    v_lock_key := abs(hashtext('class_session:' || p_class_session_id::text));
    PERFORM pg_advisory_xact_lock(v_lock_key);
    SELECT cs.id, cs.business_id, cs.service_id, cs.date, cs.start_time,
           cs.capacity, cs.status, cs.staff_id, cs.location_id,
           s.is_class, s.requires_staff, s.duration_minutes, s.is_active AS svc_active
    INTO v_cs FROM class_sessions cs JOIN services s ON s.id = cs.service_id
    WHERE cs.id = p_class_session_id;
    IF NOT FOUND THEN RETURN QUERY SELECT NULL::uuid, NULL::text, false; RETURN; END IF;
    IF v_cs.business_id != p_business_id THEN RETURN QUERY SELECT NULL::uuid, NULL::text, false; RETURN; END IF;
    IF v_cs.service_id != p_service_id THEN RETURN QUERY SELECT NULL::uuid, NULL::text, false; RETURN; END IF;
    IF NOT COALESCE(v_cs.is_class, false) THEN RETURN QUERY SELECT NULL::uuid, NULL::text, false; RETURN; END IF;
    IF NOT COALESCE(v_cs.svc_active, false) THEN RETURN QUERY SELECT NULL::uuid, NULL::text, false; RETURN; END IF;
    IF v_cs.status != 'scheduled' THEN RETURN QUERY SELECT NULL::uuid, NULL::text, false; RETURN; END IF;
    v_cs_duration := COALESCE(v_cs.duration_minutes, 60);
    IF v_cs.staff_id IS NOT NULL THEN
      IF p_staff_id IS NOT NULL AND p_staff_id != v_cs.staff_id THEN RETURN QUERY SELECT NULL::uuid, NULL::text, false; RETURN; END IF;
      SELECT csa.allowed INTO v_sched_allowed FROM check_staff_availability(v_cs.staff_id, p_business_id, v_cs.date, v_cs.start_time::text, v_cs_duration) csa;
      IF v_sched_allowed IS NOT TRUE THEN RETURN QUERY SELECT NULL::uuid, NULL::text, false; RETURN; END IF;
      SELECT bs.name INTO v_canonical_staff_name FROM business_staff bs WHERE bs.id = v_cs.staff_id;
    ELSE
      IF COALESCE(v_cs.requires_staff, false) THEN RETURN QUERY SELECT NULL::uuid, NULL::text, false; RETURN; END IF;
      v_canonical_staff_name := NULL;
    END IF;
    SELECT COALESCE(SUM(b.party_size), 0) INTO v_occupied FROM bookings b WHERE b.class_session_id = p_class_session_id AND b.status IN ('confirmed', 'pending', 'in_progress');
    IF v_occupied + p_party_size > v_cs.capacity THEN RETURN QUERY SELECT NULL::uuid, NULL::text, false; RETURN; END IF;
    INSERT INTO bookings (business_id, user_id, service_id, appointment_id, staff_id, staff_name, date, time, party_size, flow_type, channel, deposit_amount, deposit_status, status, guest_name, guest_phone, guest_email, special_requests, venue_address, end_date, addons_snapshot, promo_code_id, total_amount, quantity, location_id, bot_session_id, class_session_id)
    VALUES (p_business_id, p_user_id, v_cs.service_id, NULL, v_cs.staff_id, v_canonical_staff_name, v_cs.date, v_cs.start_time, p_party_size, p_flow_type::flow_type, 'whatsapp'::booking_channel, p_deposit_amount, p_deposit_status::deposit_status, p_status::reservation_status, p_guest_name, p_guest_phone, p_guest_email, p_special_requests, p_venue_address, p_end_date, p_addons_snapshot, p_promo_code_id, p_total_amount, p_party_size, v_cs.location_id, p_bot_session_id, p_class_session_id)
    RETURNING id, bookings.reference_code INTO v_booking_id, v_ref;
    RETURN QUERY SELECT v_booking_id, v_ref, true; RETURN;
  END IF;
  IF p_service_id IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM services WHERE id = p_service_id AND is_class = true) THEN RETURN QUERY SELECT NULL::uuid, NULL::text, false; RETURN; END IF;
  END IF;
  IF p_appointment_id IS NOT NULL THEN
    SELECT cas.allowed INTO v_sched_allowed FROM check_appointment_schedule(p_appointment_id, p_business_id, p_date, p_time) cas;
    IF v_sched_allowed IS NOT TRUE THEN RETURN QUERY SELECT NULL::uuid, NULL::text, false; RETURN; END IF;
  END IF;
  IF p_staff_id IS NOT NULL THEN
    SELECT csa.allowed INTO v_sched_allowed FROM check_staff_availability(p_staff_id, p_business_id, p_date, p_time, COALESCE(p_duration, 30)) csa;
    IF v_sched_allowed IS NOT TRUE THEN RETURN QUERY SELECT NULL::uuid, NULL::text, false; RETURN; END IF;
  END IF;
  IF p_staff_id IS NULL THEN
    v_requires_staff := false;
    IF p_appointment_id IS NOT NULL THEN SELECT COALESCE(a.requires_staff, false) INTO v_requires_staff FROM appointments a WHERE a.id = p_appointment_id;
    ELSIF p_service_id IS NOT NULL THEN SELECT COALESCE(s.requires_staff, false) INTO v_requires_staff FROM services s WHERE s.id = p_service_id;
    END IF;
    IF v_requires_staff THEN RETURN QUERY SELECT NULL::uuid, NULL::text, false; RETURN; END IF;
  END IF;
  v_lock_key := abs(hashtext(p_business_id::text || '|' || p_date::text || '|' || p_time::time::text));
  PERFORM pg_advisory_xact_lock(v_lock_key);
  SELECT COUNT(*) INTO v_count FROM bookings WHERE business_id = p_business_id AND date = p_date AND time = p_time::time AND status IN ('confirmed', 'pending', 'in_progress') AND (p_staff_id IS NULL OR staff_id = p_staff_id);
  IF v_count >= p_max_capacity THEN RETURN QUERY SELECT NULL::uuid, NULL::text, false; RETURN; END IF;
  IF p_buffer_minutes > 0 THEN
    SELECT COUNT(*) INTO v_buffer_count FROM bookings WHERE business_id = p_business_id AND date = p_date AND status IN ('pending', 'confirmed', 'in_progress') AND (p_staff_id IS NULL OR staff_id = p_staff_id) AND time != p_time::time AND (p_time::time < (time + make_interval(mins => COALESCE(p_duration, 30) + p_buffer_minutes)) AND (p_time::time + make_interval(mins => COALESCE(p_duration, 30))) > (time - make_interval(mins => p_buffer_minutes)));
    IF v_buffer_count > 0 THEN RETURN QUERY SELECT NULL::uuid, NULL::text, false; RETURN; END IF;
  END IF;
  INSERT INTO bookings (business_id, user_id, service_id, appointment_id, staff_id, staff_name, date, time, party_size, flow_type, channel, deposit_amount, deposit_status, status, guest_name, guest_phone, guest_email, special_requests, venue_address, end_date, addons_snapshot, promo_code_id, total_amount, quantity, location_id, bot_session_id)
  VALUES (p_business_id, p_user_id, CASE WHEN p_appointment_id IS NOT NULL THEN NULL ELSE p_service_id END, p_appointment_id, p_staff_id, p_staff_name, p_date, p_time::time, p_party_size, p_flow_type::flow_type, 'whatsapp'::booking_channel, p_deposit_amount, p_deposit_status::deposit_status, p_status::reservation_status, p_guest_name, p_guest_phone, p_guest_email, p_special_requests, p_venue_address, p_end_date, p_addons_snapshot, p_promo_code_id, p_total_amount, p_party_size, p_location_id, p_bot_session_id)
  RETURNING id, bookings.reference_code INTO v_booking_id, v_ref;
  RETURN QUERY SELECT v_booking_id, v_ref, true;
END;
$$;

REVOKE ALL ON FUNCTION public.book_slot_atomic(uuid,uuid,uuid,uuid,date,text,int,int,text,int,text,text,text,text,text,text,text,date,jsonb,uuid,int,text,uuid,uuid,integer,integer,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.book_slot_atomic(uuid,uuid,uuid,uuid,date,text,int,int,text,int,text,text,text,text,text,text,text,date,jsonb,uuid,int,text,uuid,uuid,integer,integer,uuid,uuid) TO service_role;


-- book_manual_slot_atomic (18-arg)
CREATE OR REPLACE FUNCTION book_manual_slot_atomic(
  p_business_id uuid, p_user_id uuid, p_service_id uuid, p_staff_id uuid,
  p_date date, p_time text, p_party_size int, p_max_capacity int,
  p_guest_name text, p_guest_phone text, p_guest_email text, p_notes text,
  p_total_amount int, p_staff_name text,
  p_buffer_minutes integer DEFAULT 0, p_duration integer DEFAULT 30,
  p_appointment_id uuid DEFAULT NULL, p_class_session_id uuid DEFAULT NULL
) RETURNS TABLE(booking_id uuid, reference_code text, slot_available boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_booking_id uuid; v_ref text; v_available boolean; v_updated_rows int;
BEGIN
  SELECT bsa.booking_id, bsa.reference_code, bsa.slot_available INTO v_booking_id, v_ref, v_available
  FROM book_slot_atomic(p_business_id, p_user_id, p_service_id, p_staff_id, p_date, p_time, p_party_size, p_max_capacity,
    'scheduling', 0, 'none', 'confirmed', p_guest_name, p_guest_phone, p_guest_email, NULL, NULL, NULL, NULL, NULL,
    p_total_amount, p_staff_name, NULL, p_appointment_id, p_buffer_minutes, p_duration, NULL, p_class_session_id) bsa;
  IF v_available IS NOT TRUE THEN RETURN QUERY SELECT NULL::uuid, NULL::text, false; RETURN; END IF;
  IF v_booking_id IS NULL THEN RAISE EXCEPTION 'book_manual_slot_atomic: book_slot_atomic returned slot_available=true but booking_id is NULL' USING ERRCODE = 'data_exception'; END IF;
  UPDATE bookings SET channel = 'dashboard'::booking_channel, confirmed_at = NOW(), notes = p_notes WHERE id = v_booking_id;
  GET DIAGNOSTICS v_updated_rows = ROW_COUNT;
  IF v_updated_rows <> 1 THEN RAISE EXCEPTION 'book_manual_slot_atomic: expected 1 row updated, got %', v_updated_rows USING ERRCODE = 'data_exception'; END IF;
  RETURN QUERY SELECT v_booking_id, v_ref, true;
END;
$$;

REVOKE EXECUTE ON FUNCTION book_manual_slot_atomic(uuid,uuid,uuid,uuid,date,text,int,int,text,text,text,text,int,text,integer,integer,uuid,uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION book_manual_slot_atomic(uuid,uuid,uuid,uuid,date,text,int,int,text,text,text,text,int,text,integer,integer,uuid,uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION book_manual_slot_atomic(uuid,uuid,uuid,uuid,date,text,int,int,text,text,text,text,int,text,integer,integer,uuid,uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION book_manual_slot_atomic(uuid,uuid,uuid,uuid,date,text,int,int,text,text,text,text,int,text,integer,integer,uuid,uuid) TO service_role;


-- reschedule_booking_atomic (6-arg, final canonical version)
CREATE OR REPLACE FUNCTION reschedule_booking_atomic(
  p_booking_id uuid, p_business_id uuid, p_new_date date, p_new_time text,
  p_new_party_size integer DEFAULT NULL, p_target_class_session_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_booking record; v_lock_key bigint; v_count integer; v_max_capacity integer;
  v_buffer_minutes integer; v_duration integer; v_buffer_count integer;
  v_sched_allowed boolean; v_sched_reason text; v_target_cs record;
  v_occupied bigint; v_party integer;
BEGIN
  SELECT id, business_id, service_id, appointment_id, staff_id, date, time, party_size, status, location_id, class_session_id
  INTO v_booking FROM bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('rescheduled', false, 'reason', 'booking_not_found'); END IF;
  IF v_booking.business_id != p_business_id THEN RETURN jsonb_build_object('rescheduled', false, 'reason', 'business_mismatch'); END IF;
  IF v_booking.status NOT IN ('pending', 'confirmed') THEN RETURN jsonb_build_object('rescheduled', false, 'reason', 'not_reschedulable', 'status', v_booking.status); END IF;
  v_party := COALESCE(p_new_party_size, v_booking.party_size);
  IF v_booking.class_session_id IS NOT NULL THEN
    IF p_target_class_session_id IS NULL THEN RETURN jsonb_build_object('rescheduled', false, 'reason', 'target_session_required'); END IF;
    IF v_booking.class_session_id = p_target_class_session_id THEN RETURN jsonb_build_object('rescheduled', true, 'already_at_target', true); END IF;
    v_lock_key := abs(hashtext('class_session:' || p_target_class_session_id::text));
    PERFORM pg_advisory_xact_lock(v_lock_key);
    SELECT cs.id, cs.business_id, cs.service_id, cs.date, cs.start_time, cs.end_time, cs.capacity, cs.status, cs.staff_id, cs.location_id,
           s.is_class, s.requires_staff, s.duration_minutes
    INTO v_target_cs FROM class_sessions cs JOIN services s ON s.id = cs.service_id WHERE cs.id = p_target_class_session_id;
    IF NOT FOUND THEN RETURN jsonb_build_object('rescheduled', false, 'reason', 'target_session_not_found'); END IF;
    IF v_target_cs.business_id != p_business_id THEN RETURN jsonb_build_object('rescheduled', false, 'reason', 'target_session_business_mismatch'); END IF;
    IF v_target_cs.service_id != v_booking.service_id THEN RETURN jsonb_build_object('rescheduled', false, 'reason', 'cross_class_not_allowed'); END IF;
    IF NOT COALESCE(v_target_cs.is_class, false) THEN RETURN jsonb_build_object('rescheduled', false, 'reason', 'target_not_class'); END IF;
    IF v_target_cs.status != 'scheduled' THEN RETURN jsonb_build_object('rescheduled', false, 'reason', 'target_session_not_bookable'); END IF;
    IF v_target_cs.staff_id IS NOT NULL THEN
      SELECT csa.allowed INTO v_sched_allowed FROM check_staff_availability(v_target_cs.staff_id, p_business_id, v_target_cs.date, v_target_cs.start_time::text, COALESCE(v_target_cs.duration_minutes, 60)) csa;
      IF v_sched_allowed IS NOT TRUE THEN RETURN jsonb_build_object('rescheduled', false, 'reason', 'target_staff_unavailable'); END IF;
    ELSIF COALESCE(v_target_cs.requires_staff, false) THEN
      RETURN jsonb_build_object('rescheduled', false, 'reason', 'target_requires_staff');
    END IF;
    SELECT COALESCE(SUM(b.party_size), 0) INTO v_occupied FROM bookings b WHERE b.class_session_id = p_target_class_session_id AND b.status IN ('confirmed', 'pending', 'in_progress') AND b.id != p_booking_id;
    IF v_occupied + v_party > v_target_cs.capacity THEN RETURN jsonb_build_object('rescheduled', false, 'reason', 'target_session_full'); END IF;
    UPDATE bookings SET class_session_id = p_target_class_session_id, date = v_target_cs.date, time = v_target_cs.start_time, party_size = v_party,
      staff_id = v_target_cs.staff_id, staff_name = (SELECT bs.name FROM business_staff bs WHERE bs.id = v_target_cs.staff_id),
      location_id = v_target_cs.location_id,
      original_date = CASE WHEN original_date IS NULL THEN v_booking.date ELSE original_date END,
      original_time = CASE WHEN original_time IS NULL THEN v_booking.time::text ELSE original_time END, rescheduled_at = NOW()
    WHERE id = p_booking_id;
    RETURN jsonb_build_object('rescheduled', true, 'old_session_id', v_booking.class_session_id, 'new_session_id', p_target_class_session_id, 'old_date', v_booking.date, 'new_date', v_target_cs.date);
  END IF;
  IF v_booking.service_id IS NOT NULL THEN
    SELECT COALESCE(max_capacity, 1), COALESCE(buffer_minutes, 0), COALESCE(duration_minutes, 30) INTO v_max_capacity, v_buffer_minutes, v_duration FROM services WHERE id = v_booking.service_id;
  ELSIF v_booking.appointment_id IS NOT NULL THEN
    SELECT COALESCE(max_capacity, 1), COALESCE(buffer_minutes, 0), COALESCE(duration_minutes, 30) INTO v_max_capacity, v_buffer_minutes, v_duration FROM appointments WHERE id = v_booking.appointment_id;
    SELECT cas.allowed, cas.reason INTO v_sched_allowed, v_sched_reason FROM check_appointment_schedule(v_booking.appointment_id, p_business_id, p_new_date, p_new_time) cas;
    IF v_sched_allowed IS NOT TRUE THEN RETURN jsonb_build_object('rescheduled', false, 'reason', COALESCE(v_sched_reason, 'appointment_schedule_conflict')); END IF;
  ELSE v_max_capacity := 1; v_buffer_minutes := 0; v_duration := 30;
  END IF;
  IF v_max_capacity IS NULL THEN v_max_capacity := 1; END IF;
  IF v_buffer_minutes IS NULL THEN v_buffer_minutes := 0; END IF;
  IF v_duration IS NULL THEN v_duration := 30; END IF;
  IF v_booking.staff_id IS NOT NULL THEN
    SELECT csa.allowed, csa.reason INTO v_sched_allowed, v_sched_reason FROM check_staff_availability(v_booking.staff_id, p_business_id, p_new_date, p_new_time, v_duration) csa;
    IF v_sched_allowed IS NOT TRUE THEN RETURN jsonb_build_object('rescheduled', false, 'reason', COALESCE(v_sched_reason, 'staff_unavailable')); END IF;
  ELSE
    DECLARE v_req_staff boolean := false;
    BEGIN
      IF v_booking.service_id IS NOT NULL THEN SELECT COALESCE(s.requires_staff, false) INTO v_req_staff FROM services s WHERE s.id = v_booking.service_id;
      ELSIF v_booking.appointment_id IS NOT NULL THEN SELECT COALESCE(a.requires_staff, false) INTO v_req_staff FROM appointments a WHERE a.id = v_booking.appointment_id;
      END IF;
      IF v_req_staff THEN RETURN jsonb_build_object('rescheduled', false, 'reason', 'staff_required'); END IF;
    END;
  END IF;
  v_lock_key := abs(hashtext(p_business_id::text || '|' || p_new_date::text || '|' || p_new_time::time::text));
  PERFORM pg_advisory_xact_lock(v_lock_key);
  IF v_booking.date = p_new_date AND v_booking.time = p_new_time::time THEN RETURN jsonb_build_object('rescheduled', true, 'already_at_target', true); END IF;
  SELECT COUNT(*) INTO v_count FROM bookings WHERE business_id = p_business_id AND date = p_new_date AND time = p_new_time::time AND status IN ('confirmed', 'pending', 'in_progress') AND id != p_booking_id AND (v_booking.staff_id IS NULL OR staff_id = v_booking.staff_id);
  IF v_count >= v_max_capacity THEN RETURN jsonb_build_object('rescheduled', false, 'reason', 'slot_full'); END IF;
  IF v_buffer_minutes > 0 THEN
    SELECT COUNT(*) INTO v_buffer_count FROM bookings WHERE business_id = p_business_id AND date = p_new_date AND status IN ('pending', 'confirmed', 'in_progress') AND id != p_booking_id AND (v_booking.staff_id IS NULL OR staff_id = v_booking.staff_id) AND time != p_new_time::time AND (p_new_time::time < (time + make_interval(mins => v_duration + v_buffer_minutes)) AND (p_new_time::time + make_interval(mins => v_duration)) > (time - make_interval(mins => v_buffer_minutes)));
    IF v_buffer_count > 0 THEN RETURN jsonb_build_object('rescheduled', false, 'reason', 'buffer_conflict'); END IF;
  END IF;
  UPDATE bookings SET date = p_new_date, time = p_new_time::time, party_size = COALESCE(p_new_party_size, party_size),
    original_date = CASE WHEN original_date IS NULL THEN v_booking.date ELSE original_date END,
    original_time = CASE WHEN original_time IS NULL THEN v_booking.time::text ELSE original_time END, rescheduled_at = NOW()
  WHERE id = p_booking_id;
  RETURN jsonb_build_object('rescheduled', true, 'old_date', v_booking.date, 'old_time', v_booking.time, 'new_date', p_new_date, 'new_time', p_new_time);
END;
$$;

REVOKE EXECUTE ON FUNCTION reschedule_booking_atomic(uuid,uuid,date,text,integer,uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION reschedule_booking_atomic(uuid,uuid,date,text,integer,uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION reschedule_booking_atomic(uuid,uuid,date,text,integer,uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION reschedule_booking_atomic(uuid,uuid,date,text,integer,uuid) TO service_role;


-- create_class_atomic (final version with delegation to create_class_recurrence_atomic)
CREATE OR REPLACE FUNCTION create_class_atomic(
  p_business_id uuid, p_name text,
  p_price integer DEFAULT 0, p_duration_minutes integer DEFAULT 60,
  p_max_capacity integer DEFAULT 10,
  p_weekday text DEFAULT NULL, p_start_time time DEFAULT NULL,
  p_staff_id uuid DEFAULT NULL, p_location_id uuid DEFAULT NULL,
  p_capacity_override integer DEFAULT NULL, p_description text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_service_id uuid; v_rule_result jsonb;
BEGIN
  IF p_duration_minutes IS NOT NULL AND p_duration_minutes < 1 THEN RETURN jsonb_build_object('success', false, 'reason', 'invalid_duration'); END IF;
  IF p_max_capacity IS NOT NULL AND p_max_capacity < 1 THEN RETURN jsonb_build_object('success', false, 'reason', 'invalid_capacity'); END IF;
  IF p_staff_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM business_staff WHERE id = p_staff_id AND business_id = p_business_id AND is_active = true) THEN RETURN jsonb_build_object('success', false, 'reason', 'invalid_staff'); END IF;
  IF p_location_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM business_locations WHERE id = p_location_id AND business_id = p_business_id AND is_active = true) THEN RETURN jsonb_build_object('success', false, 'reason', 'invalid_location'); END IF;
  INSERT INTO services (business_id, name, description, price, duration_minutes, max_capacity, is_class, is_active)
  VALUES (p_business_id, p_name, p_description, p_price, p_duration_minutes, p_max_capacity, true, true) RETURNING id INTO v_service_id;
  IF p_weekday IS NOT NULL AND p_start_time IS NOT NULL THEN
    SELECT create_class_recurrence_atomic(p_business_id, v_service_id, p_weekday, p_start_time, p_staff_id, p_location_id, p_capacity_override) INTO v_rule_result;
    IF NOT (v_rule_result->>'success')::boolean THEN RAISE EXCEPTION 'Recurrence creation failed: %', v_rule_result->>'reason'; END IF;
  END IF;
  RETURN jsonb_build_object('success', true, 'service_id', v_service_id,
    'rule_id', CASE WHEN v_rule_result IS NOT NULL THEN v_rule_result->>'rule_id' END,
    'sessions_generated', COALESCE((v_rule_result->>'sessions_generated')::int, 0));
END;
$$;

REVOKE EXECUTE ON FUNCTION create_class_atomic FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION create_class_atomic FROM anon;
REVOKE EXECUTE ON FUNCTION create_class_atomic FROM authenticated;
GRANT EXECUTE ON FUNCTION create_class_atomic TO service_role;


-- create_class_recurrence_atomic
CREATE OR REPLACE FUNCTION create_class_recurrence_atomic(
  p_business_id uuid, p_service_id uuid, p_weekday text, p_start_time time,
  p_staff_id uuid DEFAULT NULL, p_location_id uuid DEFAULT NULL,
  p_capacity_override integer DEFAULT NULL,
  p_effective_from date DEFAULT NULL, p_effective_until date DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_svc record; v_rule_id uuid; v_generated integer; v_lock_key bigint;
BEGIN
  SELECT id, is_class, is_active, requires_staff INTO v_svc FROM services WHERE id = p_service_id AND business_id = p_business_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'reason', 'service_not_found'); END IF;
  IF NOT COALESCE(v_svc.is_class, false) THEN RETURN jsonb_build_object('success', false, 'reason', 'not_a_class'); END IF;
  IF NOT COALESCE(v_svc.is_active, false) THEN RETURN jsonb_build_object('success', false, 'reason', 'service_inactive'); END IF;
  IF p_weekday NOT IN ('mon','tue','wed','thu','fri','sat','sun') THEN RETURN jsonb_build_object('success', false, 'reason', 'invalid_weekday'); END IF;
  IF p_staff_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM business_staff WHERE id = p_staff_id AND business_id = p_business_id AND is_active = true) THEN RETURN jsonb_build_object('success', false, 'reason', 'invalid_staff'); END IF;
  ELSIF COALESCE(v_svc.requires_staff, false) THEN RETURN jsonb_build_object('success', false, 'reason', 'requires_staff_no_instructor'); END IF;
  IF p_location_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM business_locations WHERE id = p_location_id AND business_id = p_business_id AND is_active = true) THEN
    RETURN jsonb_build_object('success', false, 'reason', 'invalid_location');
  END IF;
  IF p_capacity_override IS NOT NULL AND p_capacity_override < 1 THEN RETURN jsonb_build_object('success', false, 'reason', 'invalid_capacity'); END IF;
  IF p_effective_until IS NOT NULL AND p_effective_from IS NOT NULL AND p_effective_until < p_effective_from THEN RETURN jsonb_build_object('success', false, 'reason', 'invalid_dates'); END IF;
  INSERT INTO class_recurrence_rules (business_id, service_id, weekday, start_time, staff_id, location_id, capacity_override, effective_from, effective_until)
  VALUES (p_business_id, p_service_id, p_weekday, p_start_time, p_staff_id, p_location_id, p_capacity_override, COALESCE(p_effective_from, CURRENT_DATE), p_effective_until)
  RETURNING id INTO v_rule_id;
  SELECT generate_class_sessions(p_service_id, 28) INTO v_generated;
  RETURN jsonb_build_object('success', true, 'rule_id', v_rule_id, 'sessions_generated', COALESCE(v_generated, 0));
END;
$$;

REVOKE EXECUTE ON FUNCTION create_class_recurrence_atomic FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION create_class_recurrence_atomic FROM anon;
REVOKE EXECUTE ON FUNCTION create_class_recurrence_atomic FROM authenticated;
GRANT EXECUTE ON FUNCTION create_class_recurrence_atomic TO service_role;


-- update_class_session_atomic (final version)
CREATE OR REPLACE FUNCTION update_class_session_atomic(
  p_session_id uuid, p_business_id uuid,
  p_new_status text DEFAULT NULL, p_cancellation_reason text DEFAULT NULL,
  p_new_capacity integer DEFAULT NULL, p_new_staff_id uuid DEFAULT NULL,
  p_clear_staff boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_session record; v_lock_key bigint; v_occupied bigint;
  v_duration integer; v_sched_allowed boolean;
  v_active_attendee_count integer; v_final_capacity integer; v_final_staff_id uuid;
BEGIN
  v_lock_key := abs(hashtext('class_session:' || p_session_id::text));
  PERFORM pg_advisory_xact_lock(v_lock_key);
  SELECT cs.*, s.duration_minutes, s.requires_staff INTO v_session FROM class_sessions cs JOIN services s ON s.id = cs.service_id WHERE cs.id = p_session_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'reason', 'session_not_found'); END IF;
  IF v_session.business_id != p_business_id THEN RETURN jsonb_build_object('success', false, 'reason', 'business_mismatch'); END IF;
  SELECT count(*), COALESCE(SUM(b.party_size), 0) INTO v_active_attendee_count, v_occupied FROM bookings b WHERE b.class_session_id = p_session_id AND b.status IN ('confirmed', 'pending', 'in_progress');
  IF p_new_status = 'cancelled' THEN
    IF v_session.status = 'completed' THEN RETURN jsonb_build_object('success', false, 'reason', 'cannot_cancel_completed'); END IF;
    IF v_active_attendee_count > 0 THEN RETURN jsonb_build_object('success', false, 'reason', 'active_attendees_exist', 'active_attendee_count', v_active_attendee_count); END IF;
  END IF;
  v_final_capacity := v_session.capacity;
  IF p_new_capacity IS NOT NULL THEN
    IF p_new_capacity < 1 THEN RETURN jsonb_build_object('success', false, 'reason', 'invalid_capacity'); END IF;
    IF p_new_capacity < v_occupied THEN RETURN jsonb_build_object('success', false, 'reason', 'capacity_below_occupancy', 'occupancy', v_occupied); END IF;
    v_final_capacity := p_new_capacity;
  END IF;
  v_final_staff_id := v_session.staff_id;
  IF p_new_staff_id IS NOT NULL OR p_clear_staff THEN
    IF p_clear_staff AND COALESCE(v_session.requires_staff, false) THEN RETURN jsonb_build_object('success', false, 'reason', 'requires_staff_cannot_clear'); END IF;
    IF v_active_attendee_count > 0 THEN RETURN jsonb_build_object('success', false, 'reason', 'attendees_exist_cannot_change_instructor', 'active_attendee_count', v_active_attendee_count); END IF;
    IF p_new_staff_id IS NOT NULL THEN
      IF NOT EXISTS (SELECT 1 FROM business_staff WHERE id = p_new_staff_id AND business_id = p_business_id AND is_active = true) THEN RETURN jsonb_build_object('success', false, 'reason', 'invalid_staff'); END IF;
      v_duration := COALESCE(v_session.duration_minutes, 60);
      SELECT csa.allowed INTO v_sched_allowed FROM check_staff_availability(p_new_staff_id, p_business_id, v_session.date, v_session.start_time::text, v_duration) csa;
      IF v_sched_allowed IS NOT TRUE THEN RETURN jsonb_build_object('success', false, 'reason', 'staff_unavailable'); END IF;
      v_final_staff_id := p_new_staff_id;
    ELSE v_final_staff_id := NULL;
    END IF;
  END IF;
  IF p_new_status = 'cancelled' THEN
    UPDATE class_sessions SET status = 'cancelled', cancellation_reason = p_cancellation_reason WHERE id = p_session_id;
    RETURN jsonb_build_object('success', true, 'action', 'cancelled');
  END IF;
  UPDATE class_sessions SET capacity = v_final_capacity, staff_id = v_final_staff_id WHERE id = p_session_id;
  RETURN jsonb_build_object('success', true);
END;
$$;

REVOKE EXECUTE ON FUNCTION update_class_session_atomic FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION update_class_session_atomic FROM anon;
REVOKE EXECUTE ON FUNCTION update_class_session_atomic FROM authenticated;
GRANT EXECUTE ON FUNCTION update_class_session_atomic TO service_role;


-- reconcile_class_recurrence (final version with fresh-read and booking history protection)
CREATE OR REPLACE FUNCTION reconcile_class_recurrence(
  p_rule_id uuid, p_business_id uuid, p_action text,
  p_weekday text DEFAULT NULL, p_start_time time DEFAULT NULL,
  p_staff_id uuid DEFAULT NULL, p_location_id uuid DEFAULT NULL,
  p_capacity_override integer DEFAULT NULL, p_effective_from date DEFAULT NULL,
  p_effective_until date DEFAULT NULL, p_is_active boolean DEFAULT NULL,
  p_clear_staff boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_rule record; v_session record; v_lock_key bigint;
  v_today date := CURRENT_DATE; v_referenced_count integer;
BEGIN
  v_lock_key := abs(hashtext('recurrence_rule:' || p_rule_id::text));
  PERFORM pg_advisory_xact_lock(v_lock_key);
  SELECT * INTO v_rule FROM class_recurrence_rules WHERE id = p_rule_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('success', false, 'reason', 'rule_not_found'); END IF;
  IF v_rule.business_id != p_business_id THEN RETURN jsonb_build_object('success', false, 'reason', 'business_mismatch'); END IF;
  IF p_weekday IS NOT NULL AND p_weekday NOT IN ('mon','tue','wed','thu','fri','sat','sun') THEN RETURN jsonb_build_object('success', false, 'reason', 'invalid_weekday'); END IF;
  IF p_staff_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM business_staff WHERE id = p_staff_id AND business_id = p_business_id AND is_active = true) THEN RETURN jsonb_build_object('success', false, 'reason', 'invalid_staff'); END IF;
  IF p_location_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM business_locations WHERE id = p_location_id AND business_id = p_business_id AND is_active = true) THEN RETURN jsonb_build_object('success', false, 'reason', 'invalid_location'); END IF;
  IF p_capacity_override IS NOT NULL AND p_capacity_override < 1 THEN RETURN jsonb_build_object('success', false, 'reason', 'invalid_capacity'); END IF;
  FOR v_session IN SELECT cs.id FROM class_sessions cs WHERE cs.recurrence_rule_id = p_rule_id AND cs.status = 'scheduled' AND cs.date >= v_today ORDER BY cs.date
  LOOP PERFORM pg_advisory_xact_lock(abs(hashtext('class_session:' || v_session.id::text)));
  END LOOP;
  SELECT count(DISTINCT cs.id) INTO v_referenced_count FROM class_sessions cs WHERE cs.recurrence_rule_id = p_rule_id AND cs.date >= v_today AND EXISTS (SELECT 1 FROM bookings b WHERE b.class_session_id = cs.id);
  IF v_referenced_count > 0 THEN RETURN jsonb_build_object('success', false, 'reason', 'booked_sessions_exist', 'booked_session_count', v_referenced_count); END IF;
  DELETE FROM class_sessions WHERE recurrence_rule_id = p_rule_id AND status = 'scheduled' AND date >= v_today AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.class_session_id = class_sessions.id);
  IF p_action = 'delete' THEN
    DELETE FROM class_recurrence_rules WHERE id = p_rule_id;
    RETURN jsonb_build_object('success', true, 'action', 'deleted');
  END IF;
  UPDATE class_recurrence_rules SET weekday = COALESCE(p_weekday, weekday), start_time = COALESCE(p_start_time, start_time),
    staff_id = CASE WHEN p_clear_staff THEN NULL WHEN p_staff_id IS NOT NULL THEN p_staff_id ELSE staff_id END,
    location_id = COALESCE(p_location_id, location_id), capacity_override = COALESCE(p_capacity_override, capacity_override),
    effective_from = COALESCE(p_effective_from, effective_from),
    effective_until = CASE WHEN p_effective_until IS NOT NULL THEN p_effective_until ELSE effective_until END,
    is_active = COALESCE(p_is_active, is_active), updated_at = NOW()
  WHERE id = p_rule_id;
  PERFORM generate_class_sessions(v_rule.service_id, 28);
  RETURN jsonb_build_object('success', true, 'action', 'updated');
END;
$$;

REVOKE EXECUTE ON FUNCTION reconcile_class_recurrence FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION reconcile_class_recurrence FROM anon;
REVOKE EXECUTE ON FUNCTION reconcile_class_recurrence FROM authenticated;
GRANT EXECUTE ON FUNCTION reconcile_class_recurrence TO service_role;


-- ══════════════════════════════════════════════════════════════
-- END: Migration 325
-- ══════════════════════════════════════════════════════════════
