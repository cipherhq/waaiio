-- 419: Grant service_role SELECT on capability_overrides
--
-- Root cause (#496 UAT blocker): requireCapability() and
-- requireCapabilityWithRole() read capability_overrides via the service
-- client (lib/capabilities/api-guard.ts lines 122-125 and 383-386).
-- The table was created in M027 with RLS policies including a
-- service_role ALL policy, but no table-level GRANT was ever issued.
-- On staging (and any environment lacking ALTER DEFAULT PRIVILEGES),
-- service_role cannot SELECT the table, causing every capability-gated
-- API route to fail with override_read_error / HTTP 500.
--
-- Fix: GRANT SELECT only. The service client reads overrides; it does
-- not write them. INSERT/DELETE is performed by admin RPCs in M301
-- (atomic_admin_capability) which use SECURITY DEFINER functions that
-- bypass table-level privilege checks.
--
-- Same ACL drift class as M415 (staging_launch_acl_repair) and M417
-- (staging_acl_authenticated_reconciliation). No RLS policy changes.
-- No anon or authenticated grants — the guard uses the server path.
--
-- Idempotent: GRANT is a no-op if the privilege already exists.

GRANT SELECT ON public.capability_overrides TO service_role;

-- ══════════════════════════════════════════════════════════
-- Verification: confirm the grant took effect and security boundaries
--
-- Only assert conditions this migration controls:
--   1. service_role CAN SELECT (the grant we added)
--   2. anon has NO access (this migration does not grant it)
--   3. RLS remains enabled (this migration does not alter it)
--
-- We intentionally do NOT assert that service_role lacks INSERT/UPDATE/DELETE.
-- Production Supabase uses ALTER DEFAULT PRIVILEGES which legitimately grants
-- ALL on tables to service_role. The R90 test harness (entity-commit-
-- revalidation) mirrors this model. Asserting write-denial would break in
-- any environment with default privileges — which is the intended production
-- configuration. The guard only needs SELECT; write operations use SECURITY
-- DEFINER RPCs (M301) that bypass table-level privilege checks regardless.
-- ══════════════════════════════════════════════════════════
DO $$
BEGIN
  -- service_role CAN SELECT (the purpose of this migration)
  IF NOT has_table_privilege('service_role', 'public.capability_overrides', 'SELECT') THEN
    RAISE EXCEPTION 'M419: service_role must have SELECT on capability_overrides';
  END IF;

  -- anon has NO access (this migration does not grant it)
  IF has_table_privilege('anon', 'public.capability_overrides', 'SELECT') THEN
    RAISE EXCEPTION 'M419: anon must NOT have SELECT on capability_overrides';
  END IF;

  -- RLS is still enabled (this migration does not alter it)
  IF NOT (SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'capability_overrides') THEN
    RAISE EXCEPTION 'M419: RLS must remain enabled on capability_overrides';
  END IF;

  RAISE NOTICE 'M419: All privilege checks passed — service_role SELECT granted, anon denied, RLS enabled';
END $$;
