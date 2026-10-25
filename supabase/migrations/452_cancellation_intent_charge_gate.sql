-- M452 / PR #605 — PROPOSED: NOT APPROVED FOR DEPLOYMENT
-- Based on exact M337 Paystack and M305 Flutterwave claim contracts.
-- Assumes no later deployed function overrides; verify pg_get_functiondef in
-- staging and production before migration approval.
-- WARNING: dispatch returns before the external network charge. A cancellation
-- arriving after dispatch commits may still race with the provider call.
-- This proposal DOES NOT establish the end-to-end no-charge-after-cancel guarantee.
-- Issue #664 Decision 3 remains HOLD. Number 452 is provisional pending registry/CI approval.
ALTER TABLE public.customer_subscriptions
 ADD COLUMN IF NOT EXISTS cancellation_requested_at TIMESTAMPTZ;

CREATE OR REPLACE FUNCTION claim_paystack_billing_cycle(
  p_subscription_id UUID
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
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

  -- #597: No new billing claims after durable cancellation intent.
  IF v_sub.cancellation_requested_at IS NOT NULL THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'cancellation_pending');
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

CREATE OR REPLACE FUNCTION public.dispatch_paystack_attempt(
  p_attempt_id UUID, p_claim_token UUID
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE
  v_parent UUID;
  v_sub RECORD;
  v_attempt RECORD;
BEGIN
  -- Resolve parent identifier without taking an attempt lock. The identifier
  -- is NOT authorization: it is revalidated after locking both rows.
  SELECT customer_subscription_id INTO v_parent
    FROM public.paystack_billing_attempts WHERE id = p_attempt_id;
  IF v_parent IS NULL THEN
    RETURN jsonb_build_object('dispatched', false, 'reason', 'not_found');
  END IF;

  -- Match claim lock order: subscription BEFORE attempt. This serializes
  -- against the cancellation intent UPDATE on the subscription row.
  SELECT id, cancellation_requested_at, status INTO v_sub
    FROM public.customer_subscriptions WHERE id = v_parent FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('dispatched', false, 'reason', 'subscription_not_found');
  END IF;

  SELECT * INTO v_attempt FROM public.paystack_billing_attempts
    WHERE id = p_attempt_id FOR UPDATE;
  IF NOT FOUND OR v_attempt.customer_subscription_id IS DISTINCT FROM v_parent THEN
    RETURN jsonb_build_object('dispatched', false, 'reason', 'attempt_changed');
  END IF;
  IF v_attempt.status != 'reserved' THEN
    RETURN jsonb_build_object('dispatched', false, 'reason', 'wrong_status', 'status', v_attempt.status);
  END IF;
  IF v_attempt.claim_token IS DISTINCT FROM p_claim_token THEN
    RETURN jsonb_build_object('dispatched', false, 'reason', 'wrong_token');
  END IF;
  IF v_sub.cancellation_requested_at IS NOT NULL OR v_sub.status NOT IN ('active','past_due') THEN
    -- Preserve M337 status vocabulary. A reserved attempt can be left for
    -- operational recovery; the charge is NOT dispatched or authorized.
    RETURN jsonb_build_object('dispatched', false, 'reason', 'cancellation_or_inactive');
  END IF;

  UPDATE public.paystack_billing_attempts
    SET status = 'dispatched', dispatched_at = NOW()
    WHERE id = p_attempt_id AND status = 'reserved';
  RETURN jsonb_build_object('dispatched', true);
END;
$$;

CREATE OR REPLACE FUNCTION claim_recurring_billing_cycle(
  p_subscription_id UUID
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE
  v_sub RECORD;
  v_existing RECORD;
  v_stable_ref TEXT;
  v_attempt_ref TEXT;
  v_attempt_num INT;
BEGIN
  -- Lock the subscription row to serialize concurrent workers
  SELECT * INTO v_sub FROM customer_subscriptions
    WHERE id = p_subscription_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'not_found');
  END IF;

  -- Only Flutterwave subscriptions use token billing claims
  IF COALESCE(v_sub.gateway, '') != 'flutterwave' THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'wrong_gateway', 'gateway', v_sub.gateway);
  END IF;

  IF v_sub.status NOT IN ('active', 'past_due') THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'not_active', 'status', v_sub.status);
  END IF;

  -- #597: No new billing claims after durable cancellation intent.
  IF v_sub.cancellation_requested_at IS NOT NULL THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'cancellation_pending');
  END IF;

  IF v_sub.next_charge_at > NOW() THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'not_due', 'next_charge_at', v_sub.next_charge_at);
  END IF;

  -- Derive exact stable reference from authoritative state (database-controlled)
  v_stable_ref := 'flw-' || p_subscription_id::text || '-' || TO_CHAR(v_sub.next_charge_at, 'YYYY-MM-DD');

  -- Check existing claim state for this billing cycle
  SELECT status, last_attempted_at, attempts, last_error INTO v_existing
  FROM processed_webhook_events WHERE event_id = v_stable_ref;

  IF FOUND THEN
    IF v_existing.status = 'completed' THEN
      RETURN jsonb_build_object('claimed', false, 'reason', 'already_completed');
    END IF;

    -- provider_success: charge succeeded, needs finalize only — reuse SAME attempt ref
    IF v_existing.status = 'provider_success' THEN
      RETURN jsonb_build_object('claimed', true, 'subscription_id', p_subscription_id,
        'stable_ref', v_stable_ref, 'attempt_ref', v_existing.last_error,
        'reconcile_required', false, 'provider_verified', true);
    END IF;

    -- provider_failed: create NEW attempt ref — charge immediately, do NOT reconcile
    IF v_existing.status = 'provider_failed' THEN
      v_attempt_num := COALESCE(v_existing.attempts, 0) + 1;
      v_attempt_ref := v_stable_ref || '-a' || v_attempt_num;
      UPDATE processed_webhook_events
      SET status = 'claimed', attempts = v_attempt_num, last_attempted_at = NOW(),
          last_error = v_attempt_ref
      WHERE event_id = v_stable_ref;
      RETURN jsonb_build_object('claimed', true, 'subscription_id', p_subscription_id,
        'stable_ref', v_stable_ref, 'attempt_ref', v_attempt_ref,
        'reconcile_required', false, 'provider_verified', false);
    END IF;

    -- Active claim not yet stale — skip
    IF v_existing.status = 'claimed' AND v_existing.last_attempted_at > NOW() - INTERVAL '10 minutes' THEN
      RETURN jsonb_build_object('claimed', false, 'reason', 'already_claimed');
    END IF;

    -- Stale claim (>10 min): reuse SAME attempt ref — MUST reconcile first
    IF v_existing.status = 'claimed' THEN
      UPDATE processed_webhook_events
      SET last_attempted_at = NOW()
      WHERE event_id = v_stable_ref;
      RETURN jsonb_build_object('claimed', true, 'subscription_id', p_subscription_id,
        'stable_ref', v_stable_ref, 'attempt_ref', v_existing.last_error,
        'reconcile_required', true, 'provider_verified', false);
    END IF;

    RETURN jsonb_build_object('claimed', false, 'reason', 'unknown_state', 'status', v_existing.status);
  END IF;

  -- Fresh claim — generate first provider attempt ref
  v_attempt_ref := v_stable_ref || '-a1';
  INSERT INTO processed_webhook_events (event_id, gateway, event_type, status, attempts, first_received_at, last_attempted_at, last_error)
  VALUES (v_stable_ref, 'flutterwave', 'token_renewal', 'claimed', 1, NOW(), NOW(), v_attempt_ref);

  RETURN jsonb_build_object('claimed', true, 'subscription_id', p_subscription_id,
    'stable_ref', v_stable_ref, 'attempt_ref', v_attempt_ref,
    'reconcile_required', false, 'provider_verified', false);
END;
$$;

REVOKE ALL ON FUNCTION public.claim_paystack_billing_cycle(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.dispatch_paystack_attempt(UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_recurring_billing_cycle(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_paystack_billing_cycle(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.dispatch_paystack_attempt(UUID, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_recurring_billing_cycle(UUID) TO service_role;

DO $$
DECLARE v_name TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='customer_subscriptions' AND column_name='cancellation_requested_at') THEN
    RAISE EXCEPTION 'Cancellation intent column missing';
  END IF;
  FOREACH v_name IN ARRAY ARRAY['claim_paystack_billing_cycle','dispatch_paystack_attempt','claim_recurring_billing_cycle'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname=v_name AND p.prosecdef
      AND p.proconfig @> ARRAY['search_path=public, extensions']::text[]) THEN
      RAISE EXCEPTION 'Security definer verification failed: %', v_name;
    END IF;
  END LOOP;
END;
$$;


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


-- Least-privilege finalizer permissions; service role only.
REVOKE ALL ON FUNCTION public.finalize_paystack_recurring_charge(UUID, INT, TEXT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_paystack_recurring_charge(UUID, INT, TEXT, TEXT, TEXT)
  TO service_role;

-- Deployment must validate proconfig/prosecdef for every updated function,
-- compare pg_get_functiondef against latest live staging/production definitions,
-- and run concurrent finalization test BEFORE authorization.


-- Exact final-state verification for the finalizer updated last.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'finalize_paystack_recurring_charge'
      AND p.oid = to_regprocedure('public.finalize_paystack_recurring_charge(uuid,integer,text,text,text)')
      AND p.prosecdef
      AND p.proconfig @> ARRAY['search_path=public, extensions']::text[]
  ) THEN
    RAISE EXCEPTION 'M452: Paystack finalizer security attributes/signature verification failed';
  END IF;
END;
$$;

-- #605: Read-only work discovery for previously initiated Flutterwave claims.
-- Normal claim_recurring_billing_cycle deliberately denies cancelled subscriptions;
-- this separate selector cannot create attempts or authorize provider charges.
CREATE OR REPLACE FUNCTION public.list_cancelled_flutterwave_claims(
  p_limit INTEGER DEFAULT 6
) RETURNS TABLE (
  stable_ref TEXT,
  attempt_ref TEXT,
  claim_status TEXT,
  subscription_id UUID,
  amount NUMERIC,
  currency TEXT
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, extensions
AS $function$
  SELECT e.event_id AS stable_ref,
         e.last_error AS attempt_ref,
         e.status AS claim_status,
         s.id AS subscription_id,
         s.amount,
         s.currency::text AS currency
    FROM public.processed_webhook_events e
    JOIN public.customer_subscriptions s
      ON s.id = CASE
        WHEN e.event_id ~ '^flw-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[0-9]{4}-[0-9]{2}-[0-9]{2}$'
        THEN substring(e.event_id FROM 5 FOR 36)::uuid
        ELSE NULL::uuid
      END
   WHERE e.gateway = 'flutterwave'
     AND e.event_type = 'token_renewal'
     AND e.status IN ('claimed', 'provider_success')
     AND e.last_error IS NOT NULL
     AND s.gateway = 'flutterwave'
     AND (s.cancellation_requested_at IS NOT NULL OR s.status = 'cancelled')
   ORDER BY e.last_attempted_at NULLS FIRST, e.event_id
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 6), 1), 6);
$function$;
REVOKE ALL ON FUNCTION public.list_cancelled_flutterwave_claims(INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_cancelled_flutterwave_claims(INTEGER)
  TO service_role;
