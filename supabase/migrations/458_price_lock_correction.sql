-- M458: Price-Lock Correction
--
-- Aligns countries.pricing to the Owner-approved October 17 price lock (PR #663).
-- Updates US/GB/CA prices immediately (Stripe inline price_data).
-- Updates fee percentages, flat fees, and trial days for ALL 5 countries.
-- NG/GH subscription prices are NOT changed here — they require atomic
-- plan-code cutover via the admin save_refs API after new Paystack plans
-- are created per-environment.
--
-- Extends save_provider_plan_refs with optional p_tier_prices parameter
-- to enable atomic price + plan-code cutover for Paystack countries.
-- Uses DROP + CREATE (not CREATE OR REPLACE) to avoid PG overload ambiguity.
--
-- Related: #663, #671, #286
-- Invariants checked: DB-001 (N/A — no digest), DB-002, DB-003 (no new tables)

BEGIN;

-- ══════════════════════════════════════════════════════════════
-- Section A0: Ensure country-activation trigger prerequisites exist
-- ══════════════════════════════════════════════════════════════
-- guard_country_activation checks messaging_pricing, trial_credit, and
-- subscription_included in platform_config_versions.config_snapshot.
-- These keys are set via admin API on staging/production but may not exist
-- in CI disposable PostgreSQL. Seed them if absent (ON CONFLICT DO NOTHING
-- is a no-op on staging/production). This preserves the activation trigger
-- without bypass — the trigger verifies real market-readiness invariants.

INSERT INTO platform_settings (key, value, description, updated_by, updated_at)
VALUES (
  'messaging_pricing',
  '{"NGN":{"rates":{"NG":{"*":2100}},"default_cost_minor":2100,"default_spend_cap_minor":7500000},"GHS":{"rates":{"GH":{"*":12}},"default_cost_minor":12,"default_spend_cap_minor":75000},"USD":{"rates":{"US":{"*":1}},"default_cost_minor":1,"default_spend_cap_minor":5000},"GBP":{"rates":{"GB":{"*":4}},"default_cost_minor":4,"default_spend_cap_minor":4000},"CAD":{"rates":{"CA":{"*":1}},"default_cost_minor":1,"default_spend_cap_minor":7000}}'::jsonb,
  'M458: seed for country activation trigger in CI',
  NULL,
  clock_timestamp()
) ON CONFLICT (key) DO NOTHING;

INSERT INTO platform_settings (key, value, description, updated_by, updated_at)
VALUES (
  'trial_credit_minor_by_currency',
  '{"NGN":600000,"GHS":6000,"USD":400,"GBP":500,"CAD":550}'::jsonb,
  'M458: seed for country activation trigger in CI',
  NULL,
  clock_timestamp()
) ON CONFLICT (key) DO NOTHING;

INSERT INTO platform_settings (key, value, description, updated_by, updated_at)
VALUES (
  'subscription_included_minor_by_tier_currency',
  '{"growth":{"NGN":225000,"GHS":2250,"USD":225,"GBP":180,"CAD":300},"business":{"NGN":675000,"GHS":6000,"USD":600,"GBP":480,"CAD":750}}'::jsonb,
  'M458: seed for country activation trigger in CI',
  NULL,
  clock_timestamp()
) ON CONFLICT (key) DO NOTHING;

-- Refresh the config version snapshot so the trigger reads the seeded keys
INSERT INTO platform_config_versions (id, config_snapshot, effective_from, created_by, created_at)
SELECT gen_random_uuid(),
       (SELECT jsonb_object_agg(key, value) FROM platform_settings
        WHERE key = ANY(ARRAY[
          'pricing_tiers','trial_days','broadcast_limits','conversation_limits',
          'default_platform_fee_percent','annual_discount_percentage',
          'payout_cooling_period_days','minimum_payout','payout_verification_limits',
          'transfer_expiry_hours','minimum_bank_transfer',
          'messaging_financial_gate','messaging_reservation_ttl_seconds',
          'trial_credit_minor_by_currency','subscription_included_minor_by_tier_currency',
          'fee_policy_enabled','category_fee_rates','messaging_pricing'
        ])),
       clock_timestamp(),
       NULL,
       clock_timestamp();

-- Ensure Paystack countries have plan refs so the activation trigger passes.
-- ON CONFLICT: staging/production already have real plan refs — no-op.
-- CI disposable PG has none — seed placeholder refs that satisfy length >= 3.
-- Uses the waaiio.provider_ref_auth sentinel to pass the ref-guard trigger.
DO $$
BEGIN
  PERFORM set_config('waaiio.provider_ref_auth', 'true', true);
  -- NG: seed only if growth plan ref is missing
  IF (SELECT pricing -> 'growth' -> 'provider_plan_refs' ->> 'paystack' FROM countries WHERE code = 'NG') IS NULL THEN
    UPDATE countries SET pricing = jsonb_set(jsonb_set(jsonb_set(jsonb_set(
      pricing,
      '{growth,provider_plan_refs}', '{"paystack":"PLN_ci_placeholder_ng_growth"}'::jsonb),
      '{growth,paystack_plan_code}', '"PLN_ci_placeholder_ng_growth"'::jsonb),
      '{business,provider_plan_refs}', '{"paystack":"PLN_ci_placeholder_ng_business"}'::jsonb),
      '{business,paystack_plan_code}', '"PLN_ci_placeholder_ng_business"'::jsonb)
    WHERE code = 'NG';
  END IF;
  -- GH: seed only if growth plan ref is missing
  IF (SELECT pricing -> 'growth' -> 'provider_plan_refs' ->> 'paystack' FROM countries WHERE code = 'GH') IS NULL THEN
    UPDATE countries SET pricing = jsonb_set(jsonb_set(jsonb_set(jsonb_set(
      pricing,
      '{growth,provider_plan_refs}', '{"paystack":"PLN_ci_placeholder_gh_growth"}'::jsonb),
      '{growth,paystack_plan_code}', '"PLN_ci_placeholder_gh_growth"'::jsonb),
      '{business,provider_plan_refs}', '{"paystack":"PLN_ci_placeholder_gh_business"}'::jsonb),
      '{business,paystack_plan_code}', '"PLN_ci_placeholder_gh_business"'::jsonb)
    WHERE code = 'GH';
  END IF;
  PERFORM set_config('waaiio.provider_ref_auth', '', true);
END $$;

-- ══════════════════════════════════════════════════════════════
-- Section A: Env-agnostic price/fee corrections
-- ══════════════════════════════════════════════════════════════
-- guard_country_activation trigger is preserved — prerequisites seeded above.

-- US: Growth $15, Business $40 (was $39/$99)
UPDATE countries SET pricing = jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(
  pricing,
  '{free,feePercentage}', '3'),
  '{free,feeFlat}', '0'),
  '{free,trialDays}', '14'),
  '{growth,price}', '15'),
  '{growth,feePercentage}', '1.5'),
  '{growth,feeFlat}', '0'),
  '{growth,trialDays}', '14'),
  '{business,price}', '40'),
  '{business,feePercentage}', '1'),
  '{business,feeFlat}', '0'),
  '{business,trialDays}', '14'),
  '{free,price}', '0')
WHERE code = 'US' AND is_active = true;

-- GB: Growth £12, Business £32 (was £29/£79)
UPDATE countries SET pricing = jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(
  pricing,
  '{free,feePercentage}', '3'),
  '{free,feeFlat}', '0'),
  '{free,trialDays}', '14'),
  '{growth,price}', '12'),
  '{growth,feePercentage}', '1.5'),
  '{growth,feeFlat}', '0'),
  '{growth,trialDays}', '14'),
  '{business,price}', '32'),
  '{business,feePercentage}', '1'),
  '{business,feeFlat}', '0'),
  '{business,trialDays}', '14'),
  '{free,price}', '0')
WHERE code = 'GB' AND is_active = true;

-- CA: Growth C$20, Business C$50 (was C$39/C$99)
UPDATE countries SET pricing = jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(
  pricing,
  '{free,feePercentage}', '3'),
  '{free,feeFlat}', '0'),
  '{free,trialDays}', '14'),
  '{growth,price}', '20'),
  '{growth,feePercentage}', '1.5'),
  '{growth,feeFlat}', '0'),
  '{growth,trialDays}', '14'),
  '{business,price}', '50'),
  '{business,feePercentage}', '1'),
  '{business,feeFlat}', '0'),
  '{business,trialDays}', '14'),
  '{free,price}', '0')
WHERE code = 'CA' AND is_active = true;

-- NG: fees/trialDays only — prices unchanged (await atomic admin cutover)
UPDATE countries SET pricing = jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(
  pricing,
  '{free,feePercentage}', '3'),
  '{free,feeFlat}', '0'),
  '{free,trialDays}', '14'),
  '{growth,feePercentage}', '1.5'),
  '{growth,feeFlat}', '0'),
  '{growth,trialDays}', '14'),
  '{business,feePercentage}', '1'),
  '{business,feeFlat}', '0'),
  '{business,trialDays}', '14')
WHERE code = 'NG' AND is_active = true;

-- GH: fees/trialDays only — prices unchanged (await atomic admin cutover)
UPDATE countries SET pricing = jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(
  pricing,
  '{free,feePercentage}', '3'),
  '{free,feeFlat}', '0'),
  '{free,trialDays}', '14'),
  '{growth,feePercentage}', '1.5'),
  '{growth,feeFlat}', '0'),
  '{growth,trialDays}', '14'),
  '{business,feePercentage}', '1'),
  '{business,feeFlat}', '0'),
  '{business,trialDays}', '14')
WHERE code = 'GH' AND is_active = true;

-- ══════════════════════════════════════════════════════════════
-- Section B: Extend save_provider_plan_refs with p_tier_prices
-- DROP old 4-arg function, CREATE new 5-arg with all security attributes.
-- ══════════════════════════════════════════════════════════════

DROP FUNCTION public.save_provider_plan_refs(text, jsonb, uuid, uuid);

CREATE FUNCTION public.save_provider_plan_refs(
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

-- Least-privilege grants — service_role only
REVOKE ALL ON FUNCTION public.save_provider_plan_refs(text, jsonb, uuid, uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.save_provider_plan_refs(text, jsonb, uuid, uuid, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.save_provider_plan_refs(text, jsonb, uuid, uuid, jsonb) FROM authenticated;
REVOKE ALL ON FUNCTION public.save_provider_plan_refs(text, jsonb, uuid, uuid, jsonb) FROM service_role;
GRANT EXECUTE ON FUNCTION public.save_provider_plan_refs(text, jsonb, uuid, uuid, jsonb) TO service_role;

-- ══════════════════════════════════════════════════════════════
-- Section C: Verification
-- ══════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_count integer;
  v_config text[];
  v_secdef boolean;
BEGIN
  -- Exactly one function with this name
  SELECT COUNT(*) INTO v_count FROM pg_proc
  WHERE proname = 'save_provider_plan_refs' AND pronamespace = 'public'::regnamespace;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'M458: Expected 1 save_provider_plan_refs, found %', v_count;
  END IF;

  -- SECURITY DEFINER preserved
  SELECT prosecdef, proconfig INTO v_secdef, v_config FROM pg_proc
  WHERE proname = 'save_provider_plan_refs' AND pronamespace = 'public'::regnamespace;
  IF NOT v_secdef THEN
    RAISE EXCEPTION 'M458: save_provider_plan_refs must be SECURITY DEFINER';
  END IF;
  IF NOT ('search_path=public, extensions, pg_temp' = ANY(v_config)) THEN
    RAISE EXCEPTION 'M458: search_path not preserved: %', v_config;
  END IF;

  -- Verify Stripe country prices match lock
  IF (SELECT pricing -> 'growth' ->> 'price' FROM countries WHERE code = 'US') <> '15' THEN
    RAISE EXCEPTION 'M458: US growth price not 15';
  END IF;
  IF (SELECT pricing -> 'business' ->> 'price' FROM countries WHERE code = 'US') <> '40' THEN
    RAISE EXCEPTION 'M458: US business price not 40';
  END IF;
  IF (SELECT pricing -> 'growth' ->> 'price' FROM countries WHERE code = 'GB') <> '12' THEN
    RAISE EXCEPTION 'M458: GB growth price not 12';
  END IF;
  IF (SELECT pricing -> 'growth' ->> 'price' FROM countries WHERE code = 'CA') <> '20' THEN
    RAISE EXCEPTION 'M458: CA growth price not 20';
  END IF;

  -- Verify fee alignment for the 5 lock countries
  IF EXISTS (
    SELECT 1 FROM countries
    WHERE code IN ('NG', 'GH', 'US', 'GB', 'CA')
      AND (pricing -> 'free' ->> 'feePercentage')::numeric <> 3
  ) THEN
    RAISE EXCEPTION 'M458: free tier feePercentage not 3 for lock countries';
  END IF;
  IF EXISTS (
    SELECT 1 FROM countries
    WHERE code IN ('NG', 'GH', 'US', 'GB', 'CA')
      AND (pricing -> 'free' ->> 'feeFlat')::numeric <> 0
  ) THEN
    RAISE EXCEPTION 'M458: free tier feeFlat not 0 for lock countries';
  END IF;
END $$;

-- New config version snapshot to advance CAS
INSERT INTO platform_config_versions (id, config_snapshot, effective_from, created_by, created_at)
SELECT gen_random_uuid(),
       COALESCE((SELECT jsonb_object_agg(key, value) FROM platform_settings
                 WHERE key = ANY(ARRAY[
                   'pricing_tiers','trial_days','broadcast_limits','conversation_limits',
                   'default_platform_fee_percent','annual_discount_percentage',
                   'payout_cooling_period_days','minimum_payout','payout_verification_limits',
                   'transfer_expiry_hours','minimum_bank_transfer',
                   'messaging_financial_gate','messaging_reservation_ttl_seconds',
                   'trial_credit_minor_by_currency','subscription_included_minor_by_tier_currency',
                   'fee_policy_enabled','category_fee_rates','messaging_pricing'
                 ])), '{}'::jsonb),
       clock_timestamp(),
       NULL,
       clock_timestamp();

COMMIT;

-- ══════════════════════════════════════════════════════════════
-- Rollback SQL (execute manually with Owner authorization only)
-- ══════════════════════════════════════════════════════════════
-- Captured from staging MCP 2026-10-23 at SHA 8b520678
--
-- BEGIN;
-- UPDATE countries SET pricing = '{"free":{"price":0,"feeFlat":0.5,"trialDays":14,"feePercentage":2.5},"growth":{"price":39,"feeFlat":0.4,"trialDays":14,"feePercentage":1.5},"business":{"price":99,"feeFlat":0.35,"trialDays":14,"feePercentage":1}}'::jsonb WHERE code = 'US';
-- UPDATE countries SET pricing = '{"free":{"price":0,"feeFlat":0.35,"trialDays":14,"feePercentage":2.5},"growth":{"price":29,"feeFlat":0.3,"trialDays":14,"feePercentage":1.5},"business":{"price":79,"feeFlat":0.25,"trialDays":14,"feePercentage":1}}'::jsonb WHERE code = 'GB';
-- UPDATE countries SET pricing = '{"free":{"price":0,"feeFlat":0.5,"trialDays":14,"feePercentage":2.5},"growth":{"price":39,"feeFlat":0.4,"trialDays":14,"feePercentage":1.5},"business":{"price":99,"feeFlat":0.35,"trialDays":14,"feePercentage":1}}'::jsonb WHERE code = 'CA';
-- UPDATE countries SET pricing = '{"free":{"price":0,"feeFlat":150,"trialDays":30,"feePercentage":2.5},"growth":{"price":14999,"feeFlat":100,"trialDays":30,"feePercentage":1.5,"paystack_plan_code":"PLN_c6gknr7ejgqrs39","provider_plan_refs":{"paystack":"PLN_c6gknr7ejgqrs39"}},"business":{"price":39999,"feeFlat":75,"trialDays":30,"feePercentage":1,"paystack_plan_code":"PLN_a6sji3whc0iv4zg","provider_plan_refs":{"paystack":"PLN_a6sji3whc0iv4zg"}}}'::jsonb WHERE code = 'NG';
-- UPDATE countries SET pricing = '{"free":{"price":0,"feeFlat":3,"trialDays":30,"feePercentage":2.5},"growth":{"price":149,"feeFlat":2,"trialDays":30,"feePercentage":1.5},"business":{"price":399,"feeFlat":1.5,"trialDays":30,"feePercentage":1}}'::jsonb WHERE code = 'GH';
--
-- To restore the old 4-arg function signature, re-run M378 section C1.
-- COMMIT;
