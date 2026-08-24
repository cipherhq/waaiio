-- Migration 336: Paystack recurring billing-attempt authority (#176)
--
-- Establishes a durable billing-attempt/claim model for Paystack recurring
-- charges. Prevents double-charges after process crashes, enforces exact
-- financial identity, and includes apply_payment_spend_once atomically.
--
-- Replaces the unsafe process_recurring_charge path with a safe
-- claim → dispatch → finalize lifecycle.

-- ═══════════════════════════════════════════════════════════
-- 1. Billing attempt table
-- ═══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS paystack_billing_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_subscription_id UUID NOT NULL,
  cycle_key TEXT NOT NULL,
  scheduled_at TIMESTAMPTZ NOT NULL,
  attempt_number INT NOT NULL DEFAULT 1,
  provider_reference TEXT NOT NULL,
  intended_amount_minor INT NOT NULL,
  intended_currency TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'reserved'
    CHECK (status IN ('reserved', 'dispatched', 'charged', 'finalized', 'failed', 'disputed')),
  claim_token UUID,
  lease_expires_at TIMESTAMPTZ,
  verify_attempts INT NOT NULL DEFAULT 0,
  provider_invoice_code TEXT,
  provider_transaction_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  dispatched_at TIMESTAMPTZ,
  charged_at TIMESTAMPTZ,
  finalized_at TIMESTAMPTZ,
  failure_reason TEXT
);

-- Unique provider reference (Paystack requires unique refs)
CREATE UNIQUE INDEX IF NOT EXISTS idx_pba_provider_ref
  ON paystack_billing_attempts (provider_reference);

-- At most ONE unresolved attempt per subscription cycle
CREATE UNIQUE INDEX IF NOT EXISTS idx_pba_one_unresolved
  ON paystack_billing_attempts (customer_subscription_id, cycle_key)
  WHERE status IN ('reserved', 'dispatched', 'charged');

-- At most ONE finalized result per subscription cycle
CREATE UNIQUE INDEX IF NOT EXISTS idx_pba_one_finalized
  ON paystack_billing_attempts (customer_subscription_id, cycle_key)
  WHERE status = 'finalized';

ALTER TABLE paystack_billing_attempts ENABLE ROW LEVEL SECURITY;

-- ═══════════════════════════════════════════════════════════
-- 2. Claim RPC — atomic billing-cycle claim with lease
-- ═══════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION claim_paystack_billing_cycle(
  p_subscription_id UUID
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_sub RECORD;
  v_existing RECORD;
  v_cycle_key TEXT;
  v_attempt_ref TEXT;
  v_token UUID;
  v_attempt_num INT;
BEGIN
  -- Lock subscription to serialize concurrent workers
  SELECT * INTO v_sub FROM customer_subscriptions
    WHERE id = p_subscription_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'not_found');
  END IF;

  IF COALESCE(v_sub.gateway, '') != 'paystack' THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'wrong_gateway');
  END IF;

  IF v_sub.status NOT IN ('active', 'past_due') THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'not_active');
  END IF;

  IF v_sub.next_charge_at > NOW() THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'not_due');
  END IF;

  -- Derive immutable cycle key from next_charge_at
  v_cycle_key := 'ps-cron-' || p_subscription_id::text || '-' || EXTRACT(EPOCH FROM v_sub.next_charge_at)::bigint::text;

  -- Check existing attempts for this cycle
  SELECT * INTO v_existing FROM paystack_billing_attempts
    WHERE customer_subscription_id = p_subscription_id
    AND cycle_key = v_cycle_key
    AND status IN ('reserved', 'dispatched', 'charged', 'finalized')
    ORDER BY attempt_number DESC
    LIMIT 1;

  IF FOUND THEN
    IF v_existing.status = 'finalized' THEN
      RETURN jsonb_build_object('claimed', false, 'already_finalized', true,
        'payment_id', v_existing.provider_reference);
    END IF;

    IF v_existing.status IN ('dispatched', 'charged') THEN
      -- Must reconcile, not create new attempt
      RETURN jsonb_build_object('claimed', false, 'must_reconcile', true,
        'attempt_id', v_existing.id,
        'provider_reference', v_existing.provider_reference,
        'status', v_existing.status,
        'intended_amount_minor', v_existing.intended_amount_minor);
    END IF;

    IF v_existing.status = 'reserved' THEN
      IF v_existing.lease_expires_at > NOW() THEN
        -- Active lease — another worker owns this
        RETURN jsonb_build_object('claimed', false, 'active_lease', true);
      END IF;
      -- Expired lease on reserved (never dispatched) — safe to reclaim
      v_token := gen_random_uuid();
      UPDATE paystack_billing_attempts
        SET claim_token = v_token, lease_expires_at = NOW() + INTERVAL '5 minutes'
        WHERE id = v_existing.id AND status = 'reserved';
      RETURN jsonb_build_object('claimed', true, 'reclaimed', true,
        'attempt_id', v_existing.id,
        'provider_reference', v_existing.provider_reference,
        'claim_token', v_token,
        'intended_amount_minor', v_existing.intended_amount_minor,
        'intended_currency', v_existing.intended_currency);
    END IF;
  END IF;

  -- No existing unresolved attempt — determine attempt number
  SELECT COALESCE(MAX(attempt_number), 0) INTO v_attempt_num
    FROM paystack_billing_attempts
    WHERE customer_subscription_id = p_subscription_id AND cycle_key = v_cycle_key;

  v_attempt_num := v_attempt_num + 1;
  v_token := gen_random_uuid();
  v_attempt_ref := 'ps-retry-' || p_subscription_id::text || '-' || v_attempt_num || '-' || EXTRACT(EPOCH FROM NOW())::bigint::text;

  INSERT INTO paystack_billing_attempts (
    customer_subscription_id, cycle_key, scheduled_at, attempt_number,
    provider_reference, intended_amount_minor, intended_currency,
    status, claim_token, lease_expires_at
  ) VALUES (
    p_subscription_id, v_cycle_key, v_sub.next_charge_at, v_attempt_num,
    v_attempt_ref, ROUND(v_sub.amount * 100)::int, COALESCE(v_sub.currency, 'NGN'),
    'reserved', v_token, NOW() + INTERVAL '5 minutes'
  );

  RETURN jsonb_build_object('claimed', true,
    'attempt_id', (SELECT id FROM paystack_billing_attempts WHERE provider_reference = v_attempt_ref),
    'provider_reference', v_attempt_ref,
    'claim_token', v_token,
    'intended_amount_minor', ROUND(v_sub.amount * 100)::int,
    'intended_currency', COALESCE(v_sub.currency, 'NGN'));
END;
$$;

-- ═══════════════════════════════════════════════════════════
-- 3. Dispatch transition — committed before provider call
-- ═══════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION dispatch_paystack_attempt(
  p_attempt_id UUID,
  p_claim_token UUID
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_attempt RECORD;
BEGIN
  SELECT * INTO v_attempt FROM paystack_billing_attempts
    WHERE id = p_attempt_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('dispatched', false, 'reason', 'not_found');
  END IF;

  IF v_attempt.status != 'reserved' THEN
    RETURN jsonb_build_object('dispatched', false, 'reason', 'wrong_status', 'status', v_attempt.status);
  END IF;

  IF v_attempt.claim_token IS DISTINCT FROM p_claim_token THEN
    RETURN jsonb_build_object('dispatched', false, 'reason', 'wrong_token');
  END IF;

  UPDATE paystack_billing_attempts
    SET status = 'dispatched', dispatched_at = NOW()
    WHERE id = p_attempt_id;

  RETURN jsonb_build_object('dispatched', true);
END;
$$;

-- ═══════════════════════════════════════════════════════════
-- 4. Paystack recurring finalizer — atomic accounting + spend
-- ═══════════════════════════════════════════════════════════

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
    RETURN jsonb_build_object('success', true, 'already_finalized', true);
  END IF;

  IF v_attempt.status NOT IN ('dispatched', 'charged', 'failed') THEN
    -- 'failed' allowed for late-success recovery
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
    INSERT INTO platform_fees (business_id, booking_id, transaction_amount, fee_percentage, fee_flat, fee_total, tier)
    VALUES (v_sub.business_id, v_booking_id, p_provider_amount_minor / 100.0, v_fee_pct, v_fee_flat, v_fee_total, v_tier);
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

  -- Mark attempt finalized
  UPDATE paystack_billing_attempts SET
    status = 'finalized', finalized_at = v_now,
    provider_transaction_id = p_provider_transaction_id,
    provider_invoice_code = p_provider_invoice_code
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

-- ═══════════════════════════════════════════════════════════
-- 5. Remove old bypass path
-- ═══════════════════════════════════════════════════════════

DROP FUNCTION IF EXISTS process_recurring_charge(TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT, TEXT);

-- ═══════════════════════════════════════════════════════════
-- 6. Privilege hardening
-- ═══════════════════════════════════════════════════════════

DO $$
BEGIN
  REVOKE ALL ON FUNCTION claim_paystack_billing_cycle(UUID) FROM PUBLIC;
  REVOKE ALL ON FUNCTION dispatch_paystack_attempt(UUID, UUID) FROM PUBLIC;
  REVOKE ALL ON FUNCTION finalize_paystack_recurring_charge(UUID, INT, TEXT, TEXT, TEXT) FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION claim_paystack_billing_cycle(UUID) FROM anon;
    REVOKE ALL ON FUNCTION dispatch_paystack_attempt(UUID, UUID) FROM anon;
    REVOKE ALL ON FUNCTION finalize_paystack_recurring_charge(UUID, INT, TEXT, TEXT, TEXT) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION claim_paystack_billing_cycle(UUID) FROM authenticated;
    REVOKE ALL ON FUNCTION dispatch_paystack_attempt(UUID, UUID) FROM authenticated;
    REVOKE ALL ON FUNCTION finalize_paystack_recurring_charge(UUID, INT, TEXT, TEXT, TEXT) FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION claim_paystack_billing_cycle(UUID) TO service_role;
    GRANT EXECUTE ON FUNCTION dispatch_paystack_attempt(UUID, UUID) TO service_role;
    GRANT EXECUTE ON FUNCTION finalize_paystack_recurring_charge(UUID, INT, TEXT, TEXT, TEXT) TO service_role;
  END IF;
END $$;
