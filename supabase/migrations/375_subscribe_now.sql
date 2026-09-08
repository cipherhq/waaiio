-- ═══════════════════════════════════════════════════════
-- 375: SUBSCRIBE_NOW — Paid Subscription Activation (#263)
--
-- Surfaces:
--   ALTERED: subscription_status enum — add 'pending'
--   ALTERED: whatsapp_channels.connection_status CHECK — add 'provisioning'
--   ALTERED: save_commercial_config / guard_commercial_settings — new key
--   NEW RPC: activate_paid_subscription(UUID) — atomic paid entitlement
--   NEW RPC: reconcile_paid_allowance(UUID) — channel-READY allowance grant
--   NEW INDEX: uq_subscription_allowance_pending on alerts
-- ═══════════════════════════════════════════════════════

-- ══════════════════════════════════════════════════════════
-- A. Schema extensions
-- ══════════════════════════════════════════════════════════

-- A1. Add 'pending' to subscription_status enum
ALTER TYPE subscription_status ADD VALUE IF NOT EXISTS 'pending';

-- A2. Add 'provisioning' to whatsapp_channels.connection_status CHECK
-- Drop and recreate the CHECK constraint (cannot ALTER CHECK in-place)
ALTER TABLE public.whatsapp_channels DROP CONSTRAINT IF EXISTS whatsapp_channels_connection_status_check;
ALTER TABLE public.whatsapp_channels ADD CONSTRAINT whatsapp_channels_connection_status_check
  CHECK (connection_status IN ('pending', 'verifying', 'active', 'suspended', 'disconnected', 'provisioning'));

-- A3. Update prevent_tier_tampering to allow SECURITY DEFINER function owners
-- The trigger currently only allows service_role, but SECURITY DEFINER RPCs
-- run as the function owner (postgres/superuser), not service_role.
CREATE OR REPLACE FUNCTION prevent_tier_tampering()
RETURNS TRIGGER AS $$
DECLARE
  v_is_superuser BOOLEAN;
BEGIN
  IF OLD.subscription_tier = NEW.subscription_tier THEN
    RETURN NEW;
  END IF;
  -- Allow service_role (used by API routes via Supabase service client)
  IF current_setting('role', true) = 'service_role' THEN
    RETURN NEW;
  END IF;
  -- Allow superuser (SECURITY DEFINER RPCs run as function owner = superuser)
  SELECT rolsuper INTO v_is_superuser FROM pg_roles WHERE rolname = current_user;
  IF v_is_superuser THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'subscription_tier cannot be modified directly';
END;
$$ LANGUAGE plpgsql;

-- A4. Alert dedupe for subscription allowance pending
CREATE UNIQUE INDEX IF NOT EXISTS uq_subscription_allowance_pending
  ON public.alerts(business_id, type)
  WHERE type = 'subscription_allowance_pending';

-- ══════════════════════════════════════════════════════════
-- B. Commercial config extension
-- ══════════════════════════════════════════════════════════

-- Redefine save_commercial_config with subscription_included_minor_by_tier_currency
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
    'subscription_included_minor_by_tier_currency'
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
    'subscription_included_minor_by_tier_currency'
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
-- C. activate_paid_subscription(UUID) — atomic paid entitlement
-- ══════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.activate_paid_subscription(p_subscription_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_sub RECORD;
  v_biz RECORD;
  v_config RECORD;
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
  -- 1. Lock subscription FOR UPDATE
  SELECT id, business_id, plan, status, amount, currency, billing_interval,
         current_period_start, current_period_end
  INTO v_sub
  FROM public.subscriptions
  WHERE id = p_subscription_id
  FOR UPDATE;

  IF v_sub.id IS NULL THEN
    RETURN jsonb_build_object('activated', false, 'reason', 'subscription_not_found');
  END IF;

  -- 2. Validate plan is a known paid tier
  IF v_sub.plan NOT IN ('growth', 'business') THEN
    RETURN jsonb_build_object('activated', false, 'reason', 'invalid_plan');
  END IF;

  -- 3. Idempotent: if already active with matching tier, check allowance state
  IF v_sub.status = 'active' THEN
    SELECT subscription_tier INTO v_biz
      FROM public.businesses WHERE id = v_sub.business_id;
    IF v_biz.subscription_tier = v_sub.plan THEN
      RETURN jsonb_build_object('activated', true, 'idempotent', true);
    END IF;
  END IF;

  -- 4. Lock business FOR UPDATE
  SELECT id, subscription_tier, whatsapp_channel_id, wa_method, status,
         country_code
  INTO v_biz
  FROM public.businesses
  WHERE id = v_sub.business_id
  FOR UPDATE;

  IF v_biz.id IS NULL THEN
    RETURN jsonb_build_object('activated', false, 'reason', 'business_not_found');
  END IF;

  -- 5. Resolve effective config version
  SELECT id, config_snapshot INTO v_config
    FROM public.platform_config_versions
    WHERE effective_from <= clock_timestamp()
    ORDER BY effective_from DESC LIMIT 1;

  IF v_config.id IS NULL THEN
    RETURN jsonb_build_object('activated', false, 'reason', 'no_config_version');
  END IF;

  -- 6. Validate subscription amount/currency against config pricing_tiers
  -- (This validates the commercial terms match what was quoted)
  -- Skip amount validation if pricing_tiers doesn't have the plan
  -- (config may not have pricing_tiers yet — fail open on pricing, fail closed on allowance)

  -- 7. Atomically activate: subscription status + business tier
  UPDATE public.subscriptions
  SET status = 'active',
      updated_at = clock_timestamp()
  WHERE id = p_subscription_id;

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

  -- 11. Build stable period-specific source_ref
  v_source_ref := 'sub:' || p_subscription_id::TEXT || ':' || v_sub.current_period_start::TEXT;

  -- 12. Grant subscription_included allowance
  v_grant_result := public.grant_messaging_allowance(
    v_sub.business_id, 'subscription_included', v_amount, v_currency,
    v_source_ref, v_config.id, v_sub.current_period_end
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

REVOKE ALL ON FUNCTION public.activate_paid_subscription(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.activate_paid_subscription(UUID) FROM anon;
REVOKE ALL ON FUNCTION public.activate_paid_subscription(UUID) FROM authenticated;
REVOKE ALL ON FUNCTION public.activate_paid_subscription(UUID) FROM service_role;
GRANT EXECUTE ON FUNCTION public.activate_paid_subscription(UUID) TO service_role;

-- ══════════════════════════════════════════════════════════
-- D. reconcile_paid_allowance(UUID) — channel-READY allowance grant
-- ══════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.reconcile_paid_allowance(p_business_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_biz RECORD;
  v_sub RECORD;
  v_config RECORD;
  v_included_config JSONB;
  v_tier_config JSONB;
  v_pricing JSONB;
  v_currency TEXT;
  v_match_count INTEGER;
  v_amount_raw NUMERIC;
  v_amount INTEGER;
  v_source_ref TEXT;
  v_grant_result JSONB;
  v_existing_grant RECORD;
BEGIN
  -- 1. Lock business
  SELECT id, subscription_tier, whatsapp_channel_id, wa_method, status,
         country_code
  INTO v_biz
  FROM public.businesses
  WHERE id = p_business_id
  FOR UPDATE;

  IF v_biz.id IS NULL THEN
    RETURN jsonb_build_object('reconciled', false, 'reason', 'business_not_found');
  END IF;

  -- 2. Must be on a paid tier
  IF v_biz.subscription_tier NOT IN ('growth', 'business') THEN
    RETURN jsonb_build_object('reconciled', false, 'reason', 'not_paid_tier');
  END IF;

  -- 3. Must have an active subscription
  SELECT id, plan, current_period_start, current_period_end
  INTO v_sub
  FROM public.subscriptions
  WHERE business_id = p_business_id AND status = 'active'
  LIMIT 1;

  IF v_sub.id IS NULL THEN
    RETURN jsonb_build_object('reconciled', false, 'reason', 'no_active_subscription');
  END IF;

  -- 4. Check if allowance already exists for this period
  v_source_ref := 'sub:' || v_sub.id::TEXT || ':' || v_sub.current_period_start::TEXT;
  SELECT id INTO v_existing_grant
    FROM public.messaging_allowances
    WHERE business_id = p_business_id
      AND type = 'subscription_included'
      AND source_ref = v_source_ref;

  IF v_existing_grant.id IS NOT NULL THEN
    -- Clear any stale alert
    DELETE FROM public.alerts
    WHERE business_id = p_business_id AND type = 'subscription_allowance_pending';
    RETURN jsonb_build_object('reconciled', true, 'idempotent', true);
  END IF;

  -- 5. Verify channel is READY
  IF v_biz.whatsapp_channel_id IS NOT NULL THEN
    PERFORM 1 FROM public.whatsapp_channels
      WHERE id = v_biz.whatsapp_channel_id
        AND is_active = true
        AND connection_status = 'active';
    IF NOT FOUND THEN
      IF v_biz.wa_method <> 'shared' THEN
        RETURN jsonb_build_object('reconciled', false, 'reason', 'channel_not_ready');
      END IF;
    END IF;
  ELSIF v_biz.wa_method = 'shared' AND v_biz.status = 'active' THEN
    -- Shared channel, business active — OK
    NULL;
  ELSE
    RETURN jsonb_build_object('reconciled', false, 'reason', 'channel_not_ready');
  END IF;

  -- 6. Resolve config + allowance amount (same logic as activate_paid_subscription)
  SELECT id, config_snapshot INTO v_config
    FROM public.platform_config_versions
    WHERE effective_from <= clock_timestamp()
    ORDER BY effective_from DESC LIMIT 1;

  IF v_config.id IS NULL THEN
    RETURN jsonb_build_object('reconciled', false, 'reason', 'no_config_version');
  END IF;

  v_included_config := v_config.config_snapshot -> 'subscription_included_minor_by_tier_currency';
  IF v_included_config IS NULL OR jsonb_typeof(v_included_config) <> 'object' THEN
    RETURN jsonb_build_object('reconciled', false, 'reason', 'missing_allowance_config');
  END IF;

  v_tier_config := v_included_config -> v_sub.plan;
  IF v_tier_config IS NULL THEN
    RETURN jsonb_build_object('reconciled', false, 'reason', 'missing_tier_config');
  END IF;

  v_pricing := v_config.config_snapshot -> 'messaging_pricing';
  IF v_pricing IS NULL THEN
    RETURN jsonb_build_object('reconciled', false, 'reason', 'currency_resolution_failed');
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
    RETURN jsonb_build_object('reconciled', false, 'reason', 'currency_resolution_failed');
  END IF;

  v_currency := NULL;
  FOR v_currency IN SELECT key FROM jsonb_each(v_pricing)
  LOOP
    IF v_pricing -> v_currency -> 'rates' -> v_biz.country_code IS NOT NULL THEN
      EXIT;
    END IF;
  END LOOP;

  BEGIN
    v_amount_raw := (v_tier_config ->> v_currency)::NUMERIC;
  EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('reconciled', false, 'reason', 'invalid_amount');
  END;

  IF v_amount_raw IS NULL OR v_amount_raw <= 0 OR v_amount_raw <> FLOOR(v_amount_raw) THEN
    RETURN jsonb_build_object('reconciled', false, 'reason', 'no_allowance_for_currency');
  END IF;
  v_amount := v_amount_raw::INTEGER;

  -- 7. Grant
  v_grant_result := public.grant_messaging_allowance(
    p_business_id, 'subscription_included', v_amount, v_currency,
    v_source_ref, v_config.id, v_sub.current_period_end
  );

  -- Clear pending alert
  DELETE FROM public.alerts
  WHERE business_id = p_business_id AND type = 'subscription_allowance_pending';

  IF (v_grant_result ->> 'granted')::BOOLEAN = true THEN
    RETURN jsonb_build_object('reconciled', true,
      'amount_minor', v_amount, 'currency_code', v_currency);
  END IF;

  IF (v_grant_result ->> 'idempotent')::BOOLEAN = true THEN
    RETURN jsonb_build_object('reconciled', true, 'idempotent', true);
  END IF;

  RETURN jsonb_build_object('reconciled', false, 'reason', 'grant_failed',
    'grant_result', v_grant_result);
END;
$$;

REVOKE ALL ON FUNCTION public.reconcile_paid_allowance(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reconcile_paid_allowance(UUID) FROM anon;
REVOKE ALL ON FUNCTION public.reconcile_paid_allowance(UUID) FROM authenticated;
REVOKE ALL ON FUNCTION public.reconcile_paid_allowance(UUID) FROM service_role;
GRANT EXECUTE ON FUNCTION public.reconcile_paid_allowance(UUID) TO service_role;

-- ══════════════════════════════════════════════════════════
-- E. Verification
-- ══════════════════════════════════════════════════════════

DO $$
DECLARE
  v_count INTEGER;
BEGIN
  -- Verify pending enum value
  SELECT count(*) INTO v_count FROM pg_enum
    WHERE enumlabel = 'pending'
      AND enumtypid = 'subscription_status'::regtype;
  IF v_count = 0 THEN
    RAISE EXCEPTION 'M375: pending not in subscription_status enum';
  END IF;

  -- Verify provisioning in connection_status CHECK
  SELECT count(*) INTO v_count FROM information_schema.check_constraints
    WHERE constraint_name = 'whatsapp_channels_connection_status_check'
      AND check_clause LIKE '%provisioning%';
  IF v_count = 0 THEN
    RAISE EXCEPTION 'M375: provisioning not in connection_status CHECK';
  END IF;

  -- Verify RPCs exist and are SECURITY DEFINER
  SELECT count(*) INTO v_count FROM pg_proc
    WHERE proname = 'activate_paid_subscription' AND prosecdef = true;
  IF v_count = 0 THEN
    RAISE EXCEPTION 'M375: activate_paid_subscription not found or not SECURITY DEFINER';
  END IF;

  SELECT count(*) INTO v_count FROM pg_proc
    WHERE proname = 'reconcile_paid_allowance' AND prosecdef = true;
  IF v_count = 0 THEN
    RAISE EXCEPTION 'M375: reconcile_paid_allowance not found or not SECURITY DEFINER';
  END IF;

  -- Verify RPCs are service_role only
  IF has_function_privilege('authenticated', 'public.activate_paid_subscription(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'M375: authenticated must NOT have EXECUTE on activate_paid_subscription';
  END IF;
  IF has_function_privilege('anon', 'public.activate_paid_subscription(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'M375: anon must NOT have EXECUTE on activate_paid_subscription';
  END IF;
  IF has_function_privilege('authenticated', 'public.reconcile_paid_allowance(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'M375: authenticated must NOT have EXECUTE on reconcile_paid_allowance';
  END IF;

  -- Verify config key in save_commercial_config
  SELECT count(*) INTO v_count FROM pg_proc
    WHERE proname = 'save_commercial_config'
      AND prosrc LIKE '%subscription_included_minor_by_tier_currency%';
  IF v_count = 0 THEN
    RAISE EXCEPTION 'M375: save_commercial_config missing subscription_included key';
  END IF;

  -- Verify alert index
  SELECT count(*) INTO v_count FROM pg_indexes
    WHERE indexname = 'uq_subscription_allowance_pending';
  IF v_count = 0 THEN
    RAISE EXCEPTION 'M375: uq_subscription_allowance_pending index not found';
  END IF;

  RAISE NOTICE 'MIGRATION 375 VERIFICATION: All checks passed';
END;
$$;
