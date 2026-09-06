-- ═══════════════════════════════════════════════════════
-- 371: Runtime Financial Integration (#261)
--
-- Gate-switchable financial authorization wrapper, allowance
-- granting, admin reconciliation, threshold alerts, delivery
-- buffer, reservation TTL, and commercial key extensions.
--
-- Surfaces:
--   NEW RPC: check_or_authorize_send(UUID)
--   NEW RPC: grant_messaging_allowance(...)
--   NEW RPC: resolve_message_cost_reconciliation(...)
--   NEW TABLE: messaging_spend_threshold_alerts
--   NEW TABLE: unmatched_attempt_delivery_statuses
--   NEW TABLE: message_cost_reconciliation_log
--   ALTERED: save_commercial_config — extended allowlist
--   ALTERED: guard_commercial_settings — extended allowlist
--   ALTERED: authorize_message_send — reservation_expires_at
--   ALTERED: enforce_disposition_transitions — reservation_expires_at immutability
-- ═══════════════════════════════════════════════════════

-- ══════════════════════════════════════════════════════════
-- A. check_or_authorize_send(UUID) — gate-switchable wrapper
-- ══════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.check_or_authorize_send(p_attempt_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_decision_time TIMESTAMPTZ;
  v_config RECORD;
  v_gate_value JSONB;
  v_auth_result JSONB;
BEGIN
  -- Capture single decision timestamp
  v_decision_time := clock_timestamp();

  -- Resolve effective config at decision time
  SELECT id, config_snapshot INTO v_config
    FROM public.platform_config_versions
    WHERE effective_from <= v_decision_time
    ORDER BY effective_from DESC
    LIMIT 1;

  -- No config at all (pre-bootstrap) → gate OFF
  IF v_config.id IS NULL THEN
    RETURN jsonb_build_object(
      'enforcement_required', false,
      'reason', 'no_config_version',
      'decision_time', v_decision_time::TEXT
    );
  END IF;

  -- Read the gate key
  v_gate_value := v_config.config_snapshot -> 'messaging_financial_gate';

  -- Key missing (pre-gate config) → gate OFF
  IF v_gate_value IS NULL THEN
    RETURN jsonb_build_object(
      'enforcement_required', false,
      'reason', 'gate_key_absent',
      'decision_time', v_decision_time::TEXT,
      'config_version_id', v_config.id::TEXT
    );
  END IF;

  -- Validate gate value type
  IF jsonb_typeof(v_gate_value) <> 'boolean' THEN
    -- Malformed: fail closed
    RETURN jsonb_build_object(
      'authorized', false,
      'reason', 'invalid_gate_config',
      'decision_time', v_decision_time::TEXT,
      'config_version_id', v_config.id::TEXT
    );
  END IF;

  -- Gate explicitly OFF (false)
  IF v_gate_value = 'false'::JSONB THEN
    RETURN jsonb_build_object(
      'enforcement_required', false,
      'reason', 'gate_off',
      'decision_time', v_decision_time::TEXT,
      'config_version_id', v_config.id::TEXT
    );
  END IF;

  -- Gate ON (true): delegate to authorize_message_send (3-arg overload)
  -- Pass pre-resolved config_id and decision_time to avoid re-resolution drift
  v_auth_result := public.authorize_message_send(p_attempt_id, v_config.id, v_decision_time);

  -- Augment result with decision metadata
  RETURN v_auth_result || jsonb_build_object(
    'decision_time', v_decision_time::TEXT,
    'config_version_id', v_config.id::TEXT
  );
END;
$$;

-- ACL: service-role only
REVOKE ALL ON FUNCTION public.check_or_authorize_send(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.check_or_authorize_send(UUID) FROM anon;
REVOKE ALL ON FUNCTION public.check_or_authorize_send(UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.check_or_authorize_send(UUID) TO service_role;

-- ══════════════════════════════════════════════════════════
-- B. grant_messaging_allowance(...) — idempotent allowance granting
-- ══════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.grant_messaging_allowance(
  p_business_id UUID,
  p_type TEXT,
  p_amount_minor INTEGER,
  p_currency_code TEXT,
  p_source_ref TEXT,
  p_config_version_id UUID DEFAULT NULL,
  p_expires_at TIMESTAMPTZ DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_allowance_id UUID;
  v_existing RECORD;
BEGIN
  -- Validate inputs
  IF p_type NOT IN ('trial_grant', 'subscription_included', 'purchased', 'promotional') THEN
    RETURN jsonb_build_object('granted', false, 'reason', 'invalid_type');
  END IF;

  IF p_amount_minor <= 0 THEN
    RETURN jsonb_build_object('granted', false, 'reason', 'invalid_amount');
  END IF;

  -- Attempt insert with conflict detection
  v_allowance_id := gen_random_uuid();

  INSERT INTO public.messaging_allowances (
    id, business_id, type, amount_minor, currency_code,
    remaining_minor, source_ref, config_version_id, expires_at
  ) VALUES (
    v_allowance_id, p_business_id, p_type, p_amount_minor, p_currency_code,
    p_amount_minor, p_source_ref, p_config_version_id, p_expires_at
  )
  ON CONFLICT (business_id, type, source_ref) DO NOTHING;

  -- Check if our insert succeeded
  SELECT * INTO v_existing
    FROM public.messaging_allowances
    WHERE business_id = p_business_id
      AND type = p_type
      AND source_ref = p_source_ref;

  IF v_existing.id = v_allowance_id THEN
    -- Fresh insert succeeded — create grant event
    INSERT INTO public.messaging_allowance_events (
      allowance_id, business_id, event_type, amount_minor,
      balance_after_minor
    ) VALUES (
      v_allowance_id, p_business_id, 'grant', p_amount_minor,
      p_amount_minor
    );

    RETURN jsonb_build_object(
      'granted', true,
      'allowance_id', v_allowance_id::TEXT,
      'amount_minor', p_amount_minor,
      'currency_code', p_currency_code
    );
  END IF;

  -- Conflict: compare payload for idempotency
  IF v_existing.amount_minor = p_amount_minor
     AND v_existing.currency_code = p_currency_code
     AND v_existing.config_version_id IS NOT DISTINCT FROM p_config_version_id
     AND v_existing.expires_at IS NOT DISTINCT FROM p_expires_at THEN
    -- Exact replay
    RETURN jsonb_build_object(
      'granted', false,
      'idempotent', true,
      'allowance_id', v_existing.id::TEXT
    );
  END IF;

  -- Mismatched replay
  RETURN jsonb_build_object(
    'granted', false,
    'reason', 'idempotency_key_mismatch'
  );
END;
$$;

-- ACL: service-role only
REVOKE ALL ON FUNCTION public.grant_messaging_allowance(UUID, TEXT, INTEGER, TEXT, TEXT, UUID, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.grant_messaging_allowance(UUID, TEXT, INTEGER, TEXT, TEXT, UUID, TIMESTAMPTZ) FROM anon;
REVOKE ALL ON FUNCTION public.grant_messaging_allowance(UUID, TEXT, INTEGER, TEXT, TEXT, UUID, TIMESTAMPTZ) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.grant_messaging_allowance(UUID, TEXT, INTEGER, TEXT, TEXT, UUID, TIMESTAMPTZ) TO service_role;

-- ══════════════════════════════════════════════════════════
-- C. Tables: threshold alerts, unmatched delivery statuses,
--    reconciliation log
-- ══════════════════════════════════════════════════════════

-- ── C1. messaging_spend_threshold_alerts ──

CREATE TABLE IF NOT EXISTS public.messaging_spend_threshold_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE RESTRICT,
  currency_code TEXT NOT NULL,
  period_start TIMESTAMPTZ NOT NULL,
  threshold_pct INTEGER NOT NULL CHECK (threshold_pct IN (50, 75, 90, 100)),
  utilization_at_alert NUMERIC(5,2) NOT NULL,
  cap_minor INTEGER NOT NULL,
  reserved_minor INTEGER NOT NULL,
  spent_minor INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(business_id, currency_code, period_start, threshold_pct)
);

ALTER TABLE public.messaging_spend_threshold_alerts ENABLE ROW LEVEL SECURITY;

-- Owner SELECT
CREATE POLICY msta_owner_select ON messaging_spend_threshold_alerts
  FOR SELECT USING (EXISTS (
    SELECT 1 FROM public.businesses WHERE id = messaging_spend_threshold_alerts.business_id AND owner_id = auth.uid()
  ));

-- Admin SELECT
CREATE POLICY msta_admin_select ON messaging_spend_threshold_alerts
  FOR SELECT USING (public.is_admin());

-- Grants: owner/admin SELECT, service_role INSERT only
REVOKE ALL ON messaging_spend_threshold_alerts FROM PUBLIC, authenticated, service_role, anon;
GRANT SELECT ON messaging_spend_threshold_alerts TO authenticated;
GRANT SELECT, INSERT ON messaging_spend_threshold_alerts TO service_role;

-- ── C2. unmatched_attempt_delivery_statuses ──

CREATE TABLE IF NOT EXISTS public.unmatched_attempt_delivery_statuses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meta_message_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('sent', 'delivered', 'read', 'failed')),
  provider_timestamp TIMESTAMPTZ,
  error_code TEXT,
  error_reason TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  settled BOOLEAN NOT NULL DEFAULT false,
  settled_at TIMESTAMPTZ,
  UNIQUE(meta_message_id, status)
);

CREATE INDEX IF NOT EXISTS idx_uads_meta_message_id ON unmatched_attempt_delivery_statuses(meta_message_id);
CREATE INDEX IF NOT EXISTS idx_uads_received_at ON unmatched_attempt_delivery_statuses(received_at);

ALTER TABLE public.unmatched_attempt_delivery_statuses ENABLE ROW LEVEL SECURITY;

-- Service-role only: SELECT/INSERT/UPDATE
REVOKE ALL ON unmatched_attempt_delivery_statuses FROM PUBLIC, authenticated, service_role, anon;
GRANT SELECT, INSERT, UPDATE ON unmatched_attempt_delivery_statuses TO service_role;

-- ── C3. message_cost_reconciliation_log ──

CREATE TABLE IF NOT EXISTS public.message_cost_reconciliation_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id UUID NOT NULL REFERENCES public.message_send_attempts(id) ON DELETE RESTRICT,
  resolution TEXT NOT NULL CHECK (resolution IN ('charge', 'release', 'no_change')),
  source_key TEXT NOT NULL,
  actor_user_id UUID NOT NULL,
  reason TEXT NOT NULL,
  cost_event_id UUID REFERENCES public.message_cost_events(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(attempt_id, source_key)
);

ALTER TABLE public.message_cost_reconciliation_log ENABLE ROW LEVEL SECURITY;

-- Admin SELECT only
CREATE POLICY mcrl_admin_select ON message_cost_reconciliation_log
  FOR SELECT USING (public.is_admin());

-- Append-only enforcement (no UPDATE/DELETE for app roles)
CREATE OR REPLACE FUNCTION public.prevent_reconciliation_log_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'message_cost_reconciliation_log is append-only: % denied', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_reconciliation_log_no_update
  BEFORE UPDATE ON message_cost_reconciliation_log FOR EACH ROW
  EXECUTE FUNCTION prevent_reconciliation_log_mutation();

CREATE TRIGGER trg_reconciliation_log_no_delete
  BEFORE DELETE ON message_cost_reconciliation_log FOR EACH ROW
  EXECUTE FUNCTION prevent_reconciliation_log_mutation();

-- Grants
REVOKE ALL ON message_cost_reconciliation_log FROM PUBLIC, authenticated, service_role, anon;
GRANT SELECT ON message_cost_reconciliation_log TO authenticated;
GRANT SELECT, INSERT ON message_cost_reconciliation_log TO service_role;

-- ══════════════════════════════════════════════════════════
-- D. resolve_message_cost_reconciliation(...) — admin reconciliation
-- ══════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.resolve_message_cost_reconciliation(
  p_attempt_id UUID,
  p_resolution TEXT,
  p_reason TEXT,
  p_source_key TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller_id UUID;
  v_attempt RECORD;
  v_existing_log RECORD;
  v_cost_event_id UUID;
  v_reserve_event RECORD;
  v_allowance_event RECORD;
  v_allowance RECORD;
  v_cost INTEGER;
  v_period RECORD;
BEGIN
  -- Admin authorization
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN
    RETURN jsonb_build_object('resolved', false, 'reason', 'unauthenticated');
  END IF;
  IF NOT public.is_admin() THEN
    RETURN jsonb_build_object('resolved', false, 'reason', 'not_admin');
  END IF;

  -- Input validation
  IF p_resolution NOT IN ('charge', 'release', 'no_change') THEN
    RETURN jsonb_build_object('resolved', false, 'reason', 'invalid_resolution');
  END IF;

  IF p_reason IS NULL OR p_reason = '' THEN
    RETURN jsonb_build_object('resolved', false, 'reason', 'reason_required');
  END IF;

  IF p_source_key IS NULL OR p_source_key = '' THEN
    RETURN jsonb_build_object('resolved', false, 'reason', 'source_key_required');
  END IF;

  -- Lock attempt
  SELECT * INTO v_attempt
    FROM public.message_send_attempts
    WHERE id = p_attempt_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('resolved', false, 'reason', 'attempt_not_found');
  END IF;

  -- Check idempotency
  SELECT * INTO v_existing_log
    FROM public.message_cost_reconciliation_log
    WHERE attempt_id = p_attempt_id AND source_key = p_source_key;

  IF FOUND THEN
    RETURN jsonb_build_object('resolved', true, 'idempotent', true);
  END IF;

  -- Must be flagged for reconciliation
  IF v_attempt.needs_reconciliation IS NOT TRUE THEN
    RETURN jsonb_build_object('resolved', false, 'reason', 'not_flagged_for_reconciliation');
  END IF;

  IF p_resolution = 'no_change' THEN
    -- Append reconcile cost event
    v_cost_event_id := gen_random_uuid();
    INSERT INTO public.message_cost_events (
      id, attempt_id, event_type, amount_minor, source_key,
      config_version_id
    ) VALUES (
      v_cost_event_id, p_attempt_id, 'reconcile', NULL, p_source_key,
      v_attempt.config_version_id
    );

    -- Log
    INSERT INTO public.message_cost_reconciliation_log (
      attempt_id, resolution, source_key, actor_user_id, reason, cost_event_id
    ) VALUES (
      p_attempt_id, 'no_change', p_source_key, v_caller_id, p_reason, v_cost_event_id
    );

    -- Clear flag
    UPDATE public.message_send_attempts
      SET needs_reconciliation = false
      WHERE id = p_attempt_id;

    RETURN jsonb_build_object('resolved', true, 'resolution', 'no_change');
  END IF;

  -- For charge/release, we need the reserve event
  SELECT * INTO v_reserve_event
    FROM public.message_cost_events
    WHERE attempt_id = p_attempt_id AND event_type = 'reserve';

  IF NOT FOUND THEN
    RETURN jsonb_build_object('resolved', false, 'reason', 'no_reserve_event');
  END IF;

  v_cost := -v_reserve_event.amount_minor;  -- reserve.amount_minor is negative

  IF p_resolution = 'charge' THEN
    -- Append adjust cost event: charge = deduct cost that was released
    v_cost_event_id := gen_random_uuid();
    INSERT INTO public.message_cost_events (
      id, attempt_id, event_type, amount_minor, charge_type, source_key,
      config_version_id
    ) VALUES (
      v_cost_event_id, p_attempt_id, 'adjust', -v_cost, v_reserve_event.charge_type,
      p_source_key, v_attempt.config_version_id
    );

    -- Append per-allowance adjust events to decrement restored allowances
    FOR v_allowance_event IN
      SELECT mae.*, ma.type AS allowance_type
        FROM public.messaging_allowance_events mae
        JOIN public.messaging_allowances ma ON ma.id = mae.allowance_id
        WHERE mae.attempt_id = p_attempt_id
          AND mae.event_type = 'reserve'
        ORDER BY ma.created_at ASC, ma.id ASC
    LOOP
      SELECT * INTO v_allowance
        FROM public.messaging_allowances
        WHERE id = v_allowance_event.allowance_id
        FOR UPDATE;

      -- Decrement: re-reserve the amount
      UPDATE public.messaging_allowances
        SET remaining_minor = remaining_minor - (-v_allowance_event.amount_minor)
        WHERE id = v_allowance_event.allowance_id;

      INSERT INTO public.messaging_allowance_events (
        allowance_id, business_id, event_type, amount_minor, attempt_id,
        charge_type, source_key, balance_after_minor
      ) VALUES (
        v_allowance_event.allowance_id, v_attempt.business_id, 'adjust',
        v_allowance_event.amount_minor,  -- negative: deducting
        p_attempt_id,
        CASE WHEN v_allowance.type IN ('trial_grant', 'subscription_included', 'promotional') THEN 'included' ELSE 'overage' END,
        p_source_key,
        v_allowance.remaining_minor - (-v_allowance_event.amount_minor)
      );
    END LOOP;

    -- Update spend-period
    IF v_attempt.spend_period_start IS NOT NULL AND v_attempt.currency_code IS NOT NULL THEN
      SELECT * INTO v_period
        FROM public.messaging_spend_periods
        WHERE business_id = v_attempt.business_id
          AND currency_code = v_attempt.currency_code
          AND period_start = v_attempt.spend_period_start
        FOR UPDATE;

      IF FOUND THEN
        UPDATE public.messaging_spend_periods
          SET spent_minor = spent_minor + v_cost
          WHERE id = v_period.id;
      END IF;
    END IF;

  ELSIF p_resolution = 'release' THEN
    -- Append adjust cost event: release = restore cost that was charged
    v_cost_event_id := gen_random_uuid();
    INSERT INTO public.message_cost_events (
      id, attempt_id, event_type, amount_minor, charge_type, source_key,
      config_version_id
    ) VALUES (
      v_cost_event_id, p_attempt_id, 'adjust', v_cost, v_reserve_event.charge_type,
      p_source_key, v_attempt.config_version_id
    );

    -- Append per-allowance adjust events to restore allowances
    FOR v_allowance_event IN
      SELECT mae.*, ma.type AS allowance_type
        FROM public.messaging_allowance_events mae
        JOIN public.messaging_allowances ma ON ma.id = mae.allowance_id
        WHERE mae.attempt_id = p_attempt_id
          AND mae.event_type = 'reserve'
        ORDER BY ma.created_at ASC, ma.id ASC
    LOOP
      SELECT * INTO v_allowance
        FROM public.messaging_allowances
        WHERE id = v_allowance_event.allowance_id
        FOR UPDATE;

      -- Restore: give back the reserved amount
      UPDATE public.messaging_allowances
        SET remaining_minor = remaining_minor + (-v_allowance_event.amount_minor)
        WHERE id = v_allowance_event.allowance_id;

      INSERT INTO public.messaging_allowance_events (
        allowance_id, business_id, event_type, amount_minor, attempt_id,
        charge_type, source_key, balance_after_minor
      ) VALUES (
        v_allowance_event.allowance_id, v_attempt.business_id, 'adjust',
        -v_allowance_event.amount_minor,  -- positive: restoring
        p_attempt_id,
        CASE WHEN v_allowance.type IN ('trial_grant', 'subscription_included', 'promotional') THEN 'included' ELSE 'overage' END,
        p_source_key,
        v_allowance.remaining_minor + (-v_allowance_event.amount_minor)
      );
    END LOOP;

    -- Update spend-period
    IF v_attempt.spend_period_start IS NOT NULL AND v_attempt.currency_code IS NOT NULL THEN
      SELECT * INTO v_period
        FROM public.messaging_spend_periods
        WHERE business_id = v_attempt.business_id
          AND currency_code = v_attempt.currency_code
          AND period_start = v_attempt.spend_period_start
        FOR UPDATE;

      IF FOUND THEN
        UPDATE public.messaging_spend_periods
          SET spent_minor = spent_minor - v_cost
          WHERE id = v_period.id;
      END IF;
    END IF;
  END IF;

  -- Log
  INSERT INTO public.message_cost_reconciliation_log (
    attempt_id, resolution, source_key, actor_user_id, reason, cost_event_id
  ) VALUES (
    p_attempt_id, p_resolution, p_source_key, v_caller_id, p_reason, v_cost_event_id
  );

  -- Clear flag
  UPDATE public.message_send_attempts
    SET needs_reconciliation = false
    WHERE id = p_attempt_id;

  RETURN jsonb_build_object('resolved', true, 'resolution', p_resolution);
END;
$$;

-- ACL: authenticated only (admin check inside)
REVOKE ALL ON FUNCTION public.resolve_message_cost_reconciliation(UUID, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_message_cost_reconciliation(UUID, TEXT, TEXT, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.resolve_message_cost_reconciliation(UUID, TEXT, TEXT, TEXT) FROM service_role;
GRANT EXECUTE ON FUNCTION public.resolve_message_cost_reconciliation(UUID, TEXT, TEXT, TEXT) TO authenticated;

-- ══════════════════════════════════════════════════════════
-- E. Extend commercial key allowlist in save_commercial_config
--    and guard_commercial_settings
-- ══════════════════════════════════════════════════════════

-- Redefine save_commercial_config with extended allowlist + write-time validation
CREATE OR REPLACE FUNCTION public.save_commercial_config(
  p_key TEXT,
  p_value JSONB,
  p_description TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_commercial_keys TEXT[] := ARRAY[
    'pricing_tiers', 'trial_days', 'broadcast_limits', 'conversation_limits',
    'default_platform_fee_percent', 'annual_discount_percentage',
    'payout_cooling_period_days', 'minimum_payout', 'payout_verification_limits',
    'transfer_expiry_hours', 'minimum_bank_transfer',
    'messaging_financial_gate', 'messaging_reservation_ttl_seconds'
  ];
  v_caller_id UUID;
  v_snapshot JSONB;
  v_version_id UUID;
  v_now TIMESTAMPTZ;
BEGIN
  -- 1. Verify admin authorization
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'save_commercial_config requires authenticated caller';
  END IF;
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'save_commercial_config requires admin role';
  END IF;

  -- 2. Validate key is in the commercial allowlist
  IF NOT (p_key = ANY(v_commercial_keys)) THEN
    RAISE EXCEPTION 'Key "%" is not a commercial config key', p_key;
  END IF;

  -- 2b. Write-time type validation for financial keys
  IF p_key = 'messaging_financial_gate' THEN
    IF jsonb_typeof(p_value) <> 'boolean' THEN
      RAISE EXCEPTION 'messaging_financial_gate must be a boolean, got %', jsonb_typeof(p_value);
    END IF;
  END IF;

  IF p_key = 'messaging_reservation_ttl_seconds' THEN
    IF jsonb_typeof(p_value) <> 'number' THEN
      RAISE EXCEPTION 'messaging_reservation_ttl_seconds must be a positive integer, got %', jsonb_typeof(p_value);
    END IF;
    IF (p_value::TEXT)::NUMERIC <= 0 OR (p_value::TEXT)::NUMERIC <> FLOOR((p_value::TEXT)::NUMERIC) THEN
      RAISE EXCEPTION 'messaging_reservation_ttl_seconds must be a positive integer, got %', p_value::TEXT;
    END IF;
  END IF;

  -- 3. Serialize concurrent commercial saves
  PERFORM pg_advisory_xact_lock(hashtext('commercial_config_write'));

  -- 4. Upsert the target platform_settings row (create-or-update)
  INSERT INTO platform_settings (key, value, description, updated_by, updated_at)
  VALUES (p_key, p_value, COALESCE(p_description, ''), v_caller_id, clock_timestamp())
  ON CONFLICT (key) DO UPDATE
    SET value = EXCLUDED.value,
        description = COALESCE(NULLIF(p_description, ''), platform_settings.description),
        updated_by = EXCLUDED.updated_by,
        updated_at = EXCLUDED.updated_at;

  -- 5. Build snapshot from complete post-mutation allowlisted state
  SELECT jsonb_object_agg(key, value)
  INTO v_snapshot
  FROM platform_settings
  WHERE key = ANY(v_commercial_keys);

  IF v_snapshot IS NULL OR v_snapshot = '{}'::jsonb THEN
    RAISE EXCEPTION 'Cannot create config version: no commercial keys found in platform_settings';
  END IF;

  -- 6. Assign effective_from from DB clock inside serialized transaction
  v_now := clock_timestamp();

  -- 7. Create immutable version
  v_version_id := gen_random_uuid();
  INSERT INTO platform_config_versions (id, config_snapshot, effective_from, created_by, created_at)
  VALUES (v_version_id, v_snapshot, v_now, v_caller_id, v_now);

  RETURN v_version_id;
END;
$$;

-- Re-apply ACL (CREATE OR REPLACE resets grants)
REVOKE ALL ON FUNCTION public.save_commercial_config(TEXT, JSONB, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.save_commercial_config(TEXT, JSONB, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.save_commercial_config(TEXT, JSONB, TEXT) FROM authenticated;
REVOKE ALL ON FUNCTION public.save_commercial_config(TEXT, JSONB, TEXT) FROM service_role;
GRANT EXECUTE ON FUNCTION public.save_commercial_config(TEXT, JSONB, TEXT) TO authenticated;

-- Update guard_commercial_settings with extended allowlist
CREATE OR REPLACE FUNCTION public.guard_commercial_settings()
RETURNS TRIGGER AS $$
DECLARE
  v_touches_commercial BOOLEAN;
  v_trusted_owner TEXT;
  v_commercial_keys TEXT[] := ARRAY[
    'pricing_tiers', 'trial_days', 'broadcast_limits', 'conversation_limits',
    'default_platform_fee_percent', 'annual_discount_percentage',
    'payout_cooling_period_days', 'minimum_payout', 'payout_verification_limits',
    'transfer_expiry_hours', 'minimum_bank_transfer',
    'messaging_financial_gate', 'messaging_reservation_ttl_seconds'
  ];
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_touches_commercial := NEW.key = ANY(v_commercial_keys);
  ELSIF TG_OP = 'DELETE' THEN
    v_touches_commercial := OLD.key = ANY(v_commercial_keys);
  ELSE -- UPDATE
    v_touches_commercial :=
      OLD.key = ANY(v_commercial_keys)
      OR NEW.key = ANY(v_commercial_keys);
  END IF;

  IF v_touches_commercial THEN
    SELECT r.rolname INTO v_trusted_owner
      FROM pg_proc p
      JOIN pg_roles r ON p.proowner = r.oid
     WHERE p.oid = to_regprocedure('public.save_commercial_config(text,jsonb,text)');

    IF v_trusted_owner IS NULL OR current_user != v_trusted_owner THEN
      RAISE EXCEPTION 'Commercial platform settings must be modified via save_commercial_config()';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$ LANGUAGE plpgsql;

-- ══════════════════════════════════════════════════════════
-- F. Extend authorize_message_send with reservation_expires_at
-- ══════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.authorize_message_send(p_attempt_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  -- Attempt state
  v_attempt RECORD;
  -- Pricing resolution
  v_config RECORD;
  v_pricing JSONB;
  v_currency_bucket JSONB;
  v_resolved_currency TEXT;
  v_resolved_cost INTEGER;
  v_country TEXT;
  v_category TEXT;
  v_matching_currencies TEXT[];
  -- Spend period
  v_period_start TIMESTAMPTZ;
  v_period RECORD;
  -- Allowance reservation
  v_allowance RECORD;
  v_slice INTEGER;
  v_remaining_cost INTEGER;
  v_total_reserved INTEGER := 0;
  v_has_included BOOLEAN := false;
  v_has_purchased BOOLEAN := false;
  v_charge_type TEXT;
  -- Reservation TTL (#261)
  v_ttl_seconds INTEGER;
  v_reservation_expires_at TIMESTAMPTZ;
BEGIN
  -- ── Step 1: Lock attempt row ──
  SELECT * INTO v_attempt
    FROM public.message_send_attempts
    WHERE id = p_attempt_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('authorized', false, 'reason', 'attempt_not_found');
  END IF;

  -- ── Step 2: Check financial_disposition ──
  IF v_attempt.financial_disposition = 'reserved' THEN
    -- Idempotent replay: return existing reservation
    RETURN jsonb_build_object('authorized', true, 'reason', 'already_reserved', 'idempotent', true);
  END IF;

  IF v_attempt.financial_disposition IN ('charged', 'released') THEN
    RETURN jsonb_build_object('authorized', false, 'reason', 'attempt_terminally_settled');
  END IF;

  IF v_attempt.financial_disposition <> 'pending_authorization' THEN
    RETURN jsonb_build_object('authorized', false, 'reason', 'unexpected_disposition');
  END IF;

  -- ── Step 3: Business-only boundary ──
  IF v_attempt.attempt_scope <> 'business' OR v_attempt.business_id IS NULL THEN
    RETURN jsonb_build_object('authorized', false, 'reason', 'not_business_scoped');
  END IF;

  -- ── Step 4: Resolve trusted pricing from effective-dated config ──
  SELECT id, config_snapshot INTO v_config
    FROM public.platform_config_versions
    WHERE effective_from <= NOW()
    ORDER BY effective_from DESC
    LIMIT 1;

  IF v_config.id IS NULL THEN
    RETURN jsonb_build_object('authorized', false, 'reason', 'no_pricing_config');
  END IF;

  v_pricing := v_config.config_snapshot -> 'messaging_pricing';
  IF v_pricing IS NULL OR jsonb_typeof(v_pricing) <> 'object' THEN
    RETURN jsonb_build_object('authorized', false, 'reason', 'no_messaging_pricing');
  END IF;

  -- Resolve country and category from attempt — both required
  v_country := v_attempt.recipient_country_code;
  v_category := v_attempt.message_category;

  IF v_country IS NULL THEN
    RETURN jsonb_build_object('authorized', false, 'reason', 'missing_country_code');
  END IF;

  IF v_category IS NULL THEN
    RETURN jsonb_build_object('authorized', false, 'reason', 'missing_message_category');
  END IF;

  -- Find which currency bucket(s) have explicit country coverage for this country.
  v_matching_currencies := ARRAY[]::TEXT[];
  FOR v_resolved_currency IN SELECT key FROM jsonb_each(v_pricing)
  LOOP
    v_currency_bucket := v_pricing -> v_resolved_currency;
    IF jsonb_typeof(v_currency_bucket) = 'object'
       AND v_currency_bucket -> 'rates' -> v_country IS NOT NULL THEN
      v_matching_currencies := v_matching_currencies || v_resolved_currency;
    END IF;
  END LOOP;

  -- Exactly one currency must match
  IF array_length(v_matching_currencies, 1) IS NULL OR array_length(v_matching_currencies, 1) = 0 THEN
    RETURN jsonb_build_object('authorized', false, 'reason', 'no_currency_for_country');
  END IF;

  IF array_length(v_matching_currencies, 1) > 1 THEN
    RETURN jsonb_build_object('authorized', false, 'reason', 'ambiguous_currency_for_country');
  END IF;

  v_resolved_currency := v_matching_currencies[1];
  v_currency_bucket := v_pricing -> v_resolved_currency;

  -- Resolve rate with accepted precedence
  v_resolved_cost := NULL;

  IF v_currency_bucket -> 'rates' -> v_country -> v_category IS NOT NULL
     AND jsonb_typeof(v_currency_bucket -> 'rates' -> v_country -> v_category) = 'number' THEN
    v_resolved_cost := (v_currency_bucket -> 'rates' -> v_country -> v_category)::INTEGER;
  ELSIF v_currency_bucket -> 'rates' -> v_country -> '*' IS NOT NULL
     AND jsonb_typeof(v_currency_bucket -> 'rates' -> v_country -> '*') = 'number' THEN
    v_resolved_cost := (v_currency_bucket -> 'rates' -> v_country -> '*')::INTEGER;
  ELSIF v_currency_bucket -> 'default_cost_minor' IS NOT NULL
     AND jsonb_typeof(v_currency_bucket -> 'default_cost_minor') = 'number' THEN
    v_resolved_cost := (v_currency_bucket -> 'default_cost_minor')::INTEGER;
  END IF;

  IF v_resolved_cost IS NULL OR v_resolved_cost < 0 THEN
    RETURN jsonb_build_object('authorized', false, 'reason', 'unresolved_rate');
  END IF;

  -- ── Step 4b: Validate against any prepopulated attempt pricing ──
  IF v_attempt.estimated_cost_minor IS NOT NULL AND v_attempt.estimated_cost_minor <> v_resolved_cost THEN
    RETURN jsonb_build_object('authorized', false, 'reason', 'pricing_mismatch',
      'expected_cost', v_resolved_cost, 'prepopulated_cost', v_attempt.estimated_cost_minor);
  END IF;

  IF v_attempt.currency_code IS NOT NULL AND v_attempt.currency_code <> v_resolved_currency THEN
    RETURN jsonb_build_object('authorized', false, 'reason', 'currency_mismatch',
      'expected_currency', v_resolved_currency, 'prepopulated_currency', v_attempt.currency_code);
  END IF;

  IF v_attempt.config_version_id IS NOT NULL AND v_attempt.config_version_id <> v_config.id THEN
    RETURN jsonb_build_object('authorized', false, 'reason', 'config_version_mismatch');
  END IF;

  -- ── Step 4c: Resolve reservation TTL (#261) ──
  v_ttl_seconds := 900;  -- default 15 min
  IF v_config.config_snapshot -> 'messaging_reservation_ttl_seconds' IS NOT NULL
     AND jsonb_typeof(v_config.config_snapshot -> 'messaging_reservation_ttl_seconds') = 'number' THEN
    v_ttl_seconds := (v_config.config_snapshot -> 'messaging_reservation_ttl_seconds')::INTEGER;
    IF v_ttl_seconds <= 0 THEN
      v_ttl_seconds := 900;
    END IF;
  END IF;
  v_reservation_expires_at := NOW() + (v_ttl_seconds * INTERVAL '1 second');

  -- ── Step 5: Determine UTC period key ──
  v_period_start := date_trunc('month', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';

  -- ── Step 6: Find or create spend period ──
  DECLARE
    v_cap_minor INTEGER;
  BEGIN
    v_cap_minor := NULL;
    IF v_currency_bucket -> 'default_spend_cap_minor' IS NOT NULL
       AND jsonb_typeof(v_currency_bucket -> 'default_spend_cap_minor') = 'number' THEN
      v_cap_minor := (v_currency_bucket -> 'default_spend_cap_minor')::INTEGER;
    END IF;

    IF v_cap_minor IS NULL THEN
      RETURN jsonb_build_object('authorized', false, 'reason', 'no_spend_cap_for_currency');
    END IF;

    INSERT INTO public.messaging_spend_periods (business_id, currency_code, period_start, cap_minor, config_version_id)
    VALUES (v_attempt.business_id, v_resolved_currency, v_period_start, v_cap_minor, v_config.id)
    ON CONFLICT (business_id, currency_code, period_start) DO NOTHING;
  END;

  -- ── Step 7: Lock spend-period row ──
  SELECT * INTO v_period
    FROM public.messaging_spend_periods
    WHERE business_id = v_attempt.business_id
      AND currency_code = v_resolved_currency
      AND period_start = v_period_start
    FOR UPDATE;

  -- ── Step 8: Enforce cap headroom ──
  IF v_period.reserved_minor + v_period.spent_minor + v_resolved_cost > v_period.cap_minor THEN
    RETURN jsonb_build_object('authorized', false, 'reason', 'spend_cap_exceeded',
      'cap', v_period.cap_minor, 'reserved', v_period.reserved_minor,
      'spent', v_period.spent_minor, 'cost', v_resolved_cost);
  END IF;

  -- ── Step 9: Lock eligible same-currency allowance rows (FIFO) ──
  v_remaining_cost := v_resolved_cost;

  FOR v_allowance IN
    SELECT * FROM public.messaging_allowances
    WHERE business_id = v_attempt.business_id
      AND currency_code = v_resolved_currency
      AND remaining_minor > 0
      AND (expires_at IS NULL OR expires_at > NOW())
    ORDER BY created_at ASC, id ASC
    FOR UPDATE
  LOOP
    EXIT WHEN v_remaining_cost <= 0;

    v_slice := LEAST(v_allowance.remaining_minor, v_remaining_cost);

    UPDATE public.messaging_allowances
      SET remaining_minor = remaining_minor - v_slice
      WHERE id = v_allowance.id;

    IF v_allowance.type IN ('trial_grant', 'subscription_included', 'promotional') THEN
      v_has_included := true;
    ELSIF v_allowance.type = 'purchased' THEN
      v_has_purchased := true;
    END IF;

    INSERT INTO public.messaging_allowance_events (
      allowance_id, business_id, event_type, amount_minor, attempt_id,
      charge_type, balance_after_minor
    ) VALUES (
      v_allowance.id, v_attempt.business_id, 'reserve', -v_slice, p_attempt_id,
      CASE
        WHEN v_allowance.type IN ('trial_grant', 'subscription_included', 'promotional') THEN 'included'
        ELSE 'overage'
      END,
      v_allowance.remaining_minor - v_slice
    );

    v_remaining_cost := v_remaining_cost - v_slice;
    v_total_reserved := v_total_reserved + v_slice;
  END LOOP;

  IF v_remaining_cost > 0 THEN
    RAISE EXCEPTION 'insufficient_allowance_balance';
  END IF;

  -- ── Step 11b: Determine aggregate charge_type ──
  IF v_has_included AND v_has_purchased THEN
    v_charge_type := 'mixed';
  ELSIF v_has_purchased THEN
    v_charge_type := 'overage';
  ELSE
    v_charge_type := 'included';
  END IF;

  -- ── Step 11c: Append aggregate cost reserve event ──
  INSERT INTO public.message_cost_events (
    attempt_id, event_type, amount_minor, charge_type,
    balance_after_minor, config_version_id
  ) VALUES (
    p_attempt_id, 'reserve', -v_resolved_cost, v_charge_type,
    NULL, v_config.id
  );

  -- ── Step 12: Update period reserved amount ──
  UPDATE public.messaging_spend_periods
    SET reserved_minor = reserved_minor + v_resolved_cost
    WHERE id = v_period.id;

  -- ── Step 13: Atomically bind attempt pricing/period/reservation fields ──
  UPDATE public.message_send_attempts
    SET estimated_cost_minor = v_resolved_cost,
        currency_code = v_resolved_currency,
        config_version_id = v_config.id,
        spend_period_start = v_period_start,
        financial_disposition = 'reserved',
        reserved_at = NOW(),
        reservation_expires_at = v_reservation_expires_at
    WHERE id = p_attempt_id;

  -- ── Step 14: Return success ──
  RETURN jsonb_build_object(
    'authorized', true,
    'charge_type', v_charge_type,
    'cost_minor', v_resolved_cost,
    'currency_code', v_resolved_currency,
    'config_version_id', v_config.id::TEXT,
    'idempotent', false
  );

EXCEPTION
  WHEN OTHERS THEN
    IF SQLERRM = 'insufficient_allowance_balance' THEN
      RETURN jsonb_build_object('authorized', false, 'reason', 'insufficient_allowance_balance');
    END IF;
    RAISE;
END;
$$;

-- Re-apply ACL (single-arg)
REVOKE ALL ON FUNCTION public.authorize_message_send(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.authorize_message_send(UUID) FROM anon;
REVOKE ALL ON FUNCTION public.authorize_message_send(UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.authorize_message_send(UUID) TO service_role;

-- ══════════════════════════════════════════════════════════
-- F1b. authorize_message_send(UUID, UUID, TIMESTAMPTZ) — 3-arg overload
-- C.2: Accepts pre-resolved config_id and decision_time from check_or_authorize_send
-- to prevent independent re-resolution drift. The single-arg version remains for
-- backward compatibility.
-- ══════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.authorize_message_send(
  p_attempt_id UUID,
  p_config_id UUID,
  p_decision_time TIMESTAMPTZ
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  -- Attempt state
  v_attempt RECORD;
  -- Pricing resolution (uses passed config, not re-resolved)
  v_config RECORD;
  v_pricing JSONB;
  v_currency_bucket JSONB;
  v_resolved_currency TEXT;
  v_resolved_cost INTEGER;
  v_country TEXT;
  v_category TEXT;
  v_matching_currencies TEXT[];
  -- Spend period
  v_period_start TIMESTAMPTZ;
  v_period RECORD;
  -- Allowance reservation
  v_allowance RECORD;
  v_slice INTEGER;
  v_remaining_cost INTEGER;
  v_total_reserved INTEGER := 0;
  v_has_included BOOLEAN := false;
  v_has_purchased BOOLEAN := false;
  v_charge_type TEXT;
  -- Reservation TTL (#261)
  v_ttl_seconds INTEGER;
  v_reservation_expires_at TIMESTAMPTZ;
BEGIN
  -- ── Step 0: Verify p_config_id exists and is effective as of p_decision_time ──
  SELECT id, config_snapshot INTO v_config
    FROM public.platform_config_versions
    WHERE id = p_config_id
      AND effective_from <= p_decision_time;

  IF v_config.id IS NULL THEN
    RETURN jsonb_build_object('authorized', false, 'reason', 'config_not_found_or_not_effective');
  END IF;

  -- ── Step 1: Lock attempt row ──
  SELECT * INTO v_attempt
    FROM public.message_send_attempts
    WHERE id = p_attempt_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('authorized', false, 'reason', 'attempt_not_found');
  END IF;

  -- ── Step 2: Check financial_disposition ──
  IF v_attempt.financial_disposition = 'reserved' THEN
    RETURN jsonb_build_object('authorized', true, 'reason', 'already_reserved', 'idempotent', true);
  END IF;

  IF v_attempt.financial_disposition IN ('charged', 'released') THEN
    RETURN jsonb_build_object('authorized', false, 'reason', 'attempt_terminally_settled');
  END IF;

  IF v_attempt.financial_disposition <> 'pending_authorization' THEN
    RETURN jsonb_build_object('authorized', false, 'reason', 'unexpected_disposition');
  END IF;

  -- ── Step 3: Business-only boundary ──
  IF v_attempt.attempt_scope <> 'business' OR v_attempt.business_id IS NULL THEN
    RETURN jsonb_build_object('authorized', false, 'reason', 'not_business_scoped');
  END IF;

  -- ── Step 4: Resolve trusted pricing from passed config (no re-resolution) ──
  v_pricing := v_config.config_snapshot -> 'messaging_pricing';
  IF v_pricing IS NULL OR jsonb_typeof(v_pricing) <> 'object' THEN
    RETURN jsonb_build_object('authorized', false, 'reason', 'no_messaging_pricing');
  END IF;

  v_country := v_attempt.recipient_country_code;
  v_category := v_attempt.message_category;

  IF v_country IS NULL THEN
    RETURN jsonb_build_object('authorized', false, 'reason', 'missing_country_code');
  END IF;

  IF v_category IS NULL THEN
    RETURN jsonb_build_object('authorized', false, 'reason', 'missing_message_category');
  END IF;

  v_matching_currencies := ARRAY[]::TEXT[];
  FOR v_resolved_currency IN SELECT key FROM jsonb_each(v_pricing)
  LOOP
    v_currency_bucket := v_pricing -> v_resolved_currency;
    IF jsonb_typeof(v_currency_bucket) = 'object'
       AND v_currency_bucket -> 'rates' -> v_country IS NOT NULL THEN
      v_matching_currencies := v_matching_currencies || v_resolved_currency;
    END IF;
  END LOOP;

  IF array_length(v_matching_currencies, 1) IS NULL OR array_length(v_matching_currencies, 1) = 0 THEN
    RETURN jsonb_build_object('authorized', false, 'reason', 'no_currency_for_country');
  END IF;

  IF array_length(v_matching_currencies, 1) > 1 THEN
    RETURN jsonb_build_object('authorized', false, 'reason', 'ambiguous_currency_for_country');
  END IF;

  v_resolved_currency := v_matching_currencies[1];
  v_currency_bucket := v_pricing -> v_resolved_currency;

  v_resolved_cost := NULL;
  IF v_currency_bucket -> 'rates' -> v_country -> v_category IS NOT NULL
     AND jsonb_typeof(v_currency_bucket -> 'rates' -> v_country -> v_category) = 'number' THEN
    v_resolved_cost := (v_currency_bucket -> 'rates' -> v_country -> v_category)::INTEGER;
  ELSIF v_currency_bucket -> 'rates' -> v_country -> '*' IS NOT NULL
     AND jsonb_typeof(v_currency_bucket -> 'rates' -> v_country -> '*') = 'number' THEN
    v_resolved_cost := (v_currency_bucket -> 'rates' -> v_country -> '*')::INTEGER;
  ELSIF v_currency_bucket -> 'default_cost_minor' IS NOT NULL
     AND jsonb_typeof(v_currency_bucket -> 'default_cost_minor') = 'number' THEN
    v_resolved_cost := (v_currency_bucket -> 'default_cost_minor')::INTEGER;
  END IF;

  IF v_resolved_cost IS NULL OR v_resolved_cost < 0 THEN
    RETURN jsonb_build_object('authorized', false, 'reason', 'unresolved_rate');
  END IF;

  -- ── Step 4b: Validate against any prepopulated attempt pricing ──
  IF v_attempt.estimated_cost_minor IS NOT NULL AND v_attempt.estimated_cost_minor <> v_resolved_cost THEN
    RETURN jsonb_build_object('authorized', false, 'reason', 'pricing_mismatch',
      'expected_cost', v_resolved_cost, 'prepopulated_cost', v_attempt.estimated_cost_minor);
  END IF;

  IF v_attempt.currency_code IS NOT NULL AND v_attempt.currency_code <> v_resolved_currency THEN
    RETURN jsonb_build_object('authorized', false, 'reason', 'currency_mismatch',
      'expected_currency', v_resolved_currency, 'prepopulated_currency', v_attempt.currency_code);
  END IF;

  IF v_attempt.config_version_id IS NOT NULL AND v_attempt.config_version_id <> v_config.id THEN
    RETURN jsonb_build_object('authorized', false, 'reason', 'config_version_mismatch');
  END IF;

  -- ── Step 4c: Resolve reservation TTL (#261) ──
  v_ttl_seconds := 900;
  IF v_config.config_snapshot -> 'messaging_reservation_ttl_seconds' IS NOT NULL
     AND jsonb_typeof(v_config.config_snapshot -> 'messaging_reservation_ttl_seconds') = 'number' THEN
    v_ttl_seconds := (v_config.config_snapshot -> 'messaging_reservation_ttl_seconds')::INTEGER;
    IF v_ttl_seconds <= 0 THEN
      v_ttl_seconds := 900;
    END IF;
  END IF;
  v_reservation_expires_at := p_decision_time + (v_ttl_seconds * INTERVAL '1 second');

  -- ── Step 5: Determine UTC period key (uses p_decision_time) ──
  v_period_start := date_trunc('month', p_decision_time AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';

  -- ── Step 6: Find or create spend period ──
  DECLARE
    v_cap_minor INTEGER;
  BEGIN
    v_cap_minor := NULL;
    IF v_currency_bucket -> 'default_spend_cap_minor' IS NOT NULL
       AND jsonb_typeof(v_currency_bucket -> 'default_spend_cap_minor') = 'number' THEN
      v_cap_minor := (v_currency_bucket -> 'default_spend_cap_minor')::INTEGER;
    END IF;

    IF v_cap_minor IS NULL THEN
      RETURN jsonb_build_object('authorized', false, 'reason', 'no_spend_cap_for_currency');
    END IF;

    INSERT INTO public.messaging_spend_periods (business_id, currency_code, period_start, cap_minor, config_version_id)
    VALUES (v_attempt.business_id, v_resolved_currency, v_period_start, v_cap_minor, v_config.id)
    ON CONFLICT (business_id, currency_code, period_start) DO NOTHING;
  END;

  -- ── Step 7: Lock spend-period row ──
  SELECT * INTO v_period
    FROM public.messaging_spend_periods
    WHERE business_id = v_attempt.business_id
      AND currency_code = v_resolved_currency
      AND period_start = v_period_start
    FOR UPDATE;

  -- ── Step 8: Enforce cap headroom ──
  IF v_period.reserved_minor + v_period.spent_minor + v_resolved_cost > v_period.cap_minor THEN
    RETURN jsonb_build_object('authorized', false, 'reason', 'spend_cap_exceeded',
      'cap', v_period.cap_minor, 'reserved', v_period.reserved_minor,
      'spent', v_period.spent_minor, 'cost', v_resolved_cost);
  END IF;

  -- ── Step 9: Lock eligible same-currency allowance rows (FIFO) ──
  v_remaining_cost := v_resolved_cost;

  FOR v_allowance IN
    SELECT * FROM public.messaging_allowances
    WHERE business_id = v_attempt.business_id
      AND currency_code = v_resolved_currency
      AND remaining_minor > 0
      AND (expires_at IS NULL OR expires_at > p_decision_time)
    ORDER BY created_at ASC, id ASC
    FOR UPDATE
  LOOP
    EXIT WHEN v_remaining_cost <= 0;

    v_slice := LEAST(v_allowance.remaining_minor, v_remaining_cost);

    UPDATE public.messaging_allowances
      SET remaining_minor = remaining_minor - v_slice
      WHERE id = v_allowance.id;

    IF v_allowance.type IN ('trial_grant', 'subscription_included', 'promotional') THEN
      v_has_included := true;
    ELSIF v_allowance.type = 'purchased' THEN
      v_has_purchased := true;
    END IF;

    INSERT INTO public.messaging_allowance_events (
      allowance_id, business_id, event_type, amount_minor, attempt_id,
      charge_type, balance_after_minor
    ) VALUES (
      v_allowance.id, v_attempt.business_id, 'reserve', -v_slice, p_attempt_id,
      CASE
        WHEN v_allowance.type IN ('trial_grant', 'subscription_included', 'promotional') THEN 'included'
        ELSE 'overage'
      END,
      v_allowance.remaining_minor - v_slice
    );

    v_remaining_cost := v_remaining_cost - v_slice;
    v_total_reserved := v_total_reserved + v_slice;
  END LOOP;

  IF v_remaining_cost > 0 THEN
    RAISE EXCEPTION 'insufficient_allowance_balance';
  END IF;

  -- ── Step 11b: Determine aggregate charge_type ──
  IF v_has_included AND v_has_purchased THEN
    v_charge_type := 'mixed';
  ELSIF v_has_purchased THEN
    v_charge_type := 'overage';
  ELSE
    v_charge_type := 'included';
  END IF;

  -- ── Step 11c: Append aggregate cost reserve event ──
  INSERT INTO public.message_cost_events (
    attempt_id, event_type, amount_minor, charge_type,
    balance_after_minor, config_version_id
  ) VALUES (
    p_attempt_id, 'reserve', -v_resolved_cost, v_charge_type,
    NULL, v_config.id
  );

  -- ── Step 12: Update period reserved amount ──
  UPDATE public.messaging_spend_periods
    SET reserved_minor = reserved_minor + v_resolved_cost
    WHERE id = v_period.id;

  -- ── Step 13: Atomically bind attempt pricing/period/reservation fields ──
  UPDATE public.message_send_attempts
    SET estimated_cost_minor = v_resolved_cost,
        currency_code = v_resolved_currency,
        config_version_id = v_config.id,
        spend_period_start = v_period_start,
        financial_disposition = 'reserved',
        reserved_at = p_decision_time,
        reservation_expires_at = v_reservation_expires_at
    WHERE id = p_attempt_id;

  -- ── Step 14: Return success ──
  RETURN jsonb_build_object(
    'authorized', true,
    'charge_type', v_charge_type,
    'cost_minor', v_resolved_cost,
    'currency_code', v_resolved_currency,
    'config_version_id', v_config.id::TEXT,
    'idempotent', false
  );

EXCEPTION
  WHEN OTHERS THEN
    IF SQLERRM = 'insufficient_allowance_balance' THEN
      RETURN jsonb_build_object('authorized', false, 'reason', 'insufficient_allowance_balance');
    END IF;
    RAISE;
END;
$$;

-- ACL: 3-arg overload — service-role only
REVOKE ALL ON FUNCTION public.authorize_message_send(UUID, UUID, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.authorize_message_send(UUID, UUID, TIMESTAMPTZ) FROM anon;
REVOKE ALL ON FUNCTION public.authorize_message_send(UUID, UUID, TIMESTAMPTZ) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.authorize_message_send(UUID, UUID, TIMESTAMPTZ) TO service_role;

-- Re-apply settle_message_cost ACL (unchanged function, but ensure grants persist)
REVOKE ALL ON FUNCTION public.settle_message_cost(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.settle_message_cost(UUID, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.settle_message_cost(UUID, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.settle_message_cost(UUID, TEXT) TO service_role;

-- ══════════════════════════════════════════════════════════
-- F2. reservation_expires_at immutability — extend enforce_disposition_transitions
-- ══════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.enforce_disposition_transitions()
RETURNS TRIGGER AS $$
BEGIN
  -- Write-once: terminal states are immutable
  IF OLD.financial_disposition IN ('charged', 'released')
     AND NEW.financial_disposition <> OLD.financial_disposition THEN
    RAISE EXCEPTION 'financial_disposition is write-once after terminal settlement: cannot change from % to %',
      OLD.financial_disposition, NEW.financial_disposition;
  END IF;

  -- Only valid transitions
  IF NOT (
    (OLD.financial_disposition = 'pending_authorization' AND NEW.financial_disposition = 'reserved') OR
    (OLD.financial_disposition = 'reserved' AND NEW.financial_disposition IN ('charged', 'released')) OR
    (OLD.financial_disposition = NEW.financial_disposition)  -- no-op
  ) THEN
    RAISE EXCEPTION 'Invalid financial_disposition transition: % → %',
      OLD.financial_disposition, NEW.financial_disposition;
  END IF;

  -- spend_period_start is immutable after binding
  IF OLD.spend_period_start IS NOT NULL
     AND NEW.spend_period_start IS DISTINCT FROM OLD.spend_period_start THEN
    RAISE EXCEPTION 'spend_period_start is immutable after binding';
  END IF;

  -- reservation_expires_at is immutable after binding (#261)
  IF OLD.reservation_expires_at IS NOT NULL
     AND NEW.reservation_expires_at IS DISTINCT FROM OLD.reservation_expires_at THEN
    RAISE EXCEPTION 'reservation_expires_at is immutable after binding';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ══════════════════════════════════════════════════════════
-- F3. drain_unmatched_attempt_statuses — race-safe buffer drain (#261 C.4)
-- Atomically drains buffered delivery statuses for a WAMID and settles them.
-- Uses FOR UPDATE to prevent concurrent drain races.
-- ══════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.drain_unmatched_attempt_statuses(
  p_attempt_id UUID,
  p_wamid TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row RECORD;
  v_drained INTEGER := 0;
  v_settled INTEGER := 0;
  v_attempt RECORD;
  v_outcome TEXT;
  v_settle_result JSONB;
BEGIN
  -- Verify the attempt exists and has the given WAMID
  SELECT id, financial_disposition INTO v_attempt
    FROM public.message_send_attempts
    WHERE id = p_attempt_id AND meta_message_id = p_wamid;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('drained', 0, 'settled', 0, 'reason', 'attempt_wamid_mismatch');
  END IF;

  -- Lock and iterate buffered statuses for this WAMID
  FOR v_row IN
    SELECT * FROM public.unmatched_attempt_delivery_statuses
    WHERE meta_message_id = p_wamid
      AND settled = false
    FOR UPDATE SKIP LOCKED
  LOOP
    v_drained := v_drained + 1;

    -- Determine outcome based on status
    IF v_row.status IN ('delivered', 'read') THEN
      v_outcome := 'charged';
    ELSIF v_row.status = 'failed' THEN
      v_outcome := 'released';
    ELSE
      -- 'sent' → no settlement action, just mark settled
      UPDATE public.unmatched_attempt_delivery_statuses
        SET settled = true, settled_at = NOW()
        WHERE id = v_row.id;
      v_settled := v_settled + 1;
      CONTINUE;
    END IF;

    -- Only settle if attempt is still reserved
    IF v_attempt.financial_disposition = 'reserved' THEN
      BEGIN
        v_settle_result := public.settle_message_cost(p_attempt_id, v_outcome);
        -- Re-read disposition after settlement
        SELECT financial_disposition INTO v_attempt.financial_disposition
          FROM public.message_send_attempts WHERE id = p_attempt_id;

        UPDATE public.unmatched_attempt_delivery_statuses
          SET settled = true, settled_at = NOW()
          WHERE id = v_row.id;
        v_settled := v_settled + 1;
      EXCEPTION WHEN OTHERS THEN
        -- Settlement failed: log but preserve evidence (do NOT delete the row)
        -- Mark attempt for reconciliation
        UPDATE public.message_send_attempts
          SET needs_reconciliation = true
          WHERE id = p_attempt_id;
      END;
    ELSE
      -- Already terminal — mark row settled but don't try to re-settle
      UPDATE public.unmatched_attempt_delivery_statuses
        SET settled = true, settled_at = NOW()
        WHERE id = v_row.id;
      v_settled := v_settled + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('drained', v_drained, 'settled', v_settled);
END;
$$;

-- ACL: service-role only
REVOKE ALL ON FUNCTION public.drain_unmatched_attempt_statuses(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.drain_unmatched_attempt_statuses(UUID, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.drain_unmatched_attempt_statuses(UUID, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.drain_unmatched_attempt_statuses(UUID, TEXT) TO service_role;

-- ══════════════════════════════════════════════════════════
-- G. Verification block
-- ══════════════════════════════════════════════════════════

DO $$
DECLARE
  v_count INT;
BEGIN
  -- Verify check_or_authorize_send exists and is SECURITY DEFINER
  SELECT count(*) INTO v_count FROM pg_proc
    WHERE proname = 'check_or_authorize_send' AND prosecdef = true;
  IF v_count = 0 THEN
    RAISE EXCEPTION 'MIGRATION 371 VERIFICATION FAILED: check_or_authorize_send not created or not SECURITY DEFINER';
  END IF;

  -- Verify grant_messaging_allowance exists and is SECURITY DEFINER
  SELECT count(*) INTO v_count FROM pg_proc
    WHERE proname = 'grant_messaging_allowance' AND prosecdef = true;
  IF v_count = 0 THEN
    RAISE EXCEPTION 'MIGRATION 371 VERIFICATION FAILED: grant_messaging_allowance not created or not SECURITY DEFINER';
  END IF;

  -- Verify resolve_message_cost_reconciliation exists and is SECURITY DEFINER
  SELECT count(*) INTO v_count FROM pg_proc
    WHERE proname = 'resolve_message_cost_reconciliation' AND prosecdef = true;
  IF v_count = 0 THEN
    RAISE EXCEPTION 'MIGRATION 371 VERIFICATION FAILED: resolve_message_cost_reconciliation not created or not SECURITY DEFINER';
  END IF;

  -- Verify messaging_spend_threshold_alerts exists with RLS
  SELECT count(*) INTO v_count FROM pg_class
    WHERE relname = 'messaging_spend_threshold_alerts' AND relrowsecurity = true;
  IF v_count = 0 THEN
    RAISE EXCEPTION 'MIGRATION 371 VERIFICATION FAILED: messaging_spend_threshold_alerts not created or RLS not enabled';
  END IF;

  -- Verify unmatched_attempt_delivery_statuses exists with RLS
  SELECT count(*) INTO v_count FROM pg_class
    WHERE relname = 'unmatched_attempt_delivery_statuses' AND relrowsecurity = true;
  IF v_count = 0 THEN
    RAISE EXCEPTION 'MIGRATION 371 VERIFICATION FAILED: unmatched_attempt_delivery_statuses not created or RLS not enabled';
  END IF;

  -- Verify message_cost_reconciliation_log exists with RLS
  SELECT count(*) INTO v_count FROM pg_class
    WHERE relname = 'message_cost_reconciliation_log' AND relrowsecurity = true;
  IF v_count = 0 THEN
    RAISE EXCEPTION 'MIGRATION 371 VERIFICATION FAILED: message_cost_reconciliation_log not created or RLS not enabled';
  END IF;

  -- Verify append-only triggers on reconciliation_log
  SELECT count(*) INTO v_count FROM pg_trigger
    WHERE tgrelid = 'public.message_cost_reconciliation_log'::regclass
      AND tgname = 'trg_reconciliation_log_no_update';
  IF v_count = 0 THEN
    RAISE EXCEPTION 'MIGRATION 371 VERIFICATION FAILED: reconciliation_log append-only trigger missing';
  END IF;

  -- Verify save_commercial_config includes new keys in its body
  -- (check function source contains 'messaging_financial_gate')
  SELECT count(*) INTO v_count FROM pg_proc
    WHERE proname = 'save_commercial_config'
      AND prosrc LIKE '%messaging_financial_gate%';
  IF v_count = 0 THEN
    RAISE EXCEPTION 'MIGRATION 371 VERIFICATION FAILED: save_commercial_config does not include messaging_financial_gate';
  END IF;

  -- Verify authorize_message_send includes reservation_expires_at
  SELECT count(*) INTO v_count FROM pg_proc
    WHERE proname = 'authorize_message_send'
      AND prosrc LIKE '%reservation_expires_at%';
  IF v_count = 0 THEN
    RAISE EXCEPTION 'MIGRATION 371 VERIFICATION FAILED: authorize_message_send does not include reservation_expires_at';
  END IF;

  -- Verify enforce_disposition_transitions includes reservation_expires_at
  SELECT count(*) INTO v_count FROM pg_proc
    WHERE proname = 'enforce_disposition_transitions'
      AND prosrc LIKE '%reservation_expires_at%';
  IF v_count = 0 THEN
    RAISE EXCEPTION 'MIGRATION 371 VERIFICATION FAILED: enforce_disposition_transitions does not include reservation_expires_at immutability';
  END IF;

  -- Verify authorize_message_send 3-arg overload exists
  SELECT count(*) INTO v_count FROM pg_proc
    WHERE proname = 'authorize_message_send'
      AND pronargs = 3
      AND prosecdef = true;
  IF v_count = 0 THEN
    RAISE EXCEPTION 'MIGRATION 371 VERIFICATION FAILED: authorize_message_send 3-arg overload not created or not SECURITY DEFINER';
  END IF;

  -- Verify drain_unmatched_attempt_statuses exists
  SELECT count(*) INTO v_count FROM pg_proc
    WHERE proname = 'drain_unmatched_attempt_statuses' AND prosecdef = true;
  IF v_count = 0 THEN
    RAISE EXCEPTION 'MIGRATION 371 VERIFICATION FAILED: drain_unmatched_attempt_statuses not created or not SECURITY DEFINER';
  END IF;

  -- Verify RLS policies on new tables
  SELECT count(*) INTO v_count FROM pg_policy
    WHERE polrelid = 'messaging_spend_threshold_alerts'::regclass AND polname = 'msta_owner_select';
  IF v_count = 0 THEN
    RAISE EXCEPTION 'MIGRATION 371 VERIFICATION FAILED: msta_owner_select policy missing';
  END IF;

  SELECT count(*) INTO v_count FROM pg_policy
    WHERE polrelid = 'message_cost_reconciliation_log'::regclass AND polname = 'mcrl_admin_select';
  IF v_count = 0 THEN
    RAISE EXCEPTION 'MIGRATION 371 VERIFICATION FAILED: mcrl_admin_select policy missing';
  END IF;

END;
$$;

-- ══════════════════════════════════════════════════════════
-- DB-atomic reservation expiry authority
--
-- Revalidates ALL safety predicates (reserved + pending_authorization +
-- expired + no WAMID + !needs_reconciliation) at the same linearization
-- point as release. If any predicate changed between the cron's query
-- and this function, the release is NOT performed.
-- ══════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.safe_release_expired_reservation(p_attempt_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_attempt RECORD;
  v_result JSONB;
BEGIN
  -- Lock the attempt atomically
  SELECT * INTO v_attempt
    FROM public.message_send_attempts
    WHERE id = p_attempt_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('released', false, 'reason', 'attempt_not_found');
  END IF;

  -- Revalidate ALL safety predicates atomically:
  -- 1. Must still be reserved
  IF v_attempt.financial_disposition <> 'reserved' THEN
    RETURN jsonb_build_object('released', false, 'reason', 'not_reserved',
      'disposition', v_attempt.financial_disposition);
  END IF;

  -- 2. Must still be pre-emission (pending_authorization)
  IF v_attempt.status <> 'pending_authorization' THEN
    -- Attempt has advanced to sending/accepted/ambiguous — NOT safe
    -- Flag for reconciliation
    UPDATE public.message_send_attempts
      SET needs_reconciliation = true
      WHERE id = p_attempt_id AND needs_reconciliation = false;
    RETURN jsonb_build_object('released', false, 'reason', 'not_pre_emission',
      'status', v_attempt.status);
  END IF;

  -- 3. Must not have a WAMID (no emission evidence)
  IF v_attempt.meta_message_id IS NOT NULL THEN
    UPDATE public.message_send_attempts
      SET needs_reconciliation = true
      WHERE id = p_attempt_id AND needs_reconciliation = false;
    RETURN jsonb_build_object('released', false, 'reason', 'has_wamid');
  END IF;

  -- 4. Must not already be flagged for reconciliation
  IF v_attempt.needs_reconciliation = true THEN
    RETURN jsonb_build_object('released', false, 'reason', 'needs_reconciliation');
  END IF;

  -- 5. Must have an expired deadline
  IF v_attempt.reservation_expires_at IS NULL THEN
    -- Missing deadline — flag, do NOT synthesize
    UPDATE public.message_send_attempts
      SET needs_reconciliation = true
      WHERE id = p_attempt_id;
    RETURN jsonb_build_object('released', false, 'reason', 'missing_deadline');
  END IF;

  IF v_attempt.reservation_expires_at > clock_timestamp() THEN
    RETURN jsonb_build_object('released', false, 'reason', 'not_expired');
  END IF;

  -- All predicates pass — delegate to #260 settlement authority
  v_result := public.settle_message_cost(p_attempt_id, 'released');

  -- Check the RPC result — settled:false is NOT released
  IF (v_result ->> 'settled')::boolean = true THEN
    RETURN jsonb_build_object('released', true, 'settlement', v_result);
  ELSE
    -- Settlement rejected (e.g., already settled) — flag
    UPDATE public.message_send_attempts
      SET needs_reconciliation = true
      WHERE id = p_attempt_id AND needs_reconciliation = false;
    RETURN jsonb_build_object('released', false, 'reason', 'settlement_rejected',
      'settlement', v_result);
  END IF;
END;
$$;

-- ACL: service-role only
REVOKE ALL ON FUNCTION public.safe_release_expired_reservation(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.safe_release_expired_reservation(UUID) FROM anon;
REVOKE ALL ON FUNCTION public.safe_release_expired_reservation(UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.safe_release_expired_reservation(UUID) TO service_role;

-- ══════════════════════════════════════════════════════════
-- Cross-state invariant: block entry into 'sending' when
-- financial_disposition is terminally settled ('released' or 'charged').
--
-- This prevents the expiry/send race: if expiry releases a reservation
-- while a concurrent sender is waiting behind the row lock, the sender
-- wakes to find disposition='released' and is blocked from entering
-- 'sending', ensuring zero post-release Meta emission.
-- ══════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.guard_sending_requires_valid_reservation()
RETURNS TRIGGER AS $$
BEGIN
  -- Only enforce on transitions INTO 'sending'
  IF NEW.status = 'sending' AND OLD.status <> 'sending' THEN
    -- Check the CURRENT financial_disposition (which may have been changed
    -- by a concurrent transaction that committed while we were waiting)
    IF NEW.financial_disposition IN ('released', 'charged') THEN
      RAISE EXCEPTION 'Cannot enter sending: financial_disposition is terminally settled (%)',
        NEW.financial_disposition;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_guard_sending_reservation
  BEFORE UPDATE ON public.message_send_attempts FOR EACH ROW
  EXECUTE FUNCTION public.guard_sending_requires_valid_reservation();

-- Post-creation verification
DO $$
DECLARE v_count INT;
BEGIN
  SELECT count(*) INTO v_count FROM pg_proc WHERE proname = 'safe_release_expired_reservation' AND prosecdef = true;
  IF v_count = 0 THEN
    RAISE EXCEPTION 'MIGRATION 371 VERIFICATION FAILED: safe_release_expired_reservation not created or not SECURITY DEFINER';
  END IF;

  SELECT count(*) INTO v_count FROM pg_trigger
    WHERE tgrelid = 'public.message_send_attempts'::regclass
      AND tgname = 'trg_guard_sending_reservation';
  IF v_count = 0 THEN
    RAISE EXCEPTION 'MIGRATION 371 VERIFICATION FAILED: trg_guard_sending_reservation not created';
  END IF;
END;
$$;
