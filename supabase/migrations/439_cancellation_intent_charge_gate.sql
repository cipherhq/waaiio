-- ═══════════════════════════════════════════════════════════════════════════
-- M439: Durable Cancellation Intent + Billing Charge Gate (#597 F3)
--
-- Prevents Waaiio-initiated recurring charges after a customer has
-- requested cancellation, even when the local DB status update fails
-- after provider cancellation succeeds.
--
-- The billing cron uses chargeAuthorization (Transaction API), which is
-- independent of Paystack subscription status. Disabling a subscription
-- at the provider does NOT prevent Waaiio from initiating new charges
-- using the stored authorization code. This migration adds a durable
-- cancellation intent that blocks all local charge dispatch paths.
--
-- Changes:
--   1. ADD cancellation_requested_at column to customer_subscriptions
--   2. UPDATE claim_paystack_billing_cycle to check intent
--   3. UPDATE dispatch_paystack_attempt to re-verify intent under lock
--   4. UPDATE claim_recurring_billing_cycle (Flutterwave) to check intent
--
-- Lock ordering: subscription row → attempt row (consistent with M337)
-- Settlement of already-dispatched payments is NOT blocked — only NEW
-- charge initiation is prevented.
--
-- Forward-only. Never edit M305/M337.
-- Refs: #597 F3, coordinated with #604(M436), #606(M437), #607(M438)
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. Add cancellation intent column ──────────────────────────────────
ALTER TABLE customer_subscriptions
  ADD COLUMN IF NOT EXISTS cancellation_requested_at TIMESTAMPTZ;

-- Index for operational queries (find stranded intents)
CREATE INDEX IF NOT EXISTS idx_customer_subs_cancellation_intent
  ON customer_subscriptions (cancellation_requested_at)
  WHERE cancellation_requested_at IS NOT NULL;


-- ─── 2. claim_paystack_billing_cycle — add intent gate ──────────────────
-- Preserves exact M337 signature (1 UUID arg) and all existing behavior.
-- Only addition: reject rows with cancellation_requested_at IS NOT NULL.

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

  -- M439: Durable cancellation intent gate — block all new charges
  IF v_sub.cancellation_requested_at IS NOT NULL THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'cancellation_pending',
      'cancellation_requested_at', v_sub.cancellation_requested_at);
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
      RETURN jsonb_build_object('claimed', false, 'must_reconcile', true,
        'attempt_id', v_existing.id,
        'provider_reference', v_existing.provider_reference,
        'status', v_existing.status,
        'intended_amount_minor', v_existing.intended_amount_minor);
    END IF;

    IF v_existing.status = 'reserved' THEN
      IF v_existing.lease_expires_at > NOW() THEN
        RETURN jsonb_build_object('claimed', false, 'reason', 'active_lease',
          'attempt_id', v_existing.id,
          'expires_at', v_existing.lease_expires_at);
      END IF;
      v_attempt_num := v_existing.attempt_number + 1;
    END IF;
  ELSE
    v_attempt_num := 1;
  END IF;

  -- Generate claim
  v_token := gen_random_uuid();
  v_attempt_ref := 'ps-' || p_subscription_id::text || '-' || v_attempt_num::text || '-' || EXTRACT(EPOCH FROM NOW())::bigint::text;

  INSERT INTO paystack_billing_attempts (
    customer_subscription_id, cycle_key, attempt_number,
    status, claim_token, lease_expires_at,
    intended_amount_minor, intended_currency
  ) VALUES (
    p_subscription_id, v_cycle_key, v_attempt_num,
    'reserved', v_token, NOW() + INTERVAL '5 minutes',
    ROUND(v_sub.amount * 100)::int,
    COALESCE(v_sub.currency, 'NGN')
  );

  RETURN jsonb_build_object(
    'claimed', true,
    'claim_token', v_token,
    'attempt_ref', v_attempt_ref,
    'authorization_code', v_sub.authorization_code,
    'customer_code', v_sub.customer_code,
    'amount_minor', ROUND(v_sub.amount * 100)::int,
    'currency', COALESCE(v_sub.currency, 'NGN'),
    'email', v_sub.customer_email,
    'subscription_code', v_sub.gateway_subscription_code
  );
END;
$$;

-- Preserve existing ACL
REVOKE ALL ON FUNCTION public.claim_paystack_billing_cycle(UUID) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION public.claim_paystack_billing_cycle(UUID) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION public.claim_paystack_billing_cycle(UUID) FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.claim_paystack_billing_cycle(UUID) TO service_role;
  END IF;
END $$;


-- ─── 3. dispatch_paystack_attempt — re-verify intent at dispatch boundary ─
-- The dispatch function locks the attempt row. M439 adds a subscription
-- re-read to check cancellation intent BEFORE transitioning to dispatched.
-- Lock ordering: attempt (already locked) → subscription (read, no FOR UPDATE
-- needed since we only check a timestamp, avoiding deadlock with claim's
-- subscription → attempt order).

CREATE OR REPLACE FUNCTION dispatch_paystack_attempt(
  p_attempt_id UUID,
  p_claim_token UUID
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_attempt RECORD;
  v_cancel_ts TIMESTAMPTZ;
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

  -- M439: Re-verify cancellation intent at dispatch boundary.
  -- Uses a plain SELECT (no FOR UPDATE) to avoid deadlock with claim's
  -- subscription → attempt lock order. The intent timestamp is immutable
  -- once set (only clearable by explicit admin/reconciliation action).
  SELECT cancellation_requested_at INTO v_cancel_ts
    FROM customer_subscriptions
    WHERE id = v_attempt.customer_subscription_id;

  IF v_cancel_ts IS NOT NULL THEN
    -- Cancellation was requested between claim and dispatch.
    -- Release the attempt rather than dispatching.
    UPDATE paystack_billing_attempts
      SET status = 'cancelled', dispatched_at = NOW()
      WHERE id = p_attempt_id;
    RETURN jsonb_build_object('dispatched', false, 'reason', 'cancellation_pending',
      'cancellation_requested_at', v_cancel_ts);
  END IF;

  UPDATE paystack_billing_attempts
    SET status = 'dispatched', dispatched_at = NOW()
    WHERE id = p_attempt_id;

  RETURN jsonb_build_object('dispatched', true);
END;
$$;

-- Preserve existing ACL
REVOKE ALL ON FUNCTION public.dispatch_paystack_attempt(UUID, UUID) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION public.dispatch_paystack_attempt(UUID, UUID) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION public.dispatch_paystack_attempt(UUID, UUID) FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.dispatch_paystack_attempt(UUID, UUID) TO service_role;
  END IF;
END $$;


-- ─── 4. claim_recurring_billing_cycle (Flutterwave) — add intent gate ────
-- Same pattern: check cancellation_requested_at before allowing claim.

CREATE OR REPLACE FUNCTION claim_recurring_billing_cycle(
  p_subscription_id UUID
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_sub RECORD;
  v_existing RECORD;
  v_stable_ref TEXT;
  v_attempt_ref TEXT;
  v_attempt_num INT;
BEGIN
  SELECT * INTO v_sub FROM customer_subscriptions
    WHERE id = p_subscription_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'not_found');
  END IF;

  IF COALESCE(v_sub.gateway, '') != 'flutterwave' THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'wrong_gateway', 'gateway', v_sub.gateway);
  END IF;

  IF v_sub.status NOT IN ('active', 'past_due') THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'not_active', 'status', v_sub.status);
  END IF;

  -- M439: Durable cancellation intent gate
  IF v_sub.cancellation_requested_at IS NOT NULL THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'cancellation_pending',
      'cancellation_requested_at', v_sub.cancellation_requested_at);
  END IF;

  IF v_sub.next_charge_at > NOW() THEN
    RETURN jsonb_build_object('claimed', false, 'reason', 'not_due', 'next_charge_at', v_sub.next_charge_at);
  END IF;

  v_stable_ref := 'flw-' || p_subscription_id::text || '-' || TO_CHAR(v_sub.next_charge_at, 'YYYY-MM-DD');

  SELECT status, last_attempted_at, attempts, last_error INTO v_existing
  FROM processed_webhook_events WHERE event_id = v_stable_ref;

  IF FOUND THEN
    IF v_existing.status = 'completed' THEN
      RETURN jsonb_build_object('claimed', false, 'already_completed', true,
        'event_id', v_stable_ref);
    END IF;

    IF v_existing.status = 'processing' AND
       v_existing.last_attempted_at > NOW() - INTERVAL '5 minutes' THEN
      RETURN jsonb_build_object('claimed', false, 'reason', 'active_processing',
        'event_id', v_stable_ref);
    END IF;

    v_attempt_num := COALESCE(v_existing.attempts, 0) + 1;
    v_attempt_ref := v_stable_ref || ':' || v_attempt_num;

    UPDATE processed_webhook_events
    SET status = 'processing',
        attempts = v_attempt_num,
        last_attempted_at = NOW(),
        last_error = v_attempt_ref
    WHERE event_id = v_stable_ref;

    RETURN jsonb_build_object(
      'claimed', true,
      'attempt_ref', v_attempt_ref,
      'event_id', v_stable_ref,
      'authorization_code', v_sub.authorization_code,
      'amount', v_sub.amount,
      'currency', COALESCE(v_sub.currency, 'NGN'),
      'email', v_sub.customer_email,
      'service_id', v_sub.service_id,
      'business_id', v_sub.business_id,
      'subscription_id', v_sub.id
    );
  END IF;

  v_attempt_num := 1;
  v_attempt_ref := v_stable_ref || ':1';

  INSERT INTO processed_webhook_events (
    event_id, gateway, event_type, status, attempts,
    first_received_at, last_attempted_at, last_error
  ) VALUES (
    v_stable_ref, 'flutterwave', 'recurring_billing_claim', 'processing', 1,
    NOW(), NOW(), v_attempt_ref
  );

  RETURN jsonb_build_object(
    'claimed', true,
    'attempt_ref', v_attempt_ref,
    'event_id', v_stable_ref,
    'authorization_code', v_sub.authorization_code,
    'amount', v_sub.amount,
    'currency', COALESCE(v_sub.currency, 'NGN'),
    'email', v_sub.customer_email,
    'service_id', v_sub.service_id,
    'business_id', v_sub.business_id,
    'subscription_id', v_sub.id
  );
END;
$$;

-- Preserve existing ACL
REVOKE ALL ON FUNCTION public.claim_recurring_billing_cycle(UUID) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION public.claim_recurring_billing_cycle(UUID) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION public.claim_recurring_billing_cycle(UUID) FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.claim_recurring_billing_cycle(UUID) TO service_role;
  END IF;
END $$;


-- ─── Self-verification ───────────────────────────────────────────────────
DO $$
BEGIN
  -- Verify column exists
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'customer_subscriptions'
      AND column_name = 'cancellation_requested_at'
  ) THEN
    RAISE EXCEPTION 'M439 verification FAILED: cancellation_requested_at column not found';
  END IF;

  -- Verify functions exist
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'claim_paystack_billing_cycle') THEN
    RAISE EXCEPTION 'M439 verification FAILED: claim_paystack_billing_cycle not found';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'dispatch_paystack_attempt') THEN
    RAISE EXCEPTION 'M439 verification FAILED: dispatch_paystack_attempt not found';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'claim_recurring_billing_cycle') THEN
    RAISE EXCEPTION 'M439 verification FAILED: claim_recurring_billing_cycle not found';
  END IF;

  RAISE NOTICE 'M439 self-verification PASSED: cancellation intent + charge gates installed';
END $$;
