-- ═══════════════════════════════════════════════════════
-- 377: Dynamic Market / Messaging Financial Controls (#313)
--
-- Phase 1: DB/Admin-driven country messaging configuration.
--
-- Surfaces:
--   NEW RPC: save_messaging_config(jsonb, jsonb, jsonb, uuid, text)
--     Atomic three-map bundle with mandatory CAS.
--   ALTERED: save_commercial_config — 18-key snapshot, bundle-only mutation block
--   ALTERED: guard_commercial_settings — 18-key allowlist, dual owner resolution
--   NEW TRIGGER: guard_country_activation — DB-enforced market readiness
--   NEW TRIGGER: guard_country_deletion — no hard delete
--   NEW TRIGGER: guard_country_code_immutability — code immutable after creation
-- ═══════════════════════════════════════════════════════

-- ══════════════════════════════════════════════════════════
-- A. Redefine save_commercial_config with 18-key snapshot + bundle block
-- ══════════════════════════════════════════════════════════

-- Must DROP old signature before creating new 4-arg version
DROP FUNCTION IF EXISTS public.save_commercial_config(text, jsonb, text);

CREATE OR REPLACE FUNCTION public.save_commercial_config(
  p_key TEXT,
  p_value JSONB,
  p_description TEXT DEFAULT NULL,
  p_expected_version_id UUID DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  -- 18 unique snapshot keys: 15 individually mutable + 3 bundle-only
  v_commercial_keys TEXT[] := ARRAY[
    'pricing_tiers', 'trial_days', 'broadcast_limits', 'conversation_limits',
    'default_platform_fee_percent', 'annual_discount_percentage',
    'payout_cooling_period_days', 'minimum_payout', 'payout_verification_limits',
    'transfer_expiry_hours', 'minimum_bank_transfer',
    'messaging_financial_gate', 'messaging_reservation_ttl_seconds',
    'trial_credit_minor_by_currency',
    'subscription_included_minor_by_tier_currency',
    'fee_policy_enabled',
    'category_fee_rates',
    'messaging_pricing'
  ];
  -- Bundle-only keys: mutation through save_messaging_config only
  v_bundle_only_keys TEXT[] := ARRAY[
    'messaging_pricing',
    'trial_credit_minor_by_currency',
    'subscription_included_minor_by_tier_currency'
  ];
  v_caller_id UUID;
  v_snapshot JSONB;
  v_version_id UUID;
  v_now TIMESTAMPTZ;
  v_latest_version_id UUID;
  -- Validation variables
  v_key TEXT;
  v_val JSONB;
  v_tier_key TEXT;
  v_tier_val JSONB;
  v_cur_key TEXT;
  v_cur_val JSONB;
  v_cat_key TEXT;
  v_cat_val JSONB;
  v_rate_key TEXT;
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

  -- Block bundle-only keys — must use save_messaging_config
  IF p_key = ANY(v_bundle_only_keys) THEN
    RAISE EXCEPTION 'Key "%" is a bundle-only messaging key. Use save_messaging_config() instead.', p_key;
  END IF;

  -- Serialize BEFORE cross-key reads/validation
  PERFORM pg_advisory_xact_lock(hashtext('commercial_config_write'));

  -- Optional CAS for scalar keys (mandatory for bundle keys handled above)
  IF p_expected_version_id IS NOT NULL THEN
    SELECT id INTO v_latest_version_id
      FROM platform_config_versions
      WHERE effective_from <= clock_timestamp()
      ORDER BY effective_from DESC LIMIT 1;

    IF v_latest_version_id IS DISTINCT FROM p_expected_version_id THEN
      RAISE EXCEPTION 'config_version_conflict: expected % but latest is %',
        p_expected_version_id, v_latest_version_id;
    END IF;
  END IF;

  -- ── Write-time type validation (preserved from M376) ──

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

  IF p_key = 'trial_days' THEN
    IF jsonb_typeof(p_value) <> 'number' THEN
      RAISE EXCEPTION 'trial_days must be a positive integer, got %', jsonb_typeof(p_value);
    END IF;
    IF (p_value::TEXT)::NUMERIC <= 0 OR (p_value::TEXT)::NUMERIC <> FLOOR((p_value::TEXT)::NUMERIC) THEN
      RAISE EXCEPTION 'trial_days must be a positive integer, got %', p_value::TEXT;
    END IF;
  END IF;

  IF p_key = 'fee_policy_enabled' THEN
    IF jsonb_typeof(p_value) <> 'boolean' THEN
      RAISE EXCEPTION 'fee_policy_enabled must be a boolean, got %', jsonb_typeof(p_value);
    END IF;
  END IF;

  -- Cross-key validation for fee_policy_enabled + pricing_tiers (preserved from M376)
  IF p_key = 'fee_policy_enabled' AND p_value = 'true'::jsonb THEN
    DECLARE v_cur_tiers JSONB; v_ft JSONB;
    BEGIN
      SELECT value INTO v_cur_tiers FROM platform_settings WHERE key = 'pricing_tiers';
      IF v_cur_tiers IS NOT NULL THEN
        FOR v_tier_key IN SELECT jsonb_object_keys(v_cur_tiers) LOOP
          v_ft := v_cur_tiers -> v_tier_key;
          IF v_ft -> 'feeFlat' IS NOT NULL AND (v_ft ->> 'feeFlat')::NUMERIC <> 0 THEN
            RAISE EXCEPTION 'Cannot enable fee_policy while pricing_tiers[%].feeFlat is nonzero (%)', v_tier_key, v_ft ->> 'feeFlat';
          END IF;
        END LOOP;
      END IF;
    END;
  END IF;

  IF p_key = 'pricing_tiers' THEN
    DECLARE v_fpe JSONB;
    BEGIN
      SELECT value INTO v_fpe FROM platform_settings WHERE key = 'fee_policy_enabled';
      IF v_fpe = 'true'::jsonb THEN
        FOR v_tier_key IN SELECT jsonb_object_keys(p_value) LOOP
          v_val := p_value -> v_tier_key;
          IF v_val -> 'feeFlat' IS NOT NULL AND (v_val ->> 'feeFlat')::NUMERIC <> 0 THEN
            RAISE EXCEPTION 'Cannot set pricing_tiers[%].feeFlat to nonzero while fee_policy_enabled is true', v_tier_key;
          END IF;
        END LOOP;
      END IF;
    END;
  END IF;

  -- Category fee rates validation (preserved from M376)
  IF p_key = 'category_fee_rates' THEN
    IF jsonb_typeof(p_value) <> 'object' THEN
      RAISE EXCEPTION 'category_fee_rates must be a JSONB object, got %', jsonb_typeof(p_value);
    END IF;
    FOR v_cat_key IN SELECT jsonb_object_keys(p_value) LOOP
      IF v_cat_key NOT IN ('scheduling', 'reservation', 'ticketing', 'ordering', 'invoice', 'giving', 'payment', 'recurring') THEN
        RAISE EXCEPTION 'category_fee_rates: unknown category "%"', v_cat_key;
      END IF;
      v_cat_val := p_value -> v_cat_key;
      IF jsonb_typeof(v_cat_val) <> 'object' OR v_cat_val -> 'feePercentage' IS NULL THEN
        RAISE EXCEPTION 'category_fee_rates[%] must be an object with feePercentage', v_cat_key;
      END IF;
      IF jsonb_typeof(v_cat_val -> 'feePercentage') <> 'number' THEN
        RAISE EXCEPTION 'category_fee_rates[%].feePercentage must be a number', v_cat_key;
      END IF;
      IF (v_cat_val ->> 'feePercentage')::NUMERIC < 0 OR (v_cat_val ->> 'feePercentage')::NUMERIC > 100 THEN
        RAISE EXCEPTION 'category_fee_rates[%].feePercentage must be 0-100', v_cat_key;
      END IF;
      FOR v_rate_key IN SELECT jsonb_object_keys(v_cat_val) LOOP
        IF v_rate_key <> 'feePercentage' THEN
          RAISE EXCEPTION 'category_fee_rates[%] contains unknown key "%"; only feePercentage allowed', v_cat_key, v_rate_key;
        END IF;
      END LOOP;
    END LOOP;
  END IF;

  -- Upsert the setting
  INSERT INTO platform_settings (key, value, description, updated_by, updated_at)
  VALUES (p_key, p_value, COALESCE(p_description, ''), v_caller_id, clock_timestamp())
  ON CONFLICT (key) DO UPDATE
    SET value = EXCLUDED.value,
        description = COALESCE(NULLIF(p_description, ''), platform_settings.description),
        updated_by = EXCLUDED.updated_by,
        updated_at = EXCLUDED.updated_at;

  -- Build snapshot from ALL 18 commercial keys (includes messaging maps)
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

-- ACLs for new 4-arg signature
REVOKE ALL ON FUNCTION public.save_commercial_config(text, jsonb, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.save_commercial_config(text, jsonb, text, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.save_commercial_config(text, jsonb, text, uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.save_commercial_config(text, jsonb, text, uuid) FROM service_role;
GRANT EXECUTE ON FUNCTION public.save_commercial_config(text, jsonb, text, uuid) TO authenticated;

-- ══════════════════════════════════════════════════════════
-- B. Atomic save_messaging_config bundle RPC
-- ══════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.save_messaging_config(
  p_messaging_pricing JSONB,
  p_trial_credit_minor_by_currency JSONB,
  p_subscription_included_minor_by_tier_currency JSONB,
  p_expected_version_id UUID,
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
    'category_fee_rates',
    'messaging_pricing'
  ];
  v_caller_id UUID;
  v_snapshot JSONB;
  v_version_id UUID;
  v_now TIMESTAMPTZ;
  v_latest_version_id UUID;
  -- messaging_pricing validation
  v_currency TEXT;
  v_bucket JSONB;
  v_country_key TEXT;
  v_rate_val JSONB;
  v_seen_countries TEXT[] := '{}';
  -- country activation validation
  v_country RECORD;
  v_match_count INTEGER;
  v_matched_currency TEXT;
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'save_messaging_config requires authenticated caller';
  END IF;
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'save_messaging_config requires admin role';
  END IF;

  -- Acquire commercial-write lock
  PERFORM pg_advisory_xact_lock(hashtext('commercial_config_write'));

  -- Mandatory CAS — explicit NULL rejection, no bypass
  IF p_expected_version_id IS NULL THEN
    RAISE EXCEPTION 'save_messaging_config requires a non-NULL expected_version_id for CAS';
  END IF;

  SELECT id INTO v_latest_version_id
    FROM platform_config_versions
    WHERE effective_from <= clock_timestamp()
    ORDER BY effective_from DESC LIMIT 1;

  IF v_latest_version_id IS DISTINCT FROM p_expected_version_id THEN
    RAISE EXCEPTION 'config_version_conflict: expected % but latest is %',
      p_expected_version_id, v_latest_version_id;
  END IF;

  -- ── Validate messaging_pricing structure ──

  IF p_messaging_pricing IS NULL OR jsonb_typeof(p_messaging_pricing) <> 'object' THEN
    RAISE EXCEPTION 'messaging_pricing must be a JSONB object';
  END IF;

  FOR v_currency IN SELECT key FROM jsonb_each(p_messaging_pricing) LOOP
    IF length(v_currency) <> 3 OR v_currency <> upper(v_currency) THEN
      RAISE EXCEPTION 'messaging_pricing: invalid currency code "%"', v_currency;
    END IF;

    v_bucket := p_messaging_pricing -> v_currency;
    IF jsonb_typeof(v_bucket) <> 'object' THEN
      RAISE EXCEPTION 'messaging_pricing[%] must be an object', v_currency;
    END IF;

    -- default_spend_cap_minor required — must be positive integer
    IF v_bucket -> 'default_spend_cap_minor' IS NULL
       OR jsonb_typeof(v_bucket -> 'default_spend_cap_minor') <> 'number' THEN
      RAISE EXCEPTION 'messaging_pricing[%].default_spend_cap_minor must be a positive integer', v_currency;
    END IF;
    DECLARE v_cap NUMERIC;
    BEGIN
      v_cap := (v_bucket ->> 'default_spend_cap_minor')::NUMERIC;
      IF v_cap <= 0 OR v_cap <> FLOOR(v_cap) THEN
        RAISE EXCEPTION 'messaging_pricing[%].default_spend_cap_minor must be a positive integer, got %', v_currency, v_cap;
      END IF;
    END;

    -- default_cost_minor optional but must be non-negative integer if present
    IF v_bucket -> 'default_cost_minor' IS NOT NULL THEN
      IF jsonb_typeof(v_bucket -> 'default_cost_minor') <> 'number' THEN
        RAISE EXCEPTION 'messaging_pricing[%].default_cost_minor must be a non-negative integer', v_currency;
      END IF;
      DECLARE v_cost NUMERIC;
      BEGIN
        v_cost := (v_bucket ->> 'default_cost_minor')::NUMERIC;
        IF v_cost < 0 OR v_cost <> FLOOR(v_cost) THEN
          RAISE EXCEPTION 'messaging_pricing[%].default_cost_minor must be a non-negative integer, got %', v_currency, v_cost;
        END IF;
      END;
    END IF;

    -- rates required
    IF v_bucket -> 'rates' IS NULL OR jsonb_typeof(v_bucket -> 'rates') <> 'object' THEN
      RAISE EXCEPTION 'messaging_pricing[%].rates must be an object', v_currency;
    END IF;

    -- Validate each country in rates
    FOR v_country_key IN SELECT key FROM jsonb_each(v_bucket -> 'rates') LOOP
      IF length(v_country_key) <> 2 OR v_country_key <> upper(v_country_key) THEN
        RAISE EXCEPTION 'messaging_pricing[%].rates: invalid country code "%"', v_currency, v_country_key;
      END IF;

      -- Cross-bucket uniqueness: no country in multiple buckets
      IF v_country_key = ANY(v_seen_countries) THEN
        RAISE EXCEPTION 'messaging_pricing: country "%" appears in multiple currency buckets', v_country_key;
      END IF;
      v_seen_countries := array_append(v_seen_countries, v_country_key);

      -- Rate values must be an object with non-negative integer values
      v_rate_val := v_bucket -> 'rates' -> v_country_key;
      IF jsonb_typeof(v_rate_val) <> 'object' THEN
        RAISE EXCEPTION 'messaging_pricing[%].rates[%] must be an object with rate values', v_currency, v_country_key;
      END IF;

      -- Validate every rate entry: key must be a known category or wildcard, value must be non-negative integer
      DECLARE
        v_rate_entry_key TEXT;
        v_rate_entry_val JSONB;
        v_rate_num NUMERIC;
        v_allowed_rate_keys TEXT[] := ARRAY[
          '*', 'marketing', 'utility', 'authentication', 'service'
        ];
      BEGIN
        FOR v_rate_entry_key IN SELECT key FROM jsonb_each(v_rate_val) LOOP
          -- Validate rate key is a known category or wildcard
          IF NOT (v_rate_entry_key = ANY(v_allowed_rate_keys)) THEN
            RAISE EXCEPTION 'messaging_pricing[%].rates[%]: unknown rate key "%"; allowed: *, marketing, utility, authentication, service',
              v_currency, v_country_key, v_rate_entry_key;
          END IF;
          -- Validate rate value is a non-negative integer
          v_rate_entry_val := v_rate_val -> v_rate_entry_key;
          IF jsonb_typeof(v_rate_entry_val) <> 'number' THEN
            RAISE EXCEPTION 'messaging_pricing[%].rates[%][%] must be a non-negative integer, got %',
              v_currency, v_country_key, v_rate_entry_key, jsonb_typeof(v_rate_entry_val);
          END IF;
          v_rate_num := (v_rate_entry_val::TEXT)::NUMERIC;
          IF v_rate_num < 0 OR v_rate_num <> FLOOR(v_rate_num) THEN
            RAISE EXCEPTION 'messaging_pricing[%].rates[%][%] must be a non-negative integer, got %',
              v_currency, v_country_key, v_rate_entry_key, v_rate_entry_val::TEXT;
          END IF;
        END LOOP;
      END;
    END LOOP;
  END LOOP;

  -- ── Validate trial_credit_minor_by_currency ──

  IF p_trial_credit_minor_by_currency IS NULL OR jsonb_typeof(p_trial_credit_minor_by_currency) <> 'object' THEN
    RAISE EXCEPTION 'trial_credit_minor_by_currency must be a JSONB object';
  END IF;
  FOR v_currency IN SELECT key FROM jsonb_each(p_trial_credit_minor_by_currency) LOOP
    v_bucket := p_trial_credit_minor_by_currency -> v_currency;
    IF jsonb_typeof(v_bucket) <> 'number' THEN
      RAISE EXCEPTION 'trial_credit_minor_by_currency[%] must be a positive integer', v_currency;
    END IF;
    DECLARE v_tc NUMERIC;
    BEGIN
      v_tc := (v_bucket::TEXT)::NUMERIC;
      IF v_tc <= 0 OR v_tc <> FLOOR(v_tc) THEN
        RAISE EXCEPTION 'trial_credit_minor_by_currency[%] must be a positive integer, got %', v_currency, v_tc;
      END IF;
    END;
  END LOOP;

  -- ── Validate subscription_included_minor_by_tier_currency ──

  IF p_subscription_included_minor_by_tier_currency IS NULL OR jsonb_typeof(p_subscription_included_minor_by_tier_currency) <> 'object' THEN
    RAISE EXCEPTION 'subscription_included_minor_by_tier_currency must be a JSONB object';
  END IF;
  FOR v_currency IN SELECT jsonb_object_keys(p_subscription_included_minor_by_tier_currency) LOOP
    IF v_currency NOT IN ('growth', 'business') THEN
      RAISE EXCEPTION 'subscription_included_minor_by_tier_currency: unknown tier "%"', v_currency;
    END IF;
    v_bucket := p_subscription_included_minor_by_tier_currency -> v_currency;
    IF jsonb_typeof(v_bucket) <> 'object' THEN
      RAISE EXCEPTION 'subscription_included_minor_by_tier_currency[%] must be a currency→amount object', v_currency;
    END IF;
    FOR v_country_key IN SELECT jsonb_object_keys(v_bucket) LOOP
      IF jsonb_typeof(v_bucket -> v_country_key) <> 'number' THEN
        RAISE EXCEPTION 'subscription_included_minor_by_tier_currency[%][%] must be a positive integer', v_currency, v_country_key;
      END IF;
      DECLARE v_inc NUMERIC;
      BEGIN
        v_inc := (v_bucket ->> v_country_key)::NUMERIC;
        IF v_inc <= 0 OR v_inc <> FLOOR(v_inc) THEN
          RAISE EXCEPTION 'subscription_included_minor_by_tier_currency[%][%] must be a positive integer, got %', v_currency, v_country_key, v_inc;
        END IF;
      END;
    END LOOP;
  END LOOP;

  -- ── Upsert all three maps atomically ──

  INSERT INTO platform_settings (key, value, description, updated_by, updated_at)
  VALUES ('messaging_pricing', p_messaging_pricing, COALESCE(p_description, 'Messaging pricing config'), v_caller_id, clock_timestamp())
  ON CONFLICT (key) DO UPDATE
    SET value = EXCLUDED.value, description = EXCLUDED.description,
        updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at;

  INSERT INTO platform_settings (key, value, description, updated_by, updated_at)
  VALUES ('trial_credit_minor_by_currency', p_trial_credit_minor_by_currency, COALESCE(p_description, 'Trial credit config'), v_caller_id, clock_timestamp())
  ON CONFLICT (key) DO UPDATE
    SET value = EXCLUDED.value, description = EXCLUDED.description,
        updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at;

  INSERT INTO platform_settings (key, value, description, updated_by, updated_at)
  VALUES ('subscription_included_minor_by_tier_currency', p_subscription_included_minor_by_tier_currency, COALESCE(p_description, 'Subscription included config'), v_caller_id, clock_timestamp())
  ON CONFLICT (key) DO UPDATE
    SET value = EXCLUDED.value, description = EXCLUDED.description,
        updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at;

  -- ── Build candidate snapshot and validate against active markets ──

  SELECT jsonb_object_agg(key, value)
  INTO v_snapshot
  FROM platform_settings
  WHERE key = ANY(v_commercial_keys);

  IF v_snapshot IS NULL OR v_snapshot = '{}'::jsonb THEN
    RAISE EXCEPTION 'Cannot create config version: no commercial keys found';
  END IF;

  -- Validate every active market against the candidate snapshot
  FOR v_country IN
    SELECT code, currency_code, payment_gateway, pricing FROM countries WHERE is_active = true
  LOOP
    -- Country must be in exactly one messaging_pricing bucket
    v_match_count := 0;
    v_matched_currency := NULL;
    FOR v_currency IN SELECT key FROM jsonb_each(p_messaging_pricing) LOOP
      IF p_messaging_pricing -> v_currency -> 'rates' -> v_country.code IS NOT NULL THEN
        v_match_count := v_match_count + 1;
        v_matched_currency := v_currency;
      END IF;
    END LOOP;

    IF v_match_count = 0 THEN
      RAISE EXCEPTION 'Active market % not found in messaging_pricing', v_country.code;
    END IF;
    IF v_match_count > 1 THEN
      RAISE EXCEPTION 'Active market % found in % messaging_pricing buckets', v_country.code, v_match_count;
    END IF;

    -- Bucket currency must match country currency
    IF v_matched_currency <> v_country.currency_code THEN
      RAISE EXCEPTION 'Active market % mapped under % but currency_code is %', v_country.code, v_matched_currency, v_country.currency_code;
    END IF;

    -- Trial credit must cover this currency
    IF p_trial_credit_minor_by_currency ->> v_country.currency_code IS NULL THEN
      RAISE EXCEPTION 'Active market % missing trial credit for %', v_country.code, v_country.currency_code;
    END IF;

    -- Tier included must cover growth + business for this currency
    IF p_subscription_included_minor_by_tier_currency -> 'growth' ->> v_country.currency_code IS NULL
       OR p_subscription_included_minor_by_tier_currency -> 'business' ->> v_country.currency_code IS NULL THEN
      RAISE EXCEPTION 'Active market % missing tier included credit for %', v_country.code, v_country.currency_code;
    END IF;
  END LOOP;

  -- ── Create immutable config version ──

  v_now := clock_timestamp();
  v_version_id := gen_random_uuid();
  INSERT INTO platform_config_versions (id, config_snapshot, effective_from, created_by, created_at)
  VALUES (v_version_id, v_snapshot, v_now, v_caller_id, v_now);

  RETURN v_version_id;
END;
$$;

REVOKE ALL ON FUNCTION public.save_messaging_config(jsonb, jsonb, jsonb, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.save_messaging_config(jsonb, jsonb, jsonb, uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.save_messaging_config(jsonb, jsonb, jsonb, uuid, text) FROM authenticated;
REVOKE ALL ON FUNCTION public.save_messaging_config(jsonb, jsonb, jsonb, uuid, text) FROM service_role;
GRANT EXECUTE ON FUNCTION public.save_messaging_config(jsonb, jsonb, jsonb, uuid, text) TO authenticated;

-- ══════════════════════════════════════════════════════════
-- C. Update guard_commercial_settings for 18-key allowlist + dual owner
-- ══════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.guard_commercial_settings()
RETURNS TRIGGER AS $$
DECLARE
  v_touches_commercial BOOLEAN;
  v_trusted_owner_scalar TEXT;
  v_trusted_owner_bundle TEXT;
  v_commercial_keys TEXT[] := ARRAY[
    'pricing_tiers', 'trial_days', 'broadcast_limits', 'conversation_limits',
    'default_platform_fee_percent', 'annual_discount_percentage',
    'payout_cooling_period_days', 'minimum_payout', 'payout_verification_limits',
    'transfer_expiry_hours', 'minimum_bank_transfer',
    'messaging_financial_gate', 'messaging_reservation_ttl_seconds',
    'trial_credit_minor_by_currency',
    'subscription_included_minor_by_tier_currency',
    'fee_policy_enabled',
    'category_fee_rates',
    'messaging_pricing'
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
    -- Accept writes from either save_commercial_config or save_messaging_config
    SELECT r.rolname INTO v_trusted_owner_scalar
      FROM pg_proc p
      JOIN pg_roles r ON p.proowner = r.oid
     WHERE p.oid = to_regprocedure('public.save_commercial_config(text,jsonb,text,uuid)');

    SELECT r.rolname INTO v_trusted_owner_bundle
      FROM pg_proc p
      JOIN pg_roles r ON p.proowner = r.oid
     WHERE p.oid = to_regprocedure('public.save_messaging_config(jsonb,jsonb,jsonb,uuid,text)');

    IF (v_trusted_owner_scalar IS NULL OR current_user != v_trusted_owner_scalar)
       AND (v_trusted_owner_bundle IS NULL OR current_user != v_trusted_owner_bundle) THEN
      RAISE EXCEPTION 'Commercial platform settings must be modified via save_commercial_config() or save_messaging_config()';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$ LANGUAGE plpgsql;

-- ══════════════════════════════════════════════════════════
-- D. DB-enforced country activation / readiness trigger
-- ══════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.guard_country_activation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_snapshot JSONB;
  v_pricing JSONB;
  v_trial_credit JSONB;
  v_included JSONB;
  v_bucket_currency TEXT;
  v_match_count INTEGER;
  v_supported_gateways TEXT[] := ARRAY['paystack', 'stripe'];
BEGIN
  -- Code immutability: reject any code change
  IF TG_OP = 'UPDATE' AND NEW.code != OLD.code THEN
    RAISE EXCEPTION 'countries.code is immutable after creation. To change ISO code, create a new country and deactivate the old one.';
  END IF;

  -- Deactivation and inactive→inactive: always allowed
  IF TG_OP = 'UPDATE' AND NOT NEW.is_active THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' AND NOT NEW.is_active THEN RETURN NEW; END IF;

  -- From here: NEW.is_active = true

  -- Block currency_code change on active market
  IF TG_OP = 'UPDATE' AND OLD.is_active AND NEW.currency_code != OLD.currency_code THEN
    RAISE EXCEPTION 'Cannot change currency on active market %. Deactivate first.', NEW.code;
  END IF;

  -- For active→active non-readiness edits, skip full validation
  IF TG_OP = 'UPDATE' AND OLD.is_active
     AND NEW.currency_code = OLD.currency_code
     AND NEW.pricing IS NOT DISTINCT FROM OLD.pricing
     AND NEW.payment_gateway = OLD.payment_gateway THEN
    RETURN NEW;
  END IF;

  -- ── Full activation / readiness validation ──

  -- Acquire commercial-write lock for consistent config read
  PERFORM pg_advisory_xact_lock(hashtext('commercial_config_write'));

  -- Basic field validation
  IF NEW.currency_code IS NULL OR length(NEW.currency_code) < 2 THEN
    RAISE EXCEPTION 'Cannot activate market %: currency_code is required', NEW.code;
  END IF;
  IF NEW.payment_gateway IS NULL OR NEW.payment_gateway = '' THEN
    RAISE EXCEPTION 'Cannot activate market %: payment_gateway is required', NEW.code;
  END IF;

  -- Payment gateway must be supported
  IF NOT (NEW.payment_gateway = ANY(v_supported_gateways)) THEN
    RAISE EXCEPTION 'Cannot activate market %: payment gateway "%" is not supported for subscription checkout', NEW.code, NEW.payment_gateway;
  END IF;

  -- Subscription pricing must be present and valid
  IF NEW.pricing IS NULL OR jsonb_typeof(NEW.pricing) != 'object'
     OR NEW.pricing -> 'free' IS NULL
     OR NEW.pricing -> 'growth' IS NULL
     OR NEW.pricing -> 'business' IS NULL THEN
    RAISE EXCEPTION 'Cannot activate market %: countries.pricing must contain free, growth, and business tiers', NEW.code;
  END IF;

  -- Paid tier prices must be valid positive numbers
  IF NEW.pricing -> 'growth' -> 'price' IS NULL
     OR jsonb_typeof(NEW.pricing -> 'growth' -> 'price') <> 'number'
     OR (NEW.pricing -> 'growth' ->> 'price')::NUMERIC <= 0 THEN
    RAISE EXCEPTION 'Cannot activate market %: growth tier price must be a positive number', NEW.code;
  END IF;
  IF NEW.pricing -> 'business' -> 'price' IS NULL
     OR jsonb_typeof(NEW.pricing -> 'business' -> 'price') <> 'number'
     OR (NEW.pricing -> 'business' ->> 'price')::NUMERIC <= 0 THEN
    RAISE EXCEPTION 'Cannot activate market %: business tier price must be a positive number', NEW.code;
  END IF;

  -- Read latest effective config snapshot
  SELECT config_snapshot INTO v_snapshot
    FROM public.platform_config_versions
    WHERE effective_from <= clock_timestamp()
    ORDER BY effective_from DESC LIMIT 1;

  IF v_snapshot IS NULL THEN
    RAISE EXCEPTION 'Cannot activate market %: no config version exists', NEW.code;
  END IF;

  v_pricing := v_snapshot -> 'messaging_pricing';
  v_trial_credit := v_snapshot -> 'trial_credit_minor_by_currency';
  v_included := v_snapshot -> 'subscription_included_minor_by_tier_currency';

  -- messaging_pricing must contain this country in exactly one bucket
  IF v_pricing IS NULL OR jsonb_typeof(v_pricing) != 'object' THEN
    RAISE EXCEPTION 'Cannot activate market %: messaging_pricing not configured', NEW.code;
  END IF;

  v_match_count := 0;
  v_bucket_currency := NULL;
  FOR v_bucket_currency IN SELECT key FROM jsonb_each(v_pricing) LOOP
    IF v_pricing -> v_bucket_currency -> 'rates' -> NEW.code IS NOT NULL THEN
      v_match_count := v_match_count + 1;
    END IF;
  END LOOP;

  IF v_match_count = 0 THEN
    RAISE EXCEPTION 'Cannot activate market %: not found in any messaging_pricing bucket', NEW.code;
  END IF;
  IF v_match_count > 1 THEN
    RAISE EXCEPTION 'Cannot activate market %: found in % buckets (must be 1)', NEW.code, v_match_count;
  END IF;

  -- Re-resolve matched bucket currency
  v_bucket_currency := NULL;
  FOR v_bucket_currency IN SELECT key FROM jsonb_each(v_pricing) LOOP
    IF v_pricing -> v_bucket_currency -> 'rates' -> NEW.code IS NOT NULL THEN
      EXIT;
    END IF;
  END LOOP;

  -- Bucket currency must match countries.currency_code
  IF v_bucket_currency != NEW.currency_code THEN
    RAISE EXCEPTION 'Cannot activate market %: messaging_pricing maps it under % but currency_code is %',
      NEW.code, v_bucket_currency, NEW.currency_code;
  END IF;

  -- Spend cap — must be positive integer
  IF v_pricing -> v_bucket_currency -> 'default_spend_cap_minor' IS NULL
     OR jsonb_typeof(v_pricing -> v_bucket_currency -> 'default_spend_cap_minor') != 'number'
     OR (v_pricing -> v_bucket_currency ->> 'default_spend_cap_minor')::NUMERIC <= 0
     OR (v_pricing -> v_bucket_currency ->> 'default_spend_cap_minor')::NUMERIC <> FLOOR((v_pricing -> v_bucket_currency ->> 'default_spend_cap_minor')::NUMERIC) THEN
    RAISE EXCEPTION 'Cannot activate market %: bucket % default_spend_cap_minor must be a positive integer', NEW.code, v_bucket_currency;
  END IF;

  -- Trial credit
  IF v_trial_credit IS NULL OR v_trial_credit ->> NEW.currency_code IS NULL THEN
    RAISE EXCEPTION 'Cannot activate market %: trial_credit_minor_by_currency missing for %', NEW.code, NEW.currency_code;
  END IF;

  -- Tier included credits
  IF v_included IS NULL
     OR v_included -> 'growth' ->> NEW.currency_code IS NULL
     OR v_included -> 'business' ->> NEW.currency_code IS NULL THEN
    RAISE EXCEPTION 'Cannot activate market %: subscription_included incomplete for %', NEW.code, NEW.currency_code;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_guard_country_activation
  BEFORE INSERT OR UPDATE ON public.countries
  FOR EACH ROW EXECUTE FUNCTION public.guard_country_activation();

-- ══════════════════════════════════════════════════════════
-- E. No hard delete trigger
-- ══════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.guard_country_deletion()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Country deletion is not permitted. Use is_active=false to deactivate market %.', OLD.code;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_guard_country_deletion
  BEFORE DELETE ON public.countries
  FOR EACH ROW EXECUTE FUNCTION public.guard_country_deletion();

-- ══════════════════════════════════════════════════════════
-- F. Verification
-- ══════════════════════════════════════════════════════════

DO $$
DECLARE
  v_count INTEGER;
BEGIN
  -- Verify save_commercial_config has new 4-arg signature
  SELECT count(*) INTO v_count FROM pg_proc
    WHERE proname = 'save_commercial_config'
      AND pronamespace = 'public'::regnamespace
      AND pronargs = 4;
  IF v_count = 0 THEN
    RAISE EXCEPTION 'M377: save_commercial_config 4-arg not found';
  END IF;

  -- Verify save_messaging_config exists
  SELECT count(*) INTO v_count FROM pg_proc
    WHERE proname = 'save_messaging_config'
      AND pronamespace = 'public'::regnamespace;
  IF v_count = 0 THEN
    RAISE EXCEPTION 'M377: save_messaging_config not found';
  END IF;

  -- Verify save_commercial_config body contains messaging_pricing in snapshot keys
  SELECT count(*) INTO v_count FROM pg_proc
    WHERE proname = 'save_commercial_config'
      AND pronamespace = 'public'::regnamespace
      AND prosrc LIKE '%messaging_pricing%';
  IF v_count = 0 THEN
    RAISE EXCEPTION 'M377: save_commercial_config missing messaging_pricing in key set';
  END IF;

  -- Verify guard_commercial_settings body contains messaging_pricing
  SELECT count(*) INTO v_count FROM pg_proc
    WHERE proname = 'guard_commercial_settings'
      AND pronamespace = 'public'::regnamespace
      AND prosrc LIKE '%messaging_pricing%';
  IF v_count = 0 THEN
    RAISE EXCEPTION 'M377: guard_commercial_settings missing messaging_pricing';
  END IF;

  -- Verify country triggers exist
  SELECT count(*) INTO v_count FROM information_schema.triggers
    WHERE trigger_name = 'trg_guard_country_activation'
      AND event_object_table = 'countries';
  IF v_count = 0 THEN
    RAISE EXCEPTION 'M377: trg_guard_country_activation not found';
  END IF;

  SELECT count(*) INTO v_count FROM information_schema.triggers
    WHERE trigger_name = 'trg_guard_country_deletion'
      AND event_object_table = 'countries';
  IF v_count = 0 THEN
    RAISE EXCEPTION 'M377: trg_guard_country_deletion not found';
  END IF;

  -- Verify old 3-arg save_commercial_config is gone
  SELECT count(*) INTO v_count FROM pg_proc
    WHERE proname = 'save_commercial_config'
      AND pronamespace = 'public'::regnamespace
      AND pronargs = 3;
  IF v_count > 0 THEN
    RAISE EXCEPTION 'M377: old 3-arg save_commercial_config still exists — must be dropped';
  END IF;
END;
$$;
