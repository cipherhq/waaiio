-- M554: Paystack plans can expire through the same evidence authority as
-- Stripe and Flutterwave (#1135, user decision 2026-11-19 "Add Paystack expiry").
--
-- Why: a Waaiio plan billed by Paystack whose renewal is stopped (admin Stop
-- Renewal, or the merchant/provider via the subscription.disable/not_renew
-- webhook) keeps status 'active' with cancelled_at set, and the expiry cron's
-- expire_subscription_with_authority had no 'paystack' branch, so it returned
-- no_provider_identity forever and the plan never moved to Free.
--
-- §1. expire_subscription_with_authority re-created from M381 (its only
--     definition) with one added CASE line: 'paystack' derives the provider
--     subscription id from subscriptions.paystack_subscription_code. Every other
--     line, the signature, SECURITY DEFINER, SET search_path = public, pg_temp
--     (repeated per DB-002) and the grants (service_role only) are unchanged.
--     Expiry still requires terminal_no_payment evidence for the exact
--     subscription, gateway, provider id and period boundary; the evidence is
--     written only by subscription-renewal-recovery (Paystack pass) via
--     record_reconciliation_evidence (M380, which already accepts 'paystack').
--     A Paystack plan without a subscription code still returns
--     no_provider_identity, and one without evidence returns
--     authority_no_evidence, so nothing expires without evidence.
BEGIN;

-- §1
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
      WHEN 'paystack' THEN v_sub.paystack_subscription_code
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

COMMIT;
