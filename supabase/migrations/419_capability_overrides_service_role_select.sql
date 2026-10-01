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
-- Verification: confirm least-privilege invariants
-- ══════════════════════════════════════════════════════════
DO $$
BEGIN
  -- service_role CAN SELECT
  IF NOT has_table_privilege('service_role', 'public.capability_overrides', 'SELECT') THEN
    RAISE EXCEPTION 'M419: service_role must have SELECT on capability_overrides';
  END IF;

  -- service_role does NOT have INSERT (admin RPCs use SECURITY DEFINER)
  IF has_table_privilege('service_role', 'public.capability_overrides', 'INSERT') THEN
    RAISE EXCEPTION 'M419: service_role must NOT have INSERT on capability_overrides';
  END IF;

  -- service_role does NOT have UPDATE
  IF has_table_privilege('service_role', 'public.capability_overrides', 'UPDATE') THEN
    RAISE EXCEPTION 'M419: service_role must NOT have UPDATE on capability_overrides';
  END IF;

  -- service_role does NOT have DELETE (admin RPCs use SECURITY DEFINER)
  IF has_table_privilege('service_role', 'public.capability_overrides', 'DELETE') THEN
    RAISE EXCEPTION 'M419: service_role must NOT have DELETE on capability_overrides';
  END IF;

  -- anon has NO access
  IF has_table_privilege('anon', 'public.capability_overrides', 'SELECT') THEN
    RAISE EXCEPTION 'M419: anon must NOT have SELECT on capability_overrides';
  END IF;

  -- RLS is still enabled
  IF NOT (SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'capability_overrides') THEN
    RAISE EXCEPTION 'M419: RLS must remain enabled on capability_overrides';
  END IF;

  RAISE NOTICE 'M419: All privilege checks passed — service_role SELECT granted, no write/anon/RLS drift';
END $$;
