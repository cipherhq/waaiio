-- M467b: Install 5-arg save_provider_plan_refs with p_tier_prices support.
--
-- Extracted from M458 Section B (lines 121-277). Enables atomic price +
-- plan-code cutover for Paystack countries without touching existing
-- subscription prices, fees, or trialDays.
--
-- Why not apply M458 directly? M458 Section A embeds obsolete Stripe-market
-- prices (US $15/$40) that would temporarily break new checkouts until M467
-- overwrites them. This migration installs only the RPC upgrade.
--
-- Prerequisites (all present in production without M458):
--   - platform_config_versions table (M359/M377)
--   - countries table with pricing JSONB (M092/M377)
--   - platform_settings table with commercial keys (M377)
-- Production has the 4-arg version from M378; this drops it and creates
-- the 5-arg version. The 5-arg version accepts all 4-arg calls unchanged
-- (p_tier_prices DEFAULT NULL).
--
-- Idempotent: CREATE OR REPLACE is a no-op if M458 already ran.
-- Sort order: 467b runs after 467 and before 468 (alphabetic).
--
-- Rollback: CREATE OR REPLACE back to the 4-arg signature is NOT safe
-- because PostgreSQL cannot change parameter counts via REPLACE. Safe
-- rollback requires: (1) DROP the 5-arg, (2) CREATE the 4-arg, in a
-- single transaction. The admin tier_prices UI gracefully omits
-- p_tier_prices for Stripe countries, so the 4-arg version is backward
-- compatible for ref-only saves.
BEGIN;

-- Drop the 4-arg version if it exists (production state)
DO $$ BEGIN
  IF to_regprocedure('public.save_provider_plan_refs(text,jsonb,uuid,uuid)') IS NOT NULL
     AND to_regprocedure('public.save_provider_plan_refs(text,jsonb,uuid,uuid,jsonb)') IS NULL THEN
    EXECUTE 'DROP FUNCTION public.save_provider_plan_refs(text, jsonb, uuid, uuid)';
    RAISE NOTICE 'M467b: dropped 4-arg save_provider_plan_refs';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.save_provider_plan_refs(
  p_country_code TEXT,
  p_plan_refs JSONB,
  p_expected_version_id UUID,
  p_actor_id UUID DEFAULT NULL,
  p_tier_prices JSONB DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_actor_id UUID;
  v_latest_version_id UUID;
  v_version_id UUID;
  v_now TIMESTAMPTZ;
  v_tier TEXT;
  v_tier_refs JSONB;
  v_provider TEXT;
  v_ref TEXT;
  v_country RECORD;
  v_commercial_keys TEXT[] := ARRAY[
    'pricing_tiers', 'trial_days', 'broadcast_limits', 'conversation_limits',
    'default_platform_fee_percent', 'annual_discount_percentage',
    'payout_cooling_period_days', 'minimum_payout', 'payout_verification_limits',
    'transfer_expiry_hours', 'minimum_bank_transfer',
    'messaging_financial_gate', 'messaging_reservation_ttl_seconds',
    'trial_credit_minor_by_currency', 'subscription_included_minor_by_tier_currency',
    'fee_policy_enabled', 'category_fee_rates', 'messaging_pricing'
  ];
  v_snapshot JSONB;
  v_price_tier TEXT;
  v_price_obj JSONB;
  v_price_val NUMERIC;
BEGIN
  -- Actor resolution: prefer explicit p_actor_id (server-side service_role path),
  -- fall back to auth.uid() (authenticated path for backward compat)
  v_actor_id := COALESCE(p_actor_id, auth.uid());
  IF v_actor_id IS NULL THEN RAISE EXCEPTION 'save_provider_plan_refs requires actor identity'; END IF;

  PERFORM pg_advisory_xact_lock(hashtext('commercial_config_write'));

  IF p_expected_version_id IS NULL THEN
    RAISE EXCEPTION 'save_provider_plan_refs requires non-NULL expected_version_id';
  END IF;
  SELECT id INTO v_latest_version_id FROM platform_config_versions
    WHERE effective_from <= clock_timestamp() ORDER BY effective_from DESC LIMIT 1;
  IF v_latest_version_id IS DISTINCT FROM p_expected_version_id THEN
    RAISE EXCEPTION 'config_version_conflict: expected % but latest is %', p_expected_version_id, v_latest_version_id;
  END IF;

  SELECT code, payment_gateway, pricing INTO v_country FROM countries WHERE code = p_country_code;
  IF NOT FOUND THEN RAISE EXCEPTION 'save_provider_plan_refs: unknown country "%"', p_country_code; END IF;

  IF p_plan_refs IS NULL OR jsonb_typeof(p_plan_refs) <> 'object' THEN
    RAISE EXCEPTION 'p_plan_refs must be a JSONB object';
  END IF;

  -- Validate p_tier_prices if provided
  IF p_tier_prices IS NOT NULL THEN
    IF jsonb_typeof(p_tier_prices) <> 'object' THEN
      RAISE EXCEPTION 'p_tier_prices must be a JSONB object';
    END IF;
    FOR v_price_tier IN SELECT key FROM jsonb_each(p_tier_prices) LOOP
      IF v_price_tier NOT IN ('growth', 'business') THEN
        RAISE EXCEPTION 'p_tier_prices: only growth and business tiers allowed, got "%"', v_price_tier;
      END IF;
      v_price_obj := p_tier_prices -> v_price_tier;
      IF jsonb_typeof(v_price_obj) <> 'object' THEN
        RAISE EXCEPTION 'p_tier_prices[%] must be an object', v_price_tier;
      END IF;
      -- Only 'price' field is allowed
      IF (SELECT COUNT(*) FROM jsonb_each(v_price_obj) WHERE key <> 'price') > 0 THEN
        RAISE EXCEPTION 'p_tier_prices[%]: only "price" field is allowed', v_price_tier;
      END IF;
      v_price_val := (v_price_obj ->> 'price')::NUMERIC;
      IF v_price_val IS NULL OR v_price_val <= 0 THEN
        RAISE EXCEPTION 'p_tier_prices[%].price must be a positive number', v_price_tier;
      END IF;
    END LOOP;

    -- Atomicity guard: every tier with a price change must have a matching plan ref
    -- for the country's ACTIVE gateway. Prevents price-only updates and wrong-gateway refs.
    FOR v_price_tier IN SELECT key FROM jsonb_each(p_tier_prices) LOOP
      IF NOT (p_plan_refs ? v_price_tier) THEN
        RAISE EXCEPTION 'p_tier_prices[%] requires a matching p_plan_refs entry for atomic cutover', v_price_tier;
      END IF;
      -- Gateway-specific guard: the ref must be for the country's active gateway
      IF v_country.payment_gateway IN ('paystack', 'flutterwave')
         AND (p_plan_refs -> v_price_tier ->> v_country.payment_gateway) IS NULL THEN
        RAISE EXCEPTION 'p_tier_prices[%] requires a % plan reference (active gateway for %)',
          v_price_tier, v_country.payment_gateway, p_country_code;
      END IF;
    END LOOP;

    -- Apply price updates BEFORE plan ref updates (so preflight at the API
    -- layer can verify new plan codes against the new prices)
    FOR v_price_tier IN SELECT key FROM jsonb_each(p_tier_prices) LOOP
      v_price_val := (p_tier_prices -> v_price_tier ->> 'price')::NUMERIC;
      UPDATE countries SET pricing = jsonb_set(
        pricing, ARRAY[v_price_tier, 'price'], to_jsonb(v_price_val)
      ) WHERE code = p_country_code;
    END LOOP;
  END IF;

  -- Validate plan refs (unchanged from M378)
  FOR v_tier IN SELECT key FROM jsonb_each(p_plan_refs) LOOP
    IF v_tier NOT IN ('growth', 'business') THEN RAISE EXCEPTION 'unknown tier "%"', v_tier; END IF;
    v_tier_refs := p_plan_refs -> v_tier;
    IF jsonb_typeof(v_tier_refs) <> 'object' THEN RAISE EXCEPTION 'plan_refs[%] must be object', v_tier; END IF;
    FOR v_provider IN SELECT key FROM jsonb_each(v_tier_refs) LOOP
      IF v_provider NOT IN ('paystack', 'flutterwave', 'stripe') THEN
        RAISE EXCEPTION 'unknown provider "%"', v_provider;
      END IF;
      v_ref := v_tier_refs ->> v_provider;
      IF v_provider IN ('paystack', 'flutterwave') AND (v_ref IS NULL OR length(TRIM(v_ref)) < 3) THEN
        RAISE EXCEPTION 'plan_refs[%][%]: ref must be >= 3 chars', v_tier, v_provider;
      END IF;
    END LOOP;
  END LOOP;

  PERFORM set_config('waaiio.provider_ref_auth', 'true', true);

  FOR v_tier IN SELECT key FROM jsonb_each(p_plan_refs) LOOP
    v_tier_refs := p_plan_refs -> v_tier;
    UPDATE countries SET pricing = jsonb_set(
      pricing, ARRAY[v_tier, 'provider_plan_refs'],
      COALESCE(pricing -> v_tier -> 'provider_plan_refs', '{}'::jsonb) || v_tier_refs
    ) WHERE code = p_country_code;

    IF v_tier_refs ->> 'paystack' IS NOT NULL THEN
      UPDATE countries SET pricing = jsonb_set(
        pricing, ARRAY[v_tier, 'paystack_plan_code'], to_jsonb(v_tier_refs ->> 'paystack')
      ) WHERE code = p_country_code;
    END IF;
  END LOOP;

  PERFORM set_config('waaiio.provider_ref_auth', '', true);

  SELECT jsonb_object_agg(key, value) INTO v_snapshot FROM platform_settings WHERE key = ANY(v_commercial_keys);
  v_now := clock_timestamp();
  v_version_id := gen_random_uuid();
  INSERT INTO platform_config_versions (id, config_snapshot, effective_from, created_by, created_at)
  VALUES (v_version_id, COALESCE(v_snapshot, '{}'::jsonb), v_now, v_actor_id, v_now);
  RETURN v_version_id;
END;
$$;

-- Least-privilege grants (idempotent)
REVOKE ALL ON FUNCTION public.save_provider_plan_refs(text, jsonb, uuid, uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.save_provider_plan_refs(text, jsonb, uuid, uuid, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.save_provider_plan_refs(text, jsonb, uuid, uuid, jsonb) FROM authenticated;
REVOKE ALL ON FUNCTION public.save_provider_plan_refs(text, jsonb, uuid, uuid, jsonb) FROM service_role;
GRANT EXECUTE ON FUNCTION public.save_provider_plan_refs(text, jsonb, uuid, uuid, jsonb) TO service_role;

-- Verification
DO $$ BEGIN
  IF to_regprocedure('public.save_provider_plan_refs(text,jsonb,uuid,uuid,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'M467b verification failed: 5-arg save_provider_plan_refs not found';
  END IF;
END $$;

COMMIT;
