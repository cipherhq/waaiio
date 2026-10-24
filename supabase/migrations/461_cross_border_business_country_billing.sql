-- Migration 461: Cross-border billing — use business country for pricing
--
-- FIX: authorize_message_send derived billing currency from recipient_country_code.
-- A Nigerian business sending to a US customer was charged in USD (no NGN allowance match).
--
-- POLICY (Owner-approved): "Charge the business-country messaging rate in the
-- business's configured currency, regardless of the recipient's country."
--
-- CHANGE: Both overloads now JOIN businesses to get country_code and use it for
-- currency bucket + rate resolution. recipient_country_code is preserved on the
-- attempt record for WhatsApp delivery analytics and provider-cost tracking.
--
-- SECURITY: Both functions remain SECURITY DEFINER, service_role only, search_path = ''.
-- The businesses JOIN uses the attempt's already-validated business_id (FK-enforced).

-- ══════════════════════════════════════════════════════════
-- A. authorize_message_send(UUID) — single-arg overload
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
  -- Business country
  v_business_country TEXT;
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

  -- ── Step 3b: Resolve business country for billing ──
  SELECT country_code INTO v_business_country
    FROM public.businesses
    WHERE id = v_attempt.business_id;

  IF v_business_country IS NULL THEN
    RETURN jsonb_build_object('authorized', false, 'reason', 'business_country_not_found');
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

  -- Use BUSINESS country for currency resolution (not recipient country).
  -- recipient_country_code stays on the attempt for delivery analytics.
  v_country := v_business_country;
  v_category := v_attempt.message_category;

  IF v_category IS NULL THEN
    RETURN jsonb_build_object('authorized', false, 'reason', 'missing_message_category');
  END IF;

  -- Find which currency bucket(s) have explicit country coverage for the BUSINESS country.
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

  -- Resolve rate: business-country rate for the message category
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
-- B. authorize_message_send(UUID, UUID, TIMESTAMPTZ) — 3-arg overload
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
  -- Business country
  v_business_country TEXT;
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

  -- ── Step 3b: Resolve business country for billing ──
  SELECT country_code INTO v_business_country
    FROM public.businesses
    WHERE id = v_attempt.business_id;

  IF v_business_country IS NULL THEN
    RETURN jsonb_build_object('authorized', false, 'reason', 'business_country_not_found');
  END IF;

  -- ── Step 4: Resolve trusted pricing from passed config (no re-resolution) ──
  v_pricing := v_config.config_snapshot -> 'messaging_pricing';
  IF v_pricing IS NULL OR jsonb_typeof(v_pricing) <> 'object' THEN
    RETURN jsonb_build_object('authorized', false, 'reason', 'no_messaging_pricing');
  END IF;

  -- Use BUSINESS country for currency resolution (not recipient country).
  v_country := v_business_country;
  v_category := v_attempt.message_category;

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
