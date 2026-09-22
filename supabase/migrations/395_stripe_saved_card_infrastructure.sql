-- Migration 395: Stripe saved-card infrastructure
--
-- Extends the M389 global saved-card system for provider-neutral support:
-- 1. provider_customer_identities — durable Stripe Customer provisioning with CAS state machine
-- 2. provider_cleanup_operations — durable provider-side cleanup (detach, redisplay downgrade)
-- 3. saved_card_auth_attempts — 3DS auth-attempt tracking with supersession
-- 4. Extends payment_saved_card_offers with committed/confirmed lifecycle + consent source
-- 5. Adds credential_version to saved_payment_methods

-- ═══════════════════════════════════════════════════════
-- 1. provider_customer_identities
-- Durable canonical mapping: Waaiio customer phone → provider Customer ID.
-- Survives card removal, incomplete PIN setup, replacement, re-save.
-- ═══════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS provider_customer_identities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_phone TEXT NOT NULL CHECK (customer_phone ~ '^\+[1-9]\d{7,14}$'),
  gateway TEXT NOT NULL,
  provider_account_scope TEXT NOT NULL DEFAULT 'platform',
  provider_customer_id TEXT,  -- NULL until provider_confirmed
  idempotency_key TEXT NOT NULL,
  provisioning_state TEXT NOT NULL DEFAULT 'pre_dispatch'
    CHECK (provisioning_state IN ('pre_dispatch', 'dispatched', 'provider_confirmed', 'failed')),
  dispatched_at TIMESTAMPTZ,
  confirmed_at TIMESTAMPTZ,
  error_detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (customer_phone, gateway, provider_account_scope)
);

ALTER TABLE provider_customer_identities ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  REVOKE ALL ON TABLE provider_customer_identities FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE provider_customer_identities FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE provider_customer_identities FROM authenticated;
  END IF;
END $$;

CREATE POLICY pci_service ON provider_customer_identities FOR ALL TO service_role USING (true);

-- ═══════════════════════════════════════════════════════
-- 2. provider_cleanup_operations
-- Durable outbox for provider-side cleanup actions.
-- Supports: detach PM, redisplay downgrade, delete.
-- Claim-token + lease fencing prevents concurrent processing.
-- ═══════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS provider_cleanup_operations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_phone TEXT NOT NULL,
  gateway TEXT NOT NULL,
  provider_account_scope TEXT NOT NULL DEFAULT 'platform',
  operation_type TEXT NOT NULL
    CHECK (operation_type IN ('detach', 'delete', 'set_allow_redisplay_limited')),
  provider_object_id TEXT NOT NULL,
  source_event TEXT NOT NULL
    CHECK (source_event IN ('remove', 'replacement', 'redisplay_downgrade')),
  source_offer_id UUID REFERENCES payment_saved_card_offers(id) ON DELETE SET NULL,
  claim_token UUID,
  claim_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  last_attempted_at TIMESTAMPTZ,
  attempt_count INT NOT NULL DEFAULT 0,
  error_message TEXT,
  UNIQUE (gateway, provider_object_id, operation_type)
);

ALTER TABLE provider_cleanup_operations ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  REVOKE ALL ON TABLE provider_cleanup_operations FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE provider_cleanup_operations FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE provider_cleanup_operations FROM authenticated;
  END IF;
END $$;

CREATE POLICY pco_service ON provider_cleanup_operations FOR ALL TO service_role USING (true);

CREATE INDEX IF NOT EXISTS idx_pco_pending
  ON provider_cleanup_operations (gateway, created_at)
  WHERE completed_at IS NULL;

-- ═══════════════════════════════════════════════════════
-- 3. saved_card_auth_attempts
-- Durable 3DS auth-attempt tracking with supersession.
-- One active attempt per payment at a time.
-- ═══════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS saved_card_auth_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id UUID NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  customer_phone TEXT NOT NULL CHECK (customer_phone ~ '^\+[1-9]\d{7,14}$'),
  nonce TEXT NOT NULL,
  auth_version INT NOT NULL DEFAULT 1,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  superseded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (payment_id, auth_version)
);

ALTER TABLE saved_card_auth_attempts ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  REVOKE ALL ON TABLE saved_card_auth_attempts FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE saved_card_auth_attempts FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE saved_card_auth_attempts FROM authenticated;
  END IF;
END $$;

CREATE POLICY scaa_service ON saved_card_auth_attempts FOR ALL TO service_role USING (true);

-- ═══════════════════════════════════════════════════════
-- 4. Extend payment_saved_card_offers
-- Add committed/confirmed states + consent/credential tracking
-- ═══════════════════════════════════════════════════════
ALTER TABLE payment_saved_card_offers
  DROP CONSTRAINT IF EXISTS payment_saved_card_offers_state_check;
ALTER TABLE payment_saved_card_offers
  ADD CONSTRAINT payment_saved_card_offers_state_check
  CHECK (state IN ('pending', 'sending', 'sent', 'accepted', 'declined', 'ambiguous', 'committed', 'confirmed'));

ALTER TABLE payment_saved_card_offers
  ADD COLUMN IF NOT EXISTS consent_source TEXT
    CHECK (consent_source IS NULL OR consent_source IN ('whatsapp', 'provider_checkout')),
  ADD COLUMN IF NOT EXISTS consented_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS credential_committed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS confirmation_delivered_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS committed_method_id UUID
    REFERENCES saved_payment_methods(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS committed_card_display TEXT,
  ADD COLUMN IF NOT EXISTS committed_credential_version INT,
  ADD COLUMN IF NOT EXISTS activation_prompt_sent_at TIMESTAMPTZ;

-- ═══════════════════════════════════════════════════════
-- 5. Add credential_version to saved_payment_methods
-- ═══════════════════════════════════════════════════════
ALTER TABLE saved_payment_methods
  ADD COLUMN IF NOT EXISTS credential_version INT NOT NULL DEFAULT 1;

-- ═══════════════════════════════════════════════════════
-- 6. RPCs — Customer provisioning CAS
-- ═══════════════════════════════════════════════════════

-- Provision or read existing canonical provider Customer identity.
-- Returns the row state so the caller can dispatch or wait.
CREATE OR REPLACE FUNCTION provision_stripe_customer_cas(
  p_phone TEXT,
  p_gateway TEXT,
  p_scope TEXT,
  p_idempotency_key TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_row provider_customer_identities%ROWTYPE;
BEGIN
  -- Try INSERT first (common path for new customers)
  INSERT INTO provider_customer_identities
    (customer_phone, gateway, provider_account_scope, idempotency_key)
  VALUES (p_phone, p_gateway, p_scope, p_idempotency_key)
  ON CONFLICT (customer_phone, gateway, provider_account_scope) DO NOTHING;

  -- Read with lock (handles both new insert and existing row)
  SELECT * INTO v_row
  FROM provider_customer_identities
  WHERE customer_phone = p_phone
    AND gateway = p_gateway
    AND provider_account_scope = p_scope
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'row_not_found');
  END IF;

  RETURN jsonb_build_object(
    'operation_id', v_row.id,
    'current_state', v_row.provisioning_state,
    'provider_customer_id', v_row.provider_customer_id,
    'dispatched_at', v_row.dispatched_at,
    'idempotency_key', v_row.idempotency_key
  );
END;
$$;

-- CAS: pre_dispatch → dispatched
CREATE OR REPLACE FUNCTION dispatch_customer_provisioning(
  p_id UUID
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE provider_customer_identities
  SET provisioning_state = 'dispatched',
      dispatched_at = NOW()
  WHERE id = p_id
    AND provisioning_state = 'pre_dispatch';
  RETURN FOUND;
END;
$$;

-- CAS: dispatched → provider_confirmed
CREATE OR REPLACE FUNCTION confirm_customer_provisioning(
  p_id UUID,
  p_provider_customer_id TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE provider_customer_identities
  SET provisioning_state = 'provider_confirmed',
      provider_customer_id = p_provider_customer_id,
      confirmed_at = NOW()
  WHERE id = p_id
    AND provisioning_state = 'dispatched';
  RETURN FOUND;
END;
$$;

-- ═══════════════════════════════════════════════════════
-- 7. RPCs — Provider cleanup claim/complete/release
-- ═══════════════════════════════════════════════════════

-- Atomic claim: one row, skip locked. Returns claim token.
CREATE OR REPLACE FUNCTION claim_provider_cleanup_operation(
  p_gateway TEXT,
  p_max_attempts INT DEFAULT 5,
  p_lease_seconds INT DEFAULT 300
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_token UUID := gen_random_uuid();
  v_row provider_cleanup_operations%ROWTYPE;
BEGIN
  SELECT * INTO v_row
  FROM provider_cleanup_operations
  WHERE completed_at IS NULL
    AND gateway = p_gateway
    AND attempt_count < p_max_attempts
    AND (claim_token IS NULL OR claim_expires_at < NOW())
  ORDER BY created_at ASC
  LIMIT 1
  FOR UPDATE SKIP LOCKED;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  UPDATE provider_cleanup_operations
  SET claim_token = v_token,
      claim_expires_at = NOW() + (p_lease_seconds || ' seconds')::INTERVAL,
      attempt_count = v_row.attempt_count + 1,
      last_attempted_at = NOW()
  WHERE id = v_row.id;

  RETURN jsonb_build_object(
    'operation_id', v_row.id,
    'claim_token', v_token,
    'provider_object_id', v_row.provider_object_id,
    'provider_account_scope', v_row.provider_account_scope,
    'operation_type', v_row.operation_type,
    'customer_phone', v_row.customer_phone,
    'source_event', v_row.source_event,
    'attempt_count', v_row.attempt_count + 1,
    'source_offer_id', v_row.source_offer_id
  );
END;
$$;

-- Complete a cleanup operation (fenced by claim token)
CREATE OR REPLACE FUNCTION complete_provider_cleanup_operation(
  p_operation_id UUID,
  p_claim_token UUID,
  p_error_message TEXT DEFAULT NULL
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE provider_cleanup_operations
  SET completed_at = NOW(),
      error_message = p_error_message,
      claim_token = NULL,
      claim_expires_at = NULL
  WHERE id = p_operation_id
    AND claim_token = p_claim_token
    AND completed_at IS NULL;
  RETURN FOUND;
END;
$$;

-- Release a cleanup operation for retry (fenced by claim token)
CREATE OR REPLACE FUNCTION release_provider_cleanup_operation(
  p_operation_id UUID,
  p_claim_token UUID,
  p_error_message TEXT DEFAULT NULL
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE provider_cleanup_operations
  SET claim_token = NULL,
      claim_expires_at = NULL,
      error_message = p_error_message
  WHERE id = p_operation_id
    AND claim_token = p_claim_token
    AND completed_at IS NULL;
  RETURN FOUND;
END;
$$;

-- ═══════════════════════════════════════════════════════
-- 8. RPCs — Extended saved-card offer lifecycle
-- ═══════════════════════════════════════════════════════

-- Create a provider-consented offer (direct to 'accepted' state).
-- Used for Stripe where consent was collected at Checkout.
CREATE OR REPLACE FUNCTION create_provider_consented_offer(
  p_payment_id UUID,
  p_customer_phone TEXT,
  p_business_id UUID,
  p_offer_type TEXT,
  p_consent_source TEXT,
  p_consented_at TIMESTAMPTZ,
  p_card_display TEXT,
  p_current_method_id UUID DEFAULT NULL,
  p_channel_id UUID DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_id UUID;
BEGIN
  INSERT INTO payment_saved_card_offers
    (payment_id, customer_phone, business_id, offer_type, state,
     consent_source, consented_at, card_display, current_method_id,
     channel_id, resolved_at)
  VALUES
    (p_payment_id, p_customer_phone, p_business_id, p_offer_type, 'accepted',
     p_consent_source, p_consented_at, p_card_display, p_current_method_id,
     p_channel_id, NOW())
  ON CONFLICT (payment_id) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NOT NULL THEN
    RETURN jsonb_build_object('offer_id', v_id, 'already_exists', false);
  ELSE
    RETURN jsonb_build_object(
      'offer_id', (SELECT id FROM payment_saved_card_offers WHERE payment_id = p_payment_id),
      'already_exists', true
    );
  END IF;
END;
$$;

-- Commit offer: accepted → committed with exact credential evidence
CREATE OR REPLACE FUNCTION commit_saved_card_offer(
  p_offer_id UUID,
  p_customer_phone TEXT,
  p_method_id UUID,
  p_card_display TEXT,
  p_credential_version INT
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE payment_saved_card_offers
  SET state = 'committed',
      credential_committed_at = NOW(),
      committed_method_id = p_method_id,
      committed_card_display = p_card_display,
      committed_credential_version = p_credential_version
  WHERE id = p_offer_id
    AND customer_phone = p_customer_phone
    AND state = 'accepted';
  RETURN FOUND;
END;
$$;

-- Confirm offer: committed → confirmed (delivery proven)
CREATE OR REPLACE FUNCTION confirm_saved_card_offer(
  p_offer_id UUID,
  p_customer_phone TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE payment_saved_card_offers
  SET state = 'confirmed',
      confirmation_delivered_at = NOW()
  WHERE id = p_offer_id
    AND customer_phone = p_customer_phone
    AND state = 'committed';
  RETURN FOUND;
END;
$$;

-- ═══════════════════════════════════════════════════════
-- 9. Grants — service_role only for all new RPCs
-- ═══════════════════════════════════════════════════════
DO $$
BEGIN
  -- Customer provisioning
  REVOKE ALL ON FUNCTION provision_stripe_customer_cas(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION provision_stripe_customer_cas(TEXT, TEXT, TEXT, TEXT) TO service_role;
  REVOKE ALL ON FUNCTION dispatch_customer_provisioning(UUID) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION dispatch_customer_provisioning(UUID) TO service_role;
  REVOKE ALL ON FUNCTION confirm_customer_provisioning(UUID, TEXT) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION confirm_customer_provisioning(UUID, TEXT) TO service_role;

  -- Provider cleanup
  REVOKE ALL ON FUNCTION claim_provider_cleanup_operation(TEXT, INT, INT) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION claim_provider_cleanup_operation(TEXT, INT, INT) TO service_role;
  REVOKE ALL ON FUNCTION complete_provider_cleanup_operation(UUID, UUID, TEXT) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION complete_provider_cleanup_operation(UUID, UUID, TEXT) TO service_role;
  REVOKE ALL ON FUNCTION release_provider_cleanup_operation(UUID, UUID, TEXT) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION release_provider_cleanup_operation(UUID, UUID, TEXT) TO service_role;

  -- Extended offer lifecycle
  REVOKE ALL ON FUNCTION create_provider_consented_offer(UUID, TEXT, UUID, TEXT, TEXT, TIMESTAMPTZ, TEXT, UUID, UUID) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION create_provider_consented_offer(UUID, TEXT, UUID, TEXT, TEXT, TIMESTAMPTZ, TEXT, UUID, UUID) TO service_role;
  REVOKE ALL ON FUNCTION commit_saved_card_offer(UUID, TEXT, UUID, TEXT, INT) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION commit_saved_card_offer(UUID, TEXT, UUID, TEXT, INT) TO service_role;
  REVOKE ALL ON FUNCTION confirm_saved_card_offer(UUID, TEXT) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION confirm_saved_card_offer(UUID, TEXT) TO service_role;
END $$;

-- ═══════════════════════════════════════════════════════
-- 10. Atomic Stripe saved-card remove — revoke + cleanup enqueue in one transaction
-- ═══════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION atomic_stripe_revoke_and_enqueue(
  p_method_id UUID,
  p_customer_phone TEXT,
  p_provider_object_id TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_card_last4 TEXT;
  v_card_brand TEXT;
  v_revoked BOOLEAN := false;
BEGIN
  UPDATE saved_payment_methods
  SET is_active = false
  WHERE id = p_method_id AND customer_phone = p_customer_phone
    AND gateway = 'stripe' AND is_active = true
  RETURNING card_last4, card_brand INTO v_card_last4, v_card_brand;

  v_revoked := FOUND;
  IF NOT v_revoked THEN
    RETURN jsonb_build_object('revoked', false, 'reason', 'not_found_or_already_revoked');
  END IF;

  IF p_provider_object_id IS NOT NULL AND p_provider_object_id <> '' THEN
    INSERT INTO provider_cleanup_operations
      (customer_phone, gateway, provider_account_scope, operation_type, provider_object_id, source_event)
    VALUES (p_customer_phone, 'stripe', 'platform', 'detach', p_provider_object_id, 'remove')
    ON CONFLICT (gateway, provider_object_id, operation_type) DO NOTHING;
  END IF;

  RETURN jsonb_build_object('revoked', true, 'card_last4', v_card_last4, 'card_brand', v_card_brand);
END;
$$;

REVOKE ALL ON FUNCTION atomic_stripe_revoke_and_enqueue(UUID, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION atomic_stripe_revoke_and_enqueue(UUID, TEXT, TEXT) TO service_role;

-- ═══════════════════════════════════════════════════════
-- 11. Atomic customer provisioning recovery claim (FOR UPDATE SKIP LOCKED)
-- ═══════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION claim_stale_customer_provisioning(
  p_gateway TEXT,
  p_stale_minutes INT DEFAULT 10
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_row provider_customer_identities%ROWTYPE;
BEGIN
  SELECT * INTO v_row
  FROM provider_customer_identities
  WHERE provisioning_state = 'dispatched'
    AND gateway = p_gateway
    AND dispatched_at < NOW() - (p_stale_minutes || ' minutes')::INTERVAL
  ORDER BY dispatched_at ASC LIMIT 1
  FOR UPDATE SKIP LOCKED;

  IF NOT FOUND THEN RETURN NULL; END IF;

  RETURN jsonb_build_object(
    'operation_id', v_row.id,
    'customer_phone', v_row.customer_phone,
    'provider_account_scope', v_row.provider_account_scope,
    'idempotency_key', v_row.idempotency_key,
    'dispatched_at', v_row.dispatched_at
  );
END;
$$;

REVOKE ALL ON FUNCTION claim_stale_customer_provisioning(TEXT, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_stale_customer_provisioning(TEXT, INT) TO service_role;
