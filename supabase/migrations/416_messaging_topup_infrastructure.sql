-- ═══════════════════════════════════════════════════════
-- 416: Messaging Top-Up Infrastructure (#491)
--
-- Adds the durable purchase/intention table, config key,
-- and refund tracking for WhatsApp messaging credit top-up.
--
-- Surfaces:
--   NEW TABLE: messaging_topup_purchases
--   ALTERED: save_commercial_config — 19-key allowlist (+messaging_topup_packages)
--   ALTERED: save_messaging_config — 19-key allowlist
--   ALTERED: guard_commercial_settings — 19-key allowlist
--   NEW RPC: grant_purchased_messaging_allowance(UUID) — atomic verified-grant
--   NEW RPC: process_topup_refund(UUID, INTEGER) — idempotent refund clawback
-- ═══════════════════════════════════════════════════════

-- ══════════════════════════════════════════════════════════
-- 1. messaging_topup_purchases — durable purchase state machine
-- ══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.messaging_topup_purchases (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id       UUID NOT NULL REFERENCES public.businesses(id) ON DELETE RESTRICT,
  owner_id          UUID NOT NULL,
  -- Package identity (server-resolved, never client-authoritative)
  package_amount_minor  INTEGER NOT NULL CHECK (package_amount_minor > 0),
  currency_code     TEXT NOT NULL,
  -- Provider checkout
  gateway           TEXT NOT NULL CHECK (gateway IN ('stripe', 'paystack')),
  provider_checkout_id  TEXT,
  provider_reference    TEXT,
  -- State machine: pending → completed | failed | partially_refunded | refunded | disputed | review
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'completed', 'failed', 'partially_refunded', 'refunded', 'disputed', 'review')),
  -- Grant linkage (set on completion)
  allowance_id      UUID REFERENCES public.messaging_allowances(id),
  grant_source_ref  TEXT,
  -- Refund tracking
  refund_provider_ref   TEXT,
  refund_amount_minor   INTEGER CHECK (refund_amount_minor IS NULL OR refund_amount_minor >= 0),
  refund_clawback_minor INTEGER CHECK (refund_clawback_minor IS NULL OR refund_clawback_minor >= 0),
  consumed_shortfall_minor INTEGER CHECK (consumed_shortfall_minor IS NULL OR consumed_shortfall_minor >= 0),
  -- Config provenance
  config_version_id UUID REFERENCES public.platform_config_versions(id),
  -- Timestamps
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at      TIMESTAMPTZ,
  refunded_at       TIMESTAMPTZ,

  -- Exactly-once checkout per business + provider reference
  UNIQUE(business_id, gateway, provider_reference)
);

CREATE INDEX IF NOT EXISTS idx_mtp_business ON messaging_topup_purchases(business_id);
CREATE INDEX IF NOT EXISTS idx_mtp_status ON messaging_topup_purchases(status) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_mtp_provider ON messaging_topup_purchases(gateway, provider_checkout_id);

-- ── 1b. RLS ──

ALTER TABLE messaging_topup_purchases ENABLE ROW LEVEL SECURITY;

CREATE POLICY mtp_owner_select ON messaging_topup_purchases
  FOR SELECT USING (EXISTS (
    SELECT 1 FROM public.businesses WHERE id = messaging_topup_purchases.business_id AND owner_id = auth.uid()
  ));

CREATE POLICY mtp_admin_select ON messaging_topup_purchases
  FOR SELECT USING (public.is_admin());

-- ── 1c. Grants ──

REVOKE ALL ON messaging_topup_purchases FROM PUBLIC, authenticated, service_role, anon;
GRANT SELECT ON messaging_topup_purchases TO authenticated;
GRANT SELECT, INSERT, UPDATE ON messaging_topup_purchases TO service_role;

-- ══════════════════════════════════════════════════════════
-- 2. Extend save_commercial_config with messaging_topup_packages
-- ══════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.save_commercial_config(
  p_key TEXT,
  p_value JSONB,
  p_description TEXT DEFAULT NULL,
  p_expected_version_id UUID DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  -- 19 unique snapshot keys: 16 individually mutable + 3 bundle-only
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
    'messaging_pricing',
    'messaging_topup_packages'
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
  -- Top-up package validation
  v_pkg JSONB;
  v_pkg_idx INTEGER;
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

  -- CAS: if expected_version_id provided, verify it matches current latest
  IF p_expected_version_id IS NOT NULL THEN
    SELECT id INTO v_latest_version_id
      FROM platform_config_versions
      ORDER BY effective_from DESC
      LIMIT 1;
    IF v_latest_version_id IS DISTINCT FROM p_expected_version_id THEN
      RAISE EXCEPTION 'Config version conflict: expected %, got %', p_expected_version_id, v_latest_version_id;
    END IF;
  END IF;

  -- Write-time type validation for financial keys
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

  -- Write-time validation for messaging_topup_packages
  IF p_key = 'messaging_topup_packages' THEN
    IF jsonb_typeof(p_value) <> 'object' THEN
      RAISE EXCEPTION 'messaging_topup_packages must be a JSONB object keyed by currency, got %', jsonb_typeof(p_value);
    END IF;
    FOR v_cur_key, v_cur_val IN SELECT * FROM jsonb_each(p_value)
    LOOP
      IF jsonb_typeof(v_cur_val) <> 'array' THEN
        RAISE EXCEPTION 'messaging_topup_packages[%] must be an array of packages, got %', v_cur_key, jsonb_typeof(v_cur_val);
      END IF;
      FOR v_pkg_idx IN 0 .. jsonb_array_length(v_cur_val) - 1
      LOOP
        v_pkg := v_cur_val -> v_pkg_idx;
        IF jsonb_typeof(v_pkg) <> 'object' THEN
          RAISE EXCEPTION 'messaging_topup_packages[%][%] must be an object', v_cur_key, v_pkg_idx;
        END IF;
        IF v_pkg -> 'amount_minor' IS NULL OR jsonb_typeof(v_pkg -> 'amount_minor') <> 'number' THEN
          RAISE EXCEPTION 'messaging_topup_packages[%][%].amount_minor must be a positive integer', v_cur_key, v_pkg_idx;
        END IF;
        IF (v_pkg ->> 'amount_minor')::NUMERIC <= 0 OR (v_pkg ->> 'amount_minor')::NUMERIC <> FLOOR((v_pkg ->> 'amount_minor')::NUMERIC) THEN
          RAISE EXCEPTION 'messaging_topup_packages[%][%].amount_minor must be a positive integer, got %', v_cur_key, v_pkg_idx, v_pkg ->> 'amount_minor';
        END IF;
        IF v_pkg -> 'label' IS NULL OR jsonb_typeof(v_pkg -> 'label') <> 'string' THEN
          RAISE EXCEPTION 'messaging_topup_packages[%][%].label must be a string', v_cur_key, v_pkg_idx;
        END IF;
      END LOOP;
    END LOOP;
  END IF;

  -- Upsert the target platform_settings row
  INSERT INTO platform_settings (key, value, description, updated_by, updated_at)
  VALUES (p_key, p_value, COALESCE(p_description, ''), v_caller_id, clock_timestamp())
  ON CONFLICT (key) DO UPDATE
    SET value = EXCLUDED.value,
        description = COALESCE(NULLIF(p_description, ''), platform_settings.description),
        updated_by = EXCLUDED.updated_by,
        updated_at = EXCLUDED.updated_at;

  -- Build snapshot from complete post-mutation allowlisted state
  v_now := clock_timestamp();
  SELECT jsonb_object_agg(key, value)
  INTO v_snapshot
  FROM platform_settings
  WHERE key = ANY(v_commercial_keys);

  IF v_snapshot IS NULL OR v_snapshot = '{}'::jsonb THEN
    RAISE EXCEPTION 'Cannot create config version: no commercial keys found in platform_settings';
  END IF;

  v_version_id := gen_random_uuid();
  INSERT INTO platform_config_versions (id, config_snapshot, effective_from, created_by)
  VALUES (v_version_id, v_snapshot, v_now, v_caller_id);

  RETURN v_version_id;
END;
$$;

-- ══════════════════════════════════════════════════════════
-- 3. Update save_messaging_config allowlist (19 keys)
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
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  -- 19 unique snapshot keys (must match save_commercial_config)
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
    'messaging_pricing',
    'messaging_topup_packages'
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

  -- Serialize BEFORE cross-key reads/validation
  PERFORM pg_advisory_xact_lock(hashtext('commercial_config_write'));

  -- CAS: verify expected version (matches M377 contract)
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

  -- ── Validate messaging_pricing (matches M377 contract exactly) ──
  IF jsonb_typeof(p_messaging_pricing) <> 'object' THEN
    RAISE EXCEPTION 'messaging_pricing must be a JSONB object';
  END IF;
  FOR v_currency, v_bucket IN SELECT * FROM jsonb_each(p_messaging_pricing)
  LOOP
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

      IF v_country_key = ANY(v_seen_countries) THEN
        RAISE EXCEPTION 'messaging_pricing: country "%" appears in multiple currency buckets', v_country_key;
      END IF;
      v_seen_countries := array_append(v_seen_countries, v_country_key);

      v_rate_val := v_bucket -> 'rates' -> v_country_key;
      IF jsonb_typeof(v_rate_val) <> 'object' THEN
        RAISE EXCEPTION 'messaging_pricing[%].rates[%] must be an object with rate values', v_currency, v_country_key;
      END IF;

      -- Validate every rate entry: key must be a known category or wildcard
      DECLARE
        v_rate_entry_key TEXT;
        v_rate_entry_val JSONB;
        v_rate_num NUMERIC;
        v_allowed_rate_keys TEXT[] := ARRAY['*', 'marketing', 'utility', 'authentication', 'service'];
      BEGIN
        FOR v_rate_entry_key IN SELECT key FROM jsonb_each(v_rate_val) LOOP
          IF NOT (v_rate_entry_key = ANY(v_allowed_rate_keys)) THEN
            RAISE EXCEPTION 'messaging_pricing[%].rates[%]: unknown rate key "%"; allowed: *, marketing, utility, authentication, service',
              v_currency, v_country_key, v_rate_entry_key;
          END IF;
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
  IF jsonb_typeof(p_trial_credit_minor_by_currency) <> 'object' THEN
    RAISE EXCEPTION 'trial_credit_minor_by_currency must be a JSONB object';
  END IF;

  -- ── Validate subscription_included_minor_by_tier_currency ──
  IF jsonb_typeof(p_subscription_included_minor_by_tier_currency) <> 'object' THEN
    RAISE EXCEPTION 'subscription_included_minor_by_tier_currency must be a JSONB object';
  END IF;

  -- ── Atomic three-map upsert ──
  INSERT INTO platform_settings (key, value, description, updated_by, updated_at)
  VALUES ('messaging_pricing', p_messaging_pricing, COALESCE(p_description, 'messaging bundle'), v_caller_id, clock_timestamp())
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at;

  INSERT INTO platform_settings (key, value, description, updated_by, updated_at)
  VALUES ('trial_credit_minor_by_currency', p_trial_credit_minor_by_currency, COALESCE(p_description, 'messaging bundle'), v_caller_id, clock_timestamp())
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at;

  INSERT INTO platform_settings (key, value, description, updated_by, updated_at)
  VALUES ('subscription_included_minor_by_tier_currency', p_subscription_included_minor_by_tier_currency, COALESCE(p_description, 'messaging bundle'), v_caller_id, clock_timestamp())
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at;

  -- ── Country activation gate ──
  FOR v_country IN SELECT code, is_active FROM countries WHERE is_active = true
  LOOP
    v_match_count := 0;
    v_matched_currency := NULL;
    FOR v_currency IN SELECT key FROM jsonb_each(p_messaging_pricing)
    LOOP
      IF p_messaging_pricing -> v_currency -> 'rates' -> v_country.code IS NOT NULL THEN
        v_match_count := v_match_count + 1;
        v_matched_currency := v_currency;
      END IF;
    END LOOP;
    IF v_match_count = 0 THEN
      RAISE EXCEPTION 'Active country "%" has no messaging pricing coverage', v_country.code;
    END IF;
    IF v_match_count > 1 THEN
      RAISE EXCEPTION 'Active country "%" appears in multiple currency buckets', v_country.code;
    END IF;
  END LOOP;

  -- ── Build versioned snapshot ──
  v_now := clock_timestamp();
  SELECT jsonb_object_agg(key, value)
  INTO v_snapshot
  FROM platform_settings
  WHERE key = ANY(v_commercial_keys);

  IF v_snapshot IS NULL OR v_snapshot = '{}'::jsonb THEN
    RAISE EXCEPTION 'Cannot create config version: no commercial keys found';
  END IF;

  v_version_id := gen_random_uuid();
  INSERT INTO platform_config_versions (id, config_snapshot, effective_from, created_by)
  VALUES (v_version_id, v_snapshot, v_now, v_caller_id);

  RETURN v_version_id;
END;
$$;

-- ══════════════════════════════════════════════════════════
-- 4. Update guard_commercial_settings (19-key allowlist)
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
    'messaging_pricing',
    'messaging_topup_packages'
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

    IF current_user IS DISTINCT FROM v_trusted_owner_scalar
       AND current_user IS DISTINCT FROM v_trusted_owner_bundle THEN
      RAISE EXCEPTION 'Direct mutation of commercial key "%" is blocked. Use save_commercial_config() or save_messaging_config().',
        COALESCE(NEW.key, OLD.key);
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$ LANGUAGE plpgsql;

-- ══════════════════════════════════════════════════════════
-- 5. grant_purchased_messaging_allowance(UUID)
--    Atomic: transitions purchase to completed + grants allowance
-- ══════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.grant_purchased_messaging_allowance(p_purchase_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_purchase RECORD;
  v_source_ref TEXT;
  v_grant_result JSONB;
BEGIN
  -- Lock purchase row
  SELECT * INTO v_purchase
    FROM public.messaging_topup_purchases
    WHERE id = p_purchase_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('granted', false, 'reason', 'purchase_not_found');
  END IF;

  -- Idempotent: already completed — return success so webhook retries converge
  IF v_purchase.status = 'completed' THEN
    RETURN jsonb_build_object('granted', true, 'idempotent', true,
      'allowance_id', v_purchase.allowance_id::TEXT,
      'amount_minor', v_purchase.package_amount_minor,
      'currency_code', v_purchase.currency_code,
      'source_ref', v_purchase.grant_source_ref);
  END IF;

  -- Only pending purchases can be completed
  IF v_purchase.status <> 'pending' THEN
    RETURN jsonb_build_object('granted', false, 'reason', 'invalid_status',
      'current_status', v_purchase.status);
  END IF;

  -- Build source_ref from verified provider identity
  v_source_ref := v_purchase.gateway || ':' || v_purchase.provider_reference;

  -- Call canonical grant function (exactly-once via source_ref)
  v_grant_result := public.grant_messaging_allowance(
    v_purchase.business_id,
    'purchased',
    v_purchase.package_amount_minor,
    v_purchase.currency_code,
    v_source_ref,
    v_purchase.config_version_id,
    NULL  -- purchased credit does not expire (CTO decision)
  );

  IF (v_grant_result ->> 'granted')::BOOLEAN = true OR (v_grant_result ->> 'idempotent')::BOOLEAN = true THEN
    -- Transition purchase to completed
    UPDATE public.messaging_topup_purchases
      SET status = 'completed',
          completed_at = NOW(),
          allowance_id = (v_grant_result ->> 'allowance_id')::UUID,
          grant_source_ref = v_source_ref
      WHERE id = p_purchase_id;

    RETURN jsonb_build_object(
      'granted', true,
      'allowance_id', v_grant_result ->> 'allowance_id',
      'amount_minor', v_purchase.package_amount_minor,
      'currency_code', v_purchase.currency_code,
      'source_ref', v_source_ref
    );
  END IF;

  -- Grant failed (idempotency mismatch or other error)
  RETURN jsonb_build_object('granted', false, 'reason', 'grant_failed',
    'detail', v_grant_result);
END;
$$;

REVOKE ALL ON FUNCTION public.grant_purchased_messaging_allowance(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.grant_purchased_messaging_allowance(UUID) FROM anon;
REVOKE ALL ON FUNCTION public.grant_purchased_messaging_allowance(UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.grant_purchased_messaging_allowance(UUID) TO service_role;

-- ══════════════════════════════════════════════════════════
-- 6. process_topup_refund(UUID, TEXT, INTEGER)
--    Cumulative-safe, per-event idempotent refund clawback.
--    Supports sequential partial refunds and duplicate provider events.
-- ══════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.process_topup_refund(
  p_purchase_id UUID,
  p_provider_refund_id TEXT,      -- provider event identity for per-event idempotency
  p_this_refund_amount_minor INTEGER  -- amount of THIS refund event (not cumulative)
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_purchase RECORD;
  v_allowance RECORD;
  v_clawback INTEGER;
  v_shortfall INTEGER;
  v_adjust_source TEXT;
  v_prev_refund_total INTEGER;
  v_new_refund_total INTEGER;
  v_new_clawback_total INTEGER;
  v_new_shortfall_total INTEGER;
  v_new_status TEXT;
  v_existing_adjust RECORD;
BEGIN
  -- Lock purchase
  SELECT * INTO v_purchase
    FROM public.messaging_topup_purchases
    WHERE id = p_purchase_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('processed', false, 'reason', 'purchase_not_found');
  END IF;

  IF v_purchase.allowance_id IS NULL THEN
    RETURN jsonb_build_object('processed', false, 'reason', 'no_allowance_linked');
  END IF;

  -- ── Per-event idempotency FIRST ──
  -- Must run before terminal status rejection so replays of already-processed
  -- refund events return idempotent success even after terminal refunded/disputed.
  v_adjust_source := 'refund:' || p_purchase_id::TEXT || ':' || p_provider_refund_id;
  SELECT * INTO v_existing_adjust
    FROM public.messaging_allowance_events
    WHERE allowance_id = v_purchase.allowance_id
      AND event_type = 'adjust'
      AND source_key = v_adjust_source;

  IF FOUND THEN
    RETURN jsonb_build_object('processed', true, 'idempotent', true,
      'provider_refund_id', p_provider_refund_id,
      'status', v_purchase.status);
  END IF;

  -- ── Terminal/non-refundable check (new events only) ──
  IF v_purchase.status = 'disputed' THEN
    RETURN jsonb_build_object('processed', false, 'reason', 'not_refundable',
      'current_status', v_purchase.status);
  END IF;

  IF v_purchase.status NOT IN ('completed', 'partially_refunded', 'review') THEN
    RETURN jsonb_build_object('processed', false, 'reason', 'not_refundable',
      'current_status', v_purchase.status);
  END IF;

  -- Lock the linked allowance
  SELECT * INTO v_allowance
    FROM public.messaging_allowances
    WHERE id = v_purchase.allowance_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('processed', false, 'reason', 'allowance_not_found');
  END IF;

  -- Cumulative accounting
  v_prev_refund_total := COALESCE(v_purchase.refund_amount_minor, 0);
  v_new_refund_total := v_prev_refund_total + p_this_refund_amount_minor;

  -- Guard: cumulative refund cannot exceed original purchase
  IF v_new_refund_total > v_purchase.package_amount_minor THEN
    RETURN jsonb_build_object('processed', false, 'reason', 'refund_exceeds_purchase',
      'purchase_amount', v_purchase.package_amount_minor,
      'already_refunded', v_prev_refund_total,
      'this_refund', p_this_refund_amount_minor);
  END IF;

  -- Clawback THIS refund's amount from remaining credit (floor at 0)
  v_clawback := LEAST(v_allowance.remaining_minor, p_this_refund_amount_minor);
  v_shortfall := p_this_refund_amount_minor - v_clawback;

  -- Decrement allowance for this refund slice
  IF v_clawback > 0 THEN
    UPDATE public.messaging_allowances
      SET remaining_minor = remaining_minor - v_clawback
      WHERE id = v_purchase.allowance_id;

    -- Record per-event adjust event (idempotent via unique source_key)
    INSERT INTO public.messaging_allowance_events (
      allowance_id, business_id, event_type, amount_minor,
      source_key, balance_after_minor
    ) VALUES (
      v_purchase.allowance_id, v_purchase.business_id, 'adjust',
      -v_clawback, v_adjust_source,
      v_allowance.remaining_minor - v_clawback
    );
  ELSE
    -- Zero clawback — still record adjust event for idempotency tracking
    INSERT INTO public.messaging_allowance_events (
      allowance_id, business_id, event_type, amount_minor,
      source_key, balance_after_minor
    ) VALUES (
      v_purchase.allowance_id, v_purchase.business_id, 'adjust',
      0, v_adjust_source,
      v_allowance.remaining_minor
    );
  END IF;

  -- Update cumulative totals on purchase
  v_new_clawback_total := COALESCE(v_purchase.refund_clawback_minor, 0) + v_clawback;
  v_new_shortfall_total := COALESCE(v_purchase.consumed_shortfall_minor, 0) + v_shortfall;

  -- Determine new status
  IF v_new_shortfall_total > 0 THEN
    v_new_status := 'review';
  ELSIF v_new_refund_total >= v_purchase.package_amount_minor THEN
    v_new_status := 'refunded';
  ELSE
    v_new_status := 'partially_refunded';
  END IF;

  UPDATE public.messaging_topup_purchases
    SET status = v_new_status,
        refund_amount_minor = v_new_refund_total,
        refund_clawback_minor = v_new_clawback_total,
        consumed_shortfall_minor = CASE WHEN v_new_shortfall_total > 0 THEN v_new_shortfall_total ELSE NULL END,
        refund_provider_ref = COALESCE(refund_provider_ref || ',' || p_provider_refund_id, p_provider_refund_id),
        refunded_at = NOW()
    WHERE id = p_purchase_id;

  -- If any shortfall exists, suspend messaging for admin review
  IF v_shortfall > 0 THEN
    UPDATE public.businesses
      SET messaging_suspended = true
      WHERE id = v_purchase.business_id;

    INSERT INTO public.alerts (business_id, type, severity, title, message, metadata)
    VALUES (
      v_purchase.business_id,
      'messaging_refund_review',
      'critical',
      'Messaging credit refund requires review',
      'A refund of ' || p_this_refund_amount_minor || ' minor units was processed but ' ||
        v_shortfall || ' minor units had already been consumed. Messaging has been suspended pending review.',
      jsonb_build_object(
        'purchase_id', p_purchase_id,
        'provider_refund_id', p_provider_refund_id,
        'this_refund_amount', p_this_refund_amount_minor,
        'cumulative_refunded', v_new_refund_total,
        'this_clawback', v_clawback,
        'this_shortfall', v_shortfall,
        'cumulative_shortfall', v_new_shortfall_total
      )
    );
  END IF;

  RETURN jsonb_build_object(
    'processed', true,
    'clawback_minor', v_clawback,
    'shortfall_minor', v_shortfall,
    'cumulative_refunded_minor', v_new_refund_total,
    'cumulative_shortfall_minor', v_new_shortfall_total,
    'status', v_new_status,
    'messaging_suspended', v_shortfall > 0,
    'provider_refund_id', p_provider_refund_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.process_topup_refund(UUID, TEXT, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.process_topup_refund(UUID, TEXT, INTEGER) FROM anon;
REVOKE ALL ON FUNCTION public.process_topup_refund(UUID, TEXT, INTEGER) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.process_topup_refund(UUID, TEXT, INTEGER) TO service_role;

-- ══════════════════════════════════════════════════════════
-- 7. Migration verification
-- ══════════════════════════════════════════════════════════

DO $$
DECLARE
  v_count INT;
BEGIN
  -- Verify messaging_topup_purchases exists
  SELECT count(*) INTO v_count FROM pg_class WHERE relname = 'messaging_topup_purchases';
  IF v_count = 0 THEN
    RAISE EXCEPTION 'MIGRATION 416 VERIFICATION FAILED: messaging_topup_purchases not created';
  END IF;

  -- Verify RLS enabled
  SELECT count(*) INTO v_count FROM pg_class
    WHERE relname = 'messaging_topup_purchases' AND relrowsecurity = true;
  IF v_count = 0 THEN
    RAISE EXCEPTION 'MIGRATION 416 VERIFICATION FAILED: RLS not enabled on messaging_topup_purchases';
  END IF;

  -- Verify grant_purchased_messaging_allowance exists and is SECURITY DEFINER
  SELECT count(*) INTO v_count FROM pg_proc
    WHERE proname = 'grant_purchased_messaging_allowance' AND prosecdef = true;
  IF v_count = 0 THEN
    RAISE EXCEPTION 'MIGRATION 416 VERIFICATION FAILED: grant_purchased_messaging_allowance not found';
  END IF;

  -- Verify process_topup_refund (3-arg) exists and is SECURITY DEFINER
  SELECT count(*) INTO v_count FROM pg_proc
    WHERE proname = 'process_topup_refund' AND prosecdef = true AND pronargs = 3;
  IF v_count = 0 THEN
    RAISE EXCEPTION 'MIGRATION 416 VERIFICATION FAILED: process_topup_refund(uuid,text,integer) not found';
  END IF;

  -- Verify save_commercial_config includes messaging_topup_packages
  SELECT count(*) INTO v_count FROM pg_proc
    WHERE proname = 'save_commercial_config'
      AND prosrc LIKE '%messaging_topup_packages%';
  IF v_count = 0 THEN
    RAISE EXCEPTION 'MIGRATION 416 VERIFICATION FAILED: save_commercial_config missing messaging_topup_packages';
  END IF;

  -- Verify guard_commercial_settings includes messaging_topup_packages
  SELECT count(*) INTO v_count FROM pg_proc
    WHERE proname = 'guard_commercial_settings'
      AND prosrc LIKE '%messaging_topup_packages%';
  IF v_count = 0 THEN
    RAISE EXCEPTION 'MIGRATION 416 VERIFICATION FAILED: guard_commercial_settings missing messaging_topup_packages';
  END IF;

  -- Verify grant_purchased_messaging_allowance is service-role only
  SELECT count(*) INTO v_count FROM information_schema.role_routine_grants
    WHERE routine_name = 'grant_purchased_messaging_allowance'
      AND grantee = 'authenticated';
  IF v_count > 0 THEN
    RAISE EXCEPTION 'MIGRATION 416 VERIFICATION FAILED: grant_purchased_messaging_allowance should not be callable by authenticated';
  END IF;

  RAISE NOTICE 'MIGRATION 416 VERIFICATION: All checks passed';
END;
$$;
