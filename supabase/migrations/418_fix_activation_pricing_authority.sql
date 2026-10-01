-- 418: Fix activate_paid_subscription pricing authority
--
-- Root cause (#496): activate_paid_subscription step 6b reads expected price
-- from config_snapshot -> 'pricing_tiers' -> plan -> 'price', but the config
-- snapshot's pricing_tiers only contains entitlement/fee fields (feePercentage,
-- feeFlat, maxBookings, whitelabel). Actual subscription prices live in
-- countries.pricing[tier].price — the canonical pricing authority used by
-- the checkout UI (/api/public/pricing) and getPricingTiers().
--
-- Fix: Read expected subscription price from countries.pricing using the
-- business's country_code. This is the same authority the checkout/payment
-- flow presents to the customer. Config version provenance is preserved
-- for entitlements, fees, and allowance configuration.
--
-- Preserves: SECURITY DEFINER, search_path = '', all grant/revoke semantics,
-- all other steps unchanged.
--
-- DB-002 compliance: This CREATE OR REPLACE preserves SET search_path = ''
-- from M375. No other ALTER attributes exist on this function.

CREATE OR REPLACE FUNCTION public.activate_paid_subscription(p_payment_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_sub RECORD;
  v_biz RECORD;
  v_config RECORD;
  v_payment RECORD;
  v_country_pricing JSONB;
  v_expected_amount NUMERIC;
  v_included_config JSONB;
  v_tier_config JSONB;
  v_amount_raw NUMERIC;
  v_amount INTEGER;
  v_currency TEXT;
  v_pricing JSONB;
  v_match_count INTEGER;
  v_source_ref TEXT;
  v_grant_result JSONB;
  v_has_channel BOOLEAN;
BEGIN
  -- 1. Lock the exact payment row FOR UPDATE (evidence-first)
  SELECT id, subscription_id, business_id, config_version_id, provider_reference, amount, currency,
         period_start, period_end, plan AS payment_plan, status AS payment_status,
         billing_interval AS payment_billing_interval
  INTO v_payment
  FROM public.subscription_payments
  WHERE id = p_payment_id
  FOR UPDATE;

  IF v_payment.id IS NULL THEN
    RETURN jsonb_build_object('activated', false, 'reason', 'no_payment_evidence');
  END IF;

  -- 1a. Validate the locked payment is successful
  IF v_payment.payment_status <> 'success' THEN
    RETURN jsonb_build_object('activated', false, 'reason', 'payment_not_successful',
      'payment_status', v_payment.payment_status);
  END IF;

  -- 1b. Require all canonical payment fields (fail closed on NULL gaps)
  IF v_payment.amount IS NULL OR v_payment.amount <= 0 THEN
    RETURN jsonb_build_object('activated', false, 'reason', 'missing_payment_amount');
  END IF;
  IF v_payment.currency IS NULL OR v_payment.currency = '' THEN
    RETURN jsonb_build_object('activated', false, 'reason', 'missing_payment_currency');
  END IF;
  IF v_payment.provider_reference IS NULL OR v_payment.provider_reference = '' THEN
    RETURN jsonb_build_object('activated', false, 'reason', 'missing_provider_reference');
  END IF;
  IF v_payment.period_start IS NULL THEN
    RETURN jsonb_build_object('activated', false, 'reason', 'missing_period_start');
  END IF;
  IF v_payment.period_end IS NULL THEN
    RETURN jsonb_build_object('activated', false, 'reason', 'missing_period_end');
  END IF;

  -- 2. Derive subscription from the locked payment row
  IF v_payment.subscription_id IS NULL THEN
    RETURN jsonb_build_object('activated', false, 'reason', 'payment_missing_subscription');
  END IF;

  SELECT id, business_id, plan, status, amount, currency, billing_interval,
         current_period_start, current_period_end
  INTO v_sub
  FROM public.subscriptions
  WHERE id = v_payment.subscription_id
  FOR UPDATE;

  IF v_sub.id IS NULL THEN
    RETURN jsonb_build_object('activated', false, 'reason', 'subscription_not_found');
  END IF;

  -- 2a. Validate plan is a known paid tier
  IF v_sub.plan NOT IN ('growth', 'business') THEN
    RETURN jsonb_build_object('activated', false, 'reason', 'invalid_plan');
  END IF;

  -- 2b. (billing_interval now validated from payment evidence in step 2e)

  -- 2c. Validate payment plan is present and matches subscription plan (commercial binding)
  IF v_payment.payment_plan IS NULL THEN
    RETURN jsonb_build_object('activated', false, 'reason', 'missing_payment_plan');
  END IF;
  IF v_payment.payment_plan <> v_sub.plan THEN
    RETURN jsonb_build_object('activated', false, 'reason', 'plan_mismatch',
      'payment_plan', v_payment.payment_plan, 'subscription_plan', v_sub.plan);
  END IF;

  -- 2d. Validate payment business_id matches subscription business (cross-business binding)
  IF v_payment.business_id IS NULL OR v_payment.business_id <> v_sub.business_id THEN
    RETURN jsonb_build_object('activated', false, 'reason', 'business_mismatch',
      'payment_business', v_payment.business_id, 'subscription_business', v_sub.business_id);
  END IF;

  -- 2e. Validate billing interval on payment evidence (immutable provider term)
  -- #263 requires exact monthly; annual is out of scope
  IF v_payment.payment_billing_interval IS NULL OR v_payment.payment_billing_interval <> 'month' THEN
    RETURN jsonb_build_object('activated', false, 'reason', 'invalid_payment_billing_interval',
      'billing_interval', v_payment.payment_billing_interval);
  END IF;

  -- 3. Lock business FOR UPDATE
  SELECT id, subscription_tier, whatsapp_channel_id, wa_method, status,
         country_code
  INTO v_biz
  FROM public.businesses
  WHERE id = v_sub.business_id
  FOR UPDATE;

  IF v_biz.id IS NULL THEN
    RETURN jsonb_build_object('activated', false, 'reason', 'business_not_found');
  END IF;

  -- 4. Idempotent: if already active with matching tier AND same payment evidence,
  -- this is a duplicate call — not a renewal. Return early.
  IF v_sub.status = 'active' AND v_biz.subscription_tier::TEXT = v_sub.plan THEN
    DECLARE
      v_idempotent_ref TEXT;
      v_existing_allowance_id UUID;
    BEGIN
      v_idempotent_ref := 'sub:' || v_payment.subscription_id::TEXT || ':' || v_payment.provider_reference;
      SELECT id INTO v_existing_allowance_id
        FROM public.messaging_allowances
        WHERE business_id = v_sub.business_id
          AND type = 'subscription_included'
          AND source_ref = v_idempotent_ref;
      IF v_existing_allowance_id IS NOT NULL THEN
        RETURN jsonb_build_object('activated', true, 'idempotent', true);
      END IF;
      -- If no existing allowance for this source_ref, this is a renewal — continue
    END;
  END IF;

  -- 5. Config provenance must come from payment evidence — mandatory
  IF v_payment.config_version_id IS NULL THEN
    RETURN jsonb_build_object('activated', false, 'reason', 'missing_config_provenance');
  END IF;

  SELECT id, config_snapshot INTO v_config
    FROM public.platform_config_versions
    WHERE id = v_payment.config_version_id;

  IF v_config.id IS NULL THEN
    RETURN jsonb_build_object('activated', false, 'reason', 'no_config_version');
  END IF;

  -- 6a. Defense-in-depth: subscription billing_interval must also be valid
  -- (primary validation is from payment evidence in step 2e)
  IF v_sub.billing_interval IS NULL OR v_sub.billing_interval NOT IN ('month') THEN
    RETURN jsonb_build_object('activated', false, 'reason', 'invalid_subscription_billing_interval',
      'billing_interval', v_sub.billing_interval);
  END IF;

  -- 6b. Validate payment amount against canonical country pricing authority
  -- (#496 fix): Read expected subscription price from countries.pricing,
  -- which is the same authority the checkout UI and /api/public/pricing use.
  -- Config snapshot pricing_tiers contains only entitlement/fee fields.
  SELECT pricing -> v_sub.plan INTO v_country_pricing
    FROM public.countries
    WHERE code = v_biz.country_code;

  IF v_country_pricing IS NULL OR jsonb_typeof(v_country_pricing) <> 'object' THEN
    RETURN jsonb_build_object('activated', false, 'reason', 'pricing_config_missing',
      'plan', v_sub.plan, 'country_code', v_biz.country_code);
  END IF;

  -- countries.pricing stores amounts in major units; payment amount is smallest unit
  v_expected_amount := (v_country_pricing ->> 'price')::NUMERIC;
  IF v_expected_amount IS NULL OR v_expected_amount <= 0 THEN
    RETURN jsonb_build_object('activated', false, 'reason', 'pricing_config_missing',
      'plan', v_sub.plan, 'country_code', v_biz.country_code);
  END IF;

  -- Convert payment amount from smallest to major (divide by 100)
  IF ABS((v_payment.amount::NUMERIC / 100.0) - v_expected_amount) > 0.01 THEN
    RAISE NOTICE 'M418 amount_mismatch diagnostic: country=%, plan=%, expected_major=%, payment_amount=%, payment_major=%, country_pricing=%',
      v_biz.country_code, v_sub.plan, v_expected_amount, v_payment.amount,
      v_payment.amount::NUMERIC / 100.0, v_country_pricing;
    RETURN jsonb_build_object('activated', false, 'reason', 'amount_mismatch',
      'expected_major', v_expected_amount,
      'actual_smallest', v_payment.amount,
      'country_code', v_biz.country_code);
  END IF;

  -- 6c. Validate currency: payment currency must match business resolved currency
  DECLARE
    v_biz_currency TEXT;
    v_biz_match_count INTEGER := 0;
    v_biz_pricing JSONB;
    v_cur_iter TEXT;
  BEGIN
    v_biz_pricing := v_config.config_snapshot -> 'messaging_pricing';
    IF v_biz_pricing IS NULL OR jsonb_typeof(v_biz_pricing) <> 'object' THEN
      RETURN jsonb_build_object('activated', false, 'reason', 'currency_config_missing');
    END IF;
    FOR v_cur_iter IN SELECT key FROM jsonb_each(v_biz_pricing)
    LOOP
      IF v_biz_pricing -> v_cur_iter -> 'rates' -> v_biz.country_code IS NOT NULL THEN
        v_biz_currency := v_cur_iter;
        v_biz_match_count := v_biz_match_count + 1;
      END IF;
    END LOOP;
    -- If match_count != 1, reject with specific reason
    IF v_biz_match_count <> 1 THEN
      RETURN jsonb_build_object('activated', false, 'reason', 'currency_resolution_failed',
        'match_count', v_biz_match_count, 'country_code', v_biz.country_code);
    END IF;
    IF UPPER(v_payment.currency) <> UPPER(v_biz_currency) THEN
      RETURN jsonb_build_object('activated', false, 'reason', 'currency_mismatch',
        'payment_currency', v_payment.currency,
        'business_currency', v_biz_currency);
    END IF;
  END;

  -- Build stable source_ref from the locked payment's provider_reference
  v_source_ref := 'sub:' || v_payment.subscription_id::TEXT || ':' || v_payment.provider_reference;

  -- 7. Atomically activate: subscription status + business tier (entitlement)
  -- Synchronize subscription period from payment evidence (source of truth)
  UPDATE public.subscriptions
  SET status = 'active',
      current_period_start = v_payment.period_start,
      current_period_end = v_payment.period_end,
      updated_at = clock_timestamp()
  WHERE id = v_payment.subscription_id;

  UPDATE public.businesses
  SET subscription_tier = v_sub.plan::public.subscription_tier,
      trial_ends_at = COALESCE(trial_ends_at, clock_timestamp())
  WHERE id = v_sub.business_id;

  -- 8. Check channel READY for allowance grant
  v_has_channel := false;
  IF v_biz.whatsapp_channel_id IS NOT NULL THEN
    PERFORM 1 FROM public.whatsapp_channels
      WHERE id = v_biz.whatsapp_channel_id
        AND is_active = true
        AND connection_status = 'active';
    IF FOUND THEN
      v_has_channel := true;
    END IF;
  END IF;

  -- For shared channels, check business is active
  IF NOT v_has_channel AND v_biz.wa_method = 'shared' AND v_biz.status = 'active' THEN
    v_has_channel := true;
  END IF;

  -- 9. Resolve included allowance from config
  v_included_config := v_config.config_snapshot -> 'subscription_included_minor_by_tier_currency';

  IF v_included_config IS NULL OR jsonb_typeof(v_included_config) <> 'object' THEN
    -- Config not yet set — entitlement active, allowance pending
    INSERT INTO public.alerts (business_id, type, severity, title, message)
    VALUES (v_sub.business_id, 'subscription_allowance_pending', 'warning',
      'Subscription allowance pending',
      'Paid subscription activated but included messaging allowance not configured. Configure subscription_included_minor_by_tier_currency.')
    ON CONFLICT (business_id, type) WHERE type = 'subscription_allowance_pending' DO NOTHING;

    RETURN jsonb_build_object('activated', true, 'allowance_granted', false,
      'reason', 'missing_allowance_config');
  END IF;

  v_tier_config := v_included_config -> v_sub.plan;
  IF v_tier_config IS NULL OR jsonb_typeof(v_tier_config) <> 'object' THEN
    INSERT INTO public.alerts (business_id, type, severity, title, message)
    VALUES (v_sub.business_id, 'subscription_allowance_pending', 'warning',
      'Subscription allowance pending',
      'No allowance config for tier ' || v_sub.plan)
    ON CONFLICT (business_id, type) WHERE type = 'subscription_allowance_pending' DO NOTHING;

    RETURN jsonb_build_object('activated', true, 'allowance_granted', false,
      'reason', 'missing_tier_allowance_config');
  END IF;

  -- Resolve currency from business country via messaging_pricing (same as trial)
  v_pricing := v_config.config_snapshot -> 'messaging_pricing';
  IF v_pricing IS NULL OR jsonb_typeof(v_pricing) <> 'object' THEN
    INSERT INTO public.alerts (business_id, type, severity, title, message)
    VALUES (v_sub.business_id, 'subscription_allowance_pending', 'warning',
      'Subscription allowance pending',
      'messaging_pricing not configured')
    ON CONFLICT (business_id, type) WHERE type = 'subscription_allowance_pending' DO NOTHING;

    RETURN jsonb_build_object('activated', true, 'allowance_granted', false,
      'reason', 'currency_resolution_failed');
  END IF;

  v_match_count := 0;
  v_currency := NULL;
  FOR v_currency IN SELECT key FROM jsonb_each(v_pricing)
  LOOP
    IF v_pricing -> v_currency -> 'rates' -> v_biz.country_code IS NOT NULL THEN
      v_match_count := v_match_count + 1;
    END IF;
  END LOOP;

  IF v_match_count <> 1 THEN
    INSERT INTO public.alerts (business_id, type, severity, title, message)
    VALUES (v_sub.business_id, 'subscription_allowance_pending', 'warning',
      'Subscription allowance pending',
      'Currency resolution failed (match_count=' || v_match_count || ')')
    ON CONFLICT (business_id, type) WHERE type = 'subscription_allowance_pending' DO NOTHING;

    RETURN jsonb_build_object('activated', true, 'allowance_granted', false,
      'reason', 'currency_resolution_failed');
  END IF;

  -- Re-resolve single matching currency
  v_currency := NULL;
  FOR v_currency IN SELECT key FROM jsonb_each(v_pricing)
  LOOP
    IF v_pricing -> v_currency -> 'rates' -> v_biz.country_code IS NOT NULL THEN
      EXIT;
    END IF;
  END LOOP;

  -- Get amount for tier + currency
  BEGIN
    v_amount_raw := (v_tier_config ->> v_currency)::NUMERIC;
  EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('activated', true, 'allowance_granted', false,
      'reason', 'invalid_allowance_amount');
  END;

  IF v_amount_raw IS NULL OR v_amount_raw <= 0 OR v_amount_raw <> FLOOR(v_amount_raw) THEN
    RETURN jsonb_build_object('activated', true, 'allowance_granted', false,
      'reason', 'no_allowance_for_currency');
  END IF;
  v_amount := v_amount_raw::INTEGER;

  -- 10. If channel not READY, entitlement active but allowance pending
  IF NOT v_has_channel THEN
    RETURN jsonb_build_object('activated', true, 'allowance_granted', false,
      'reason', 'channel_not_ready',
      'amount_minor', v_amount, 'currency_code', v_currency);
  END IF;

  -- 11. source_ref already built in step 5 using provider_reference

  -- 12. Grant subscription_included allowance (expiry from payment evidence, not subscription table)
  v_grant_result := public.grant_messaging_allowance(
    v_sub.business_id, 'subscription_included', v_amount, v_currency,
    v_source_ref, v_config.id, v_payment.period_end
  );

  -- Clear any pending alert
  DELETE FROM public.alerts
  WHERE business_id = v_sub.business_id AND type = 'subscription_allowance_pending';

  IF (v_grant_result ->> 'granted')::BOOLEAN = true THEN
    RETURN jsonb_build_object('activated', true, 'allowance_granted', true,
      'amount_minor', v_amount, 'currency_code', v_currency,
      'source_ref', v_source_ref);
  END IF;

  IF (v_grant_result ->> 'idempotent')::BOOLEAN = true THEN
    RETURN jsonb_build_object('activated', true, 'allowance_granted', true,
      'idempotent', true);
  END IF;

  RETURN jsonb_build_object('activated', true, 'allowance_granted', false,
    'reason', 'grant_failed', 'grant_result', v_grant_result);
END;
$$;

-- Preserve exact same grant/revoke semantics from M375
REVOKE ALL ON FUNCTION public.activate_paid_subscription(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.activate_paid_subscription(UUID) FROM anon;
REVOKE ALL ON FUNCTION public.activate_paid_subscription(UUID) FROM authenticated;
REVOKE ALL ON FUNCTION public.activate_paid_subscription(UUID) FROM service_role;
GRANT EXECUTE ON FUNCTION public.activate_paid_subscription(UUID) TO service_role;

-- ══════════════════════════════════════════════════════════
-- Verification: confirm SECURITY DEFINER + search_path preserved
-- ══════════════════════════════════════════════════════════
DO $$
DECLARE
  v_config TEXT[];
  v_secdef BOOLEAN;
BEGIN
  SELECT p.proconfig, p.prosecdef INTO v_config, v_secdef
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.oid = 'public.activate_paid_subscription(uuid)'::regprocedure;

  IF NOT v_secdef THEN
    RAISE EXCEPTION 'M418: activate_paid_subscription is not SECURITY DEFINER';
  END IF;

  -- search_path='' is stored as search_path="" in proconfig
  IF NOT (array_to_string(v_config, ',') LIKE '%search_path%') THEN
    RAISE EXCEPTION 'M418: activate_paid_subscription search_path incorrect: %', v_config;
  END IF;

  -- Verify service_role can execute
  IF NOT has_function_privilege('service_role', 'public.activate_paid_subscription(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'M418: service_role cannot EXECUTE activate_paid_subscription';
  END IF;

  -- Verify authenticated CANNOT execute
  IF has_function_privilege('authenticated', 'public.activate_paid_subscription(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'M418: authenticated must NOT have EXECUTE on activate_paid_subscription';
  END IF;

  -- Verify anon CANNOT execute
  IF has_function_privilege('anon', 'public.activate_paid_subscription(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'M418: anon must NOT have EXECUTE on activate_paid_subscription';
  END IF;
END $$;
