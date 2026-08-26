-- Migration 339: Stripe recurring finalization authority (#177)
--
-- Establishes a single atomic PostgreSQL finalizer for Stripe customer-subscription
-- invoice.paid events. Prevents the partial-accounting defect where independent
-- application writes could leave partial state on crash/restart.
--
-- Architecture (Revision 7):
-- - Stripe Invoice ID is the durable billing-cycle/finalization identity
-- - PaymentIntent ID remains payments.gateway_reference for refund compatibility
-- - One atomic RPC covers: booking, payment, apply_payment_spend_once,
--   subscription_charges, platform_fee, subscription counters, finalization marker
-- - Advisory lock serializes concurrent deliveries per invoice
-- - Terminal finalization marker proves all writes committed

-- ═══════════════════════════════════════════════════════════
-- 1. Finalization marker table
-- ═══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS stripe_recurring_finalizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stripe_invoice_id TEXT NOT NULL,
  customer_subscription_id UUID NOT NULL REFERENCES customer_subscriptions(id),
  stripe_subscription_code TEXT NOT NULL,
  canonical_payment_id UUID NOT NULL,
  canonical_booking_id UUID NOT NULL,
  canonical_booking_ref TEXT NOT NULL,
  finalized_amount_cents INT NOT NULL,
  finalized_currency TEXT NOT NULL,
  provider_payment_ref TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT uq_stripe_fin_invoice UNIQUE (stripe_invoice_id)
);

ALTER TABLE stripe_recurring_finalizations ENABLE ROW LEVEL SECURITY;

-- ═══════════════════════════════════════════════════════════
-- 2. Atomic finalizer RPC
-- ═══════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION finalize_stripe_recurring_charge(
  p_subscription_id UUID,
  p_stripe_invoice_id TEXT,
  p_stripe_subscription_code TEXT,
  p_amount_cents INT,
  p_currency TEXT DEFAULT 'USD',
  p_payment_intent_id TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_existing RECORD;
  v_sub RECORD;
  v_now TIMESTAMPTZ := NOW();
  v_today DATE := CURRENT_DATE;
  v_time TEXT;
  v_booking_id UUID;
  v_booking_ref TEXT;
  v_payment_id UUID;
  v_next_charge TIMESTAMPTZ;
  v_amount NUMERIC(12,2);
  v_business RECORD;
  v_fee_pct NUMERIC(5,2);
  v_fee_flat NUMERIC(12,2);
  v_fee_total NUMERIC(12,2);
  v_is_in_trial BOOLEAN;
  v_tier TEXT;
  v_spend_result JSONB;
BEGIN
  -- ── Input validation: reject null/malformed IDs before any locking ──
  IF p_stripe_invoice_id IS NULL OR p_stripe_invoice_id !~ '^in_' THEN
    RETURN jsonb_build_object('success', false, 'reason', 'invalid_invoice_id');
  END IF;
  IF p_stripe_subscription_code IS NULL OR p_stripe_subscription_code !~ '^sub_' THEN
    RETURN jsonb_build_object('success', false, 'reason', 'invalid_subscription_code');
  END IF;
  IF p_payment_intent_id IS NULL OR p_payment_intent_id !~ '^pi_' THEN
    RETURN jsonb_build_object('success', false, 'reason', 'invalid_payment_intent_id');
  END IF;
  IF p_subscription_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'reason', 'null_subscription_id');
  END IF;
  IF p_amount_cents IS NULL OR p_amount_cents <= 0 THEN
    RETURN jsonb_build_object('success', false, 'reason', 'invalid_amount');
  END IF;
  IF p_currency IS NULL OR TRIM(p_currency) = '' THEN
    RETURN jsonb_build_object('success', false, 'reason', 'invalid_currency');
  END IF;

  -- ── Invoice-level advisory lock: serializes ALL concurrent callers for this invoice ──
  -- This prevents the race where two workers both see "no finalization marker"
  -- and both attempt to insert (which would cause a unique violation instead
  -- of a clean replay response).
  PERFORM pg_advisory_xact_lock(hashtext(p_stripe_invoice_id));

  -- ── Check for existing finalization (replay path) ──
  SELECT * INTO v_existing FROM stripe_recurring_finalizations
    WHERE stripe_invoice_id = p_stripe_invoice_id;

  IF FOUND THEN
    -- Validate replay identity: all fields must match (null-safe)
    IF v_existing.finalized_amount_cents IS DISTINCT FROM p_amount_cents THEN
      RETURN jsonb_build_object('success', false, 'reason', 'replay_amount_mismatch');
    END IF;
    IF UPPER(v_existing.finalized_currency) IS DISTINCT FROM UPPER(p_currency) THEN
      RETURN jsonb_build_object('success', false, 'reason', 'replay_currency_mismatch');
    END IF;
    IF v_existing.customer_subscription_id IS DISTINCT FROM p_subscription_id THEN
      RETURN jsonb_build_object('success', false, 'reason', 'replay_subscription_mismatch');
    END IF;
    IF v_existing.provider_payment_ref IS DISTINCT FROM p_payment_intent_id THEN
      RETURN jsonb_build_object('success', false, 'reason', 'replay_provider_ref_mismatch');
    END IF;
    -- Return canonical IDs for Stage 3 recovery
    RETURN jsonb_build_object('success', true, 'already_finalized', true,
      'payment_id', v_existing.canonical_payment_id,
      'booking_id', v_existing.canonical_booking_id,
      'booking_ref', v_existing.canonical_booking_ref,
      'amount', v_existing.finalized_amount_cents / 100.0,
      'currency', v_existing.finalized_currency,
      'subscription_id', v_existing.customer_subscription_id);
  END IF;

  -- ── Lock subscription row for counter serialization ──
  SELECT * INTO v_sub FROM customer_subscriptions
    WHERE id = p_subscription_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'reason', 'subscription_not_found');
  END IF;

  -- ── Validate DB authority (null-safe: NULL gateway/status/code must fail closed) ──
  IF v_sub.gateway IS NULL OR v_sub.gateway != 'stripe' THEN
    RETURN jsonb_build_object('success', false, 'reason', 'wrong_gateway',
      'expected', 'stripe', 'actual', v_sub.gateway);
  END IF;

  IF v_sub.status IS NULL OR v_sub.status NOT IN ('active', 'past_due') THEN
    RETURN jsonb_build_object('success', false, 'reason', 'wrong_status',
      'status', v_sub.status);
  END IF;

  IF v_sub.gateway_subscription_code IS NULL OR
     v_sub.gateway_subscription_code IS DISTINCT FROM p_stripe_subscription_code THEN
    RETURN jsonb_build_object('success', false, 'reason', 'subscription_code_mismatch');
  END IF;

  -- Amount validation: exact cents equality, no tolerance
  IF v_sub.amount IS NULL OR p_amount_cents IS DISTINCT FROM ROUND(v_sub.amount * 100)::int THEN
    RETURN jsonb_build_object('success', false, 'reason', 'amount_mismatch',
      'expected_cents', ROUND(COALESCE(v_sub.amount, 0) * 100)::int, 'received_cents', p_amount_cents);
  END IF;

  IF v_sub.currency IS NULL OR UPPER(p_currency) IS DISTINCT FROM UPPER(v_sub.currency) THEN
    RETURN jsonb_build_object('success', false, 'reason', 'currency_mismatch');
  END IF;

  -- ── Financial writes: all-or-nothing ──
  v_amount := p_amount_cents / 100.0;
  v_time := TO_CHAR(v_now, 'HH24:MI');

  -- Create booking
  INSERT INTO bookings (
    business_id, user_id, service_id, date, time, party_size,
    flow_type, channel, payment_source, deposit_amount, deposit_status, status,
    total_amount, quantity, guest_name, guest_phone, confirmed_at, notes
  ) VALUES (
    v_sub.business_id, v_sub.user_id, v_sub.service_id, v_today, v_time, 1,
    'payment', 'api', 'subscription',
    v_amount, 'paid', 'confirmed',
    v_amount, 1,
    COALESCE(v_sub.customer_name, ''), COALESCE(v_sub.customer_phone, ''),
    v_now, 'Recurring ' || v_sub.frequency || ' charge (Stripe)'
  ) RETURNING id, reference_code INTO v_booking_id, v_booking_ref;

  -- Create payment (gateway_reference = PaymentIntent ID for refund compatibility)
  INSERT INTO payments (
    business_id, user_id, booking_id, amount, currency, gateway,
    gateway_reference, status, gateway_status, payment_method,
    card_last_four, card_brand, paid_at, metadata
  ) VALUES (
    v_sub.business_id, v_sub.user_id, v_booking_id,
    v_amount, v_sub.currency, 'stripe',
    p_payment_intent_id, 'success', 'success', 'card',
    v_sub.card_last_four, v_sub.card_brand, v_now,
    jsonb_build_object('recurring', true, 'subscription_id', v_sub.id,
      'stripe_invoice_id', p_stripe_invoice_id)
  ) RETURNING id INTO v_payment_id;

  -- ── Atomic spend marker: hard gate ──
  v_spend_result := apply_payment_spend_once(v_payment_id);
  IF v_spend_result IS NULL OR (v_spend_result->>'applied')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'Stripe recurring spend failed for payment %: %',
      v_payment_id, COALESCE(v_spend_result::text, 'null_result');
  END IF;

  -- Subscription charge record
  INSERT INTO subscription_charges (
    subscription_id, business_id, user_id, amount, currency,
    status, gateway, gateway_reference, payment_id, booking_id, charged_at
  ) VALUES (
    v_sub.id, v_sub.business_id, v_sub.user_id,
    v_amount, v_sub.currency,
    'success', 'stripe', p_payment_intent_id, v_payment_id, v_booking_id, v_now
  );

  -- ── Platform fee: preserves active Stripe fee semantics exactly ──
  -- Uses ROUND(x) = integer rounding to match Math.round in getPlatformFees
  -- Uses strict > 0.10 micro-tx guard (exactly 10% is NOT waived)
  SELECT subscription_tier, trial_ends_at, payout_mode INTO v_business
    FROM businesses WHERE id = v_sub.business_id;

  IF v_business IS NOT NULL AND COALESCE(v_business.payout_mode, 'platform') != 'direct_split' THEN
    v_is_in_trial := v_business.trial_ends_at > v_now;
    v_tier := COALESCE(v_business.subscription_tier, 'free');
    IF v_is_in_trial THEN
      v_fee_pct := 0; v_fee_flat := 0; v_fee_total := 0;
    ELSE
      SELECT COALESCE((value::jsonb -> v_tier ->> 'feePercentage')::numeric,
               CASE v_tier WHEN 'free' THEN 2.5 WHEN 'growth' THEN 1.5 ELSE 1.5 END),
             COALESCE((value::jsonb -> v_tier ->> 'feeFlat')::numeric, 0)
      INTO v_fee_pct, v_fee_flat FROM platform_settings WHERE key = 'pricing_tiers' LIMIT 1;
      IF v_fee_pct IS NULL THEN
        v_fee_pct := CASE v_tier WHEN 'free' THEN 2.5 WHEN 'growth' THEN 1.5 ELSE 1.5 END;
        v_fee_flat := 0;
      END IF;
      -- Micro-transaction guard: strict > 0.10 (exactly 10% is NOT waived)
      IF v_fee_flat > 0 AND v_amount > 0 AND v_fee_flat / v_amount > 0.10 THEN
        v_fee_flat := 0;
      END IF;
      -- Integer rounding to match Math.round behavior
      v_fee_total := ROUND(v_amount * v_fee_pct / 100) + v_fee_flat;
    END IF;
    INSERT INTO platform_fees (business_id, booking_id, transaction_amount, fee_percentage, fee_flat, fee_total, tier)
    VALUES (v_sub.business_id, v_booking_id, v_amount, v_fee_pct, v_fee_flat, v_fee_total, v_tier);
  END IF;

  -- ── Update subscription counters ──
  IF v_sub.frequency = 'weekly' THEN v_next_charge := v_now + INTERVAL '7 days';
  ELSIF v_sub.frequency = 'yearly' THEN v_next_charge := v_now + INTERVAL '1 year';
  ELSE v_next_charge := v_now + INTERVAL '1 month';
  END IF;

  UPDATE customer_subscriptions SET
    charge_count = COALESCE(charge_count, 0) + 1,
    total_charged = COALESCE(total_charged, 0) + v_amount,
    last_charged_at = v_now,
    next_charge_at = v_next_charge,
    failure_count = 0,
    status = 'active'
  WHERE id = v_sub.id;

  -- ── Terminal finalization marker: inserted ONLY at end of successful transaction ──
  -- All canonical fields are NOT NULL. A committed row proves all financial writes succeeded.
  INSERT INTO stripe_recurring_finalizations (
    stripe_invoice_id, customer_subscription_id, stripe_subscription_code,
    canonical_payment_id, canonical_booking_id, canonical_booking_ref,
    finalized_amount_cents, finalized_currency, provider_payment_ref
  ) VALUES (
    p_stripe_invoice_id, p_subscription_id, p_stripe_subscription_code,
    v_payment_id, v_booking_id, v_booking_ref,
    p_amount_cents, p_currency, p_payment_intent_id
  );

  RETURN jsonb_build_object('success', true, 'already_finalized', false,
    'subscription_id', v_sub.id, 'booking_id', v_booking_id,
    'booking_ref', v_booking_ref, 'payment_id', v_payment_id,
    'amount', v_amount, 'currency', v_sub.currency,
    'business_id', v_sub.business_id,
    'customer_phone', v_sub.customer_phone,
    'customer_name', v_sub.customer_name);
END;
$$;

-- ═══════════════════════════════════════════════════════════
-- 3. Privilege hardening
-- ═══════════════════════════════════════════════════════════

DO $$
BEGIN
  REVOKE ALL ON FUNCTION finalize_stripe_recurring_charge(UUID, TEXT, TEXT, INT, TEXT, TEXT) FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION finalize_stripe_recurring_charge(UUID, TEXT, TEXT, INT, TEXT, TEXT) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION finalize_stripe_recurring_charge(UUID, TEXT, TEXT, INT, TEXT, TEXT) FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION finalize_stripe_recurring_charge(UUID, TEXT, TEXT, INT, TEXT, TEXT) TO service_role;
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════
-- 4. Privilege verification
-- ═══════════════════════════════════════════════════════════

DO $$
DECLARE v_has BOOLEAN;
BEGIN
  SELECT has_function_privilege('anon', 'finalize_stripe_recurring_charge(uuid,text,text,int,text,text)', 'EXECUTE') INTO v_has;
  IF v_has THEN RAISE EXCEPTION 'anon can execute finalize_stripe_recurring_charge'; END IF;

  SELECT has_function_privilege('authenticated', 'finalize_stripe_recurring_charge(uuid,text,text,int,text,text)', 'EXECUTE') INTO v_has;
  IF v_has THEN RAISE EXCEPTION 'authenticated can execute finalize_stripe_recurring_charge'; END IF;

  SELECT has_function_privilege('service_role', 'finalize_stripe_recurring_charge(uuid,text,text,int,text,text)', 'EXECUTE') INTO v_has;
  IF NOT v_has THEN RAISE EXCEPTION 'service_role cannot execute finalize_stripe_recurring_charge'; END IF;

  RAISE NOTICE 'All privilege checks passed for finalize_stripe_recurring_charge';
END $$;
