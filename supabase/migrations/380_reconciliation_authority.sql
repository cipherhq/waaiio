-- ═══════════════════════════════════════════════════════
-- 380: Reconciliation Authority (#315)
--
-- Additive over M378. New surfaces:
--   RPC: terminalize_stale_checkout_intent (service_role)
--   TABLE: subscription_reconciliation_evidence
--   RPC: finalize_subscription_cancellation (5-arg, replaces 3-arg)
--   RPC: record_reconciliation_evidence (service_role)
--   RPC: check_reconciliation_authority (service_role)
-- ═══════════════════════════════════════════════════════

-- ══════════════════════════════════════════════════════════
-- A. terminalize_stale_checkout_intent
-- ══════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.terminalize_stale_checkout_intent(
  p_intent_id UUID,
  p_reason TEXT DEFAULT 'provider_terminal'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_intent RECORD;
  v_allowed_reasons TEXT[] := ARRAY['provider_terminal', 'provider_failed', 'cron_stale_cleanup'];
  v_is_stale BOOLEAN;
BEGIN
  -- Validate reason
  IF NOT (p_reason = ANY(v_allowed_reasons)) THEN
    RAISE EXCEPTION 'terminalize_stale_checkout_intent: invalid reason "%"', p_reason;
  END IF;

  -- Lock the intent
  SELECT * INTO v_intent
    FROM subscription_checkout_intents
    WHERE id = p_intent_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('terminalized', false, 'reason', 'not_found');
  END IF;

  -- Already terminal
  IF v_intent.status = 'completed' THEN
    RETURN jsonb_build_object('terminalized', false, 'reason', 'already_completed');
  END IF;
  IF v_intent.status = 'failed' THEN
    RETURN jsonb_build_object('terminalized', false, 'reason', 'already_failed');
  END IF;
  IF v_intent.status = 'superseded' THEN
    RETURN jsonb_build_object('terminalized', false, 'reason', 'already_superseded');
  END IF;

  -- Must be pending at this point
  -- DB-enforced staleness check
  IF v_intent.provider_timeout_not_before IS NOT NULL THEN
    v_is_stale := v_intent.provider_timeout_not_before <= clock_timestamp();
  ELSE
    v_is_stale := v_intent.created_at + (v_intent.provider_session_duration_minutes * 2) * interval '1 minute' <= clock_timestamp();
  END IF;

  IF NOT v_is_stale THEN
    RETURN jsonb_build_object('terminalized', false, 'reason', 'not_stale');
  END IF;

  -- Terminalize: set to failed only
  UPDATE subscription_checkout_intents
    SET status = 'failed'
    WHERE id = p_intent_id;

  RETURN jsonb_build_object('terminalized', true, 'intent_id', p_intent_id, 'reason', p_reason);
END;
$$;

REVOKE ALL ON FUNCTION public.terminalize_stale_checkout_intent(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.terminalize_stale_checkout_intent(UUID, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.terminalize_stale_checkout_intent(UUID, TEXT) FROM authenticated;
REVOKE ALL ON FUNCTION public.terminalize_stale_checkout_intent(UUID, TEXT) FROM service_role;
GRANT EXECUTE ON FUNCTION public.terminalize_stale_checkout_intent(UUID, TEXT) TO service_role;

-- ══════════════════════════════════════════════════════════
-- B. subscription_reconciliation_evidence table
-- ══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.subscription_reconciliation_evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id UUID NOT NULL REFERENCES subscriptions(id),
  gateway TEXT NOT NULL CHECK (gateway IN ('flutterwave', 'stripe', 'paystack')),
  provider_subscription_id TEXT NOT NULL,
  period_boundary TIMESTAMPTZ NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN (
    'paid_finalized', 'terminal_no_payment', 'provider_active_or_retrying', 'ambiguous', 'unavailable'
  )),
  source_key TEXT NOT NULL CHECK (length(source_key) > 0),
  evidence_tx_count INTEGER NOT NULL DEFAULT 0,
  evidence_matched_count INTEGER NOT NULL DEFAULT 0,
  evidence_provider_status TEXT,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  checked_by TEXT NOT NULL DEFAULT 'reconciliation_cron',
  CONSTRAINT uq_recon_evidence_period UNIQUE (subscription_id, gateway, provider_subscription_id, period_boundary)
);

CREATE INDEX idx_recon_evidence_sub_period
  ON subscription_reconciliation_evidence (subscription_id, period_boundary DESC);

ALTER TABLE subscription_reconciliation_evidence ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.subscription_reconciliation_evidence FROM PUBLIC;
REVOKE ALL ON TABLE public.subscription_reconciliation_evidence FROM anon;
REVOKE ALL ON TABLE public.subscription_reconciliation_evidence FROM authenticated;
GRANT ALL ON TABLE public.subscription_reconciliation_evidence TO service_role;

-- ══════════════════════════════════════════════════════════
-- C. finalize_subscription_cancellation (5-arg, replaces 3-arg)
-- ══════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.finalize_subscription_cancellation(
  p_subscription_id UUID,
  p_gateway TEXT,
  p_provider_subscription_id TEXT,
  p_provider_event_id TEXT,
  p_reason TEXT DEFAULT 'provider_cancelled'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_sub RECORD;
  v_canonical_provider_sub_id TEXT;
  v_event_claim_id UUID;
BEGIN
  -- Validate gateway
  IF p_gateway NOT IN ('flutterwave', 'stripe') THEN
    RAISE EXCEPTION 'finalize_subscription_cancellation: unsupported gateway "%". Paystack cancellation not supported via this function.', p_gateway;
  END IF;

  -- Validate provider_event_id
  IF p_provider_event_id IS NULL OR length(trim(p_provider_event_id)) = 0 THEN
    RAISE EXCEPTION 'finalize_subscription_cancellation: p_provider_event_id must not be NULL or empty';
  END IF;

  -- Validate provider_subscription_id
  IF p_provider_subscription_id IS NULL OR length(trim(p_provider_subscription_id)) = 0 THEN
    RAISE EXCEPTION 'finalize_subscription_cancellation: p_provider_subscription_id must not be NULL or empty';
  END IF;

  -- Lock subscription
  SELECT * INTO v_sub FROM subscriptions WHERE id = p_subscription_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('cancelled', false, 'reason', 'not_found');
  END IF;

  IF v_sub.status = 'cancelled' THEN
    RETURN jsonb_build_object('cancelled', false, 'reason', 'already_cancelled');
  END IF;

  -- Verify gateway matches
  IF v_sub.gateway IS DISTINCT FROM p_gateway THEN
    RETURN jsonb_build_object('cancelled', false, 'reason', 'gateway_mismatch');
  END IF;

  -- Resolve canonical provider subscription ID
  IF p_gateway = 'flutterwave' THEN
    v_canonical_provider_sub_id := v_sub.flutterwave_subscription_id;
  ELSIF p_gateway = 'stripe' THEN
    v_canonical_provider_sub_id := v_sub.stripe_subscription_id;
  END IF;

  -- If no canonical ID on the subscription, cannot verify
  IF v_canonical_provider_sub_id IS NULL OR length(trim(v_canonical_provider_sub_id)) = 0 THEN
    RETURN jsonb_build_object('cancelled', false, 'reason', 'no_canonical_provider_sub_id');
  END IF;

  -- Compare supplied vs canonical
  IF trim(p_provider_subscription_id) IS DISTINCT FROM trim(v_canonical_provider_sub_id) THEN
    RETURN jsonb_build_object('cancelled', false, 'reason', 'provider_subscription_mismatch');
  END IF;

  -- Atomic event claim via unique constraint on event_id
  BEGIN
    INSERT INTO processed_webhook_events (event_id, gateway, event_type, processed_at)
    VALUES (
      p_gateway || ':cancel:' || trim(p_provider_event_id),
      p_gateway,
      'subscription.cancelled',
      clock_timestamp()
    )
    RETURNING id INTO v_event_claim_id;
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('cancelled', false, 'reason', 'already_processed');
  END;

  -- Mutate subscription
  UPDATE subscriptions SET
    status = 'cancelled',
    cancelled_at = clock_timestamp(),
    cancellation_reason = p_reason,
    updated_at = clock_timestamp()
  WHERE id = p_subscription_id;

  -- Mutate business
  UPDATE businesses SET
    subscription_tier = 'free',
    updated_at = clock_timestamp()
  WHERE id = v_sub.business_id;

  RETURN jsonb_build_object('cancelled', true, 'subscription_id', p_subscription_id);
END;
$$;

-- Revoke old 3-arg signature
REVOKE ALL ON FUNCTION public.finalize_subscription_cancellation(UUID, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finalize_subscription_cancellation(UUID, TEXT, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.finalize_subscription_cancellation(UUID, TEXT, TEXT) FROM authenticated;
REVOKE ALL ON FUNCTION public.finalize_subscription_cancellation(UUID, TEXT, TEXT) FROM service_role;

-- Revoke and grant new 5-arg signature
REVOKE ALL ON FUNCTION public.finalize_subscription_cancellation(UUID, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finalize_subscription_cancellation(UUID, TEXT, TEXT, TEXT, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.finalize_subscription_cancellation(UUID, TEXT, TEXT, TEXT, TEXT) FROM authenticated;
REVOKE ALL ON FUNCTION public.finalize_subscription_cancellation(UUID, TEXT, TEXT, TEXT, TEXT) FROM service_role;
GRANT EXECUTE ON FUNCTION public.finalize_subscription_cancellation(UUID, TEXT, TEXT, TEXT, TEXT) TO service_role;

-- ══════════════════════════════════════════════════════════
-- D. record_reconciliation_evidence
-- ══════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.record_reconciliation_evidence(
  p_subscription_id UUID,
  p_gateway TEXT,
  p_provider_subscription_id TEXT,
  p_period_boundary TIMESTAMPTZ,
  p_outcome TEXT,
  p_source_key TEXT,
  p_evidence_tx_count INTEGER DEFAULT 0,
  p_evidence_matched_count INTEGER DEFAULT 0,
  p_evidence_provider_status TEXT DEFAULT NULL,
  p_checked_by TEXT DEFAULT 'reconciliation_cron'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_valid_gateways TEXT[] := ARRAY['flutterwave', 'stripe', 'paystack'];
  v_valid_outcomes TEXT[] := ARRAY['paid_finalized', 'terminal_no_payment', 'provider_active_or_retrying', 'ambiguous', 'unavailable'];
  v_new_rank INTEGER;
  v_existing_rank INTEGER;
  v_existing RECORD;
  v_lock_key BIGINT;
BEGIN
  -- Validate gateway
  IF NOT (p_gateway = ANY(v_valid_gateways)) THEN
    RAISE EXCEPTION 'record_reconciliation_evidence: invalid gateway "%"', p_gateway;
  END IF;

  -- Validate outcome
  IF NOT (p_outcome = ANY(v_valid_outcomes)) THEN
    RAISE EXCEPTION 'record_reconciliation_evidence: invalid outcome "%"', p_outcome;
  END IF;

  -- Validate source_key
  IF p_source_key IS NULL OR length(trim(p_source_key)) = 0 THEN
    RAISE EXCEPTION 'record_reconciliation_evidence: source_key must not be empty';
  END IF;

  -- Compute authority rank
  v_new_rank := CASE p_outcome
    WHEN 'paid_finalized' THEN 5
    WHEN 'terminal_no_payment' THEN 4
    WHEN 'provider_active_or_retrying' THEN 3
    WHEN 'ambiguous' THEN 2
    WHEN 'unavailable' THEN 1
  END;

  -- Advisory lock keyed by hash of composite key
  v_lock_key := hashtext(p_subscription_id::text || p_gateway || p_provider_subscription_id || p_period_boundary::text);
  PERFORM pg_advisory_xact_lock(v_lock_key);

  -- Check for existing evidence under advisory lock
  SELECT * INTO v_existing
    FROM subscription_reconciliation_evidence
    WHERE subscription_id = p_subscription_id
      AND gateway = p_gateway
      AND provider_subscription_id = p_provider_subscription_id
      AND period_boundary = p_period_boundary;

  IF NOT FOUND THEN
    -- Insert new evidence
    INSERT INTO subscription_reconciliation_evidence (
      subscription_id, gateway, provider_subscription_id, period_boundary,
      outcome, source_key, evidence_tx_count, evidence_matched_count,
      evidence_provider_status, checked_by
    ) VALUES (
      p_subscription_id, p_gateway, p_provider_subscription_id, p_period_boundary,
      p_outcome, p_source_key, p_evidence_tx_count, p_evidence_matched_count,
      p_evidence_provider_status, p_checked_by
    );
    RETURN jsonb_build_object('recorded', true, 'action', 'created');
  END IF;

  -- Compute existing rank
  v_existing_rank := CASE v_existing.outcome
    WHEN 'paid_finalized' THEN 5
    WHEN 'terminal_no_payment' THEN 4
    WHEN 'provider_active_or_retrying' THEN 3
    WHEN 'ambiguous' THEN 2
    WHEN 'unavailable' THEN 1
  END;

  -- No downgrade
  IF v_new_rank <= v_existing_rank THEN
    RETURN jsonb_build_object('recorded', false, 'action', 'no_change');
  END IF;

  -- Upgrade
  UPDATE subscription_reconciliation_evidence SET
    outcome = p_outcome,
    source_key = p_source_key,
    evidence_tx_count = p_evidence_tx_count,
    evidence_matched_count = p_evidence_matched_count,
    evidence_provider_status = p_evidence_provider_status,
    checked_at = clock_timestamp(),
    checked_by = p_checked_by
  WHERE id = v_existing.id;

  RETURN jsonb_build_object('recorded', true, 'action', 'upgraded', 'from', v_existing.outcome, 'to', p_outcome);
END;
$$;

REVOKE ALL ON FUNCTION public.record_reconciliation_evidence(UUID, TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, INTEGER, INTEGER, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_reconciliation_evidence(UUID, TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, INTEGER, INTEGER, TEXT, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.record_reconciliation_evidence(UUID, TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, INTEGER, INTEGER, TEXT, TEXT) FROM authenticated;
REVOKE ALL ON FUNCTION public.record_reconciliation_evidence(UUID, TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, INTEGER, INTEGER, TEXT, TEXT) FROM service_role;
GRANT EXECUTE ON FUNCTION public.record_reconciliation_evidence(UUID, TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, INTEGER, INTEGER, TEXT, TEXT) TO service_role;

-- ══════════════════════════════════════════════════════════
-- E. check_reconciliation_authority
-- ══════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.check_reconciliation_authority(
  p_subscription_id UUID,
  p_period_boundary TIMESTAMPTZ
)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_sub RECORD;
  v_provider_sub_id TEXT;
  v_evidence RECORD;
BEGIN
  -- Load subscription
  SELECT gateway, flutterwave_subscription_id, stripe_subscription_id
    INTO v_sub
    FROM subscriptions
    WHERE id = p_subscription_id;

  IF NOT FOUND THEN
    RETURN 'no_evidence';
  END IF;

  -- Resolve provider subscription ID
  v_provider_sub_id := CASE v_sub.gateway
    WHEN 'flutterwave' THEN v_sub.flutterwave_subscription_id
    WHEN 'stripe' THEN v_sub.stripe_subscription_id
    ELSE NULL
  END;

  IF v_provider_sub_id IS NULL OR length(trim(v_provider_sub_id)) = 0 THEN
    RETURN 'no_evidence';
  END IF;

  -- Exact match on all 4 dimensions
  SELECT * INTO v_evidence
    FROM subscription_reconciliation_evidence
    WHERE subscription_id = p_subscription_id
      AND gateway = v_sub.gateway
      AND provider_subscription_id = v_provider_sub_id
      AND period_boundary = p_period_boundary;

  IF NOT FOUND THEN
    RETURN 'no_evidence';
  END IF;

  RETURN v_evidence.outcome;
END;
$$;

REVOKE ALL ON FUNCTION public.check_reconciliation_authority(UUID, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.check_reconciliation_authority(UUID, TIMESTAMPTZ) FROM anon;
REVOKE ALL ON FUNCTION public.check_reconciliation_authority(UUID, TIMESTAMPTZ) FROM authenticated;
REVOKE ALL ON FUNCTION public.check_reconciliation_authority(UUID, TIMESTAMPTZ) FROM service_role;
GRANT EXECUTE ON FUNCTION public.check_reconciliation_authority(UUID, TIMESTAMPTZ) TO service_role;

-- ══════════════════════════════════════════════════════════
-- F. Self-verification
-- ══════════════════════════════════════════════════════════

DO $$
DECLARE v_count INTEGER;
BEGIN
  -- terminalize_stale_checkout_intent
  SELECT count(*) INTO v_count FROM pg_proc
    WHERE proname = 'terminalize_stale_checkout_intent' AND pronamespace = 'public'::regnamespace;
  IF v_count = 0 THEN RAISE EXCEPTION 'M380: terminalize_stale_checkout_intent not found'; END IF;

  -- subscription_reconciliation_evidence table
  SELECT count(*) INTO v_count FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'subscription_reconciliation_evidence';
  IF v_count = 0 THEN RAISE EXCEPTION 'M380: subscription_reconciliation_evidence not found'; END IF;

  -- finalize_subscription_cancellation (5-arg)
  SELECT count(*) INTO v_count FROM pg_proc
    WHERE proname = 'finalize_subscription_cancellation' AND pronamespace = 'public'::regnamespace AND pronargs = 5;
  IF v_count = 0 THEN RAISE EXCEPTION 'M380: finalize_subscription_cancellation (5-arg) not found'; END IF;

  -- record_reconciliation_evidence
  SELECT count(*) INTO v_count FROM pg_proc
    WHERE proname = 'record_reconciliation_evidence' AND pronamespace = 'public'::regnamespace;
  IF v_count = 0 THEN RAISE EXCEPTION 'M380: record_reconciliation_evidence not found'; END IF;

  -- check_reconciliation_authority
  SELECT count(*) INTO v_count FROM pg_proc
    WHERE proname = 'check_reconciliation_authority' AND pronamespace = 'public'::regnamespace;
  IF v_count = 0 THEN RAISE EXCEPTION 'M380: check_reconciliation_authority not found'; END IF;
END;
$$;
