-- 422: capability_overrides security reconciliation
--
-- M419 design contract: "No anon or authenticated grants — the guard uses
-- the server path." service_role SELECT only.
--
-- Production divergence: capability_overrides_service_all policy uses
-- USING(true) instead of USING(auth.role() = 'service_role'), and
-- ALTER DEFAULT Privileges gave anon/authenticated full CRUD.
--
-- Fix:
-- 1. REVOKE ALL from anon + authenticated.
-- 2. Replace service_all policy with service-role-only predicate (matching staging).
-- 3. Retain service_role SELECT only (M419 grant).
--
-- Idempotent: REVOKE is a no-op when privileges don't exist.
-- Works on both staging (already correct) and production (needs REVOKE + policy fix).

-- ══════════════════════════════════════════════════════════
-- Table-level privilege reconciliation
-- ══════════════════════════════════════════════════════════

REVOKE ALL ON public.capability_overrides FROM anon;
REVOKE ALL ON public.capability_overrides FROM authenticated;

-- Ensure service_role SELECT is present (M419, idempotent)
GRANT SELECT ON public.capability_overrides TO service_role;

-- Ensure service_role does NOT have INSERT/UPDATE/DELETE
-- (admin writes go through SECURITY DEFINER RPCs in M301)
REVOKE INSERT, UPDATE, DELETE ON public.capability_overrides FROM service_role;

-- ══════════════════════════════════════════════════════════
-- RLS policy reconciliation
-- ══════════════════════════════════════════════════════════

-- Drop and recreate capability_overrides_service_all with the correct predicate.
-- Production has USING(true); staging has USING(auth.role() = 'service_role').
-- The correct version is the staging predicate — only service_role should match.
DROP POLICY IF EXISTS capability_overrides_service_all ON public.capability_overrides;
CREATE POLICY capability_overrides_service_all ON public.capability_overrides
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- Preserve the owner-select policy (unchanged — currently inert because
-- authenticated has no table-level SELECT, which is intentional per M419)
-- DO NOT DROP capability_overrides_owner_select

-- ══════════════════════════════════════════════════════════
-- Verification
-- ══════════════════════════════════════════════════════════
DO $$
BEGIN
  -- 1. RLS enabled
  IF NOT (SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'capability_overrides') THEN
    RAISE EXCEPTION 'M422: RLS must remain enabled on capability_overrides';
  END IF;

  -- 2. anon has NO privileges
  IF has_table_privilege('anon', 'public.capability_overrides', 'SELECT') THEN
    RAISE EXCEPTION 'M422: anon must NOT have SELECT on capability_overrides';
  END IF;
  IF has_table_privilege('anon', 'public.capability_overrides', 'INSERT') THEN
    RAISE EXCEPTION 'M422: anon must NOT have INSERT on capability_overrides';
  END IF;

  -- 3. authenticated has NO privileges
  IF has_table_privilege('authenticated', 'public.capability_overrides', 'SELECT') THEN
    RAISE EXCEPTION 'M422: authenticated must NOT have SELECT on capability_overrides';
  END IF;
  IF has_table_privilege('authenticated', 'public.capability_overrides', 'INSERT') THEN
    RAISE EXCEPTION 'M422: authenticated must NOT have INSERT on capability_overrides';
  END IF;

  -- 4. service_role has SELECT only
  IF NOT has_table_privilege('service_role', 'public.capability_overrides', 'SELECT') THEN
    RAISE EXCEPTION 'M422: service_role must have SELECT on capability_overrides';
  END IF;
  IF has_table_privilege('service_role', 'public.capability_overrides', 'INSERT') THEN
    RAISE EXCEPTION 'M422: service_role must NOT have INSERT on capability_overrides (use SECURITY DEFINER RPCs)';
  END IF;

  -- 5. service_all policy exists with correct predicate
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polrelid = 'public.capability_overrides'::regclass
      AND polname = 'capability_overrides_service_all'
      AND pg_get_expr(polqual, polrelid) LIKE '%service_role%'
  ) THEN
    RAISE EXCEPTION 'M422: capability_overrides_service_all must use service_role predicate';
  END IF;

  -- 6. owner_select policy still exists
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polrelid = 'public.capability_overrides'::regclass
      AND polname = 'capability_overrides_owner_select'
  ) THEN
    RAISE EXCEPTION 'M422: capability_overrides_owner_select must still exist';
  END IF;

  RAISE NOTICE 'M422: All checks passed — capability_overrides security reconciliation complete';
END $$;
