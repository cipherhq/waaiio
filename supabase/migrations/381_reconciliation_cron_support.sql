-- ═══════════════════════════════════════════════════════
-- 381: Reconciliation Cron Support (#315, Phase 3C)
--
-- Additive over M380. New surfaces:
--   COLUMN: subscription_checkout_intents.reconciliation_claimed_at
--   COLUMN: subscriptions.last_reconciliation_attempt_at
--   COLUMN: subscriptions.cancellation_checked_at
--   RPC: expire_subscription_with_authority (service_role)
--   RPC: claim_stale_checkout_batch (service_role)
--   RPC: claim_overdue_subscription_batch (service_role) — returns business_id, plan
--   RPC: claim_active_subscriptions_for_cancellation_check (service_role)
-- ═══════════════════════════════════════════════════════

-- ══════════════════════════════════════════════════════════
-- A. Column additions
-- ══════════════════════════════════════════════════════════

ALTER TABLE subscription_checkout_intents ADD COLUMN IF NOT EXISTS reconciliation_claimed_at TIMESTAMPTZ;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS last_reconciliation_attempt_at TIMESTAMPTZ;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS cancellation_checked_at TIMESTAMPTZ;

-- ══════════════════════════════════════════════════════════
-- B. expire_subscription_with_authority
-- ══════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.expire_subscription_with_authority(
  p_subscription_id UUID,
  p_period_boundary TIMESTAMPTZ
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_sub RECORD;
  v_provider_sub_id TEXT;
  v_lock_key BIGINT;
  v_evidence_outcome TEXT;
BEGIN
  -- Lock subscription
  SELECT * INTO v_sub FROM subscriptions WHERE id = p_subscription_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('expired', false, 'reason', 'not_found');
  END IF;

  -- Must be active
  IF v_sub.status != 'active' THEN
    RETURN jsonb_build_object('expired', false, 'reason', 'not_active');
  END IF;

  -- Period boundary check: must match exactly
  IF v_sub.current_period_end IS DISTINCT FROM p_period_boundary THEN
    RETURN jsonb_build_object('expired', false, 'reason', 'period_boundary_moved');
  END IF;

  -- Provider-managed subscriptions require reconciliation authority
  IF v_sub.gateway IS NOT NULL THEN
    -- Derive provider subscription ID
    v_provider_sub_id := CASE v_sub.gateway
      WHEN 'flutterwave' THEN v_sub.flutterwave_subscription_id
      WHEN 'stripe' THEN v_sub.stripe_subscription_id
      ELSE NULL
    END;

    -- No provider identity → cannot verify, fail closed
    IF v_provider_sub_id IS NULL THEN
      RETURN jsonb_build_object('expired', false, 'reason', 'no_provider_identity');
    END IF;

    -- Acquire same advisory lock as evidence writer for consistency
    v_lock_key := hashtext(p_subscription_id::text || v_sub.gateway || v_provider_sub_id || p_period_boundary::text);
    PERFORM pg_advisory_xact_lock(v_lock_key);

    -- Read evidence directly
    SELECT outcome INTO v_evidence_outcome
      FROM subscription_reconciliation_evidence
      WHERE subscription_id = p_subscription_id
        AND gateway = v_sub.gateway
        AND provider_subscription_id = v_provider_sub_id
        AND period_boundary = p_period_boundary;

    -- Only terminal_no_payment authorizes expiry
    IF v_evidence_outcome IS DISTINCT FROM 'terminal_no_payment' THEN
      RETURN jsonb_build_object('expired', false, 'reason', 'authority_' || COALESCE(v_evidence_outcome, 'no_evidence'));
    END IF;
  END IF;

  -- Non-provider (gateway IS NULL) skips authority check entirely

  -- Atomic: expire subscription + downgrade business
  UPDATE subscriptions SET
    status = 'expired',
    updated_at = clock_timestamp()
  WHERE id = p_subscription_id;

  UPDATE businesses SET
    subscription_tier = 'free',
    updated_at = clock_timestamp()
  WHERE id = v_sub.business_id;

  RETURN jsonb_build_object('expired', true);
END;
$$;

REVOKE ALL ON FUNCTION public.expire_subscription_with_authority(UUID, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.expire_subscription_with_authority(UUID, TIMESTAMPTZ) FROM anon;
REVOKE ALL ON FUNCTION public.expire_subscription_with_authority(UUID, TIMESTAMPTZ) FROM authenticated;
REVOKE ALL ON FUNCTION public.expire_subscription_with_authority(UUID, TIMESTAMPTZ) FROM service_role;
GRANT EXECUTE ON FUNCTION public.expire_subscription_with_authority(UUID, TIMESTAMPTZ) TO service_role;

-- ══════════════════════════════════════════════════════════
-- C. claim_stale_checkout_batch
-- ══════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.claim_stale_checkout_batch(
  p_batch_size INTEGER DEFAULT 20
)
RETURNS TABLE(intent_id UUID, idempotency_key TEXT, created_at TIMESTAMPTZ, gateway TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN QUERY
  WITH candidates AS (
    SELECT sci.id, sci.idempotency_key, sci.created_at, sci.gateway
      FROM subscription_checkout_intents sci
      WHERE sci.gateway = 'flutterwave'
        AND sci.status = 'pending'
        AND (
          (sci.provider_timeout_not_before IS NOT NULL AND sci.provider_timeout_not_before <= clock_timestamp())
          OR
          (sci.provider_timeout_not_before IS NULL AND sci.created_at + (sci.provider_session_duration_minutes * 2) * interval '1 minute' <= clock_timestamp())
        )
        AND (sci.reconciliation_claimed_at IS NULL OR sci.reconciliation_claimed_at < clock_timestamp() - interval '15 minutes')
      ORDER BY COALESCE(sci.reconciliation_claimed_at, '1970-01-01'::timestamptz) ASC
      LIMIT p_batch_size
      FOR UPDATE SKIP LOCKED
  )
  UPDATE subscription_checkout_intents sci2
    SET reconciliation_claimed_at = clock_timestamp()
    FROM candidates c
    WHERE sci2.id = c.id
  RETURNING sci2.id, sci2.idempotency_key, sci2.created_at, sci2.gateway;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_stale_checkout_batch(INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_stale_checkout_batch(INTEGER) FROM anon;
REVOKE ALL ON FUNCTION public.claim_stale_checkout_batch(INTEGER) FROM authenticated;
REVOKE ALL ON FUNCTION public.claim_stale_checkout_batch(INTEGER) FROM service_role;
GRANT EXECUTE ON FUNCTION public.claim_stale_checkout_batch(INTEGER) TO service_role;

-- ══════════════════════════════════════════════════════════
-- D. claim_overdue_subscription_batch
-- ══════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.claim_overdue_subscription_batch(
  p_batch_size INTEGER DEFAULT 20
)
RETURNS TABLE(
  sub_id UUID,
  gateway TEXT,
  current_period_end TIMESTAMPTZ,
  flutterwave_subscription_id TEXT,
  flutterwave_subscriber_email TEXT,
  flutterwave_plan_id INTEGER,
  stripe_subscription_id TEXT,
  currency TEXT,
  amount INTEGER,
  billing_config_version_id UUID,
  business_id UUID,
  plan TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN QUERY
  WITH candidates AS (
    SELECT s.id
      FROM subscriptions s
      WHERE s.status = 'active'
        AND s.current_period_end < clock_timestamp()
        AND s.gateway IN ('flutterwave', 'stripe')
        AND (s.last_reconciliation_attempt_at IS NULL OR s.last_reconciliation_attempt_at < clock_timestamp() - interval '4 hours')
      ORDER BY COALESCE(s.last_reconciliation_attempt_at, '1970-01-01'::timestamptz) ASC
      LIMIT p_batch_size
      FOR UPDATE SKIP LOCKED
  )
  UPDATE subscriptions s2
    SET last_reconciliation_attempt_at = clock_timestamp()
    FROM candidates c
    WHERE s2.id = c.id
  RETURNING s2.id, s2.gateway, s2.current_period_end,
    s2.flutterwave_subscription_id, s2.flutterwave_subscriber_email,
    s2.flutterwave_plan_id, s2.stripe_subscription_id,
    s2.currency, s2.amount, s2.billing_config_version_id,
    s2.business_id, s2.plan;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_overdue_subscription_batch(INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_overdue_subscription_batch(INTEGER) FROM anon;
REVOKE ALL ON FUNCTION public.claim_overdue_subscription_batch(INTEGER) FROM authenticated;
REVOKE ALL ON FUNCTION public.claim_overdue_subscription_batch(INTEGER) FROM service_role;
GRANT EXECUTE ON FUNCTION public.claim_overdue_subscription_batch(INTEGER) TO service_role;

-- ══════════════════════════════════════════════════════════
-- E. claim_active_subscriptions_for_cancellation_check (Finding 3)
-- ══════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.claim_active_subscriptions_for_cancellation_check(
  p_batch_size INTEGER DEFAULT 50
)
RETURNS TABLE(
  sub_id UUID,
  gateway TEXT,
  flutterwave_subscription_id TEXT,
  flutterwave_subscriber_email TEXT,
  flutterwave_plan_id INTEGER,
  stripe_subscription_id TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN QUERY
  WITH candidates AS (
    SELECT s.id
      FROM subscriptions s
      WHERE s.status = 'active'
        AND s.gateway IN ('flutterwave', 'stripe')
        AND (s.cancellation_checked_at IS NULL OR s.cancellation_checked_at < clock_timestamp() - interval '24 hours')
      ORDER BY COALESCE(s.cancellation_checked_at, '1970-01-01'::timestamptz) ASC
      LIMIT p_batch_size
      FOR UPDATE SKIP LOCKED
  )
  UPDATE subscriptions s2
    SET cancellation_checked_at = clock_timestamp()
    FROM candidates c
    WHERE s2.id = c.id
  RETURNING s2.id, s2.gateway,
    s2.flutterwave_subscription_id, s2.flutterwave_subscriber_email,
    s2.flutterwave_plan_id, s2.stripe_subscription_id;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_active_subscriptions_for_cancellation_check(INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_active_subscriptions_for_cancellation_check(INTEGER) FROM anon;
REVOKE ALL ON FUNCTION public.claim_active_subscriptions_for_cancellation_check(INTEGER) FROM authenticated;
REVOKE ALL ON FUNCTION public.claim_active_subscriptions_for_cancellation_check(INTEGER) FROM service_role;
GRANT EXECUTE ON FUNCTION public.claim_active_subscriptions_for_cancellation_check(INTEGER) TO service_role;

-- ══════════════════════════════════════════════════════════
-- F. Self-verification
-- ══════════════════════════════════════════════════════════

DO $$
DECLARE v_count INTEGER;
BEGIN
  -- reconciliation_claimed_at column on subscription_checkout_intents
  SELECT count(*) INTO v_count FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'subscription_checkout_intents' AND column_name = 'reconciliation_claimed_at';
  IF v_count = 0 THEN RAISE EXCEPTION 'M381: subscription_checkout_intents.reconciliation_claimed_at not found'; END IF;

  -- last_reconciliation_attempt_at column on subscriptions
  SELECT count(*) INTO v_count FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'subscriptions' AND column_name = 'last_reconciliation_attempt_at';
  IF v_count = 0 THEN RAISE EXCEPTION 'M381: subscriptions.last_reconciliation_attempt_at not found'; END IF;

  -- expire_subscription_with_authority
  SELECT count(*) INTO v_count FROM pg_proc
    WHERE proname = 'expire_subscription_with_authority' AND pronamespace = 'public'::regnamespace;
  IF v_count = 0 THEN RAISE EXCEPTION 'M381: expire_subscription_with_authority not found'; END IF;

  -- claim_stale_checkout_batch
  SELECT count(*) INTO v_count FROM pg_proc
    WHERE proname = 'claim_stale_checkout_batch' AND pronamespace = 'public'::regnamespace;
  IF v_count = 0 THEN RAISE EXCEPTION 'M381: claim_stale_checkout_batch not found'; END IF;

  -- claim_overdue_subscription_batch
  SELECT count(*) INTO v_count FROM pg_proc
    WHERE proname = 'claim_overdue_subscription_batch' AND pronamespace = 'public'::regnamespace;
  IF v_count = 0 THEN RAISE EXCEPTION 'M381: claim_overdue_subscription_batch not found'; END IF;

  -- cancellation_checked_at column on subscriptions
  SELECT count(*) INTO v_count FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'subscriptions' AND column_name = 'cancellation_checked_at';
  IF v_count = 0 THEN RAISE EXCEPTION 'M381: subscriptions.cancellation_checked_at not found'; END IF;

  -- claim_active_subscriptions_for_cancellation_check
  SELECT count(*) INTO v_count FROM pg_proc
    WHERE proname = 'claim_active_subscriptions_for_cancellation_check' AND pronamespace = 'public'::regnamespace;
  IF v_count = 0 THEN RAISE EXCEPTION 'M381: claim_active_subscriptions_for_cancellation_check not found'; END IF;
END;
$$;
