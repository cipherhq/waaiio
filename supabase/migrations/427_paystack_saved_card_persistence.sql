-- Migration 427: verified Paystack saved-card persistence (#530).
-- Repairs staging's missing service_role CRUD while preserving an existing
-- production ACL unchanged, plus atomic metadata enrichment after canonical
-- payment verification.

DO $$
DECLARE
  v_missing_service_acl BOOLEAN;
  v_rls_enabled BOOLEAN;
  v_table_oid REGCLASS := 'public.saved_payment_methods'::regclass;
BEGIN
  SELECT NOT has_table_privilege('service_role', 'public.saved_payment_methods', 'SELECT')
    INTO v_missing_service_acl;
  SELECT relrowsecurity FROM pg_class
    WHERE oid = 'public.saved_payment_methods'::regclass INTO v_rls_enabled;

  -- Staging has no service-role table ACL. Production already has the runtime
  -- CRUD grants plus historical client grants; preserve that production ACL
  -- exactly and keep its client-role hardening as a separate authorized task.
  IF v_missing_service_acl THEN
    IF NOT v_rls_enabled THEN
      ALTER TABLE public.saved_payment_methods ENABLE ROW LEVEL SECURITY;
    END IF;
    REVOKE ALL PRIVILEGES ON TABLE public.saved_payment_methods FROM PUBLIC;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      REVOKE ALL PRIVILEGES ON TABLE public.saved_payment_methods FROM anon;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      REVOKE ALL PRIVILEGES ON TABLE public.saved_payment_methods FROM authenticated;
    END IF;
    REVOKE ALL PRIVILEGES ON TABLE public.saved_payment_methods FROM service_role;
    -- Confirmed runtime callers use read/create/update/revoke; no TRUNCATE or DDL.
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.saved_payment_methods TO service_role;
  END IF;

  SELECT relrowsecurity FROM pg_class WHERE oid = v_table_oid INTO v_rls_enabled;
  IF NOT v_rls_enabled
     OR NOT (has_table_privilege('service_role', v_table_oid, 'SELECT')
       AND has_table_privilege('service_role', v_table_oid, 'INSERT')
       AND has_table_privilege('service_role', v_table_oid, 'UPDATE')
       AND has_table_privilege('service_role', v_table_oid, 'DELETE')) THEN
    RAISE EXCEPTION 'M427 verification failed: saved_payment_methods RLS or service_role CRUD is incorrect';
  END IF;
  IF v_missing_service_acl AND (
       has_table_privilege('anon', v_table_oid, 'SELECT')
       OR has_table_privilege('anon', v_table_oid, 'INSERT')
       OR has_table_privilege('anon', v_table_oid, 'UPDATE')
       OR has_table_privilege('anon', v_table_oid, 'DELETE')
       OR has_table_privilege('authenticated', v_table_oid, 'SELECT')
       OR has_table_privilege('authenticated', v_table_oid, 'INSERT')
       OR has_table_privilege('authenticated', v_table_oid, 'UPDATE')
       OR has_table_privilege('authenticated', v_table_oid, 'DELETE')) THEN
    RAISE EXCEPTION 'M427 verification failed: staging client role has saved_payment_methods access';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.persist_verified_paystack_card_authorization(
  p_payment_id UUID,
  p_amount NUMERIC,
  p_currency TEXT,
  p_authorization JSONB
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_safe_authorization JSONB;
BEGIN
  IF COALESCE(p_authorization->>'reusable', 'false') <> 'true'
     OR NULLIF(BTRIM(p_authorization->>'authorization_code'), '') IS NULL
     OR NULLIF(BTRIM(p_authorization->>'email'), '') IS NULL THEN
    RETURN false;
  END IF;

  -- Rebuild from an explicit allowlist; provider payloads can never persist
  -- PAN, CVV, or arbitrary metadata through this function.
  v_safe_authorization := jsonb_build_object(
    'authorization_code', p_authorization->>'authorization_code',
    'customer_code', p_authorization->'customer_code',
    'email', p_authorization->>'email',
    'last4', p_authorization->'last4',
    'brand', p_authorization->'brand',
    'exp_month', p_authorization->'exp_month',
    'exp_year', p_authorization->'exp_year',
    'card_type', p_authorization->'card_type',
    'bank', p_authorization->'bank',
    'reusable', true
  );

  UPDATE public.payments
  SET metadata = COALESCE(metadata, '{}'::jsonb)
      || jsonb_build_object('_card_authorization', v_safe_authorization)
  WHERE id = p_payment_id
    AND gateway = 'paystack'
    AND status IN ('pending', 'success')
    AND amount = p_amount
    AND UPPER(currency) = UPPER(BTRIM(p_currency))
    AND metadata->>'payment_origin' = 'platform'
    AND (
      metadata->'_card_authorization' IS NULL
      OR metadata->'_card_authorization'->>'authorization_code' = p_authorization->>'authorization_code'
    );

  RETURN FOUND;
END;
$$;

REVOKE ALL PRIVILEGES ON FUNCTION public.persist_verified_paystack_card_authorization(UUID, NUMERIC, TEXT, JSONB) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL PRIVILEGES ON FUNCTION public.persist_verified_paystack_card_authorization(UUID, NUMERIC, TEXT, JSONB) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL PRIVILEGES ON FUNCTION public.persist_verified_paystack_card_authorization(UUID, NUMERIC, TEXT, JSONB) FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.persist_verified_paystack_card_authorization(UUID, NUMERIC, TEXT, JSONB) TO service_role;
  END IF;
END $$;

-- Migration self-check: fail closed if the staging ACL repair is broader than
-- the runtime needs or if the narrow persistence RPC is externally callable.
DO $$
DECLARE
  v_function_oid REGPROCEDURE := 'public.persist_verified_paystack_card_authorization(uuid,numeric,text,jsonb)'::regprocedure;
BEGIN
  IF NOT has_function_privilege('service_role', v_function_oid, 'EXECUTE')
     OR has_function_privilege('anon', v_function_oid, 'EXECUTE')
     OR has_function_privilege('authenticated', v_function_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'M427 verification failed: Paystack authorization RPC ACL is incorrect';
  END IF;
END $$;
