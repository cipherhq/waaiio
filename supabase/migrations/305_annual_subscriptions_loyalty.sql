-- 305: Annual subscription support + loyalty tier wiring
--
-- 1. Extend customer_subscriptions.frequency to include 'yearly'
-- 2. Extend services.recurring_interval to include 'yearly'
-- 3. No changes to invoices (already supports 'yearly')

-- ═══════════════════════════════════════════════════════
-- 1. Extend customer_subscriptions frequency constraint
-- ═══════════════════════════════════════════════════════

-- Drop the existing CHECK constraint and re-add with 'yearly'
ALTER TABLE customer_subscriptions DROP CONSTRAINT IF EXISTS customer_subscriptions_frequency_check;
ALTER TABLE customer_subscriptions ADD CONSTRAINT customer_subscriptions_frequency_check
  CHECK (frequency IN ('weekly', 'monthly', 'yearly'));

-- ═══════════════════════════════════════════════════════
-- 2. Extend services recurring_interval constraint
-- ═══════════════════════════════════════════════════════

-- Drop and re-add the CHECK constraint
ALTER TABLE services DROP CONSTRAINT IF EXISTS services_recurring_interval_check;
ALTER TABLE services ADD CONSTRAINT services_recurring_interval_check
  CHECK (recurring_interval IS NULL OR recurring_interval IN ('weekly', 'monthly', 'yearly'));

-- ═══════════════════════════════════════════════════════
-- 3. Fix process_recurring_charge yearly next_charge_at
-- The RPC previously only handled weekly/monthly. Yearly subscriptions
-- would get next_charge_at set to +1 month instead of +1 year.
-- ═══════════════════════════════════════════════════════

-- Replace the function with yearly support in the date-math section
CREATE OR REPLACE FUNCTION process_recurring_charge(
  p_event_id TEXT, p_event_type TEXT, p_gateway_ref TEXT,
  p_auth_code TEXT, p_cust_code TEXT, p_amount_kobo BIGINT,
  p_currency TEXT DEFAULT 'NGN', p_channel TEXT DEFAULT 'card',
  p_card_last_four TEXT DEFAULT NULL, p_card_brand TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_sub RECORD; v_charge_amount NUMERIC(12,2); v_now TIMESTAMPTZ := NOW();
  v_today DATE := CURRENT_DATE; v_time TEXT; v_booking_id UUID; v_booking_ref TEXT;
  v_payment_id UUID; v_next_charge TIMESTAMPTZ; v_business RECORD;
  v_fee_pct NUMERIC(5,2); v_fee_flat NUMERIC(12,2); v_fee_total NUMERIC(12,2);
  v_is_in_trial BOOLEAN; v_tier TEXT; v_claimed_status TEXT; v_claimed_attempts INT;
BEGIN
  INSERT INTO processed_webhook_events (event_id, gateway, event_type, status, attempts, first_received_at, last_attempted_at)
  VALUES (p_event_id, 'paystack', p_event_type, 'processing', 1, v_now, v_now)
  ON CONFLICT (event_id) DO UPDATE
    SET attempts = processed_webhook_events.attempts + 1, last_attempted_at = v_now
  RETURNING status, attempts INTO v_claimed_status, v_claimed_attempts;
  IF v_claimed_status = 'completed' THEN RETURN jsonb_build_object('skipped', true, 'reason', 'already_completed'); END IF;
  IF v_claimed_status = 'processing' AND v_claimed_attempts > 2 THEN RETURN jsonb_build_object('skipped', true, 'reason', 'already_processing'); END IF;

  IF EXISTS (SELECT 1 FROM payments WHERE gateway_reference = p_gateway_ref AND status = 'success') THEN
    UPDATE processed_webhook_events SET status = 'completed', completed_at = v_now WHERE event_id = p_event_id;
    RETURN jsonb_build_object('skipped', true, 'reason', 'payment_exists');
  END IF;

  IF p_auth_code IS NOT NULL AND p_auth_code != '' THEN
    SELECT * INTO v_sub FROM customer_subscriptions WHERE authorization_code = p_auth_code AND status = 'active' LIMIT 1;
  ELSIF p_cust_code IS NOT NULL AND p_cust_code != '' THEN
    SELECT * INTO v_sub FROM customer_subscriptions WHERE gateway_customer_code = p_cust_code AND status = 'active' LIMIT 1;
  END IF;
  IF v_sub IS NULL THEN
    UPDATE processed_webhook_events SET status = 'failed', last_error = 'No matching active subscription', last_attempted_at = v_now WHERE event_id = p_event_id;
    RETURN jsonb_build_object('skipped', true, 'reason', 'no_subscription');
  END IF;

  v_charge_amount := p_amount_kobo / 100.0;
  v_time := TO_CHAR(v_now, 'HH24:MI');

  INSERT INTO bookings (business_id, user_id, service_id, date, time, party_size, flow_type, channel, payment_source, deposit_amount, deposit_status, status, total_amount, quantity, guest_name, guest_phone, confirmed_at, notes)
  VALUES (v_sub.business_id, v_sub.user_id, v_sub.service_id, v_today, v_time, 1, 'payment', 'recurring', 'subscription', v_charge_amount, 'paid', 'confirmed', v_charge_amount, 1, COALESCE(v_sub.customer_name, ''), COALESCE(v_sub.customer_phone, ''), v_now, 'Recurring ' || v_sub.frequency || ' charge')
  RETURNING id, reference_code INTO v_booking_id, v_booking_ref;

  INSERT INTO payments (business_id, user_id, booking_id, amount, currency, gateway, gateway_reference, status, gateway_status, payment_method, card_last_four, card_brand, paid_at, metadata)
  VALUES (v_sub.business_id, v_sub.user_id, v_booking_id, v_charge_amount, v_sub.currency, 'paystack', p_gateway_ref, 'success', 'success', p_channel, COALESCE(p_card_last_four, v_sub.card_last_four), COALESCE(p_card_brand, v_sub.card_brand), v_now, jsonb_build_object('recurring', true, 'subscription_id', v_sub.id))
  RETURNING id INTO v_payment_id;

  INSERT INTO subscription_charges (subscription_id, business_id, user_id, amount, currency, status, gateway, gateway_reference, payment_id, booking_id, charged_at)
  VALUES (v_sub.id, v_sub.business_id, v_sub.user_id, v_charge_amount, v_sub.currency, 'success', 'paystack', p_gateway_ref, v_payment_id, v_booking_id, v_now);

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
      IF v_fee_flat > 0 AND v_charge_amount > 0 AND v_fee_flat / v_charge_amount > 0.10 THEN v_fee_flat := 0; END IF;
      v_fee_total := ROUND(v_charge_amount * v_fee_pct / 100, 2) + v_fee_flat;
    END IF;
    INSERT INTO platform_fees (business_id, booking_id, transaction_amount, fee_percentage, fee_flat, fee_total, tier)
    VALUES (v_sub.business_id, v_booking_id, v_charge_amount, v_fee_pct, v_fee_flat, v_fee_total, v_tier);
  END IF;

  -- ── YEARLY FIX: next_charge_at date math ──
  IF v_sub.frequency = 'weekly' THEN
    v_next_charge := v_now + INTERVAL '7 days';
  ELSIF v_sub.frequency = 'yearly' THEN
    v_next_charge := v_now + INTERVAL '1 year';
  ELSE
    v_next_charge := v_now + INTERVAL '1 month';
  END IF;

  UPDATE customer_subscriptions SET
    charge_count = COALESCE(charge_count, 0) + 1,
    total_charged = COALESCE(total_charged, 0) + v_charge_amount,
    last_charged_at = v_now, next_charge_at = v_next_charge, failure_count = 0
  WHERE id = v_sub.id;

  UPDATE processed_webhook_events SET status = 'completed', completed_at = v_now WHERE event_id = p_event_id;

  RETURN jsonb_build_object('success', true, 'subscription_id', v_sub.id, 'booking_id', v_booking_id,
    'booking_ref', v_booking_ref, 'payment_id', v_payment_id, 'amount', v_charge_amount,
    'currency', v_sub.currency, 'business_id', v_sub.business_id,
    'customer_phone', v_sub.customer_phone, 'customer_name', v_sub.customer_name);
EXCEPTION WHEN OTHERS THEN RAISE;
END;
$$;

DO $$ BEGIN
  REVOKE ALL ON FUNCTION process_recurring_charge FROM PUBLIC;
  EXECUTE 'GRANT EXECUTE ON FUNCTION process_recurring_charge TO service_role';
EXCEPTION WHEN undefined_object THEN NULL;
END $$;
