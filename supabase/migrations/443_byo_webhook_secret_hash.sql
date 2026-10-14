-- M443: webhook_secret_hash column + least-privilege grants on payment credentials
--
-- 1. Adds webhook_secret_hash column for Flutterwave BYO webhook verification.
-- 2. Applies least-privilege grants: only service_role may write; authenticated
--    may SELECT a fixed set of non-sensitive metadata columns; anon has no access.
-- 3. Self-check verifies the final privilege state.
--
-- All writes go through createServiceClient() (service_role). The only
-- authenticated SELECT path is the GET route returning metadata columns.
-- RLS policies and service_role grants are unchanged.

-- ══════════════════════════════════════════════════════════════
-- 1. Add webhook_secret_hash column
-- ══════════════════════════════════════════════════════════════

ALTER TABLE public.business_payment_credentials
ADD COLUMN IF NOT EXISTS webhook_secret_hash TEXT;

-- ══════════════════════════════════════════════════════════════
-- 2. Least-privilege grants
-- ══════════════════════════════════════════════════════════════

-- Remove all privileges from PUBLIC and anon
REVOKE ALL ON TABLE public.business_payment_credentials FROM PUBLIC;
REVOKE ALL ON TABLE public.business_payment_credentials FROM anon;

-- Remove write + broad read from authenticated; keep only column-level SELECT below
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES
  ON TABLE public.business_payment_credentials FROM authenticated;
REVOKE SELECT ON TABLE public.business_payment_credentials FROM authenticated;

-- Authenticated: column-level SELECT on metadata columns only.
-- Matches M426 positive contract + GET route column list.
GRANT SELECT (
  id, business_id, gateway, platform_subaccount_code,
  connect_account_id, connection_type, is_active, verified_at,
  created_at
) ON TABLE public.business_payment_credentials TO authenticated;

-- ══════════════════════════════════════════════════════════════
-- 3. Self-check
-- ══════════════════════════════════════════════════════════════

DO $$
BEGIN
  -- Column existence
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'business_payment_credentials'
      AND column_name = 'webhook_secret_hash'
  ) THEN
    RAISE EXCEPTION 'M443: webhook_secret_hash column missing after ALTER';
  END IF;

  -- anon must have no privilege at all
  IF has_any_column_privilege('anon', 'public.business_payment_credentials', 'SELECT')
     OR has_any_column_privilege('anon', 'public.business_payment_credentials', 'INSERT')
     OR has_any_column_privilege('anon', 'public.business_payment_credentials', 'UPDATE')
     OR has_table_privilege('anon', 'public.business_payment_credentials', 'DELETE')
     OR has_table_privilege('anon', 'public.business_payment_credentials', 'TRUNCATE') THEN
    RAISE EXCEPTION 'M443 FAILED: anon retains privileges on business_payment_credentials';
  END IF;

  -- authenticated must not write
  IF has_table_privilege('authenticated', 'public.business_payment_credentials', 'INSERT')
     OR has_table_privilege('authenticated', 'public.business_payment_credentials', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.business_payment_credentials', 'DELETE')
     OR has_table_privilege('authenticated', 'public.business_payment_credentials', 'TRUNCATE') THEN
    RAISE EXCEPTION 'M443 FAILED: authenticated retains write privileges on business_payment_credentials';
  END IF;

  -- authenticated must not SELECT sensitive columns
  IF has_column_privilege('authenticated', 'public.business_payment_credentials', 'secret_key', 'SELECT') THEN
    RAISE EXCEPTION 'M443 FAILED: authenticated can SELECT secret_key';
  END IF;
  IF has_column_privilege('authenticated', 'public.business_payment_credentials', 'webhook_secret_hash', 'SELECT') THEN
    RAISE EXCEPTION 'M443 FAILED: authenticated can SELECT webhook_secret_hash';
  END IF;
  IF has_column_privilege('authenticated', 'public.business_payment_credentials', 'public_key', 'SELECT') THEN
    RAISE EXCEPTION 'M443 FAILED: authenticated can SELECT public_key';
  END IF;

  RAISE NOTICE 'M443 self-check PASSED: least-privilege grants verified';
END $$;
