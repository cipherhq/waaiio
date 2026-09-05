-- ═══════════════════════════════════════════════════════
-- 368: Messaging Allowance Schema (A-1, #258)
--
-- Financial authorization for outbound message sends.
-- Parent authorization: authorize_message_send() atomically
-- creates a cost reservation tied 1:1 to a message_send_attempts row.
--
-- Trial is volume (message units), not money.
-- Free allowance first, trial second, paid last.
-- ═══════════════════════════════════════════════════════

-- ── 1. Business messaging accounts ──

CREATE TABLE IF NOT EXISTS public.business_messaging_accounts (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id       UUID NOT NULL REFERENCES public.businesses(id) ON DELETE RESTRICT,
  free_units_remaining   INTEGER NOT NULL DEFAULT 0 CHECK (free_units_remaining >= 0),
  trial_units_remaining  INTEGER NOT NULL DEFAULT 0 CHECK (trial_units_remaining >= 0),
  paid_balance_minor     INTEGER NOT NULL DEFAULT 0 CHECK (paid_balance_minor >= 0),
  currency_code     TEXT NOT NULL DEFAULT 'NGN',
  config_version_id UUID REFERENCES public.platform_config_versions(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(business_id)
);

CREATE INDEX IF NOT EXISTS idx_bma_business ON business_messaging_accounts(business_id);

-- ── 2. Message cost reservations (1:1 with message_send_attempts) ──

CREATE TABLE IF NOT EXISTS public.message_cost_reservations (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id        UUID NOT NULL REFERENCES public.message_send_attempts(id) ON DELETE RESTRICT,
  business_id       UUID NOT NULL REFERENCES public.businesses(id) ON DELETE RESTRICT,
  authorization_source TEXT NOT NULL CHECK (authorization_source IN ('free', 'trial', 'paid')),
  estimated_cost_minor INTEGER NOT NULL CHECK (estimated_cost_minor >= 0),
  currency_code     TEXT NOT NULL,
  config_version_id UUID REFERENCES public.platform_config_versions(id),
  estimate_provenance JSONB NOT NULL,
  status            TEXT NOT NULL DEFAULT 'reserved'
                    CHECK (status IN ('reserved', 'consumed', 'released', 'reconciliation')),
  reserved_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finalized_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(attempt_id)  -- exactly one reservation per attempt
);

CREATE INDEX IF NOT EXISTS idx_mcr_business ON message_cost_reservations(business_id);
CREATE INDEX IF NOT EXISTS idx_mcr_attempt ON message_cost_reservations(attempt_id);
CREATE INDEX IF NOT EXISTS idx_mcr_status ON message_cost_reservations(status) WHERE status NOT IN ('consumed', 'released');

-- ── 3. Reservation state transition enforcement ──

CREATE OR REPLACE FUNCTION public.enforce_reservation_transitions()
RETURNS TRIGGER AS $$
BEGIN
  -- Terminal states are write-once
  IF OLD.status IN ('consumed', 'released') AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'reservation status is terminal: cannot change from % to %',
      OLD.status, NEW.status;
  END IF;

  -- Valid transitions only
  IF NOT (
    (OLD.status = 'reserved' AND NEW.status IN ('consumed', 'released', 'reconciliation')) OR
    (OLD.status = 'reconciliation' AND NEW.status IN ('consumed', 'released')) OR
    (OLD.status = NEW.status)  -- no-op
  ) THEN
    RAISE EXCEPTION 'Invalid reservation transition: % → %',
      OLD.status, NEW.status;
  END IF;

  -- Set finalized_at on terminal transition
  IF NEW.status IN ('consumed', 'released') AND OLD.status NOT IN ('consumed', 'released') THEN
    NEW.finalized_at = clock_timestamp();
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_reservation_transitions
  BEFORE UPDATE ON message_cost_reservations FOR EACH ROW
  EXECUTE FUNCTION enforce_reservation_transitions();

-- ── 4. Authoritative parent authorization RPC ──
-- Atomically: lock attempt → verify estimate → check allowance → reserve → mark attempt reserved

CREATE OR REPLACE FUNCTION public.authorize_message_send(
  p_attempt_id UUID,
  p_estimated_cost_minor INTEGER,
  p_currency_code TEXT,
  p_estimate_provenance JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_attempt RECORD;
  v_account RECORD;
  v_source TEXT;
  v_reservation_id UUID;
  v_config_version_id UUID;
BEGIN
  -- 1. Validate estimate provenance
  IF p_estimate_provenance IS NULL OR p_estimate_provenance = '{}'::jsonb THEN
    RAISE EXCEPTION 'estimate_provenance is required for financial authorization';
  END IF;
  IF p_estimate_provenance->>'source' IS NULL THEN
    RAISE EXCEPTION 'estimate_provenance must include a source field';
  END IF;
  -- Only server-authoritative sources allowed
  IF p_estimate_provenance->>'source' NOT IN ('server_rate_card', 'platform_config', 'admin_override', 'meta_pricing_api') THEN
    RAISE EXCEPTION 'Untrusted estimate source: %. Only server-authoritative sources are accepted.', p_estimate_provenance->>'source';
  END IF;

  -- 2. Lock and validate the parent attempt
  SELECT * INTO v_attempt
  FROM message_send_attempts
  WHERE id = p_attempt_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'attempt not found: %', p_attempt_id;
  END IF;

  IF v_attempt.financial_disposition NOT IN ('pending_authorization') THEN
    -- Idempotency: already authorized
    IF v_attempt.financial_disposition = 'reserved' THEN
      -- Return existing reservation
      SELECT id INTO v_reservation_id FROM message_cost_reservations WHERE attempt_id = p_attempt_id;
      RETURN jsonb_build_object(
        'authorized', true,
        'idempotent', true,
        'reservation_id', v_reservation_id,
        'source', (SELECT authorization_source FROM message_cost_reservations WHERE attempt_id = p_attempt_id)
      );
    END IF;
    RAISE EXCEPTION 'attempt % is in financial state %, cannot authorize', p_attempt_id, v_attempt.financial_disposition;
  END IF;

  IF v_attempt.business_id IS NULL THEN
    RAISE EXCEPTION 'cannot authorize financial reservation for platform-scoped attempt (no business_id)';
  END IF;

  -- 3. Lock the business messaging account
  SELECT * INTO v_account
  FROM business_messaging_accounts
  WHERE business_id = v_attempt.business_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'no messaging account for business %', v_attempt.business_id;
  END IF;

  -- Get current config version
  SELECT id INTO v_config_version_id
  FROM platform_config_versions
  ORDER BY effective_from DESC LIMIT 1;

  -- 4. Determine authorization source (free → trial → paid)
  IF p_estimated_cost_minor = 0 THEN
    -- Free message (e.g., free-entry-point)
    v_source := 'free';
  ELSIF v_account.free_units_remaining > 0 THEN
    v_source := 'free';
    UPDATE business_messaging_accounts
    SET free_units_remaining = free_units_remaining - 1, updated_at = NOW()
    WHERE id = v_account.id;
  ELSIF v_account.trial_units_remaining > 0 THEN
    v_source := 'trial';
    UPDATE business_messaging_accounts
    SET trial_units_remaining = trial_units_remaining - 1, updated_at = NOW()
    WHERE id = v_account.id;
  ELSIF v_account.paid_balance_minor >= p_estimated_cost_minor THEN
    v_source := 'paid';
    UPDATE business_messaging_accounts
    SET paid_balance_minor = paid_balance_minor - p_estimated_cost_minor, updated_at = NOW()
    WHERE id = v_account.id;
  ELSE
    RAISE EXCEPTION 'insufficient messaging allowance for business %', v_attempt.business_id;
  END IF;

  -- 5. Create the cost reservation atomically
  v_reservation_id := gen_random_uuid();
  INSERT INTO message_cost_reservations (
    id, attempt_id, business_id, authorization_source,
    estimated_cost_minor, currency_code, config_version_id,
    estimate_provenance, status
  ) VALUES (
    v_reservation_id, p_attempt_id, v_attempt.business_id, v_source,
    p_estimated_cost_minor, p_currency_code, v_config_version_id,
    p_estimate_provenance, 'reserved'
  );

  -- 6. Mark the parent attempt as financially reserved
  UPDATE message_send_attempts
  SET financial_disposition = 'reserved',
      spend_period_start = NOW(),
      reserved_at = NOW()
  WHERE id = p_attempt_id;

  RETURN jsonb_build_object(
    'authorized', true,
    'idempotent', false,
    'reservation_id', v_reservation_id,
    'source', v_source,
    'estimated_cost_minor', p_estimated_cost_minor,
    'currency_code', p_currency_code,
    'config_version_id', v_config_version_id
  );
END;
$$;

-- ACL: service-role only (backend authorization path)
REVOKE ALL ON FUNCTION public.authorize_message_send(UUID, INTEGER, TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.authorize_message_send(UUID, INTEGER, TEXT, JSONB) FROM anon;
REVOKE ALL ON FUNCTION public.authorize_message_send(UUID, INTEGER, TEXT, JSONB) FROM authenticated;
REVOKE ALL ON FUNCTION public.authorize_message_send(UUID, INTEGER, TEXT, JSONB) FROM service_role;
GRANT EXECUTE ON FUNCTION public.authorize_message_send(UUID, INTEGER, TEXT, JSONB) TO service_role;

-- ── 5. Finalization RPCs ──

CREATE OR REPLACE FUNCTION public.finalize_reservation(
  p_attempt_id UUID,
  p_outcome TEXT  -- 'consumed' or 'released'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_reservation RECORD;
  v_account RECORD;
BEGIN
  IF p_outcome NOT IN ('consumed', 'released') THEN
    RAISE EXCEPTION 'outcome must be consumed or released, got %', p_outcome;
  END IF;

  -- Lock reservation
  SELECT * INTO v_reservation
  FROM message_cost_reservations
  WHERE attempt_id = p_attempt_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'no reservation for attempt %', p_attempt_id;
  END IF;

  -- Idempotency: already finalized to same outcome
  IF v_reservation.status = p_outcome THEN
    RETURN jsonb_build_object('finalized', true, 'idempotent', true, 'status', p_outcome);
  END IF;

  -- Terminal check (transition enforcement trigger will also catch, but early exit is clearer)
  IF v_reservation.status IN ('consumed', 'released') THEN
    RAISE EXCEPTION 'reservation already finalized as %', v_reservation.status;
  END IF;

  -- Release: restore the reserved amount
  IF p_outcome = 'released' THEN
    SELECT * INTO v_account
    FROM business_messaging_accounts
    WHERE business_id = v_reservation.business_id
    FOR UPDATE;

    IF v_reservation.authorization_source = 'free' THEN
      UPDATE business_messaging_accounts
      SET free_units_remaining = free_units_remaining + 1, updated_at = NOW()
      WHERE id = v_account.id;
    ELSIF v_reservation.authorization_source = 'trial' THEN
      UPDATE business_messaging_accounts
      SET trial_units_remaining = trial_units_remaining + 1, updated_at = NOW()
      WHERE id = v_account.id;
    ELSIF v_reservation.authorization_source = 'paid' THEN
      UPDATE business_messaging_accounts
      SET paid_balance_minor = paid_balance_minor + v_reservation.estimated_cost_minor, updated_at = NOW()
      WHERE id = v_account.id;
    END IF;
  END IF;

  -- Update reservation status (trigger sets finalized_at)
  UPDATE message_cost_reservations
  SET status = p_outcome
  WHERE id = v_reservation.id;

  RETURN jsonb_build_object('finalized', true, 'idempotent', false, 'status', p_outcome);
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_reservation(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finalize_reservation(UUID, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.finalize_reservation(UUID, TEXT) FROM authenticated;
REVOKE ALL ON FUNCTION public.finalize_reservation(UUID, TEXT) FROM service_role;
GRANT EXECUTE ON FUNCTION public.finalize_reservation(UUID, TEXT) TO service_role;

-- ── 6. RLS ──

ALTER TABLE business_messaging_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_cost_reservations ENABLE ROW LEVEL SECURITY;

-- Business owners read their own account
CREATE POLICY bma_owner_select ON business_messaging_accounts
  FOR SELECT USING (EXISTS (
    SELECT 1 FROM businesses WHERE id = business_messaging_accounts.business_id AND owner_id = auth.uid()
  ));

-- Admin reads all
CREATE POLICY bma_admin_select ON business_messaging_accounts
  FOR SELECT USING (public.is_admin());

-- Business owners read their own reservations
CREATE POLICY mcr_owner_select ON message_cost_reservations
  FOR SELECT USING (EXISTS (
    SELECT 1 FROM businesses WHERE id = message_cost_reservations.business_id AND owner_id = auth.uid()
  ));

CREATE POLICY mcr_admin_select ON message_cost_reservations
  FOR SELECT USING (public.is_admin());

-- Grants: service-role for mutations, authenticated for reads
GRANT SELECT ON business_messaging_accounts TO authenticated;
GRANT SELECT, INSERT, UPDATE ON business_messaging_accounts TO service_role;
GRANT SELECT ON message_cost_reservations TO authenticated;
GRANT SELECT, INSERT, UPDATE ON message_cost_reservations TO service_role;
