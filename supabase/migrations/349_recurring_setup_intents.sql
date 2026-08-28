-- Migration 349: Recurring Setup Intents (#165)
--
-- Post-payment recurring continuation lifecycle.
-- ONE intent per source payment (unconditional UNIQUE).
-- State machine: offered → frequency_selected → consent_confirmed →
--   provider_attempted → active | provider_ambiguous | setup_failed
-- Terminal: declined, expired, setup_failed, active
--
-- Paystack-only MVP. Weekly + Monthly. 24-hour expiry.
-- Payment Authority invariant: original payment is NEVER modified.

-- ═══════════════════════════════════════════════════════
-- Table: recurring_setup_intents
-- ═══════════════════════════════════════════════════════

CREATE TABLE recurring_setup_intents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Source payment linkage — ONE intent per payment FOREVER
  source_payment_id UUID NOT NULL REFERENCES payments(id),

  -- Tenant + identity
  business_id UUID NOT NULL REFERENCES businesses(id),
  user_id UUID NOT NULL REFERENCES profiles(id),
  service_id UUID REFERENCES services(id),

  -- Financial terms (from source payment, immutable after creation)
  amount INTEGER NOT NULL,
  currency VARCHAR(3) NOT NULL,

  -- Frequency: NULL until customer selects
  frequency VARCHAR(10) CHECK (frequency IS NULL OR frequency IN ('weekly', 'monthly')),

  -- State machine
  status TEXT NOT NULL DEFAULT 'offered' CHECK (status IN (
    'offered', 'frequency_selected', 'consent_confirmed',
    'provider_attempted', 'provider_ambiguous',
    'active', 'declined', 'expired', 'setup_failed'
  )),

  -- Provider
  provider TEXT CHECK (provider IS NULL OR provider IN ('paystack')),

  -- Consent evidence (durable BEFORE provider mutation)
  consent_at TIMESTAMPTZ,
  consent_message_hash TEXT,

  -- Paystack provider identifiers (persisted immediately after each provider response)
  provider_plan_id TEXT,         -- Paystack plan_code (persisted after Phase 1)
  provider_subscription_id TEXT, -- Paystack subscription_code (persisted after Phase 2)
  provider_email_token TEXT,     -- Paystack email token for cancellation

  -- Paystack reconciliation fields (recorded before provider attempt)
  provider_customer_code TEXT,      -- CUS_xxx from _card_authorization
  provider_authorization_code TEXT, -- authorization_code used for this attempt
  provider_start_date TIMESTAMPTZ,  -- deferred first-charge date

  -- Local activation
  resulting_subscription_id UUID REFERENCES customer_subscriptions(id),

  -- Worker claim lease
  claim_token UUID,
  claim_expires_at TIMESTAMPTZ,

  -- Timestamps
  offered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- ═══ State/data invariants ═══

  -- Frequency required once past 'offered' (except terminal decline/expired)
  CHECK (
    status IN ('offered', 'declined', 'expired')
    OR frequency IS NOT NULL
  ),

  -- Consent required before provider attempt
  CHECK (
    status NOT IN ('consent_confirmed', 'provider_attempted', 'provider_ambiguous', 'active')
    OR (consent_at IS NOT NULL AND consent_message_hash IS NOT NULL)
  ),

  -- Provider required once past consent
  CHECK (
    status NOT IN ('consent_confirmed', 'provider_attempted', 'provider_ambiguous', 'active')
    OR provider IS NOT NULL
  ),

  -- Active requires all provider + local identifiers
  CHECK (
    status != 'active'
    OR (provider_plan_id IS NOT NULL AND provider_subscription_id IS NOT NULL AND resulting_subscription_id IS NOT NULL)
  )
);

-- CRITICAL: unconditional uniqueness — one intent per source payment FOREVER
CREATE UNIQUE INDEX uq_rsi_source_payment ON recurring_setup_intents(source_payment_id);

-- Lookup indexes
CREATE INDEX idx_rsi_business_status ON recurring_setup_intents(business_id, status);
CREATE INDEX idx_rsi_user ON recurring_setup_intents(user_id);
CREATE INDEX idx_rsi_expires ON recurring_setup_intents(expires_at) WHERE status = 'offered';

-- RLS
ALTER TABLE recurring_setup_intents ENABLE ROW LEVEL SECURITY;

-- ═══════════════════════════════════════════════════════
-- RPC: create_recurring_offer
-- Post-finalization hook. Idempotent via ON CONFLICT.
-- ═══════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION create_recurring_offer(
  p_source_payment_id UUID,
  p_business_id UUID,
  p_provider TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_intent RECORD;
  v_new_id UUID;
  v_amount INTEGER;
  v_currency VARCHAR(3);
  v_user_id UUID;
  v_service_id UUID;
BEGIN
  -- Validate provider
  IF p_provider != 'paystack' THEN
    RETURN jsonb_build_object('created', false, 'reason', 'unsupported_provider');
  END IF;

  -- Load authoritative values from source payment and its associated booking
  -- Booking MUST exist with flow_type='payment' (Payment/Giving context required)
  SELECT p.amount, p.currency, p.user_id, b.service_id
  INTO v_amount, v_currency, v_user_id, v_service_id
  FROM public.payments p
  INNER JOIN public.bookings b ON b.id = p.booking_id
  WHERE p.id = p_source_payment_id
    AND p.business_id = p_business_id
    AND p.gateway = p_provider                              -- gateway match
    AND p.status = 'success'
    AND p.finalization_completed_at IS NOT NULL
    AND p.confirmation_sent_at IS NOT NULL
    AND b.flow_type = 'payment'                             -- canonical Payment/Giving booking
    AND b.business_id = p_business_id;                      -- booking tenant match

  IF NOT FOUND THEN
    RETURN jsonb_build_object('created', false, 'reason', 'payment_not_eligible');
  END IF;

  -- Validate the payment has a user_id (anonymous payments cannot set up recurring)
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('created', false, 'reason', 'payment_missing_user');
  END IF;

  -- Idempotent insert
  INSERT INTO public.recurring_setup_intents (
    source_payment_id, business_id, user_id, service_id,
    amount, currency, provider
  ) VALUES (
    p_source_payment_id, p_business_id, v_user_id, v_service_id,
    v_amount, v_currency, p_provider
  )
  ON CONFLICT (source_payment_id) DO NOTHING
  RETURNING id INTO v_new_id;

  IF v_new_id IS NOT NULL THEN
    RETURN jsonb_build_object('created', true, 'intent_id', v_new_id);
  END IF;

  -- Existing intent — return its current state
  SELECT id, status, expires_at INTO v_intent
  FROM public.recurring_setup_intents
  WHERE source_payment_id = p_source_payment_id;

  RETURN jsonb_build_object(
    'created', false,
    'reason', 'already_exists',
    'intent_id', v_intent.id,
    'status', v_intent.status,
    'expired', v_intent.expires_at < NOW()
  );
END;
$$;

-- ═══════════════════════════════════════════════════════
-- RPC: select_recurring_frequency
-- offered → frequency_selected
-- ═══════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION select_recurring_frequency(
  p_intent_id UUID,
  p_business_id UUID,
  p_frequency TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_intent RECORD;
BEGIN
  IF p_frequency NOT IN ('weekly', 'monthly') THEN
    RETURN jsonb_build_object('transitioned', false, 'reason', 'invalid_frequency');
  END IF;

  SELECT id, status, business_id, expires_at INTO v_intent
  FROM public.recurring_setup_intents
  WHERE id = p_intent_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('transitioned', false, 'reason', 'intent_not_found');
  END IF;
  IF v_intent.business_id != p_business_id THEN
    RETURN jsonb_build_object('transitioned', false, 'reason', 'tenant_mismatch');
  END IF;
  IF v_intent.expires_at < NOW() THEN
    UPDATE public.recurring_setup_intents SET status = 'expired', updated_at = NOW() WHERE id = p_intent_id AND status = 'offered';
    RETURN jsonb_build_object('transitioned', false, 'reason', 'expired');
  END IF;
  IF v_intent.status != 'offered' THEN
    RETURN jsonb_build_object('transitioned', false, 'reason', 'invalid_state_' || v_intent.status);
  END IF;

  UPDATE public.recurring_setup_intents
  SET status = 'frequency_selected', frequency = p_frequency, updated_at = NOW()
  WHERE id = p_intent_id AND status = 'offered';

  RETURN jsonb_build_object('transitioned', true);
END;
$$;

-- ═══════════════════════════════════════════════════════
-- RPC: confirm_recurring_consent
-- frequency_selected → consent_confirmed
-- ═══════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION confirm_recurring_consent(
  p_intent_id UUID,
  p_business_id UUID,
  p_consent_message_hash TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_intent RECORD;
BEGIN
  IF p_consent_message_hash IS NULL OR TRIM(p_consent_message_hash) = '' THEN
    RETURN jsonb_build_object('transitioned', false, 'reason', 'missing_consent_hash');
  END IF;

  SELECT id, status, business_id, frequency, expires_at INTO v_intent
  FROM public.recurring_setup_intents
  WHERE id = p_intent_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('transitioned', false, 'reason', 'intent_not_found');
  END IF;
  IF v_intent.business_id != p_business_id THEN
    RETURN jsonb_build_object('transitioned', false, 'reason', 'tenant_mismatch');
  END IF;
  IF v_intent.expires_at < NOW() THEN
    UPDATE public.recurring_setup_intents SET status = 'expired', updated_at = NOW() WHERE id = p_intent_id AND status IN ('offered', 'frequency_selected');
    RETURN jsonb_build_object('transitioned', false, 'reason', 'expired');
  END IF;
  IF v_intent.status != 'frequency_selected' THEN
    RETURN jsonb_build_object('transitioned', false, 'reason', 'invalid_state_' || v_intent.status);
  END IF;
  IF v_intent.frequency IS NULL THEN
    RETURN jsonb_build_object('transitioned', false, 'reason', 'frequency_not_set');
  END IF;

  UPDATE public.recurring_setup_intents
  SET status = 'consent_confirmed', consent_at = NOW(), consent_message_hash = p_consent_message_hash, updated_at = NOW()
  WHERE id = p_intent_id AND status = 'frequency_selected';

  RETURN jsonb_build_object('transitioned', true);
END;
$$;

-- ═══════════════════════════════════════════════════════
-- RPC: begin_recurring_provider_attempt
-- consent_confirmed → provider_attempted
-- Records all reconciliation fields BEFORE any provider call
-- ═══════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION begin_recurring_provider_attempt(
  p_intent_id UUID,
  p_business_id UUID,
  p_customer_code TEXT,
  p_authorization_code TEXT,
  p_start_date TIMESTAMPTZ
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_intent RECORD;
  v_token UUID;
BEGIN
  SELECT id, status, business_id, consent_at, consent_message_hash, expires_at
  INTO v_intent
  FROM public.recurring_setup_intents
  WHERE id = p_intent_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('transitioned', false, 'reason', 'intent_not_found');
  END IF;
  IF v_intent.business_id != p_business_id THEN
    RETURN jsonb_build_object('transitioned', false, 'reason', 'tenant_mismatch');
  END IF;
  IF v_intent.expires_at < NOW() THEN
    UPDATE public.recurring_setup_intents SET status = 'expired', updated_at = NOW() WHERE id = p_intent_id AND status IN ('offered', 'frequency_selected', 'consent_confirmed');
    RETURN jsonb_build_object('transitioned', false, 'reason', 'expired');
  END IF;
  IF v_intent.status != 'consent_confirmed' THEN
    RETURN jsonb_build_object('transitioned', false, 'reason', 'invalid_state_' || v_intent.status);
  END IF;
  IF v_intent.consent_at IS NULL OR v_intent.consent_message_hash IS NULL THEN
    RETURN jsonb_build_object('transitioned', false, 'reason', 'consent_incomplete');
  END IF;

  v_token := gen_random_uuid();

  UPDATE public.recurring_setup_intents
  SET status = 'provider_attempted',
      provider_customer_code = p_customer_code,
      provider_authorization_code = p_authorization_code,
      provider_start_date = p_start_date,
      claim_token = v_token,
      claim_expires_at = NOW() + INTERVAL '5 minutes',
      updated_at = NOW()
  WHERE id = p_intent_id AND status = 'consent_confirmed';

  RETURN jsonb_build_object('transitioned', true, 'claim_token', v_token);
END;
$$;

-- ═══════════════════════════════════════════════════════
-- RPC: persist_recurring_plan_id
-- Records Paystack plan_code after successful Phase 1
-- ═══════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION persist_recurring_plan_id(
  p_intent_id UUID,
  p_claim_token UUID,
  p_plan_code TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_intent RECORD;
BEGIN
  -- Reject empty/whitespace plan codes
  IF p_plan_code IS NULL OR TRIM(p_plan_code) = '' THEN
    RETURN jsonb_build_object('persisted', false, 'reason', 'empty_plan_code');
  END IF;

  SELECT id, status, claim_token FROM public.recurring_setup_intents
  WHERE id = p_intent_id FOR UPDATE INTO v_intent;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('persisted', false, 'reason', 'intent_not_found');
  END IF;
  IF v_intent.status != 'provider_attempted' THEN
    RETURN jsonb_build_object('persisted', false, 'reason', 'invalid_state_' || v_intent.status);
  END IF;
  IF v_intent.claim_token IS NULL OR v_intent.claim_token != p_claim_token THEN
    RETURN jsonb_build_object('persisted', false, 'reason', 'token_mismatch');
  END IF;

  UPDATE public.recurring_setup_intents
  SET provider_plan_id = p_plan_code, updated_at = NOW()
  WHERE id = p_intent_id;

  RETURN jsonb_build_object('persisted', true);
END;
$$;

-- ═══════════════════════════════════════════════════════
-- RPC: persist_recurring_subscription_id
-- Records Paystack subscription_code after successful Phase 2
-- MUST be called BEFORE activate_recurring_subscription
-- so the code is durably bound even if activation fails.
-- ═══════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION persist_recurring_subscription_id(
  p_intent_id UUID,
  p_claim_token UUID,
  p_subscription_code TEXT,
  p_email_token TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_intent RECORD;
BEGIN
  -- Reject empty/whitespace subscription codes
  IF p_subscription_code IS NULL OR TRIM(p_subscription_code) = '' THEN
    RETURN jsonb_build_object('persisted', false, 'reason', 'empty_subscription_code');
  END IF;

  SELECT id, status, claim_token FROM public.recurring_setup_intents
  WHERE id = p_intent_id FOR UPDATE INTO v_intent;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('persisted', false, 'reason', 'intent_not_found');
  END IF;
  IF v_intent.status != 'provider_attempted' THEN
    RETURN jsonb_build_object('persisted', false, 'reason', 'invalid_state_' || v_intent.status);
  END IF;
  IF v_intent.claim_token IS NULL OR v_intent.claim_token != p_claim_token THEN
    RETURN jsonb_build_object('persisted', false, 'reason', 'token_mismatch');
  END IF;

  UPDATE public.recurring_setup_intents
  SET provider_subscription_id = p_subscription_code,
      provider_email_token = p_email_token,
      updated_at = NOW()
  WHERE id = p_intent_id;

  RETURN jsonb_build_object('persisted', true);
END;
$$;

-- ═══════════════════════════════════════════════════════
-- RPC: activate_recurring_subscription
-- provider_attempted → active (with local subscription creation)
-- Atomic: creates customer_subscriptions + updates intent
-- NOTE: only provider_attempted is accepted. provider_ambiguous
--   intents are fail-closed and require manual/admin resolution (deferred).
-- ═══════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION activate_recurring_subscription(
  p_intent_id UUID,
  p_claim_token UUID
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_intent RECORD;
  v_sub_id UUID;
BEGIN
  SELECT * FROM public.recurring_setup_intents
  WHERE id = p_intent_id FOR UPDATE INTO v_intent;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('activated', false, 'reason', 'intent_not_found');
  END IF;
  -- Idempotent: if already activated, return success regardless of current state
  IF v_intent.resulting_subscription_id IS NOT NULL THEN
    RETURN jsonb_build_object('activated', true, 'already_activated', true, 'subscription_id', v_intent.resulting_subscription_id);
  END IF;
  -- Only provider_attempted accepted. provider_ambiguous is fail-closed
  -- and requires manual/admin resolution (deferred to a future reconciliation worker).
  IF v_intent.status != 'provider_attempted' THEN
    RETURN jsonb_build_object('activated', false, 'reason', 'invalid_state_' || v_intent.status);
  END IF;
  IF v_intent.claim_token IS NULL OR v_intent.claim_token != p_claim_token THEN
    RETURN jsonb_build_object('activated', false, 'reason', 'token_mismatch');
  END IF;

  -- Consume persisted provider evidence — do NOT accept caller-supplied values
  IF v_intent.provider_plan_id IS NULL OR v_intent.provider_subscription_id IS NULL THEN
    RETURN jsonb_build_object('activated', false, 'reason', 'provider_evidence_incomplete');
  END IF;
  -- Reject empty/whitespace provider identifiers (defense-in-depth)
  IF TRIM(v_intent.provider_plan_id) = '' OR TRIM(v_intent.provider_subscription_id) = '' THEN
    RETURN jsonb_build_object('activated', false, 'reason', 'empty_provider_identifiers');
  END IF;

  -- provider_start_date must be set (recorded in begin_recurring_provider_attempt)
  IF v_intent.provider_start_date IS NULL THEN
    RETURN jsonb_build_object('activated', false, 'reason', 'missing_provider_start_date');
  END IF;

  -- Create customer_subscriptions row using persisted provider evidence
  INSERT INTO public.customer_subscriptions (
    business_id, user_id, service_id, amount, currency, frequency,
    status, gateway, gateway_subscription_code, gateway_plan_code,
    gateway_customer_code, authorization_code,
    card_last_four, card_brand, next_charge_at,
    customer_phone, setup_channel, metadata
  )
  SELECT
    v_intent.business_id, v_intent.user_id, v_intent.service_id,
    v_intent.amount, v_intent.currency, v_intent.frequency,
    'active', v_intent.provider, v_intent.provider_subscription_id, v_intent.provider_plan_id,
    v_intent.provider_customer_code, v_intent.provider_authorization_code,
    NULL, NULL, v_intent.provider_start_date,
    (SELECT guest_phone FROM public.bookings WHERE payment_id = v_intent.source_payment_id LIMIT 1),
    'whatsapp',
    jsonb_build_object('source_payment_id', v_intent.source_payment_id, 'setup_intent_id', v_intent.id, 'email_token', v_intent.provider_email_token)
  RETURNING id INTO v_sub_id;

  -- Update intent to active — no need to overwrite provider fields (already persisted)
  UPDATE public.recurring_setup_intents
  SET status = 'active',
      resulting_subscription_id = v_sub_id,
      claim_token = NULL,
      claim_expires_at = NULL,
      updated_at = NOW()
  WHERE id = p_intent_id;

  RETURN jsonb_build_object('activated', true, 'subscription_id', v_sub_id);
END;
$$;

-- ═══════════════════════════════════════════════════════
-- RPC: mark_recurring_ambiguous
-- provider_attempted → provider_ambiguous
-- ═══════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION mark_recurring_ambiguous(
  p_intent_id UUID,
  p_claim_token UUID,
  p_reason TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_intent RECORD;
BEGIN
  SELECT id, status, claim_token FROM public.recurring_setup_intents
  WHERE id = p_intent_id FOR UPDATE INTO v_intent;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('marked', false, 'reason', 'intent_not_found');
  END IF;
  IF v_intent.status != 'provider_attempted' THEN
    RETURN jsonb_build_object('marked', false, 'reason', 'invalid_state_' || v_intent.status);
  END IF;
  IF v_intent.claim_token IS NULL OR v_intent.claim_token != p_claim_token THEN
    RETURN jsonb_build_object('marked', false, 'reason', 'token_mismatch');
  END IF;

  UPDATE public.recurring_setup_intents
  SET status = 'provider_ambiguous', claim_token = NULL, claim_expires_at = NULL, updated_at = NOW()
  WHERE id = p_intent_id;

  RETURN jsonb_build_object('marked', true);
END;
$$;

-- ═══════════════════════════════════════════════════════
-- RPC: fail_recurring_setup
-- consent_confirmed|provider_attempted → setup_failed
-- ═══════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION fail_recurring_setup(
  p_intent_id UUID,
  p_business_id UUID,
  p_reason TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_intent RECORD;
BEGIN
  SELECT id, status, business_id FROM public.recurring_setup_intents
  WHERE id = p_intent_id FOR UPDATE INTO v_intent;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('failed', false, 'reason', 'intent_not_found');
  END IF;
  IF v_intent.business_id != p_business_id THEN
    RETURN jsonb_build_object('failed', false, 'reason', 'tenant_mismatch');
  END IF;
  IF v_intent.status NOT IN ('consent_confirmed', 'provider_attempted') THEN
    RETURN jsonb_build_object('failed', false, 'reason', 'invalid_state_' || v_intent.status);
  END IF;

  UPDATE public.recurring_setup_intents
  SET status = 'setup_failed', claim_token = NULL, claim_expires_at = NULL, updated_at = NOW()
  WHERE id = p_intent_id;

  RETURN jsonb_build_object('failed', true);
END;
$$;

-- ═══════════════════════════════════════════════════════
-- RPC: decline_recurring_offer
-- offered|frequency_selected → declined
-- ═══════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION decline_recurring_offer(
  p_intent_id UUID,
  p_business_id UUID,
  p_user_id UUID
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_intent RECORD;
BEGIN
  SELECT id, status, business_id, user_id, expires_at FROM public.recurring_setup_intents
  WHERE id = p_intent_id FOR UPDATE INTO v_intent;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('declined', false, 'reason', 'intent_not_found');
  END IF;
  IF v_intent.business_id != p_business_id THEN
    RETURN jsonb_build_object('declined', false, 'reason', 'tenant_mismatch');
  END IF;
  IF v_intent.user_id != p_user_id THEN
    RETURN jsonb_build_object('declined', false, 'reason', 'user_mismatch');
  END IF;
  -- Expiry check: stale pre-provider intent → expire rather than decline
  IF v_intent.expires_at < NOW() THEN
    UPDATE public.recurring_setup_intents SET status = 'expired', updated_at = NOW()
    WHERE id = p_intent_id AND status IN ('offered', 'frequency_selected');
    RETURN jsonb_build_object('declined', false, 'reason', 'expired');
  END IF;
  IF v_intent.status NOT IN ('offered', 'frequency_selected') THEN
    RETURN jsonb_build_object('declined', false, 'reason', 'invalid_state_' || v_intent.status);
  END IF;

  UPDATE public.recurring_setup_intents
  SET status = 'declined', updated_at = NOW()
  WHERE id = p_intent_id;

  RETURN jsonb_build_object('declined', true);
END;
$$;

-- ═══════════════════════════════════════════════════════
-- RPC: expire_stale_recurring_offers
-- Cron-callable: offered past expires_at → expired
-- ═══════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION expire_stale_recurring_offers()
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_count INTEGER;
BEGIN
  UPDATE public.recurring_setup_intents
  SET status = 'expired', updated_at = NOW()
  WHERE status = 'offered' AND expires_at < NOW();
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- ═══════════════════════════════════════════════════════
-- Privilege restrictions
-- ═══════════════════════════════════════════════════════

DO $$ BEGIN
  -- Revoke from PUBLIC, anon, authenticated
  REVOKE ALL ON FUNCTION create_recurring_offer(UUID, UUID, TEXT) FROM PUBLIC;
  REVOKE ALL ON FUNCTION select_recurring_frequency(UUID, UUID, TEXT) FROM PUBLIC;
  REVOKE ALL ON FUNCTION confirm_recurring_consent(UUID, UUID, TEXT) FROM PUBLIC;
  REVOKE ALL ON FUNCTION begin_recurring_provider_attempt(UUID, UUID, TEXT, TEXT, TIMESTAMPTZ) FROM PUBLIC;
  REVOKE ALL ON FUNCTION persist_recurring_plan_id(UUID, UUID, TEXT) FROM PUBLIC;
  REVOKE ALL ON FUNCTION persist_recurring_subscription_id(UUID, UUID, TEXT, TEXT) FROM PUBLIC;
  REVOKE ALL ON FUNCTION activate_recurring_subscription(UUID, UUID) FROM PUBLIC;
  REVOKE ALL ON FUNCTION mark_recurring_ambiguous(UUID, UUID, TEXT) FROM PUBLIC;
  REVOKE ALL ON FUNCTION fail_recurring_setup(UUID, UUID, TEXT) FROM PUBLIC;
  REVOKE ALL ON FUNCTION decline_recurring_offer(UUID, UUID, UUID) FROM PUBLIC;
  REVOKE ALL ON FUNCTION expire_stale_recurring_offers() FROM PUBLIC;

  EXECUTE 'REVOKE ALL ON FUNCTION create_recurring_offer(UUID, UUID, TEXT) FROM anon';
  EXECUTE 'REVOKE ALL ON FUNCTION select_recurring_frequency(UUID, UUID, TEXT) FROM anon';
  EXECUTE 'REVOKE ALL ON FUNCTION confirm_recurring_consent(UUID, UUID, TEXT) FROM anon';
  EXECUTE 'REVOKE ALL ON FUNCTION begin_recurring_provider_attempt(UUID, UUID, TEXT, TEXT, TIMESTAMPTZ) FROM anon';
  EXECUTE 'REVOKE ALL ON FUNCTION persist_recurring_plan_id(UUID, UUID, TEXT) FROM anon';
  EXECUTE 'REVOKE ALL ON FUNCTION persist_recurring_subscription_id(UUID, UUID, TEXT, TEXT) FROM anon';
  EXECUTE 'REVOKE ALL ON FUNCTION activate_recurring_subscription(UUID, UUID) FROM anon';
  EXECUTE 'REVOKE ALL ON FUNCTION mark_recurring_ambiguous(UUID, UUID, TEXT) FROM anon';
  EXECUTE 'REVOKE ALL ON FUNCTION fail_recurring_setup(UUID, UUID, TEXT) FROM anon';
  EXECUTE 'REVOKE ALL ON FUNCTION decline_recurring_offer(UUID, UUID, UUID) FROM anon';
  EXECUTE 'REVOKE ALL ON FUNCTION expire_stale_recurring_offers() FROM anon';

  EXECUTE 'REVOKE ALL ON FUNCTION create_recurring_offer(UUID, UUID, TEXT) FROM authenticated';
  EXECUTE 'REVOKE ALL ON FUNCTION select_recurring_frequency(UUID, UUID, TEXT) FROM authenticated';
  EXECUTE 'REVOKE ALL ON FUNCTION confirm_recurring_consent(UUID, UUID, TEXT) FROM authenticated';
  EXECUTE 'REVOKE ALL ON FUNCTION begin_recurring_provider_attempt(UUID, UUID, TEXT, TEXT, TIMESTAMPTZ) FROM authenticated';
  EXECUTE 'REVOKE ALL ON FUNCTION persist_recurring_plan_id(UUID, UUID, TEXT) FROM authenticated';
  EXECUTE 'REVOKE ALL ON FUNCTION persist_recurring_subscription_id(UUID, UUID, TEXT, TEXT) FROM authenticated';
  EXECUTE 'REVOKE ALL ON FUNCTION activate_recurring_subscription(UUID, UUID) FROM authenticated';
  EXECUTE 'REVOKE ALL ON FUNCTION mark_recurring_ambiguous(UUID, UUID, TEXT) FROM authenticated';
  EXECUTE 'REVOKE ALL ON FUNCTION fail_recurring_setup(UUID, UUID, TEXT) FROM authenticated';
  EXECUTE 'REVOKE ALL ON FUNCTION decline_recurring_offer(UUID, UUID, UUID) FROM authenticated';
  EXECUTE 'REVOKE ALL ON FUNCTION expire_stale_recurring_offers() FROM authenticated';

  -- Grant only to service_role
  EXECUTE 'GRANT EXECUTE ON FUNCTION create_recurring_offer(UUID, UUID, TEXT) TO service_role';
  EXECUTE 'GRANT EXECUTE ON FUNCTION select_recurring_frequency(UUID, UUID, TEXT) TO service_role';
  EXECUTE 'GRANT EXECUTE ON FUNCTION confirm_recurring_consent(UUID, UUID, TEXT) TO service_role';
  EXECUTE 'GRANT EXECUTE ON FUNCTION begin_recurring_provider_attempt(UUID, UUID, TEXT, TEXT, TIMESTAMPTZ) TO service_role';
  EXECUTE 'GRANT EXECUTE ON FUNCTION persist_recurring_plan_id(UUID, UUID, TEXT) TO service_role';
  EXECUTE 'GRANT EXECUTE ON FUNCTION persist_recurring_subscription_id(UUID, UUID, TEXT, TEXT) TO service_role';
  EXECUTE 'GRANT EXECUTE ON FUNCTION activate_recurring_subscription(UUID, UUID) TO service_role';
  EXECUTE 'GRANT EXECUTE ON FUNCTION mark_recurring_ambiguous(UUID, UUID, TEXT) TO service_role';
  EXECUTE 'GRANT EXECUTE ON FUNCTION fail_recurring_setup(UUID, UUID, TEXT) TO service_role';
  EXECUTE 'GRANT EXECUTE ON FUNCTION decline_recurring_offer(UUID, UUID, UUID) TO service_role';
  EXECUTE 'GRANT EXECUTE ON FUNCTION expire_stale_recurring_offers() TO service_role';
EXCEPTION WHEN undefined_object THEN NULL;
END $$;
