-- ═══════════════════════════════════════════════════════
-- 376: Fee Policy Pinning (#264)
--
-- Surfaces:
--   ALTERED: payments — add fee_policy_version, config_version_id FK,
--            transaction_category, fee_basis, provider_init_state
--   NEW TRIGGER: validate_fee_basis — structural validation of v1 fee authority
--   NEW TRIGGER: guard_fee_policy_immutability — freeze v1 authority fields
--   ALTERED: save_commercial_config / guard_commercial_settings — new keys
-- ═══════════════════════════════════════════════════════

-- ══════════════════════════════════════════════════════════
-- A. Schema extensions on payments
-- ══════════════════════════════════════════════════════════

-- A1. Fee policy version: 0 = legacy, 1 = fee-policy-active
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS fee_policy_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE public.payments ADD CONSTRAINT chk_fee_policy_version_values
  CHECK (fee_policy_version IN (0, 1));

-- A2. Config version FK (pinned commercial snapshot)
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS config_version_id UUID
  REFERENCES public.platform_config_versions(id);

-- A3. Transaction category (server-derived, closed vocabulary)
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS transaction_category TEXT;
ALTER TABLE public.payments ADD CONSTRAINT chk_transaction_category_valid
  CHECK (transaction_category IS NULL
    OR transaction_category IN ('scheduling', 'reservation', 'ticketing',
       'ordering', 'invoice', 'giving', 'payment', 'recurring'));

-- A4. Fee basis (immutable resolved fee inputs for v1)
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS fee_basis JSONB;

-- A5. Provider init state (durable dispatch lifecycle)
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS provider_init_state TEXT;
ALTER TABLE public.payments ADD CONSTRAINT chk_provider_init_state_valid
  CHECK (provider_init_state IS NULL
    OR provider_init_state IN ('pre_dispatch', 'dispatched', 'provider_confirmed'));

-- A6. V1 completeness: fee-policy-active rows must have full binding
ALTER TABLE public.payments ADD CONSTRAINT chk_fee_policy_v1_complete
  CHECK (fee_policy_version = 0
    OR (config_version_id IS NOT NULL
        AND transaction_category IS NOT NULL
        AND fee_basis IS NOT NULL));

-- ══════════════════════════════════════════════════════════
-- B. Fee basis structural validation trigger (BEFORE INSERT)
-- ══════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.validate_fee_basis()
RETURNS TRIGGER AS $$
DECLARE
  v_key TEXT;
  v_allowed_keys TEXT[] := ARRAY[
    'payment_routing', 'tier', 'is_in_trial',
    'custom_fee_percentage', 'custom_fee_flat'
  ];
BEGIN
  IF NEW.fee_policy_version >= 1 THEN
    -- fee_basis must be a JSON object
    IF NEW.fee_basis IS NULL OR jsonb_typeof(NEW.fee_basis) <> 'object' THEN
      RAISE EXCEPTION 'fee_basis must be a non-null JSON object for fee_policy_version >= 1';
    END IF;

    -- All five keys must be present (null values allowed, missing keys not)
    IF NOT (NEW.fee_basis ? 'payment_routing'
        AND NEW.fee_basis ? 'tier'
        AND NEW.fee_basis ? 'is_in_trial'
        AND NEW.fee_basis ? 'custom_fee_percentage'
        AND NEW.fee_basis ? 'custom_fee_flat') THEN
      RAISE EXCEPTION 'fee_basis must contain all five required keys: payment_routing, tier, is_in_trial, custom_fee_percentage, custom_fee_flat';
    END IF;

    -- Reject unknown keys
    FOR v_key IN SELECT key FROM jsonb_object_keys(NEW.fee_basis) AS key
    LOOP
      IF NOT (v_key = ANY(v_allowed_keys)) THEN
        RAISE EXCEPTION 'fee_basis contains unknown key: %', v_key;
      END IF;
    END LOOP;

    -- payment_routing: required, closed enum
    IF NEW.fee_basis ->> 'payment_routing' IS NULL
       OR NEW.fee_basis ->> 'payment_routing' NOT IN ('platform', 'byo', 'connect') THEN
      RAISE EXCEPTION 'fee_basis.payment_routing must be platform, byo, or connect';
    END IF;

    -- tier: required, closed enum
    IF NEW.fee_basis ->> 'tier' IS NULL
       OR NEW.fee_basis ->> 'tier' NOT IN ('free', 'growth', 'business') THEN
      RAISE EXCEPTION 'fee_basis.tier must be free, growth, or business';
    END IF;

    -- is_in_trial: required boolean
    IF (NEW.fee_basis -> 'is_in_trial') IS NULL
       OR jsonb_typeof(NEW.fee_basis -> 'is_in_trial') <> 'boolean' THEN
      RAISE EXCEPTION 'fee_basis.is_in_trial must be a boolean';
    END IF;

    -- custom_fee_percentage: must be present (null or valid number 0-100)
    IF jsonb_typeof(NEW.fee_basis -> 'custom_fee_percentage') = 'number' THEN
      IF (NEW.fee_basis ->> 'custom_fee_percentage')::NUMERIC < 0
         OR (NEW.fee_basis ->> 'custom_fee_percentage')::NUMERIC > 100 THEN
        RAISE EXCEPTION 'fee_basis.custom_fee_percentage must be 0-100';
      END IF;
    ELSIF jsonb_typeof(NEW.fee_basis -> 'custom_fee_percentage') <> 'null' THEN
      RAISE EXCEPTION 'fee_basis.custom_fee_percentage must be null or a number 0-100';
    END IF;

    -- custom_fee_flat: must be present (null or valid non-negative number)
    IF jsonb_typeof(NEW.fee_basis -> 'custom_fee_flat') = 'number' THEN
      IF (NEW.fee_basis ->> 'custom_fee_flat')::NUMERIC < 0 THEN
        RAISE EXCEPTION 'fee_basis.custom_fee_flat must be non-negative';
      END IF;
    ELSIF jsonb_typeof(NEW.fee_basis -> 'custom_fee_flat') <> 'null' THEN
      RAISE EXCEPTION 'fee_basis.custom_fee_flat must be null or a non-negative number';
    END IF;

    -- Validate fee_basis currency matches payment currency
    -- (currency is NOT in fee_basis — payments.currency is the sole authority)
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_validate_fee_basis
  BEFORE INSERT ON public.payments FOR EACH ROW
  EXECUTE FUNCTION public.validate_fee_basis();

-- ══════════════════════════════════════════════════════════
-- C. Fee policy immutability trigger (BEFORE UPDATE)
-- ══════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.guard_fee_policy_immutability()
RETURNS TRIGGER AS $$
BEGIN
  -- fee_policy_version is immutable for ALL rows after creation
  IF OLD.fee_policy_version IS DISTINCT FROM NEW.fee_policy_version THEN
    RAISE EXCEPTION 'fee_policy_version is immutable after creation';
  END IF;

  -- For v1 rows: full fee-authority binding is immutable
  IF OLD.fee_policy_version >= 1 THEN
    IF NEW.config_version_id IS DISTINCT FROM OLD.config_version_id THEN
      RAISE EXCEPTION 'config_version_id is immutable for fee-policy-active payments';
    END IF;
    IF NEW.transaction_category IS DISTINCT FROM OLD.transaction_category THEN
      RAISE EXCEPTION 'transaction_category is immutable for fee-policy-active payments';
    END IF;
    IF NEW.fee_basis IS DISTINCT FROM OLD.fee_basis THEN
      RAISE EXCEPTION 'fee_basis is immutable for fee-policy-active payments';
    END IF;
    IF NEW.amount IS DISTINCT FROM OLD.amount THEN
      RAISE EXCEPTION 'amount is immutable for fee-policy-active payments';
    END IF;
    IF NEW.currency IS DISTINCT FROM OLD.currency THEN
      RAISE EXCEPTION 'currency is immutable for fee-policy-active payments';
    END IF;
  END IF;

  -- v0 rows cannot acquire a config_version_id after creation
  IF OLD.fee_policy_version = 0 AND OLD.config_version_id IS NULL
     AND NEW.config_version_id IS NOT NULL THEN
    RAISE EXCEPTION 'v0 payments cannot acquire config_version_id';
  END IF;

  -- provider_init_state exact forward graph:
  -- NULL → pre_dispatch → dispatched → provider_confirmed (or NULL unchanged)
  -- Any other transition is rejected.
  IF OLD.provider_init_state IS DISTINCT FROM NEW.provider_init_state THEN
    IF NOT (
      (OLD.provider_init_state IS NULL AND NEW.provider_init_state = 'pre_dispatch')
      OR (OLD.provider_init_state = 'pre_dispatch' AND NEW.provider_init_state = 'dispatched')
      OR (OLD.provider_init_state = 'dispatched' AND NEW.provider_init_state = 'provider_confirmed')
      OR (NEW.provider_init_state IS NULL AND OLD.provider_init_state IS NULL)
    ) THEN
      RAISE EXCEPTION 'Invalid provider_init_state transition: % → %', OLD.provider_init_state, NEW.provider_init_state;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_guard_fee_policy_immutability
  BEFORE UPDATE ON public.payments FOR EACH ROW
  EXECUTE FUNCTION public.guard_fee_policy_immutability();

-- ══════════════════════════════════════════════════════════
-- D. Commercial config extension
-- ══════════════════════════════════════════════════════════

-- Redefine save_commercial_config with fee_policy_enabled + category_fee_rates
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
    'messaging_financial_gate', 'messaging_reservation_ttl_seconds',
    'trial_credit_minor_by_currency',
    'subscription_included_minor_by_tier_currency',
    'fee_policy_enabled',
    'category_fee_rates'
  ];
  v_caller_id UUID;
  v_snapshot JSONB;
  v_version_id UUID;
  v_now TIMESTAMPTZ;
  v_key TEXT;
  v_val JSONB;
  v_tier_key TEXT;
  v_tier_val JSONB;
  v_cur_key TEXT;
  v_cur_val JSONB;
  v_cat_key TEXT;
  v_cat_val JSONB;
  v_allowed_categories TEXT[] := ARRAY[
    'scheduling', 'reservation', 'ticketing',
    'ordering', 'invoice', 'giving', 'payment', 'recurring'
  ];
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'save_commercial_config requires authenticated caller';
  END IF;
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'save_commercial_config requires admin role';
  END IF;

  IF NOT (p_key = ANY(v_commercial_keys)) THEN
    RAISE EXCEPTION 'Key "%" is not a commercial config key', p_key;
  END IF;

  -- ── Write-time type validation for financial keys ──

  IF p_key = 'messaging_financial_gate' THEN
    IF jsonb_typeof(p_value) <> 'boolean' THEN
      RAISE EXCEPTION 'messaging_financial_gate must be a boolean, got %', jsonb_typeof(p_value);
    END IF;
  END IF;

  IF p_key = 'fee_policy_enabled' THEN
    IF jsonb_typeof(p_value) <> 'boolean' THEN
      RAISE EXCEPTION 'fee_policy_enabled must be a boolean, got %', jsonb_typeof(p_value);
    END IF;
    -- When enabling fee policy, validate that all pricing_tiers have feeFlat = 0
    IF p_value = 'true'::JSONB THEN
      DECLARE
        v_pricing JSONB;
        v_tier_name TEXT;
        v_tier_data JSONB;
        v_flat_val NUMERIC;
      BEGIN
        SELECT value INTO v_pricing FROM platform_settings WHERE key = 'pricing_tiers';
        IF v_pricing IS NOT NULL AND jsonb_typeof(v_pricing) = 'object' THEN
          FOR v_tier_name, v_tier_data IN SELECT * FROM jsonb_each(v_pricing)
          LOOP
            v_flat_val := COALESCE((v_tier_data ->> 'feeFlat')::NUMERIC, 0);
            IF v_flat_val <> 0 THEN
              RAISE EXCEPTION 'Cannot enable fee_policy: pricing_tiers.%.feeFlat must be 0 (got %)', v_tier_name, v_flat_val;
            END IF;
          END LOOP;
        END IF;
      END;
    END IF;
  END IF;

  -- When updating pricing_tiers while fee_policy is enabled, enforce zero feeFlat
  IF p_key = 'pricing_tiers' THEN
    DECLARE
      v_fee_gate JSONB;
      v_pt_tier TEXT;
      v_pt_data JSONB;
      v_pt_flat NUMERIC;
    BEGIN
      SELECT value INTO v_fee_gate FROM platform_settings WHERE key = 'fee_policy_enabled';
      IF v_fee_gate = 'true'::JSONB THEN
        IF jsonb_typeof(p_value) = 'object' THEN
          FOR v_pt_tier, v_pt_data IN SELECT * FROM jsonb_each(p_value)
          LOOP
            v_pt_flat := COALESCE((v_pt_data ->> 'feeFlat')::NUMERIC, 0);
            IF v_pt_flat <> 0 THEN
              RAISE EXCEPTION 'Cannot update pricing_tiers while fee_policy_enabled: %.feeFlat must be 0 (got %)', v_pt_tier, v_pt_flat;
            END IF;
          END LOOP;
        END IF;
      END IF;
    END;
  END IF;

  IF p_key = 'messaging_reservation_ttl_seconds' THEN
    IF jsonb_typeof(p_value) <> 'number' THEN
      RAISE EXCEPTION 'messaging_reservation_ttl_seconds must be a positive integer, got %', jsonb_typeof(p_value);
    END IF;
    IF (p_value::TEXT)::NUMERIC <= 0 OR (p_value::TEXT)::NUMERIC <> FLOOR((p_value::TEXT)::NUMERIC) THEN
      RAISE EXCEPTION 'messaging_reservation_ttl_seconds must be a positive integer, got %', p_value::TEXT;
    END IF;
  END IF;

  IF p_key = 'trial_days' THEN
    IF jsonb_typeof(p_value) <> 'number' THEN
      RAISE EXCEPTION 'trial_days must be a positive integer, got %', jsonb_typeof(p_value);
    END IF;
    IF (p_value::TEXT)::NUMERIC <= 0 OR (p_value::TEXT)::NUMERIC <> FLOOR((p_value::TEXT)::NUMERIC) THEN
      RAISE EXCEPTION 'trial_days must be a positive integer, got %', p_value::TEXT;
    END IF;
  END IF;

  IF p_key = 'trial_credit_minor_by_currency' THEN
    IF jsonb_typeof(p_value) <> 'object' THEN
      RAISE EXCEPTION 'trial_credit_minor_by_currency must be a JSONB object, got %', jsonb_typeof(p_value);
    END IF;
    FOR v_key, v_val IN SELECT * FROM jsonb_each(p_value)
    LOOP
      IF jsonb_typeof(v_val) <> 'number' THEN
        RAISE EXCEPTION 'trial_credit_minor_by_currency[%] must be a positive integer, got %', v_key, jsonb_typeof(v_val);
      END IF;
      IF (v_val::TEXT)::NUMERIC <= 0 OR (v_val::TEXT)::NUMERIC <> FLOOR((v_val::TEXT)::NUMERIC) THEN
        RAISE EXCEPTION 'trial_credit_minor_by_currency[%] must be a positive integer, got %', v_key, v_val::TEXT;
      END IF;
    END LOOP;
  END IF;

  -- Write-time validation for subscription_included_minor_by_tier_currency
  IF p_key = 'subscription_included_minor_by_tier_currency' THEN
    IF jsonb_typeof(p_value) <> 'object' THEN
      RAISE EXCEPTION 'subscription_included_minor_by_tier_currency must be a JSONB object, got %', jsonb_typeof(p_value);
    END IF;
    FOR v_tier_key, v_tier_val IN SELECT * FROM jsonb_each(p_value)
    LOOP
      IF v_tier_key NOT IN ('growth', 'business') THEN
        RAISE EXCEPTION 'subscription_included_minor_by_tier_currency: unknown tier "%"', v_tier_key;
      END IF;
      IF jsonb_typeof(v_tier_val) <> 'object' THEN
        RAISE EXCEPTION 'subscription_included_minor_by_tier_currency[%] must be a currency→amount object', v_tier_key;
      END IF;
      FOR v_cur_key, v_cur_val IN SELECT * FROM jsonb_each(v_tier_val)
      LOOP
        IF jsonb_typeof(v_cur_val) <> 'number' THEN
          RAISE EXCEPTION 'subscription_included_minor_by_tier_currency[%][%] must be a positive integer', v_tier_key, v_cur_key;
        END IF;
        IF (v_cur_val::TEXT)::NUMERIC <= 0 OR (v_cur_val::TEXT)::NUMERIC <> FLOOR((v_cur_val::TEXT)::NUMERIC) THEN
          RAISE EXCEPTION 'subscription_included_minor_by_tier_currency[%][%] must be a positive integer, got %', v_tier_key, v_cur_key, v_cur_val::TEXT;
        END IF;
      END LOOP;
    END LOOP;
  END IF;

  -- Write-time validation for category_fee_rates (#264)
  IF p_key = 'category_fee_rates' THEN
    IF jsonb_typeof(p_value) <> 'object' THEN
      RAISE EXCEPTION 'category_fee_rates must be a JSONB object, got %', jsonb_typeof(p_value);
    END IF;
    FOR v_cat_key, v_cat_val IN SELECT * FROM jsonb_each(p_value)
    LOOP
      -- Closed vocabulary: only known categories
      IF NOT (v_cat_key = ANY(v_allowed_categories)) THEN
        RAISE EXCEPTION 'category_fee_rates: unknown category "%"', v_cat_key;
      END IF;
      IF jsonb_typeof(v_cat_val) <> 'object' THEN
        RAISE EXCEPTION 'category_fee_rates[%] must be an object with feePercentage', v_cat_key;
      END IF;
      -- feePercentage: required, non-negative, <= 100
      IF (v_cat_val ->> 'feePercentage') IS NULL THEN
        RAISE EXCEPTION 'category_fee_rates[%].feePercentage is required', v_cat_key;
      END IF;
      IF jsonb_typeof(v_cat_val -> 'feePercentage') <> 'number' THEN
        RAISE EXCEPTION 'category_fee_rates[%].feePercentage must be a number', v_cat_key;
      END IF;
      IF (v_cat_val ->> 'feePercentage')::NUMERIC < 0
         OR (v_cat_val ->> 'feePercentage')::NUMERIC > 100 THEN
        RAISE EXCEPTION 'category_fee_rates[%].feePercentage must be 0-100', v_cat_key;
      END IF;
      -- Reject extra keys (only feePercentage allowed — percentage-only for v1)
      DECLARE
        v_rate_key TEXT;
      BEGIN
        FOR v_rate_key IN SELECT key FROM jsonb_object_keys(v_cat_val) AS key
        LOOP
          IF v_rate_key <> 'feePercentage' THEN
            RAISE EXCEPTION 'category_fee_rates[%] contains unknown key "%"; only feePercentage allowed', v_cat_key, v_rate_key;
          END IF;
        END LOOP;
      END;
    END LOOP;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('commercial_config_write'));

  INSERT INTO platform_settings (key, value, description, updated_by, updated_at)
  VALUES (p_key, p_value, COALESCE(p_description, ''), v_caller_id, clock_timestamp())
  ON CONFLICT (key) DO UPDATE
    SET value = EXCLUDED.value,
        description = COALESCE(NULLIF(p_description, ''), platform_settings.description),
        updated_by = EXCLUDED.updated_by,
        updated_at = EXCLUDED.updated_at;

  SELECT jsonb_object_agg(key, value)
  INTO v_snapshot
  FROM platform_settings
  WHERE key = ANY(v_commercial_keys);

  IF v_snapshot IS NULL OR v_snapshot = '{}'::jsonb THEN
    RAISE EXCEPTION 'Cannot create config version: no commercial keys found in platform_settings';
  END IF;

  v_now := clock_timestamp();
  v_version_id := gen_random_uuid();
  INSERT INTO platform_config_versions (id, config_snapshot, effective_from, created_by, created_at)
  VALUES (v_version_id, v_snapshot, v_now, v_caller_id, v_now);

  RETURN v_version_id;
END;
$$;

REVOKE ALL ON FUNCTION public.save_commercial_config(TEXT, JSONB, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.save_commercial_config(TEXT, JSONB, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.save_commercial_config(TEXT, JSONB, TEXT) FROM authenticated;
REVOKE ALL ON FUNCTION public.save_commercial_config(TEXT, JSONB, TEXT) FROM service_role;
GRANT EXECUTE ON FUNCTION public.save_commercial_config(TEXT, JSONB, TEXT) TO authenticated;

-- Update guard with same extended key list
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
    'messaging_financial_gate', 'messaging_reservation_ttl_seconds',
    'trial_credit_minor_by_currency',
    'subscription_included_minor_by_tier_currency',
    'fee_policy_enabled',
    'category_fee_rates'
  ];
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_touches_commercial := NEW.key = ANY(v_commercial_keys);
  ELSIF TG_OP = 'DELETE' THEN
    v_touches_commercial := OLD.key = ANY(v_commercial_keys);
  ELSE
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
-- E. Verification
-- ══════════════════════════════════════════════════════════

DO $$
DECLARE
  v_count INTEGER;
BEGIN
  -- Verify fee_policy_version column exists
  SELECT count(*) INTO v_count FROM information_schema.columns
    WHERE table_name = 'payments' AND column_name = 'fee_policy_version';
  IF v_count = 0 THEN
    RAISE EXCEPTION 'M376: fee_policy_version column not found on payments';
  END IF;

  -- Verify config_version_id column exists
  SELECT count(*) INTO v_count FROM information_schema.columns
    WHERE table_name = 'payments' AND column_name = 'config_version_id';
  IF v_count = 0 THEN
    RAISE EXCEPTION 'M376: config_version_id column not found on payments';
  END IF;

  -- Verify transaction_category column exists
  SELECT count(*) INTO v_count FROM information_schema.columns
    WHERE table_name = 'payments' AND column_name = 'transaction_category';
  IF v_count = 0 THEN
    RAISE EXCEPTION 'M376: transaction_category column not found on payments';
  END IF;

  -- Verify fee_basis column exists
  SELECT count(*) INTO v_count FROM information_schema.columns
    WHERE table_name = 'payments' AND column_name = 'fee_basis';
  IF v_count = 0 THEN
    RAISE EXCEPTION 'M376: fee_basis column not found on payments';
  END IF;

  -- Verify provider_init_state column exists
  SELECT count(*) INTO v_count FROM information_schema.columns
    WHERE table_name = 'payments' AND column_name = 'provider_init_state';
  IF v_count = 0 THEN
    RAISE EXCEPTION 'M376: provider_init_state column not found on payments';
  END IF;

  -- Verify validation trigger
  SELECT count(*) INTO v_count FROM pg_trigger
    WHERE tgname = 'trg_validate_fee_basis';
  IF v_count = 0 THEN
    RAISE EXCEPTION 'M376: trg_validate_fee_basis trigger not found';
  END IF;

  -- Verify immutability trigger
  SELECT count(*) INTO v_count FROM pg_trigger
    WHERE tgname = 'trg_guard_fee_policy_immutability';
  IF v_count = 0 THEN
    RAISE EXCEPTION 'M376: trg_guard_fee_policy_immutability trigger not found';
  END IF;

  -- Verify commercial config keys include new keys
  SELECT count(*) INTO v_count FROM pg_proc
    WHERE proname = 'save_commercial_config'
      AND prosrc LIKE '%fee_policy_enabled%'
      AND prosrc LIKE '%category_fee_rates%';
  IF v_count = 0 THEN
    RAISE EXCEPTION 'M376: save_commercial_config missing fee_policy_enabled or category_fee_rates';
  END IF;

  RAISE NOTICE 'MIGRATION 376 VERIFICATION: All checks passed';
END;
$$;
