-- ══════════════════════════════════════════════════════════
-- 464: Atomic Customer Subscription Failure Recording
--
-- Provides an idempotent, atomic RPC for recording customer
-- subscription payment failures. Prevents double-increment
-- on webhook retry and permanent undercount on partial failure.
--
-- Concurrent safety via:
--   1. UNIQUE partial index on subscription_charges.gateway_reference
--      (WHERE gateway_reference IS NOT NULL) — prevents duplicate charge inserts
--   2. INSERT ... ON CONFLICT DO NOTHING — losing concurrent request detects
--      the winner's charge record and skips mutation
--   3. FOR UPDATE row lock on customer_subscriptions — serializes the
--      failure_count read-modify-write within the transaction
--
-- Both the charge insert and failure_count increment happen in
-- a single transaction. Either both commit or neither does.
--
-- SECURITY: service_role only (webhook handler). Not callable
-- by anon or authenticated. SECURITY DEFINER with search_path = ''.
-- ══════════════════════════════════════════════════════════

-- ── Step 1: UNIQUE partial index for idempotency enforcement ──
-- Partial index: only non-NULL gateway_reference values are constrained.
-- Existing rows with NULL gateway_reference are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS idx_subscription_charges_gateway_ref_unique
  ON public.subscription_charges (gateway_reference)
  WHERE gateway_reference IS NOT NULL;

-- ── Step 2: Atomic RPC ──
CREATE OR REPLACE FUNCTION public.record_customer_subscription_failure(
  p_subscription_id UUID,
  p_business_id UUID,
  p_user_id UUID,
  p_currency TEXT,
  p_gateway TEXT,
  p_gateway_reference TEXT,  -- webhook event ID (idempotency key)
  p_failure_reason TEXT,
  p_failure_threshold INT DEFAULT 3
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_current_fail_count INT;
  v_current_status TEXT;
  v_new_fail_count INT;
  v_new_status TEXT;
  v_charge_id UUID;
  v_inserted BOOLEAN;
BEGIN
  -- Validate required inputs
  IF p_subscription_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'reason', 'null_subscription_id');
  END IF;
  IF p_gateway_reference IS NULL OR p_gateway_reference = '' THEN
    RETURN jsonb_build_object('success', false, 'reason', 'null_gateway_reference');
  END IF;

  -- 1. Lock the subscription row FIRST to serialize all concurrent operations
  --    for this subscription. This prevents two transactions from reading the
  --    same failure_count before either writes.
  SELECT failure_count, status INTO v_current_fail_count, v_current_status
  FROM public.customer_subscriptions
  WHERE id = p_subscription_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'reason', 'subscription_not_found');
  END IF;

  -- 2. Only process active/past_due subscriptions
  IF v_current_status NOT IN ('active', 'past_due') THEN
    RETURN jsonb_build_object(
      'success', true,
      'already_processed', false,
      'reason', 'terminal_status',
      'status', v_current_status
    );
  END IF;

  -- 3. Attempt to insert the charge record (idempotency marker).
  --    ON CONFLICT DO NOTHING: if gateway_reference already exists
  --    (from a prior partial-commit or concurrent winner), this is a no-op.
  INSERT INTO public.subscription_charges (
    subscription_id, business_id, user_id, amount, currency,
    status, gateway, gateway_reference, failure_reason, created_at
  ) VALUES (
    p_subscription_id, p_business_id, p_user_id, 0, p_currency,
    'failed', p_gateway, p_gateway_reference, p_failure_reason, NOW()
  )
  ON CONFLICT (gateway_reference) WHERE gateway_reference IS NOT NULL
  DO NOTHING
  RETURNING id INTO v_charge_id;

  -- 4. Check if we were the inserter (winner) or the loser
  v_inserted := v_charge_id IS NOT NULL;

  IF NOT v_inserted THEN
    -- Charge record already exists — this event was already processed.
    -- Look up the existing charge for the response.
    SELECT id INTO v_charge_id
    FROM public.subscription_charges
    WHERE gateway_reference = p_gateway_reference
    LIMIT 1;

    RETURN jsonb_build_object(
      'success', true,
      'already_processed', true,
      'charge_id', v_charge_id
    );
  END IF;

  -- 5. We are the winner — compute and apply the failure_count increment.
  v_new_fail_count := COALESCE(v_current_fail_count, 0) + 1;
  v_new_status := CASE
    WHEN v_new_fail_count >= p_failure_threshold THEN 'past_due'
    ELSE v_current_status
  END;

  UPDATE public.customer_subscriptions
  SET failure_count = v_new_fail_count,
      status = v_new_status,
      updated_at = NOW()
  WHERE id = p_subscription_id;

  -- 6. Return result for caller side effects (alerts, notifications)
  RETURN jsonb_build_object(
    'success', true,
    'already_processed', false,
    'charge_id', v_charge_id,
    'new_failure_count', v_new_fail_count,
    'new_status', v_new_status,
    'escalated', v_new_fail_count >= p_failure_threshold
  );
END;
$$;

-- ── ACL: service_role only ──
REVOKE ALL ON FUNCTION public.record_customer_subscription_failure(UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, INT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_customer_subscription_failure(UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, INT) FROM anon;
REVOKE ALL ON FUNCTION public.record_customer_subscription_failure(UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, INT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.record_customer_subscription_failure(UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, INT) TO service_role;

-- ── Verification ──
DO $$
BEGIN
  -- RPC exists
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'record_customer_subscription_failure'
  ) THEN
    RAISE EXCEPTION 'M464: record_customer_subscription_failure RPC missing';
  END IF;

  -- UNIQUE partial index exists
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE indexname = 'idx_subscription_charges_gateway_ref_unique'
      AND tablename = 'subscription_charges'
  ) THEN
    RAISE EXCEPTION 'M464: idx_subscription_charges_gateway_ref_unique index missing';
  END IF;

  -- ACL: service_role has EXECUTE, anon/authenticated do not
  IF EXISTS (
    SELECT 1 FROM information_schema.role_routine_grants
    WHERE routine_name = 'record_customer_subscription_failure'
    AND grantee IN ('anon', 'authenticated')
    AND privilege_type = 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'M464: anon or authenticated has EXECUTE on record_customer_subscription_failure';
  END IF;

  RAISE NOTICE 'M464: Atomic customer subscription failure RPC + UNIQUE index created and verified';
END $$;
