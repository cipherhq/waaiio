-- ═══════════════════════════════════════════════════════
-- 378: Provider-Neutral Subscription Configuration (#315)
--
-- Additive over M377. Does NOT modify M377 objects except:
--   - Replaces trg_guard_paystack_plan_codes with trg_guard_provider_refs
--   - Evolves guard_country_activation for multi-provider readiness
--   - Evolves save_market_messaging_config to set provider_ref_auth marker
--
-- New surfaces:
--   TABLE: subscription_checkout_intents
--   TABLE: subscription_payment_quarantine
--   ALTER: subscriptions (billing_config_version_id, flutterwave columns)
--   ALTER: subscription_payments (provider-tx unique index)
--   RPC: save_provider_plan_refs (service_role)
--   RPC: switch_country_provider (service_role)
--   RPC: claim_checkout_initialization (service_role)
--   RPC: persist_checkout_provider_response (service_role)
--   RPC: replace_terminal_checkout_intent (service_role)
--   RPC: finalize_flutterwave_subscription_checkout (service_role)
--   RPC: finalize_flutterwave_subscription_renewal (service_role)
--   RPC: finalize_subscription_cancellation (service_role)
--   TRIGGER: trg_guard_provider_refs (replaces trg_guard_paystack_plan_codes)
--   DATA BACKFILL: paystack_plan_code → provider_plan_refs (non-destructive)
-- ═══════════════════════════════════════════════════════

-- ══════════════════════════════════════════════════════════
-- A. Schema additions
-- ══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.subscription_checkout_intents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES public.businesses(id),
  user_id UUID NOT NULL,
  plan TEXT NOT NULL CHECK (plan IN ('growth', 'business')),
  gateway TEXT NOT NULL CHECK (gateway IN ('paystack', 'flutterwave', 'stripe')),
  country_code TEXT NOT NULL,
  currency TEXT NOT NULL,
  amount INTEGER NOT NULL,
  provider_plan_ref TEXT,
  config_version_id UUID NOT NULL REFERENCES public.platform_config_versions(id),
  subscriber_email TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  provider_session_duration_minutes INTEGER NOT NULL DEFAULT 30,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'completed', 'failed', 'superseded')),
  claimed_at TIMESTAMPTZ,
  provider_checkout_url TEXT,
  provider_tx_ref TEXT,
  provider_timeout_not_before TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_checkout_intent_active
  ON public.subscription_checkout_intents (business_id, plan, gateway)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_checkout_intent_idem_key
  ON public.subscription_checkout_intents (idempotency_key);

ALTER TABLE public.subscription_checkout_intents ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.subscription_payment_quarantine (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  intent_id UUID REFERENCES public.subscription_checkout_intents(id),
  subscription_id UUID,
  provider_tx_ref TEXT NOT NULL,
  provider_tx_id TEXT,
  provider_amount INTEGER,
  provider_currency TEXT,
  provider_status TEXT,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  resolved_at TIMESTAMPTZ,
  resolution TEXT
);

ALTER TABLE public.subscription_payment_quarantine ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS billing_config_version_id UUID REFERENCES public.platform_config_versions(id),
  ADD COLUMN IF NOT EXISTS flutterwave_subscription_id TEXT,
  ADD COLUMN IF NOT EXISTS flutterwave_plan_id INTEGER,
  ADD COLUMN IF NOT EXISTS flutterwave_subscriber_email TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_subscription_payment_provider_tx
  ON public.subscription_payments(gateway, provider_reference)
  WHERE status = 'success' AND provider_reference IS NOT NULL;

-- ══════════════════════════════════════════════════════════
-- B. Data backfill: paystack_plan_code → provider_plan_refs
-- Runs BEFORE guard replacement. M377 guard watches only paystack_plan_code
-- changes, not provider_plan_refs additions — no marker needed.
-- ══════════════════════════════════════════════════════════

UPDATE public.countries
SET pricing = jsonb_set(
  jsonb_set(
    pricing,
    '{growth,provider_plan_refs}',
    COALESCE(pricing -> 'growth' -> 'provider_plan_refs', '{}'::jsonb) ||
      jsonb_build_object('paystack', pricing -> 'growth' ->> 'paystack_plan_code')
  ),
  '{business,provider_plan_refs}',
  COALESCE(pricing -> 'business' -> 'provider_plan_refs', '{}'::jsonb) ||
    jsonb_build_object('paystack', pricing -> 'business' ->> 'paystack_plan_code')
)
WHERE pricing -> 'growth' ->> 'paystack_plan_code' IS NOT NULL
   OR pricing -> 'business' ->> 'paystack_plan_code' IS NOT NULL;

-- ══════════════════════════════════════════════════════════
-- C. Provider-config RPCs (service_role only)
-- ══════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.save_provider_plan_refs(
  p_country_code TEXT,
  p_plan_refs JSONB,
  p_expected_version_id UUID,
  p_actor_id UUID DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
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

REVOKE ALL ON FUNCTION public.save_provider_plan_refs(text, jsonb, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.save_provider_plan_refs(text, jsonb, uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.save_provider_plan_refs(text, jsonb, uuid, uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.save_provider_plan_refs(text, jsonb, uuid, uuid) FROM service_role;
GRANT EXECUTE ON FUNCTION public.save_provider_plan_refs(text, jsonb, uuid, uuid) TO service_role;

-- C2. switch_country_provider
CREATE OR REPLACE FUNCTION public.switch_country_provider(
  p_country_code TEXT, p_new_gateway TEXT, p_expected_version_id UUID,
  p_actor_id UUID DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor_id UUID;
  v_latest_version_id UUID; v_version_id UUID; v_now TIMESTAMPTZ;
  v_country RECORD; v_growth_ref TEXT; v_business_ref TEXT;
  v_commercial_keys TEXT[] := ARRAY[
    'pricing_tiers','trial_days','broadcast_limits','conversation_limits',
    'default_platform_fee_percent','annual_discount_percentage',
    'payout_cooling_period_days','minimum_payout','payout_verification_limits',
    'transfer_expiry_hours','minimum_bank_transfer',
    'messaging_financial_gate','messaging_reservation_ttl_seconds',
    'trial_credit_minor_by_currency','subscription_included_minor_by_tier_currency',
    'fee_policy_enabled','category_fee_rates','messaging_pricing'
  ];
  v_snapshot JSONB;
BEGIN
  v_actor_id := COALESCE(p_actor_id, auth.uid());
  IF v_actor_id IS NULL THEN RAISE EXCEPTION 'requires actor identity'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('commercial_config_write'));
  IF p_expected_version_id IS NULL THEN RAISE EXCEPTION 'requires non-NULL expected_version_id'; END IF;
  SELECT id INTO v_latest_version_id FROM platform_config_versions
    WHERE effective_from <= clock_timestamp() ORDER BY effective_from DESC LIMIT 1;
  IF v_latest_version_id IS DISTINCT FROM p_expected_version_id THEN
    RAISE EXCEPTION 'config_version_conflict: expected % but latest is %', p_expected_version_id, v_latest_version_id;
  END IF;
  IF p_new_gateway NOT IN ('paystack','flutterwave','stripe') THEN
    RAISE EXCEPTION 'unsupported gateway "%"', p_new_gateway;
  END IF;
  SELECT code, payment_gateway, pricing INTO v_country FROM countries WHERE code = p_country_code FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown country "%"', p_country_code; END IF;

  IF p_new_gateway IN ('paystack','flutterwave') THEN
    v_growth_ref := v_country.pricing -> 'growth' -> 'provider_plan_refs' ->> p_new_gateway;
    v_business_ref := v_country.pricing -> 'business' -> 'provider_plan_refs' ->> p_new_gateway;
    IF v_growth_ref IS NULL OR length(TRIM(v_growth_ref)) < 3 THEN
      RAISE EXCEPTION '% growth plan ref missing for %', p_country_code, p_new_gateway;
    END IF;
    IF v_business_ref IS NULL OR length(TRIM(v_business_ref)) < 3 THEN
      RAISE EXCEPTION '% business plan ref missing for %', p_country_code, p_new_gateway;
    END IF;
  END IF;

  PERFORM set_config('waaiio.provider_ref_auth', 'true', true);
  PERFORM set_config('waaiio.gateway_switch_auth', 'true', true);
  UPDATE countries SET payment_gateway = p_new_gateway WHERE code = p_country_code;
  PERFORM set_config('waaiio.provider_ref_auth', '', true);
  PERFORM set_config('waaiio.gateway_switch_auth', '', true);

  SELECT jsonb_object_agg(key, value) INTO v_snapshot FROM platform_settings WHERE key = ANY(v_commercial_keys);
  v_now := clock_timestamp();
  v_version_id := gen_random_uuid();
  INSERT INTO platform_config_versions (id, config_snapshot, effective_from, created_by, created_at)
  VALUES (v_version_id, COALESCE(v_snapshot, '{}'::jsonb), v_now, v_actor_id, v_now);
  RETURN v_version_id;
END;
$$;

REVOKE ALL ON FUNCTION public.switch_country_provider(text, text, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.switch_country_provider(text, text, uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.switch_country_provider(text, text, uuid, uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.switch_country_provider(text, text, uuid, uuid) FROM service_role;
GRANT EXECUTE ON FUNCTION public.switch_country_provider(text, text, uuid, uuid) TO service_role;

-- ══════════════════════════════════════════════════════════
-- D. Checkout RPCs (service_role only)
-- ══════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.claim_checkout_initialization(
  p_business_id UUID, p_plan TEXT, p_gateway TEXT,
  p_currency TEXT, p_amount INTEGER, p_provider_plan_ref TEXT,
  p_config_version_id UUID, p_subscriber_email TEXT,
  p_session_duration INTEGER DEFAULT 30,
  p_actor_id UUID DEFAULT NULL
)
RETURNS TABLE(
  intent_id UUID, is_claimed BOOLEAN, provider_checkout_url TEXT,
  idempotency_key TEXT, needs_provider_verification BOOLEAN, intent_status TEXT
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor_id UUID;
  v_existing RECORD; v_new_id UUID; v_new_key TEXT;
BEGIN
  v_actor_id := COALESCE(p_actor_id, auth.uid());
  IF v_actor_id IS NULL THEN RAISE EXCEPTION 'requires actor identity'; END IF;
  SELECT * INTO v_existing FROM subscription_checkout_intents sci
    WHERE sci.business_id = p_business_id AND sci.plan = p_plan
      AND sci.gateway = p_gateway AND sci.status = 'pending'
    FOR UPDATE;

  IF FOUND THEN
    IF v_existing.provider_checkout_url IS NOT NULL THEN
      IF v_existing.provider_timeout_not_before IS NOT NULL
         AND v_existing.provider_timeout_not_before <= clock_timestamp() THEN
        RETURN QUERY SELECT v_existing.id, false, v_existing.provider_checkout_url,
          v_existing.idempotency_key, true, 'pending'::TEXT;
        RETURN;
      END IF;
      RETURN QUERY SELECT v_existing.id, false, v_existing.provider_checkout_url,
        v_existing.idempotency_key, false, 'pending'::TEXT;
      RETURN;
    END IF;
    IF v_existing.claimed_at IS NOT NULL
       AND v_existing.claimed_at > clock_timestamp() - interval '90 seconds' THEN
      RETURN QUERY SELECT v_existing.id, false, NULL::TEXT,
        v_existing.idempotency_key, false, 'pending'::TEXT;
      RETURN;
    END IF;
    UPDATE subscription_checkout_intents SET claimed_at = clock_timestamp() WHERE id = v_existing.id;
    RETURN QUERY SELECT v_existing.id, true, NULL::TEXT,
      v_existing.idempotency_key, false, 'pending'::TEXT;
    RETURN;
  END IF;

  v_new_id := gen_random_uuid();
  v_new_key := 'waaiiosub' || replace(v_new_id::text, '-', '');
  INSERT INTO subscription_checkout_intents (
    id, business_id, user_id, plan, gateway, country_code, currency, amount,
    provider_plan_ref, config_version_id, subscriber_email,
    idempotency_key, provider_session_duration_minutes, status, claimed_at, provider_tx_ref
  ) VALUES (
    v_new_id, p_business_id, v_actor_id, p_plan, p_gateway,
    (SELECT country_code FROM businesses WHERE id = p_business_id),
    p_currency, p_amount, p_provider_plan_ref, p_config_version_id,
    p_subscriber_email, v_new_key, p_session_duration, 'pending', clock_timestamp(), v_new_key
  );
  RETURN QUERY SELECT v_new_id, true, NULL::TEXT, v_new_key, false, 'pending'::TEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_checkout_initialization(uuid,text,text,text,integer,text,uuid,text,integer,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_checkout_initialization(uuid,text,text,text,integer,text,uuid,text,integer,uuid) FROM anon;
REVOKE ALL ON FUNCTION public.claim_checkout_initialization(uuid,text,text,text,integer,text,uuid,text,integer,uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.claim_checkout_initialization(uuid,text,text,text,integer,text,uuid,text,integer,uuid) FROM service_role;
GRANT EXECUTE ON FUNCTION public.claim_checkout_initialization(uuid,text,text,text,integer,text,uuid,text,integer,uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.persist_checkout_provider_response(
  p_intent_id UUID, p_provider_checkout_url TEXT, p_idempotency_key TEXT
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_intent RECORD;
BEGIN
  SELECT * INTO v_intent FROM subscription_checkout_intents
    WHERE id = p_intent_id AND status = 'pending' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'intent % not found or not pending', p_intent_id; END IF;
  IF v_intent.idempotency_key <> p_idempotency_key THEN
    RAISE EXCEPTION 'idempotency key mismatch';
  END IF;
  IF v_intent.provider_checkout_url IS NOT NULL THEN RETURN; END IF;
  UPDATE subscription_checkout_intents SET
    provider_checkout_url = p_provider_checkout_url,
    provider_timeout_not_before = clock_timestamp()
      + (provider_session_duration_minutes + 5) * interval '1 minute',
    claimed_at = NULL
  WHERE id = p_intent_id;
END;
$$;

REVOKE ALL ON FUNCTION public.persist_checkout_provider_response(uuid,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.persist_checkout_provider_response(uuid,text,text) FROM anon;
REVOKE ALL ON FUNCTION public.persist_checkout_provider_response(uuid,text,text) FROM authenticated;
REVOKE ALL ON FUNCTION public.persist_checkout_provider_response(uuid,text,text) FROM service_role;
GRANT EXECUTE ON FUNCTION public.persist_checkout_provider_response(uuid,text,text) TO service_role;

CREATE OR REPLACE FUNCTION public.replace_terminal_checkout_intent(
  p_old_intent_id UUID, p_business_id UUID, p_plan TEXT, p_gateway TEXT,
  p_currency TEXT, p_amount INTEGER, p_provider_plan_ref TEXT,
  p_config_version_id UUID, p_subscriber_email TEXT, p_session_duration INTEGER DEFAULT 30,
  p_actor_id UUID DEFAULT NULL
) RETURNS TABLE(intent_id UUID, idempotency_key TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_actor_id UUID; v_new_id UUID; v_new_key TEXT; v_rows INTEGER;
BEGIN
  v_actor_id := COALESCE(p_actor_id, auth.uid());
  IF v_actor_id IS NULL THEN RAISE EXCEPTION 'requires actor identity'; END IF;
  UPDATE subscription_checkout_intents SET status = 'failed'
    WHERE id = p_old_intent_id AND status = 'pending';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RETURN QUERY SELECT sci.id, sci.idempotency_key FROM subscription_checkout_intents sci
      WHERE sci.business_id = p_business_id AND sci.plan = p_plan
        AND sci.gateway = p_gateway AND sci.status = 'pending' LIMIT 1;
    RETURN;
  END IF;
  v_new_id := gen_random_uuid();
  v_new_key := 'waaiiosub' || replace(v_new_id::text, '-', '');
  INSERT INTO subscription_checkout_intents (
    id, business_id, user_id, plan, gateway, country_code, currency, amount,
    provider_plan_ref, config_version_id, subscriber_email,
    idempotency_key, provider_session_duration_minutes, status, claimed_at, provider_tx_ref
  ) VALUES (
    v_new_id, p_business_id, v_actor_id, p_plan, p_gateway,
    (SELECT country_code FROM businesses WHERE id = p_business_id),
    p_currency, p_amount, p_provider_plan_ref, p_config_version_id,
    p_subscriber_email, v_new_key, p_session_duration, 'pending', clock_timestamp(), v_new_key
  );
  RETURN QUERY SELECT v_new_id, v_new_key;
END;
$$;

REVOKE ALL ON FUNCTION public.replace_terminal_checkout_intent(uuid,uuid,text,text,text,integer,text,uuid,text,integer,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.replace_terminal_checkout_intent(uuid,uuid,text,text,text,integer,text,uuid,text,integer,uuid) FROM anon;
REVOKE ALL ON FUNCTION public.replace_terminal_checkout_intent(uuid,uuid,text,text,text,integer,text,uuid,text,integer,uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.replace_terminal_checkout_intent(uuid,uuid,text,text,text,integer,text,uuid,text,integer,uuid) FROM service_role;
GRANT EXECUTE ON FUNCTION public.replace_terminal_checkout_intent(uuid,uuid,text,text,text,integer,text,uuid,text,integer,uuid) TO service_role;

-- ══════════════════════════════════════════════════════════
-- E. Subscription finalizers (service_role only)
-- ══════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.finalize_flutterwave_subscription_checkout(
  p_intent_id UUID, p_provider_tx_id TEXT, p_provider_subscription_id TEXT,
  p_provider_plan_id INTEGER, p_verified_amount_minor INTEGER,
  p_verified_currency TEXT, p_provider_paid_at TIMESTAMPTZ
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_intent RECORD; v_sub_id UUID; v_payment_id UUID;
  v_period_start TIMESTAMPTZ; v_period_end TIMESTAMPTZ;
  v_existing_sub RECORD;
  v_activation_result JSONB;
  v_existing_payment RECORD;
BEGIN
  -- Require non-null provider timestamp
  IF p_provider_paid_at IS NULL THEN
    RAISE EXCEPTION 'finalize_checkout: p_provider_paid_at must not be NULL';
  END IF;

  SELECT * INTO v_intent FROM subscription_checkout_intents WHERE id = p_intent_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'intent % not found', p_intent_id; END IF;

  -- Idempotent: already completed
  IF v_intent.status = 'completed' THEN
    SELECT id INTO v_sub_id FROM subscriptions
      WHERE business_id = v_intent.business_id
      ORDER BY created_at DESC LIMIT 1;
    RETURN v_sub_id;
  END IF;

  IF v_intent.status <> 'pending' THEN
    RAISE EXCEPTION 'intent % is %, not pending', p_intent_id, v_intent.status;
  END IF;

  -- Validate against immutable intent evidence
  IF p_verified_amount_minor <> v_intent.amount * 100 THEN
    RAISE EXCEPTION 'amount mismatch: verified=% expected=%', p_verified_amount_minor, v_intent.amount * 100;
  END IF;
  IF upper(p_verified_currency) <> upper(v_intent.currency) THEN
    RAISE EXCEPTION 'currency mismatch: verified=% expected=%', p_verified_currency, v_intent.currency;
  END IF;

  v_period_start := p_provider_paid_at;
  v_period_end := v_period_start + interval '30 days';

  -- Upsert subscription (unique on business_id)
  SELECT * INTO v_existing_sub FROM subscriptions WHERE business_id = v_intent.business_id FOR UPDATE;
  IF v_existing_sub.id IS NOT NULL THEN
    UPDATE subscriptions SET
      plan = v_intent.plan, status = 'active', gateway = 'flutterwave',
      currency = v_intent.currency, amount = v_intent.amount, billing_interval = 'month',
      billing_config_version_id = v_intent.config_version_id,
      flutterwave_subscription_id = p_provider_subscription_id,
      flutterwave_plan_id = p_provider_plan_id,
      flutterwave_subscriber_email = v_intent.subscriber_email,
      current_period_start = v_period_start, current_period_end = v_period_end,
      updated_at = clock_timestamp()
    WHERE id = v_existing_sub.id;
    v_sub_id := v_existing_sub.id;
  ELSE
    v_sub_id := gen_random_uuid();
    INSERT INTO subscriptions (
      id, business_id, plan, status, gateway, currency, amount, billing_interval,
      billing_config_version_id, flutterwave_subscription_id, flutterwave_plan_id,
      flutterwave_subscriber_email, current_period_start, current_period_end
    ) VALUES (
      v_sub_id, v_intent.business_id, v_intent.plan, 'active', 'flutterwave',
      v_intent.currency, v_intent.amount, 'month', v_intent.config_version_id,
      p_provider_subscription_id, p_provider_plan_id, v_intent.subscriber_email,
      v_period_start, v_period_end
    );
  END IF;

  -- Insert payment evidence — distinguish exact-tx duplicate from period conflict
  BEGIN
    INSERT INTO subscription_payments (
      id, business_id, subscription_id, amount, currency, gateway,
      gateway_reference, provider_reference, plan, action, status,
      billing_interval, config_version_id, period_start, period_end
    ) VALUES (
      gen_random_uuid(), v_intent.business_id, v_sub_id,
      p_verified_amount_minor, upper(v_intent.currency), 'flutterwave',
      p_provider_tx_id, p_provider_tx_id, v_intent.plan, 'upgrade', 'success',
      'month', v_intent.config_version_id, v_period_start, v_period_end
    ) RETURNING id INTO v_payment_id;
  EXCEPTION WHEN unique_violation THEN
    -- Check if this is the SAME provider transaction (idempotent) or a DIFFERENT one (conflict)
    SELECT * INTO v_existing_payment FROM subscription_payments
      WHERE gateway = 'flutterwave' AND provider_reference = p_provider_tx_id AND status = 'success';
    IF FOUND THEN
      -- Same provider transaction — idempotent
      v_payment_id := v_existing_payment.id;
    ELSE
      -- Different transaction hit the period uniqueness constraint — quarantine
      INSERT INTO subscription_payment_quarantine (
        intent_id, subscription_id, provider_tx_ref, provider_tx_id,
        provider_amount, provider_currency, provider_status, reason
      ) VALUES (
        p_intent_id, v_sub_id, v_intent.idempotency_key, p_provider_tx_id,
        p_verified_amount_minor, p_verified_currency, 'conflict',
        'different_provider_tx_for_occupied_period'
      );
      RAISE EXCEPTION 'payment evidence conflict: different provider tx for occupied period';
    END IF;
  END;

  -- Mark intent completed BEFORE M375 activation — if activation fails, whole tx rolls back
  UPDATE subscription_checkout_intents SET status = 'completed' WHERE id = p_intent_id;

  -- Call M375 and ENFORCE its result — rollback on rejection
  v_activation_result := public.activate_paid_subscription(v_payment_id);
  IF v_activation_result IS NULL OR (v_activation_result ->> 'activated')::BOOLEAN IS NOT TRUE THEN
    RAISE EXCEPTION 'M375 activation rejected: %', COALESCE(v_activation_result ->> 'reason', 'unknown');
  END IF;

  RETURN v_sub_id;
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_flutterwave_subscription_checkout(uuid,text,text,integer,integer,text,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finalize_flutterwave_subscription_checkout(uuid,text,text,integer,integer,text,timestamptz) FROM anon;
REVOKE ALL ON FUNCTION public.finalize_flutterwave_subscription_checkout(uuid,text,text,integer,integer,text,timestamptz) FROM authenticated;
REVOKE ALL ON FUNCTION public.finalize_flutterwave_subscription_checkout(uuid,text,text,integer,integer,text,timestamptz) FROM service_role;
GRANT EXECUTE ON FUNCTION public.finalize_flutterwave_subscription_checkout(uuid,text,text,integer,integer,text,timestamptz) TO service_role;

CREATE OR REPLACE FUNCTION public.finalize_flutterwave_subscription_renewal(
  p_subscription_id UUID, p_provider_tx_id TEXT,
  p_verified_amount_minor INTEGER, p_verified_currency TEXT,
  p_provider_paid_at TIMESTAMPTZ
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_sub RECORD; v_period_start TIMESTAMPTZ; v_period_end TIMESTAMPTZ;
  v_payment_id UUID; v_activation_result JSONB; v_existing_payment RECORD;
BEGIN
  -- Require non-null provider timestamp (Blocker 4)
  IF p_provider_paid_at IS NULL THEN
    RAISE EXCEPTION 'finalize_renewal: p_provider_paid_at must not be NULL';
  END IF;

  SELECT * INTO v_sub FROM subscriptions WHERE id = p_subscription_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'subscription % not found', p_subscription_id; END IF;

  v_period_start := p_provider_paid_at;
  v_period_end := v_period_start + interval '30 days';

  -- Out-of-order protection: reject if provider timestamp would regress chronology (Blocker 4)
  IF v_sub.current_period_start IS NOT NULL AND v_period_start < v_sub.current_period_start THEN
    RAISE EXCEPTION 'renewal out-of-order: provider_paid_at % is before current_period_start %',
      v_period_start, v_sub.current_period_start;
  END IF;

  -- Insert payment evidence — distinguish same-tx duplicate from period conflict (Blocker 3)
  BEGIN
    INSERT INTO subscription_payments (
      id, business_id, subscription_id, amount, currency, gateway,
      gateway_reference, provider_reference, plan, action, status,
      billing_interval, config_version_id, period_start, period_end
    ) VALUES (
      gen_random_uuid(), v_sub.business_id, p_subscription_id,
      p_verified_amount_minor, upper(p_verified_currency), 'flutterwave',
      p_provider_tx_id, p_provider_tx_id, v_sub.plan, 'renewal', 'success',
      'month', v_sub.billing_config_version_id, v_period_start, v_period_end
    ) RETURNING id INTO v_payment_id;
  EXCEPTION WHEN unique_violation THEN
    -- Check if exact same provider transaction (idempotent)
    SELECT * INTO v_existing_payment FROM subscription_payments
      WHERE gateway = 'flutterwave' AND provider_reference = p_provider_tx_id AND status = 'success';
    IF FOUND THEN
      -- Same provider tx — idempotent, no extension
      RETURN;
    ELSE
      -- Different tx for occupied period — quarantine (Blocker 3)
      INSERT INTO subscription_payment_quarantine (
        subscription_id, provider_tx_ref, provider_tx_id,
        provider_amount, provider_currency, provider_status, reason
      ) VALUES (
        p_subscription_id, p_provider_tx_id, p_provider_tx_id,
        p_verified_amount_minor, p_verified_currency, 'conflict',
        'different_renewal_tx_for_occupied_period'
      );
      RAISE EXCEPTION 'renewal conflict: different provider tx for occupied period';
    END IF;
  END;

  -- Extend subscription period
  UPDATE subscriptions SET
    current_period_start = v_period_start, current_period_end = v_period_end,
    status = 'active', updated_at = clock_timestamp()
  WHERE id = p_subscription_id;

  -- Call M375 and enforce result (Blocker 2)
  v_activation_result := public.activate_paid_subscription(v_payment_id);
  IF v_activation_result IS NULL OR (v_activation_result ->> 'activated')::BOOLEAN IS NOT TRUE THEN
    RAISE EXCEPTION 'M375 renewal activation rejected: %', COALESCE(v_activation_result ->> 'reason', 'unknown');
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_flutterwave_subscription_renewal(uuid,text,integer,text,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finalize_flutterwave_subscription_renewal(uuid,text,integer,text,timestamptz) FROM anon;
REVOKE ALL ON FUNCTION public.finalize_flutterwave_subscription_renewal(uuid,text,integer,text,timestamptz) FROM authenticated;
REVOKE ALL ON FUNCTION public.finalize_flutterwave_subscription_renewal(uuid,text,integer,text,timestamptz) FROM service_role;
GRANT EXECUTE ON FUNCTION public.finalize_flutterwave_subscription_renewal(uuid,text,integer,text,timestamptz) TO service_role;

CREATE OR REPLACE FUNCTION public.finalize_subscription_cancellation(
  p_subscription_id UUID, p_provider_event_id TEXT, p_reason TEXT DEFAULT 'provider_cancelled'
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_sub RECORD; v_existing INTEGER;
BEGIN
  IF p_provider_event_id IS NOT NULL THEN
    SELECT count(*) INTO v_existing FROM processed_webhook_events WHERE event_id = p_provider_event_id;
    IF v_existing > 0 THEN RETURN; END IF;
    INSERT INTO processed_webhook_events (event_id, gateway, event_type, processed_at)
    VALUES (p_provider_event_id, 'flutterwave', 'subscription.cancelled', clock_timestamp())
    ON CONFLICT (event_id) DO NOTHING;
  END IF;

  SELECT * INTO v_sub FROM subscriptions WHERE id = p_subscription_id FOR UPDATE;
  IF NOT FOUND OR v_sub.status = 'cancelled' THEN RETURN; END IF;

  UPDATE subscriptions SET status = 'cancelled', cancelled_at = clock_timestamp(),
    cancellation_reason = p_reason, updated_at = clock_timestamp()
  WHERE id = p_subscription_id;

  UPDATE businesses SET subscription_tier = 'free', updated_at = clock_timestamp()
  WHERE id = v_sub.business_id;
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_subscription_cancellation(uuid,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finalize_subscription_cancellation(uuid,text,text) FROM anon;
REVOKE ALL ON FUNCTION public.finalize_subscription_cancellation(uuid,text,text) FROM authenticated;
REVOKE ALL ON FUNCTION public.finalize_subscription_cancellation(uuid,text,text) FROM service_role;
GRANT EXECUTE ON FUNCTION public.finalize_subscription_cancellation(uuid,text,text) TO service_role;

-- ══════════════════════════════════════════════════════════
-- F. Evolved guards
-- ══════════════════════════════════════════════════════════

DROP TRIGGER IF EXISTS trg_guard_paystack_plan_codes ON public.countries;

CREATE OR REPLACE FUNCTION public.guard_provider_ref_authority()
RETURNS TRIGGER AS $$
DECLARE
  v_auth_marker TEXT;
  v_gateway_marker TEXT;
  v_old_refs_g JSONB; v_new_refs_g JSONB;
  v_old_refs_b JSONB; v_new_refs_b JSONB;
  v_old_ppc_g TEXT; v_new_ppc_g TEXT;
  v_old_ppc_b TEXT; v_new_ppc_b TEXT;
  v_refs_changed BOOLEAN;
  v_gw_changed BOOLEAN;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_old_refs_g := NULL; v_old_refs_b := NULL;
    v_old_ppc_g := NULL; v_old_ppc_b := NULL;
  ELSE
    v_old_refs_g := OLD.pricing -> 'growth' -> 'provider_plan_refs';
    v_old_refs_b := OLD.pricing -> 'business' -> 'provider_plan_refs';
    v_old_ppc_g := OLD.pricing -> 'growth' ->> 'paystack_plan_code';
    v_old_ppc_b := OLD.pricing -> 'business' ->> 'paystack_plan_code';
  END IF;

  v_new_refs_g := NEW.pricing -> 'growth' -> 'provider_plan_refs';
  v_new_refs_b := NEW.pricing -> 'business' -> 'provider_plan_refs';
  v_new_ppc_g := NEW.pricing -> 'growth' ->> 'paystack_plan_code';
  v_new_ppc_b := NEW.pricing -> 'business' ->> 'paystack_plan_code';

  v_refs_changed := v_old_refs_g IS DISTINCT FROM v_new_refs_g
    OR v_old_refs_b IS DISTINCT FROM v_new_refs_b
    OR v_old_ppc_g IS DISTINCT FROM v_new_ppc_g
    OR v_old_ppc_b IS DISTINCT FROM v_new_ppc_b;

  v_gw_changed := TG_OP <> 'INSERT'
    AND OLD.payment_gateway IS DISTINCT FROM NEW.payment_gateway;

  IF NOT v_refs_changed AND NOT v_gw_changed THEN RETURN NEW; END IF;

  IF v_refs_changed THEN
    v_auth_marker := current_setting('waaiio.provider_ref_auth', true);
    IF v_auth_marker IS NULL OR v_auth_marker <> 'true' THEN
      -- Also accept legacy plan_code_auth for M377 backward compat
      v_auth_marker := current_setting('waaiio.plan_code_auth', true);
      IF v_auth_marker IS NULL OR v_auth_marker <> 'true' THEN
        RAISE EXCEPTION 'Provider plan references may only be modified via save_provider_plan_refs() or save_market_messaging_config()';
      END IF;
    END IF;
  END IF;

  IF v_gw_changed THEN
    v_gateway_marker := current_setting('waaiio.gateway_switch_auth', true);
    IF v_gateway_marker IS NULL OR v_gateway_marker <> 'true' THEN
      RAISE EXCEPTION 'payment_gateway changes require switch_country_provider()';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_guard_provider_refs
  BEFORE INSERT OR UPDATE ON public.countries
  FOR EACH ROW EXECUTE FUNCTION public.guard_provider_ref_authority();

-- F2. Evolve guard_country_activation for multi-provider support
CREATE OR REPLACE FUNCTION public.guard_country_activation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_snapshot JSONB; v_pricing JSONB; v_trial_credit JSONB; v_included JSONB;
  v_bucket_currency TEXT; v_match_count INTEGER;
  v_supported_gateways TEXT[] := ARRAY['paystack','stripe','flutterwave'];
  v_growth_ref TEXT; v_business_ref TEXT;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.code != OLD.code THEN
    RAISE EXCEPTION 'countries.code is immutable after creation.';
  END IF;
  IF TG_OP = 'UPDATE' AND NOT NEW.is_active THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' AND NOT NEW.is_active THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.is_active AND NEW.currency_code != OLD.currency_code THEN
    RAISE EXCEPTION 'Cannot change currency on active market %. Deactivate first.', NEW.code;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.is_active
     AND NEW.currency_code = OLD.currency_code
     AND NEW.pricing IS NOT DISTINCT FROM OLD.pricing
     AND NEW.payment_gateway = OLD.payment_gateway THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('commercial_config_write'));

  IF NEW.currency_code IS NULL OR length(NEW.currency_code) < 2 THEN
    RAISE EXCEPTION 'Cannot activate market %: currency_code required', NEW.code;
  END IF;
  IF NEW.payment_gateway IS NULL OR NEW.payment_gateway = '' THEN
    RAISE EXCEPTION 'Cannot activate market %: payment_gateway required', NEW.code;
  END IF;
  IF NOT (NEW.payment_gateway = ANY(v_supported_gateways)) THEN
    RAISE EXCEPTION 'Cannot activate market %: gateway "%" not supported', NEW.code, NEW.payment_gateway;
  END IF;

  IF NEW.pricing IS NULL OR jsonb_typeof(NEW.pricing) != 'object'
     OR NEW.pricing -> 'free' IS NULL OR NEW.pricing -> 'growth' IS NULL OR NEW.pricing -> 'business' IS NULL THEN
    RAISE EXCEPTION 'Cannot activate market %: pricing must contain free, growth, business', NEW.code;
  END IF;
  IF NEW.pricing -> 'growth' -> 'price' IS NULL OR jsonb_typeof(NEW.pricing -> 'growth' -> 'price') <> 'number'
     OR (NEW.pricing -> 'growth' ->> 'price')::NUMERIC <= 0 THEN
    RAISE EXCEPTION 'Cannot activate market %: growth price must be positive', NEW.code;
  END IF;
  IF NEW.pricing -> 'business' -> 'price' IS NULL OR jsonb_typeof(NEW.pricing -> 'business' -> 'price') <> 'number'
     OR (NEW.pricing -> 'business' ->> 'price')::NUMERIC <= 0 THEN
    RAISE EXCEPTION 'Cannot activate market %: business price must be positive', NEW.code;
  END IF;

  IF NEW.payment_gateway IN ('paystack','flutterwave') THEN
    v_growth_ref := NEW.pricing -> 'growth' -> 'provider_plan_refs' ->> NEW.payment_gateway;
    v_business_ref := NEW.pricing -> 'business' -> 'provider_plan_refs' ->> NEW.payment_gateway;
    IF NEW.payment_gateway = 'paystack' THEN
      IF v_growth_ref IS NULL OR length(v_growth_ref) < 3 THEN
        v_growth_ref := NEW.pricing -> 'growth' ->> 'paystack_plan_code';
      END IF;
      IF v_business_ref IS NULL OR length(v_business_ref) < 3 THEN
        v_business_ref := NEW.pricing -> 'business' ->> 'paystack_plan_code';
      END IF;
    END IF;
    IF v_growth_ref IS NULL OR length(v_growth_ref) < 3 THEN
      RAISE EXCEPTION 'Cannot activate % market %: growth plan ref missing', NEW.payment_gateway, NEW.code;
    END IF;
    IF v_business_ref IS NULL OR length(v_business_ref) < 3 THEN
      RAISE EXCEPTION 'Cannot activate % market %: business plan ref missing', NEW.payment_gateway, NEW.code;
    END IF;
  END IF;

  SELECT config_snapshot INTO v_snapshot FROM public.platform_config_versions
    WHERE effective_from <= clock_timestamp() ORDER BY effective_from DESC LIMIT 1;
  IF v_snapshot IS NULL THEN
    RAISE EXCEPTION 'Cannot activate market %: no config version', NEW.code;
  END IF;

  v_pricing := v_snapshot -> 'messaging_pricing';
  v_trial_credit := v_snapshot -> 'trial_credit_minor_by_currency';
  v_included := v_snapshot -> 'subscription_included_minor_by_tier_currency';

  IF v_pricing IS NULL OR jsonb_typeof(v_pricing) != 'object' THEN
    RAISE EXCEPTION 'Cannot activate market %: messaging_pricing not configured', NEW.code;
  END IF;

  v_match_count := 0;
  FOR v_bucket_currency IN SELECT key FROM jsonb_each(v_pricing) LOOP
    IF v_pricing -> v_bucket_currency -> 'rates' -> NEW.code IS NOT NULL THEN
      v_match_count := v_match_count + 1;
    END IF;
  END LOOP;
  IF v_match_count = 0 THEN
    RAISE EXCEPTION 'Cannot activate market %: not in messaging_pricing', NEW.code;
  END IF;
  IF v_match_count > 1 THEN
    RAISE EXCEPTION 'Cannot activate market %: in % buckets', NEW.code, v_match_count;
  END IF;

  v_bucket_currency := NULL;
  FOR v_bucket_currency IN SELECT key FROM jsonb_each(v_pricing) LOOP
    IF v_pricing -> v_bucket_currency -> 'rates' -> NEW.code IS NOT NULL THEN EXIT; END IF;
  END LOOP;
  IF v_bucket_currency != NEW.currency_code THEN
    RAISE EXCEPTION 'Cannot activate market %: pricing maps under % but currency is %',
      NEW.code, v_bucket_currency, NEW.currency_code;
  END IF;

  IF v_pricing -> v_bucket_currency -> 'default_spend_cap_minor' IS NULL
     OR jsonb_typeof(v_pricing -> v_bucket_currency -> 'default_spend_cap_minor') != 'number'
     OR (v_pricing -> v_bucket_currency ->> 'default_spend_cap_minor')::NUMERIC <= 0
     OR (v_pricing -> v_bucket_currency ->> 'default_spend_cap_minor')::NUMERIC <>
        FLOOR((v_pricing -> v_bucket_currency ->> 'default_spend_cap_minor')::NUMERIC) THEN
    RAISE EXCEPTION 'Cannot activate market %: spend cap must be positive integer', NEW.code;
  END IF;
  IF v_trial_credit IS NULL OR v_trial_credit ->> NEW.currency_code IS NULL THEN
    RAISE EXCEPTION 'Cannot activate market %: trial credit missing for %', NEW.code, NEW.currency_code;
  END IF;
  IF v_included IS NULL
     OR v_included -> 'growth' ->> NEW.currency_code IS NULL
     OR v_included -> 'business' ->> NEW.currency_code IS NULL THEN
    RAISE EXCEPTION 'Cannot activate market %: tier included missing for %', NEW.code, NEW.currency_code;
  END IF;

  RETURN NEW;
END;
$$;

-- F3. Update save_market_messaging_config to set both auth markers
CREATE OR REPLACE FUNCTION public.save_market_messaging_config(
  p_messaging_pricing JSONB, p_trial_credit_minor_by_currency JSONB,
  p_subscription_included_minor_by_tier_currency JSONB,
  p_paystack_plan_codes JSONB DEFAULT NULL,
  p_expected_version_id UUID DEFAULT NULL,
  p_description TEXT DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_caller_id UUID; v_version_id UUID; v_latest_version_id UUID;
  v_country_code TEXT; v_plan_obj JSONB; v_growth_code TEXT; v_business_code TEXT;
  v_row_count INTEGER; v_country_gateway TEXT; v_plan_key TEXT; v_key_count INTEGER;
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN RAISE EXCEPTION 'requires authenticated caller'; END IF;
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'requires admin role'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('commercial_config_write'));
  IF p_expected_version_id IS NULL THEN RAISE EXCEPTION 'requires non-NULL expected_version_id'; END IF;
  SELECT id INTO v_latest_version_id FROM platform_config_versions
    WHERE effective_from <= clock_timestamp() ORDER BY effective_from DESC LIMIT 1;
  IF v_latest_version_id IS DISTINCT FROM p_expected_version_id THEN
    RAISE EXCEPTION 'config_version_conflict: expected % but latest is %', p_expected_version_id, v_latest_version_id;
  END IF;

  IF p_paystack_plan_codes IS NOT NULL THEN
    IF jsonb_typeof(p_paystack_plan_codes) <> 'object' THEN
      RAISE EXCEPTION 'p_paystack_plan_codes must be a JSONB object';
    END IF;
    IF p_paystack_plan_codes = '{}'::jsonb THEN
      RAISE EXCEPTION 'p_paystack_plan_codes must not be empty when supplied';
    END IF;
    FOR v_country_code IN SELECT key FROM jsonb_each(p_paystack_plan_codes) LOOP
      v_plan_obj := p_paystack_plan_codes -> v_country_code;
      IF jsonb_typeof(v_plan_obj) <> 'object' THEN
        RAISE EXCEPTION 'paystack_plan_codes[%] must be object', v_country_code;
      END IF;
      v_key_count := 0;
      FOR v_plan_key IN SELECT key FROM jsonb_each(v_plan_obj) LOOP
        IF v_plan_key NOT IN ('growth','business') THEN
          RAISE EXCEPTION 'paystack_plan_codes[%] unknown key "%"', v_country_code, v_plan_key;
        END IF;
        v_key_count := v_key_count + 1;
      END LOOP;
      IF v_plan_obj -> 'growth' IS NULL OR v_plan_obj -> 'business' IS NULL THEN
        RAISE EXCEPTION 'paystack_plan_codes[%] must contain both growth and business', v_country_code;
      END IF;
      IF jsonb_typeof(v_plan_obj -> 'growth') <> 'string' OR length(TRIM(v_plan_obj ->> 'growth')) < 3 THEN
        RAISE EXCEPTION 'paystack_plan_codes[%].growth must be >= 3 chars', v_country_code;
      END IF;
      IF jsonb_typeof(v_plan_obj -> 'business') <> 'string' OR length(TRIM(v_plan_obj ->> 'business')) < 3 THEN
        RAISE EXCEPTION 'paystack_plan_codes[%].business must be >= 3 chars', v_country_code;
      END IF;
      SELECT payment_gateway INTO v_country_gateway FROM public.countries WHERE code = v_country_code;
      IF NOT FOUND THEN RAISE EXCEPTION 'unknown country "%"', v_country_code; END IF;
      IF v_country_gateway <> 'paystack' THEN
        RAISE EXCEPTION 'paystack_plan_codes[%]: gateway is "%" not "paystack"', v_country_code, v_country_gateway;
      END IF;
    END LOOP;
  END IF;

  v_version_id := public.save_messaging_config(
    p_messaging_pricing, p_trial_credit_minor_by_currency,
    p_subscription_included_minor_by_tier_currency, p_expected_version_id, p_description
  );

  IF p_paystack_plan_codes IS NOT NULL THEN
    PERFORM set_config('waaiio.plan_code_auth', 'true', true);
    PERFORM set_config('waaiio.provider_ref_auth', 'true', true);
    FOR v_country_code IN SELECT key FROM jsonb_each(p_paystack_plan_codes) LOOP
      v_plan_obj := p_paystack_plan_codes -> v_country_code;
      v_growth_code := TRIM(v_plan_obj ->> 'growth');
      v_business_code := TRIM(v_plan_obj ->> 'business');
      -- Update both legacy paystack_plan_code AND provider_plan_refs.paystack coherently (Blocker 6)
      UPDATE public.countries SET pricing =
        jsonb_set(
          jsonb_set(
            jsonb_set(
              jsonb_set(COALESCE(pricing, '{}'::jsonb),
                '{growth,paystack_plan_code}', to_jsonb(v_growth_code)),
              '{business,paystack_plan_code}', to_jsonb(v_business_code)),
            '{growth,provider_plan_refs}',
            COALESCE(pricing -> 'growth' -> 'provider_plan_refs', '{}'::jsonb) || jsonb_build_object('paystack', v_growth_code)),
          '{business,provider_plan_refs}',
          COALESCE(pricing -> 'business' -> 'provider_plan_refs', '{}'::jsonb) || jsonb_build_object('paystack', v_business_code))
      WHERE code = v_country_code AND payment_gateway = 'paystack';
      GET DIAGNOSTICS v_row_count = ROW_COUNT;
      IF v_row_count <> 1 THEN
        RAISE EXCEPTION 'paystack_plan_codes[%]: UPDATE affected % rows', v_country_code, v_row_count;
      END IF;
    END LOOP;
    PERFORM set_config('waaiio.plan_code_auth', '', true);
    PERFORM set_config('waaiio.provider_ref_auth', '', true);
  END IF;

  RETURN v_version_id;
END;
$$;

-- ══════════════════════════════════════════════════════════
-- G. Verification
-- ══════════════════════════════════════════════════════════

DO $$
DECLARE v_count INTEGER;
BEGIN
  SELECT count(*) INTO v_count FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'subscription_checkout_intents';
  IF v_count = 0 THEN RAISE EXCEPTION 'M378: subscription_checkout_intents not found'; END IF;

  SELECT count(*) INTO v_count FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'subscription_payment_quarantine';
  IF v_count = 0 THEN RAISE EXCEPTION 'M378: subscription_payment_quarantine not found'; END IF;

  SELECT count(*) INTO v_count FROM pg_proc
    WHERE proname = 'save_provider_plan_refs' AND pronamespace = 'public'::regnamespace;
  IF v_count = 0 THEN RAISE EXCEPTION 'M378: save_provider_plan_refs not found'; END IF;

  SELECT count(*) INTO v_count FROM pg_proc
    WHERE proname = 'switch_country_provider' AND pronamespace = 'public'::regnamespace;
  IF v_count = 0 THEN RAISE EXCEPTION 'M378: switch_country_provider not found'; END IF;

  SELECT count(*) INTO v_count FROM pg_proc
    WHERE proname = 'claim_checkout_initialization' AND pronamespace = 'public'::regnamespace;
  IF v_count = 0 THEN RAISE EXCEPTION 'M378: claim_checkout_initialization not found'; END IF;

  SELECT count(*) INTO v_count FROM pg_proc
    WHERE proname = 'finalize_flutterwave_subscription_checkout' AND pronamespace = 'public'::regnamespace;
  IF v_count = 0 THEN RAISE EXCEPTION 'M378: finalize_flutterwave_subscription_checkout not found'; END IF;

  SELECT count(*) INTO v_count FROM pg_proc
    WHERE proname = 'finalize_flutterwave_subscription_renewal' AND pronamespace = 'public'::regnamespace;
  IF v_count = 0 THEN RAISE EXCEPTION 'M378: finalize_flutterwave_subscription_renewal not found'; END IF;

  SELECT count(*) INTO v_count FROM pg_proc
    WHERE proname = 'finalize_subscription_cancellation' AND pronamespace = 'public'::regnamespace;
  IF v_count = 0 THEN RAISE EXCEPTION 'M378: finalize_subscription_cancellation not found'; END IF;

  SELECT count(*) INTO v_count FROM information_schema.triggers
    WHERE trigger_name = 'trg_guard_provider_refs' AND event_object_table = 'countries';
  IF v_count = 0 THEN RAISE EXCEPTION 'M378: trg_guard_provider_refs not found'; END IF;

  SELECT count(*) INTO v_count FROM information_schema.triggers
    WHERE trigger_name = 'trg_guard_paystack_plan_codes' AND event_object_table = 'countries';
  IF v_count > 0 THEN RAISE EXCEPTION 'M378: old trg_guard_paystack_plan_codes still exists'; END IF;

  SELECT count(*) INTO v_count FROM information_schema.columns
    WHERE table_name = 'subscriptions' AND column_name = 'billing_config_version_id';
  IF v_count = 0 THEN RAISE EXCEPTION 'M378: subscriptions.billing_config_version_id not found'; END IF;

  SELECT count(*) INTO v_count FROM pg_indexes WHERE indexname = 'uq_subscription_payment_provider_tx';
  IF v_count = 0 THEN RAISE EXCEPTION 'M378: uq_subscription_payment_provider_tx not found'; END IF;

  -- M377 backward compat
  SELECT count(*) INTO v_count FROM pg_proc
    WHERE proname = 'save_commercial_config' AND pronamespace = 'public'::regnamespace AND pronargs = 4;
  IF v_count = 0 THEN RAISE EXCEPTION 'M378: M377 save_commercial_config(4-arg) missing'; END IF;
  SELECT count(*) INTO v_count FROM pg_proc
    WHERE proname = 'save_messaging_config' AND pronamespace = 'public'::regnamespace;
  IF v_count = 0 THEN RAISE EXCEPTION 'M378: M377 save_messaging_config missing'; END IF;
END;
$$;
