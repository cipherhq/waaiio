-- M443: Dedicated Flutterwave webhook secret hash for BYO integrations
--        + column-level access hardening for secret_key / webhook_secret_hash
--
-- Flutterwave BYO webhooks must verify the verif-hash header against a
-- per-business webhook secret configured in the Flutterwave dashboard,
-- NOT the API secret key. This column stores the encrypted value.
--
-- Invariants touched:
--   DB-003  — RLS remains enabled (not changed here).
--   SEC-001 — secret_key / webhook_secret_hash must never be readable by
--             anon or authenticated roles via PostgREST.
--
-- Client-side reads: app/api/settings/payment-credentials/route.ts GET
--   uses createClient() (SSR, RLS-protected) and selects:
--   id, gateway, platform_subaccount_code, is_active, verified_at,
--   created_at, connection_type, connect_account_id.
--   Neither secret_key nor webhook_secret_hash is selected, but without
--   column-level restrictions a crafted PostgREST request could read them.

-- ══════════════════════════════════════════════════════════════
-- 1. Add webhook_secret_hash column
-- ══════════════════════════════════════════════════════════════

ALTER TABLE public.business_payment_credentials
ADD COLUMN IF NOT EXISTS webhook_secret_hash TEXT;

-- ══════════════════════════════════════════════════════════════
-- 2. Column-level access hardening
-- ══════════════════════════════════════════════════════════════

-- Revoke any table-level SELECT from anon and authenticated.
-- Production may have historical broad grants from Supabase defaults.
REVOKE SELECT ON TABLE public.business_payment_credentials FROM anon;
REVOKE SELECT ON TABLE public.business_payment_credentials FROM authenticated;

-- Grant column-level SELECT on every column EXCEPT secret_key and
-- webhook_secret_hash to authenticated. These are the columns the
-- GET route and RLS bpc_owner_select policy need.
GRANT SELECT (
  id, business_id, gateway, public_key, platform_subaccount_code,
  connect_account_id, connection_type, is_active, verified_at,
  created_at, updated_at
) ON TABLE public.business_payment_credentials TO authenticated;

-- ══════════════════════════════════════════════════════════════
-- 3. Self-check: column exists + access hardening verified
-- ══════════════════════════════════════════════════════════════

DO $$
BEGIN
  -- Verify webhook_secret_hash column exists
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'business_payment_credentials'
      AND column_name = 'webhook_secret_hash'
  ) THEN
    RAISE EXCEPTION 'M443: webhook_secret_hash column missing after ALTER';
  END IF;

  -- Verify anon cannot SELECT any column
  IF has_any_column_privilege('anon', 'public.business_payment_credentials', 'SELECT') THEN
    RAISE EXCEPTION 'M443 FAILED: anon can still SELECT columns on business_payment_credentials';
  END IF;

  -- Verify authenticated cannot SELECT secret_key
  IF has_column_privilege('authenticated', 'public.business_payment_credentials', 'secret_key', 'SELECT') THEN
    RAISE EXCEPTION 'M443 FAILED: authenticated can still SELECT secret_key';
  END IF;

  -- Verify authenticated cannot SELECT webhook_secret_hash
  IF has_column_privilege('authenticated', 'public.business_payment_credentials', 'webhook_secret_hash', 'SELECT') THEN
    RAISE EXCEPTION 'M443 FAILED: authenticated can still SELECT webhook_secret_hash';
  END IF;

  RAISE NOTICE 'M443 self-check PASSED: column-level access hardening verified';
END $$;
