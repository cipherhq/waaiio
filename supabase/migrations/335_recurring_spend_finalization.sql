-- 335: Atomic customer spend for Flutterwave recurring renewals (#164)
--
-- Replaces finalize_token_recurring_charge to invoke the existing
-- apply_payment_spend_once(payment_id) authority INSIDE the same
-- transaction as recurring finalization.
--
-- If spend application fails (null, malformed, or applied != true),
-- the entire transaction rolls back — no partial finalization state.
--
-- All existing migration 306 safety behavior is preserved:
-- - claim-row FOR UPDATE serialization
-- - gateway/event/subscription ownership checks
-- - authoritative attempt-reference checks
-- - amount/currency validation
-- - completed/already-finalized idempotency
-- - booking/payment/subscription-charge/platform-fee/subscription advancement

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
    INSERT INTO platform_fees (business_id, booking_id, transaction_amount, fee_percentage, fee_flat, fee_total, tier)
    VALUES (v_sub.business_id, v_booking_id, p_verified_amount, v_fee_pct, v_fee_flat, v_fee_total, v_tier);
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
