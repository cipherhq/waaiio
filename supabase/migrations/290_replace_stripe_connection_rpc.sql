-- ═══════════════════════════════════════════════════════
-- 290: Transactional Stripe connection replacement
--
-- Atomically revokes existing active Stripe connections for a
-- business and inserts the replacement in a single transaction.
-- Any failure after revocation rolls back the entire transaction
-- (no EXCEPTION handler — Postgres auto-aborts on unhandled error).
--
-- Preserves all non-Stripe providers. Correctly handles the
-- is_default flag based on whether another provider holds a
-- valid default (matching the resolver's 5-condition predicate).
--
-- Service-role only. Called from the Stripe OAuth callback handler
-- after Stripe API verification confirms the account is valid.
-- ═══════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.replace_stripe_connection(
  p_business_id   UUID,
  p_account_id    TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_biz_exists   BOOLEAN;
  v_revoked      INT;
  v_has_default  BOOLEAN;
  v_new_id       UUID;
BEGIN
  -- ① Validate inputs (before any mutation)
  IF p_business_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'reason', 'invalid_input');
  END IF;
  IF p_account_id IS NULL OR trim(p_account_id) = '' THEN
    RETURN jsonb_build_object('success', false, 'reason', 'invalid_input');
  END IF;

  -- ② Verify business exists (tenant boundary)
  SELECT EXISTS(
    SELECT 1 FROM public.businesses WHERE id = p_business_id
  ) INTO v_biz_exists;

  IF NOT v_biz_exists THEN
    RETURN jsonb_build_object('success', false, 'reason', 'business_not_found');
  END IF;

  -- ③ Lock all Stripe connections for this business to serialize
  --    concurrent replacement and set_default_connection calls
  PERFORM id FROM public.payout_accounts
    WHERE business_id = p_business_id
      AND gateway = 'stripe'
    FOR UPDATE;

  -- ④ MUTATION: Revoke existing active Stripe connections
  --    Preserves all non-Stripe providers. Clears is_default on
  --    revoked rows so the partial unique index is freed.
  UPDATE public.payout_accounts
    SET is_active = false,
        connection_status = 'revoked',
        is_default = false,
        updated_at = NOW()
    WHERE business_id = p_business_id
      AND gateway = 'stripe'
      AND is_active = true;

  GET DIAGNOSTICS v_revoked = ROW_COUNT;

  -- ⑤ Check if another provider holds a valid default.
  --    Uses the same 5-condition predicate as the payment route
  --    resolver (is_default, is_active, connection_status, verified_at,
  --    health_status) so the default decision stays consistent.
  SELECT EXISTS(
    SELECT 1 FROM public.payout_accounts
      WHERE business_id = p_business_id
        AND is_default = true
        AND is_active = true
        AND connection_status = 'active'
        AND verified_at IS NOT NULL
        AND health_status = 'healthy'
  ) INTO v_has_default;

  -- ⑥ MUTATION: Insert replacement connection.
  --    All sensitive values are hardcoded — not caller-supplied.
  --    If this INSERT fails (constraint, trigger, etc.), Postgres
  --    aborts the entire transaction and rolls back step ④.
  INSERT INTO public.payout_accounts (
    business_id, gateway, stripe_account_id, platform_percentage,
    is_active, is_default, connection_mode, connection_status,
    health_status, verified_at
  ) VALUES (
    p_business_id,
    'stripe',
    p_account_id,
    2.5,
    true,
    NOT v_has_default,
    'connect',
    'active',
    'healthy',
    NOW()
  )
  RETURNING id INTO v_new_id;

  -- ⑦ Return success with connection details
  RETURN jsonb_build_object(
    'success',       true,
    'connection_id', v_new_id,
    'is_default',    NOT v_has_default,
    'revoked_count', v_revoked
  );
END;
$$;

-- Restrict to service_role only
REVOKE ALL ON FUNCTION public.replace_stripe_connection(UUID, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.replace_stripe_connection(UUID, TEXT)
  TO service_role;
