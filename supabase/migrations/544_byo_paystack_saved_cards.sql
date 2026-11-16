-- Migration 544: Save Card on a merchant's own Paystack account (BYO) (#1065 step 1).
-- A card authorized on a merchant's own Paystack account can only be charged with
-- that merchant's key, so it is scoped to the exact credential connection that
-- issued it. NULL provider_credential_id = Waaiio shared-account card (unchanged).
-- No backfill: every existing row stays a shared-account card.

ALTER TABLE public.saved_payment_methods
  ADD COLUMN IF NOT EXISTS provider_credential_id UUID
    REFERENCES public.business_payment_credentials(id) ON DELETE CASCADE;

ALTER TABLE public.saved_payment_methods
  DROP CONSTRAINT IF EXISTS chk_saved_pm_byo_business;
ALTER TABLE public.saved_payment_methods
  ADD CONSTRAINT chk_saved_pm_byo_business
  CHECK (provider_credential_id IS NULL OR business_id IS NOT NULL);

-- One active shared card per customer+gateway (as before), plus at most one
-- active card per customer on each merchant's own Paystack connection.
DROP INDEX IF EXISTS public.idx_saved_pm_customer_gateway_active;
CREATE UNIQUE INDEX IF NOT EXISTS idx_saved_pm_platform_active
  ON public.saved_payment_methods (customer_phone, gateway)
  WHERE is_active = true AND provider_credential_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_saved_pm_byo_active
  ON public.saved_payment_methods (customer_phone, provider_credential_id)
  WHERE is_active = true AND provider_credential_id IS NOT NULL;

-- Same body as M427 except payment_origin may also be 'byo'. Attributes are
-- restated in full (DB-002): SECURITY DEFINER, search_path = pg_catalog, pg_temp.
CREATE OR REPLACE FUNCTION public.persist_verified_paystack_card_authorization(
  p_payment_id UUID,
  p_amount NUMERIC,
  p_currency TEXT,
  p_authorization JSONB
) RETURNS BOOLEAN
LANGUAGE plpgsql
-- service_role deliberately has no direct UPDATE grant on payments. This
-- narrowly scoped definer RPC performs only the validated metadata merge below.
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
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
    AND metadata->>'payment_origin' IN ('platform', 'byo')
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

-- Migration self-check: final state must match the contract above.
DO $$
DECLARE
  v_function_oid REGPROCEDURE := 'public.persist_verified_paystack_card_authorization(uuid,numeric,text,jsonb)'::regprocedure;
  v_proc RECORD;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_saved_pm_customer_gateway_active')
     OR NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_saved_pm_platform_active')
     OR NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_saved_pm_byo_active') THEN
    RAISE EXCEPTION 'M544 verification failed: saved card active indexes are incorrect';
  END IF;

  SELECT prosecdef, proconfig INTO v_proc FROM pg_proc WHERE oid = v_function_oid;
  IF NOT v_proc.prosecdef OR NOT (v_proc.proconfig @> ARRAY['search_path=pg_catalog, pg_temp']) THEN
    RAISE EXCEPTION 'M544 verification failed: Paystack authorization RPC attributes are incorrect';
  END IF;

  IF NOT has_function_privilege('service_role', v_function_oid, 'EXECUTE')
     OR has_function_privilege('anon', v_function_oid, 'EXECUTE')
     OR has_function_privilege('authenticated', v_function_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'M544 verification failed: Paystack authorization RPC ACL is incorrect';
  END IF;
END $$;
