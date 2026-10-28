-- 473_api_key_close_direct_writes.sql
-- Issue #705: Close direct authenticated DML bypass on api_keys table.
--
-- DESTRUCTIVE — apply ONLY after all app instances are deployed with
-- the service-client RPC code from M472. Old app instances that INSERT
-- or UPDATE api_keys directly will get permission-denied errors.
--
-- Deploy order:
--   1. Apply M472 (additive RPCs) — safe anytime
--   2. Deploy app code using service-client RPCs
--   3. Verify all instances serve correctly (no direct DML errors in logs)
--   4. Apply this migration (M473) to close the bypass
--
-- Rollback: GRANT INSERT, UPDATE, DELETE ON public.api_keys TO authenticated;

-- Revoke write access from all non-service roles.
-- Authenticated retains SELECT for the GET endpoint (filtered by RLS).
REVOKE INSERT, UPDATE, DELETE ON TABLE public.api_keys FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.api_keys FROM anon;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.api_keys FROM authenticated;

-- Ensure service_role has full CRUD (for RPCs + validateApiKey last_used_at update)
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.api_keys TO service_role;

-- Ensure authenticated has SELECT (for GET endpoint, filtered by RLS)
GRANT SELECT ON TABLE public.api_keys TO authenticated;

-- ============================================================
-- Self-verification block
-- ============================================================
DO $$
DECLARE
  v_auth_insert BOOLEAN;
  v_auth_update BOOLEAN;
  v_auth_delete BOOLEAN;
  v_auth_select BOOLEAN;
  v_anon_insert BOOLEAN;
  v_sr_insert BOOLEAN;
  v_sr_select BOOLEAN;
BEGIN
  SELECT has_table_privilege('authenticated', 'public.api_keys', 'INSERT') INTO v_auth_insert;
  SELECT has_table_privilege('authenticated', 'public.api_keys', 'UPDATE') INTO v_auth_update;
  SELECT has_table_privilege('authenticated', 'public.api_keys', 'DELETE') INTO v_auth_delete;
  SELECT has_table_privilege('authenticated', 'public.api_keys', 'SELECT') INTO v_auth_select;
  SELECT has_table_privilege('anon', 'public.api_keys', 'INSERT') INTO v_anon_insert;
  SELECT has_table_privilege('service_role', 'public.api_keys', 'INSERT') INTO v_sr_insert;
  SELECT has_table_privilege('service_role', 'public.api_keys', 'SELECT') INTO v_sr_select;

  IF v_auth_insert OR v_auth_update OR v_auth_delete THEN
    RAISE EXCEPTION 'M473 verification FAILED: authenticated still has write access to api_keys';
  END IF;

  IF NOT v_auth_select THEN
    RAISE EXCEPTION 'M473 verification FAILED: authenticated lost SELECT on api_keys';
  END IF;

  IF v_anon_insert THEN
    RAISE EXCEPTION 'M473 verification FAILED: anon has INSERT on api_keys';
  END IF;

  IF NOT v_sr_insert OR NOT v_sr_select THEN
    RAISE EXCEPTION 'M473 verification FAILED: service_role missing CRUD on api_keys';
  END IF;

  RAISE NOTICE 'M473 self-verification PASSED: api_keys write-locked, authenticated SELECT preserved';
END;
$$;
