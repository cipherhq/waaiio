-- Exact public source definition: 452_cancellation_intent_charge_gate.sql
-- Finalizer: preserve M337 accounting/body; change only locking order.
-- Requires runtime pg_get_functiondef parity verification before application.
CREATE OR REPLACE FUNCTION finalize_paystack_recurring_charge(
  p_attempt_id UUID,
  p_provider_amount_minor INT,
  p_provider_currency TEXT DEFAULT 'NGN',
  p_provider_transaction_id TEXT DEFAULT NULL,
  p_provider_invoice_code TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE
  v_attempt RECORD;
  v_parent UUID;
  v_locked_parent UUID;
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
  -- Acquire the subscription lock first, matching claim and dispatch.
  -- The initial parent lookup is only an identifier lookup, not authorization.
  SELECT customer_subscription_id INTO v_parent
    FROM public.paystack_billing_attempts WHERE id = p_attempt_id;
  IF v_parent IS NULL THEN
    RETURN jsonb_build_object('success', false, 'reason', 'attempt_not_found');
  END IF;

  SELECT id INTO v_locked_parent
    FROM public.customer_subscriptions WHERE id = v_parent FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'reason', 'subscription_not_found');
  END IF;

  SELECT * INTO v_attempt FROM public.paystack_billing_attempts
    WHERE id = p_attempt_id FOR UPDATE;
  IF FOUND AND v_attempt.customer_subscription_id IS DISTINCT FROM v_parent THEN
    RETURN jsonb_build_object('success', false, 'reason', 'attempt_changed');
  END IF;

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
