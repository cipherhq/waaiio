-- LOCAL TEST CANDIDATE ONLY. Not a migration or an operational deployment packet.
-- Preserve the three public precursor definitions; no later cancellation changes.

-- Public 335_recurring_spend_finalization.sql with authoritative payment linkage only.
CREATE OR REPLACE FUNCTION finalize_token_recurring_charge(
  p_stable_ref       TEXT,
  p_subscription_id  UUID,
  p_verified_amount  NUMERIC(12,2),
  p_verified_currency TEXT DEFAULT 'NGN',
  p_gateway          TEXT DEFAULT 'flutterwave',
  p_provider_attempt_ref TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_sub              RECORD;
  v_claim            RECORD;
  v_now              TIMESTAMPTZ := NOW();
  v_today            DATE := CURRENT_DATE;
  v_time             TEXT;
  v_booking_id       UUID;
  v_booking_ref      TEXT;
  v_payment_id       UUID;
  v_next_charge      TIMESTAMPTZ;
  v_business         RECORD;
  v_fee_pct          NUMERIC(5,2);
  v_fee_flat         NUMERIC(12,2);
  v_fee_total        NUMERIC(12,2);
  v_is_in_trial      BOOLEAN;
  v_tier             TEXT;
  v_authoritative_attempt_ref TEXT;
  v_spend_result     JSONB;  -- #164: spend application result
BEGIN
  -- Lock the claim row to serialize concurrent finalizers (FOR UPDATE from 306).
  SELECT * INTO v_claim FROM processed_webhook_events WHERE event_id = p_stable_ref FOR UPDATE;
  IF NOT FOUND OR v_claim.status NOT IN ('claimed', 'completed', 'provider_success') THEN
    RETURN jsonb_build_object('success', false, 'reason', 'no_valid_claim');
  END IF;
  IF v_claim.gateway != 'flutterwave' OR v_claim.event_type != 'token_renewal' THEN
    RETURN jsonb_build_object('success', false, 'reason', 'claim_type_mismatch');
  END IF;
  IF p_stable_ref NOT LIKE 'flw-' || p_subscription_id::text || '-%' THEN
    RETURN jsonb_build_object('success', false, 'reason', 'claim_subscription_mismatch');
  END IF;

  -- Extract authoritative provider attempt ref from claim row (sole source of truth).
  v_authoritative_attempt_ref := v_claim.last_error;

  IF p_provider_attempt_ref IS NOT NULL
     AND p_provider_attempt_ref IS DISTINCT FROM v_authoritative_attempt_ref THEN
    RETURN jsonb_build_object('success', false, 'reason', 'attempt_ref_mismatch',
      'expected', v_authoritative_attempt_ref, 'received', p_provider_attempt_ref);
  END IF;

  -- Idempotency: if already finalized, return success without duplicating.
  IF v_claim.status = 'completed' THEN
    SELECT id INTO v_payment_id FROM payments
      WHERE (gateway_reference = p_stable_ref
             OR (v_authoritative_attempt_ref IS NOT NULL AND gateway_reference = v_authoritative_attempt_ref))
      AND status = 'success' LIMIT 1;
    IF v_payment_id IS NULL THEN
      RETURN jsonb_build_object('success', false, 'reason', 'completed_payment_missing',
        'stable_ref', p_stable_ref, 'authoritative_attempt_ref', v_authoritative_attempt_ref);
    END IF;
    RETURN jsonb_build_object('success', true, 'already_finalized', true, 'payment_id', v_payment_id);
  END IF;

  -- Belt + suspenders: check payment doesn't already exist
  IF EXISTS (SELECT 1 FROM payments
     WHERE (gateway_reference = p_stable_ref
            OR (v_authoritative_attempt_ref IS NOT NULL AND gateway_reference = v_authoritative_attempt_ref))
     AND status = 'success') THEN
    UPDATE processed_webhook_events SET status = 'completed', completed_at = v_now WHERE event_id = p_stable_ref;
    SELECT id INTO v_payment_id FROM payments
      WHERE (gateway_reference = p_stable_ref
             OR (v_authoritative_attempt_ref IS NOT NULL AND gateway_reference = v_authoritative_attempt_ref))
      AND status = 'success' LIMIT 1;
    RETURN jsonb_build_object('success', true, 'already_finalized', true, 'payment_id', v_payment_id);
  END IF;

  -- For new finalization, claim MUST have authoritative attempt ref.
  IF v_authoritative_attempt_ref IS NULL OR v_authoritative_attempt_ref = '' THEN
    RETURN jsonb_build_object('success', false, 'reason', 'missing_authoritative_attempt_ref');
  END IF;

  -- Load and validate subscription
  SELECT * INTO v_sub FROM customer_subscriptions WHERE id = p_subscription_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'reason', 'subscription_not_found');
  END IF;
  IF COALESCE(v_sub.gateway, '') != 'flutterwave' THEN
    RETURN jsonb_build_object('success', false, 'reason', 'wrong_gateway', 'gateway', v_sub.gateway);
  END IF;
  IF p_gateway != 'flutterwave' THEN
    RETURN jsonb_build_object('success', false, 'reason', 'gateway_mismatch', 'expected', 'flutterwave', 'received', p_gateway);
  END IF;

  IF ABS(p_verified_amount - v_sub.amount) > 0.01 THEN
    RETURN jsonb_build_object('success', false, 'reason', 'amount_mismatch',
      'expected', v_sub.amount, 'received', p_verified_amount);
  END IF;
  IF LOWER(p_verified_currency) != LOWER(COALESCE(v_sub.currency, 'NGN')) THEN
    RETURN jsonb_build_object('success', false, 'reason', 'currency_mismatch',
      'expected', v_sub.currency, 'received', p_verified_currency);
  END IF;

  v_time := TO_CHAR(v_now, 'HH24:MI');

  -- Create booking (recurring accounting record)
  INSERT INTO bookings (
    business_id, user_id, service_id, date, time, party_size,
    flow_type, channel, payment_source, deposit_amount, deposit_status, status,
    total_amount, quantity, guest_name, guest_phone, confirmed_at, notes
  ) VALUES (
    v_sub.business_id, v_sub.user_id, v_sub.service_id, v_today, v_time, 1,
    'payment', 'recurring', 'subscription', p_verified_amount, 'paid', 'confirmed',
    p_verified_amount, 1, COALESCE(v_sub.customer_name, ''), COALESCE(v_sub.customer_phone, ''),
    v_now, 'Recurring ' || v_sub.frequency || ' charge'
  ) RETURNING id, reference_code INTO v_booking_id, v_booking_ref;

  -- Create payment
  INSERT INTO payments (
    business_id, user_id, booking_id, amount, currency, gateway,
    gateway_reference, status, gateway_status, payment_method,
    card_last_four, card_brand, paid_at, metadata
  ) VALUES (
    v_sub.business_id, v_sub.user_id, v_booking_id, p_verified_amount, p_verified_currency, p_gateway,
    v_authoritative_attempt_ref, 'success', 'success', 'card',
    v_sub.card_last_four, v_sub.card_brand,
    v_now, jsonb_build_object('recurring', true, 'subscription_id', v_sub.id, 'billing_cycle_ref', p_stable_ref, 'provider_attempt_ref', v_authoritative_attempt_ref)
  ) RETURNING id INTO v_payment_id;

  -- ═══════════════════════════════════════════════════════════
  -- #164: Atomic customer spend — reuses existing authority
  -- apply_payment_spend_once derives amount from payments.amount
  -- and source identity from payments.booking_id.
  -- Only applied=true is acceptable (includes already_applied).
  -- Any failure rolls back the entire finalizer transaction.
  -- ═══════════════════════════════════════════════════════════
  v_spend_result := apply_payment_spend_once(v_payment_id);

  IF v_spend_result IS NULL OR (v_spend_result->>'applied')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'Recurring spend application failed for payment %: %',
      v_payment_id, COALESCE(v_spend_result::text, 'null_result');
  END IF;

  -- Log subscription charge
  INSERT INTO subscription_charges (
    subscription_id, business_id, user_id, amount, currency,
    status, gateway, gateway_reference, payment_id, booking_id, charged_at
  ) VALUES (
    v_sub.id, v_sub.business_id, v_sub.user_id, p_verified_amount, p_verified_currency,
    'success', p_gateway, v_authoritative_attempt_ref, v_payment_id, v_booking_id, v_now
  );

  -- Platform fee
  SELECT subscription_tier, trial_ends_at, payout_mode INTO v_business FROM businesses WHERE id = v_sub.business_id;
  IF v_business IS NOT NULL AND COALESCE(v_business.payout_mode, 'platform') != 'direct_split' THEN
    v_is_in_trial := v_business.trial_ends_at > v_now;
    v_tier := COALESCE(v_business.subscription_tier, 'free');
    IF v_is_in_trial THEN v_fee_pct := 0; v_fee_flat := 0; v_fee_total := 0;
    ELSE
      SELECT COALESCE((value::jsonb -> v_tier ->> 'feePercentage')::numeric, CASE v_tier WHEN 'free' THEN 2.5 WHEN 'growth' THEN 1.5 ELSE 1.5 END),
             COALESCE((value::jsonb -> v_tier ->> 'feeFlat')::numeric, 0)
      INTO v_fee_pct, v_fee_flat FROM platform_settings WHERE key = 'pricing_tiers' LIMIT 1;
      IF v_fee_pct IS NULL THEN v_fee_pct := CASE v_tier WHEN 'free' THEN 2.5 WHEN 'growth' THEN 1.5 ELSE 1.5 END; v_fee_flat := 0; END IF;
      IF v_fee_flat > 0 AND p_verified_amount > 0 AND v_fee_flat / p_verified_amount > 0.10 THEN v_fee_flat := 0; END IF;
      v_fee_total := ROUND(p_verified_amount * v_fee_pct / 100, 2) + v_fee_flat;
    END IF;
    INSERT INTO platform_fees (payment_id, business_id, booking_id, transaction_amount, fee_percentage, fee_flat, fee_total, tier)
    VALUES (v_payment_id, v_sub.business_id, v_booking_id, p_verified_amount, v_fee_pct, v_fee_flat, v_fee_total, v_tier);
  END IF;

  -- Update subscription totals
  IF v_sub.frequency = 'weekly' THEN v_next_charge := v_now + INTERVAL '7 days';
  ELSIF v_sub.frequency = 'yearly' THEN v_next_charge := v_now + INTERVAL '1 year';
  ELSE v_next_charge := v_now + INTERVAL '1 month';
  END IF;

  UPDATE customer_subscriptions SET
    charge_count = charge_count + 1,
    total_charged = total_charged + p_verified_amount,
    last_charged_at = v_now,
    next_charge_at = v_next_charge,
    failure_count = 0
  WHERE id = v_sub.id;

  -- Mark billing cycle completed
  UPDATE processed_webhook_events SET status = 'completed', completed_at = v_now WHERE event_id = p_stable_ref;

  RETURN jsonb_build_object(
    'success', true,
    'already_finalized', false,
    'subscription_id', v_sub.id,
    'booking_id', v_booking_id,
    'booking_ref', v_booking_ref,
    'payment_id', v_payment_id,
    'amount', p_verified_amount,
    'currency', p_verified_currency,
    'business_id', v_sub.business_id,
    'customer_phone', v_sub.customer_phone,
    'customer_name', v_sub.customer_name
  );
END;
$$;

-- Public 339_stripe_recurring_finalization.sql with authoritative payment linkage only.
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

  -- ── Resolve business BEFORE financial writes ──
  -- Must happen before bookings INSERT (FK: bookings.business_id → businesses.id)
  -- to give a clean error instead of a FK violation on orphaned subscriptions.
  SELECT subscription_tier, trial_ends_at, payout_mode INTO v_business
    FROM businesses WHERE id = v_sub.business_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Business % not found for subscription %', v_sub.business_id, v_sub.id;
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
    v_sub.business_id, v_sub.user_id, v_sub.service_id, v_today, v_time::TIME, 1,
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
  -- Business was resolved above (before financial writes).
  IF COALESCE(v_business.payout_mode, 'platform') != 'direct_split' THEN
    -- NULL trial_ends_at = not in trial (matches process-success.ts semantics)
    v_is_in_trial := COALESCE(v_business.trial_ends_at > v_now, false);
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
    INSERT INTO platform_fees (payment_id, business_id, booking_id, transaction_amount, fee_percentage, fee_flat, fee_total, tier)
    VALUES (v_payment_id, v_sub.business_id, v_booking_id, v_amount, v_fee_pct, v_fee_flat, v_fee_total, v_tier::subscription_tier);
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

-- Public 337_paystack_recurring_finalization.sql with authoritative payment linkage only.
CREATE OR REPLACE FUNCTION finalize_paystack_recurring_charge(
  p_attempt_id UUID,
  p_provider_amount_minor INT,
  p_provider_currency TEXT DEFAULT 'NGN',
  p_provider_transaction_id TEXT DEFAULT NULL,
  p_provider_invoice_code TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_attempt RECORD;
  v_sub RECORD;
  v_now TIMESTAMPTZ := NOW();
  v_today DATE := CURRENT_DATE;
  v_time TEXT;
  v_booking_id UUID;
  v_booking_ref TEXT;
  v_payment_id UUID;
  v_next_charge TIMESTAMPTZ;
  v_business RECORD;
  v_fee_pct NUMERIC(5,2);
  v_fee_flat NUMERIC(12,2);
  v_fee_total NUMERIC(12,2);
  v_is_in_trial BOOLEAN;
  v_tier TEXT;
  v_spend_result JSONB;
BEGIN
  -- Lock the attempt to serialize concurrent finalization
  SELECT * INTO v_attempt FROM paystack_billing_attempts
    WHERE id = p_attempt_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'reason', 'attempt_not_found');
  END IF;

  IF v_attempt.status = 'finalized' THEN
    -- Replay identity validation: incoming evidence must match ALL persisted identity
    IF p_provider_amount_minor != v_attempt.intended_amount_minor THEN
      RETURN jsonb_build_object('success', false, 'reason', 'replay_amount_mismatch');
    END IF;
    IF LOWER(p_provider_currency) != LOWER(v_attempt.intended_currency) THEN
      RETURN jsonb_build_object('success', false, 'reason', 'replay_currency_mismatch');
    END IF;
    -- Validate transaction_id if both present
    IF p_provider_transaction_id IS NOT NULL AND v_attempt.provider_transaction_id IS NOT NULL
       AND p_provider_transaction_id IS DISTINCT FROM v_attempt.provider_transaction_id THEN
      RETURN jsonb_build_object('success', false, 'reason', 'replay_transaction_id_mismatch');
    END IF;
    -- Validate invoice_code if both present
    IF p_provider_invoice_code IS NOT NULL AND v_attempt.provider_invoice_code IS NOT NULL
       AND p_provider_invoice_code IS DISTINCT FROM v_attempt.provider_invoice_code THEN
      RETURN jsonb_build_object('success', false, 'reason', 'replay_invoice_mismatch');
    END IF;
    -- Return canonical IDs for safe Stage 3 recovery
    RETURN jsonb_build_object('success', true, 'already_finalized', true,
      'payment_id', v_attempt.canonical_payment_id,
      'booking_id', v_attempt.canonical_booking_id,
      'booking_ref', v_attempt.canonical_booking_ref,
      'amount', v_attempt.intended_amount_minor / 100.0,
      'currency', v_attempt.intended_currency,
      'subscription_id', v_attempt.customer_subscription_id);
  END IF;

  -- Guard: only dispatched/charged/failed may finalize. 'reserved' cannot.
  IF v_attempt.status NOT IN ('dispatched', 'charged', 'failed') THEN
    RETURN jsonb_build_object('success', false, 'reason', 'wrong_status', 'status', v_attempt.status);
  END IF;

  -- Exact amount/currency validation — no tolerance
  IF p_provider_amount_minor != v_attempt.intended_amount_minor THEN
    RETURN jsonb_build_object('success', false, 'reason', 'amount_mismatch',
      'expected', v_attempt.intended_amount_minor, 'received', p_provider_amount_minor);
  END IF;

  IF LOWER(p_provider_currency) != LOWER(v_attempt.intended_currency) THEN
    RETURN jsonb_build_object('success', false, 'reason', 'currency_mismatch',
      'expected', v_attempt.intended_currency, 'received', p_provider_currency);
  END IF;

  -- Load subscription
  SELECT * INTO v_sub FROM customer_subscriptions
    WHERE id = v_attempt.customer_subscription_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'reason', 'subscription_not_found');
  END IF;

  v_time := TO_CHAR(v_now, 'HH24:MI');

  -- Create booking (recurring accounting record)
  INSERT INTO bookings (
    business_id, user_id, service_id, date, time, party_size,
    flow_type, channel, payment_source, deposit_amount, deposit_status, status,
    total_amount, quantity, guest_name, guest_phone, confirmed_at, notes
  ) VALUES (
    v_sub.business_id, v_sub.user_id, v_sub.service_id, v_today, v_time, 1,
    'payment', 'recurring', 'subscription',
    p_provider_amount_minor / 100.0, 'paid', 'confirmed',
    p_provider_amount_minor / 100.0, 1,
    COALESCE(v_sub.customer_name, ''), COALESCE(v_sub.customer_phone, ''),
    v_now, 'Recurring ' || v_sub.frequency || ' charge'
  ) RETURNING id, reference_code INTO v_booking_id, v_booking_ref;

  -- Create payment
  INSERT INTO payments (
    business_id, user_id, booking_id, amount, currency, gateway,
    gateway_reference, status, gateway_status, payment_method,
    card_last_four, card_brand, paid_at, metadata
  ) VALUES (
    v_sub.business_id, v_sub.user_id, v_booking_id,
    p_provider_amount_minor / 100.0, v_attempt.intended_currency, 'paystack',
    v_attempt.provider_reference, 'success', 'success', 'card',
    v_sub.card_last_four, v_sub.card_brand, v_now,
    jsonb_build_object('recurring', true, 'subscription_id', v_sub.id,
      'billing_attempt_id', v_attempt.id, 'cycle_key', v_attempt.cycle_key)
  ) RETURNING id INTO v_payment_id;

  -- Atomic customer spend (#176 + #164 pattern)
  v_spend_result := apply_payment_spend_once(v_payment_id);
  IF v_spend_result IS NULL OR (v_spend_result->>'applied')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'Paystack recurring spend failed for payment %: %',
      v_payment_id, COALESCE(v_spend_result::text, 'null_result');
  END IF;

  -- Subscription charge record
  INSERT INTO subscription_charges (
    subscription_id, business_id, user_id, amount, currency,
    status, gateway, gateway_reference, payment_id, booking_id, charged_at
  ) VALUES (
    v_sub.id, v_sub.business_id, v_sub.user_id,
    p_provider_amount_minor / 100.0, v_attempt.intended_currency,
    'success', 'paystack', v_attempt.provider_reference, v_payment_id, v_booking_id, v_now
  );

  -- Platform fee
  SELECT subscription_tier, trial_ends_at, payout_mode INTO v_business
    FROM businesses WHERE id = v_sub.business_id;

  IF v_business IS NOT NULL AND COALESCE(v_business.payout_mode, 'platform') != 'direct_split' THEN
    v_is_in_trial := v_business.trial_ends_at > v_now;
    v_tier := COALESCE(v_business.subscription_tier, 'free');
    IF v_is_in_trial THEN v_fee_pct := 0; v_fee_flat := 0; v_fee_total := 0;
    ELSE
      SELECT COALESCE((value::jsonb -> v_tier ->> 'feePercentage')::numeric,
               CASE v_tier WHEN 'free' THEN 2.5 WHEN 'growth' THEN 1.5 ELSE 1.5 END),
             COALESCE((value::jsonb -> v_tier ->> 'feeFlat')::numeric, 0)
      INTO v_fee_pct, v_fee_flat FROM platform_settings WHERE key = 'pricing_tiers' LIMIT 1;
      IF v_fee_pct IS NULL THEN
        v_fee_pct := CASE v_tier WHEN 'free' THEN 2.5 WHEN 'growth' THEN 1.5 ELSE 1.5 END;
        v_fee_flat := 0;
      END IF;
      IF v_fee_flat > 0 AND (p_provider_amount_minor / 100.0) > 0
         AND v_fee_flat / (p_provider_amount_minor / 100.0) > 0.10 THEN
        v_fee_flat := 0;
      END IF;
      v_fee_total := ROUND((p_provider_amount_minor / 100.0) * v_fee_pct / 100, 2) + v_fee_flat;
    END IF;
    INSERT INTO platform_fees (payment_id, business_id, booking_id, transaction_amount, fee_percentage, fee_flat, fee_total, tier)
    VALUES (v_payment_id, v_sub.business_id, v_booking_id, p_provider_amount_minor / 100.0, v_fee_pct, v_fee_flat, v_fee_total, v_tier);
  END IF;

  -- Update subscription totals
  IF v_sub.frequency = 'weekly' THEN v_next_charge := v_now + INTERVAL '7 days';
  ELSIF v_sub.frequency = 'yearly' THEN v_next_charge := v_now + INTERVAL '1 year';
  ELSE v_next_charge := v_now + INTERVAL '1 month';
  END IF;

  UPDATE customer_subscriptions SET
    charge_count = COALESCE(charge_count, 0) + 1,
    total_charged = COALESCE(total_charged, 0) + (p_provider_amount_minor / 100.0),
    last_charged_at = v_now, next_charge_at = v_next_charge, failure_count = 0
  WHERE id = v_sub.id;

  -- Mark attempt finalized with canonical IDs for replay recovery
  UPDATE paystack_billing_attempts SET
    status = 'finalized', finalized_at = v_now,
    provider_transaction_id = p_provider_transaction_id,
    provider_invoice_code = p_provider_invoice_code,
    canonical_payment_id = v_payment_id,
    canonical_booking_id = v_booking_id,
    canonical_booking_ref = v_booking_ref
  WHERE id = p_attempt_id;

  RETURN jsonb_build_object('success', true, 'already_finalized', false,
    'subscription_id', v_sub.id, 'booking_id', v_booking_id,
    'booking_ref', v_booking_ref, 'payment_id', v_payment_id,
    'amount', p_provider_amount_minor / 100.0,
    'currency', v_attempt.intended_currency,
    'business_id', v_sub.business_id,
    'customer_phone', v_sub.customer_phone,
    'customer_name', v_sub.customer_name);
END;
$$;
