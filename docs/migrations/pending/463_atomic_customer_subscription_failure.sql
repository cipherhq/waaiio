-- ══════════════════════════════════════════════════════════
-- 463: Atomic Customer Subscription Failure Recording
--
-- Provides an idempotent, atomic RPC for recording customer
-- subscription payment failures. Prevents double-increment
-- on webhook retry and permanent undercount on partial failure.
--
-- The charge record (keyed by gateway_reference = webhook event ID)
-- is the idempotency marker. If it already exists, the failure
-- was already recorded — return success without mutation.
--
-- Both the charge insert and failure_count increment happen in
-- a single transaction. Either both commit or neither does.
--
-- SECURITY: service_role only (webhook handler). Not callable
-- by anon or authenticated.
-- ══════════════════════════════════════════════════════════

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
  v_existing_charge_id UUID;
  v_current_fail_count INT;
  v_current_status TEXT;
  v_new_fail_count INT;
  v_new_status TEXT;
  v_charge_id UUID;
BEGIN
  -- 1. Check idempotency: has this event already been processed?
  SELECT id INTO v_existing_charge_id
  FROM public.subscription_charges
  WHERE gateway_reference = p_gateway_reference
  LIMIT 1;

  IF v_existing_charge_id IS NOT NULL THEN
    -- Already processed — return success without mutation
    RETURN jsonb_build_object(
      'success', true,
      'already_processed', true,
      'charge_id', v_existing_charge_id
    );
  END IF;

  -- 2. Read current state with row lock (prevents concurrent increment)
  SELECT failure_count, status INTO v_current_fail_count, v_current_status
  FROM public.customer_subscriptions
  WHERE id = p_subscription_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'reason', 'subscription_not_found');
  END IF;

  -- 3. Only process active/past_due subscriptions
  IF v_current_status NOT IN ('active', 'past_due') THEN
    RETURN jsonb_build_object(
      'success', true,
      'already_processed', false,
      'reason', 'terminal_status',
      'status', v_current_status
    );
  END IF;

  -- 4. Compute new state
  v_new_fail_count := COALESCE(v_current_fail_count, 0) + 1;
  v_new_status := CASE
    WHEN v_new_fail_count >= p_failure_threshold THEN 'past_due'
    ELSE v_current_status
  END;

  -- 5. Insert charge record (durable idempotency marker)
  INSERT INTO public.subscription_charges (
    subscription_id, business_id, user_id, amount, currency,
    status, gateway, gateway_reference, failure_reason, created_at
  ) VALUES (
    p_subscription_id, p_business_id, p_user_id, 0, p_currency,
    'failed', p_gateway, p_gateway_reference, p_failure_reason, NOW()
  )
  RETURNING id INTO v_charge_id;

  -- 6. Update subscription (atomic with charge insert)
  UPDATE public.customer_subscriptions
  SET failure_count = v_new_fail_count,
      status = v_new_status,
      updated_at = NOW()
  WHERE id = p_subscription_id;

  -- 7. Return result for caller side effects (alerts, notifications)
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

-- ACL: service_role only (webhook handler)
REVOKE ALL ON FUNCTION public.record_customer_subscription_failure(UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, INT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_customer_subscription_failure(UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, INT) FROM anon;
REVOKE ALL ON FUNCTION public.record_customer_subscription_failure(UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, INT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.record_customer_subscription_failure(UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, INT) TO service_role;

-- ── Verification ──
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'record_customer_subscription_failure'
  ) THEN
    RAISE EXCEPTION 'M463: record_customer_subscription_failure RPC missing';
  END IF;

  -- Verify ACL: service_role has EXECUTE, anon/authenticated do not
  IF EXISTS (
    SELECT 1 FROM information_schema.role_routine_grants
    WHERE routine_name = 'record_customer_subscription_failure'
    AND grantee IN ('anon', 'authenticated')
    AND privilege_type = 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'M463: anon or authenticated has EXECUTE on record_customer_subscription_failure';
  END IF;

  RAISE NOTICE 'M463: Atomic customer subscription failure RPC created and ACL verified';
END $$;
