-- 432: Corrective ACL for engage_segments (#557)
--
-- M431 creates engage_segments but has no explicit table GRANT.
-- Supabase Cloud has NO default ACL for public-schema tables granting
-- service_role access (verified via pg_default_acl MCP query).
-- service_role has BYPASSRLS but NOT table DML privileges without GRANT.
--
-- Engage API routes use createServiceClient() for direct table CRUD.
-- Without this grant, all Engage segment operations fail with
-- "permission denied for table engage_segments".
--
-- Apply atomically with M431 on first staging/production application.

-- ══════════════════════════════════════════════════════════
-- Privilege contract: service_role CRUD, deny anon/authenticated
-- ══════════════════════════════════════════════════════════

REVOKE ALL ON TABLE public.engage_segments FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.engage_segments TO service_role;

-- ══════════════════════════════════════════════════════════
-- Verification: 9 privilege assertions
-- ══════════════════════════════════════════════════════════
DO $$
BEGIN
  -- service_role: all four CRUD allowed
  IF NOT has_table_privilege('service_role', 'public.engage_segments', 'SELECT') THEN
    RAISE EXCEPTION 'M432: service_role must have SELECT on engage_segments';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.engage_segments', 'INSERT') THEN
    RAISE EXCEPTION 'M432: service_role must have INSERT on engage_segments';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.engage_segments', 'UPDATE') THEN
    RAISE EXCEPTION 'M432: service_role must have UPDATE on engage_segments';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.engage_segments', 'DELETE') THEN
    RAISE EXCEPTION 'M432: service_role must have DELETE on engage_segments';
  END IF;

  -- anon: all four denied
  IF has_table_privilege('anon', 'public.engage_segments', 'SELECT') THEN
    RAISE EXCEPTION 'M432: anon must NOT have SELECT on engage_segments';
  END IF;
  IF has_table_privilege('anon', 'public.engage_segments', 'INSERT') THEN
    RAISE EXCEPTION 'M432: anon must NOT have INSERT on engage_segments';
  END IF;
  IF has_table_privilege('anon', 'public.engage_segments', 'UPDATE') THEN
    RAISE EXCEPTION 'M432: anon must NOT have UPDATE on engage_segments';
  END IF;
  IF has_table_privilege('anon', 'public.engage_segments', 'DELETE') THEN
    RAISE EXCEPTION 'M432: anon must NOT have DELETE on engage_segments';
  END IF;

  -- authenticated: all four denied
  IF has_table_privilege('authenticated', 'public.engage_segments', 'SELECT') THEN
    RAISE EXCEPTION 'M432: authenticated must NOT have SELECT on engage_segments';
  END IF;
  IF has_table_privilege('authenticated', 'public.engage_segments', 'INSERT') THEN
    RAISE EXCEPTION 'M432: authenticated must NOT have INSERT on engage_segments';
  END IF;
  IF has_table_privilege('authenticated', 'public.engage_segments', 'UPDATE') THEN
    RAISE EXCEPTION 'M432: authenticated must NOT have UPDATE on engage_segments';
  END IF;
  IF has_table_privilege('authenticated', 'public.engage_segments', 'DELETE') THEN
    RAISE EXCEPTION 'M432: authenticated must NOT have DELETE on engage_segments';
  END IF;

  -- RLS still enabled (defense in depth from M431)
  IF NOT (SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'engage_segments') THEN
    RAISE EXCEPTION 'M432: RLS must remain enabled on engage_segments';
  END IF;

  RAISE NOTICE 'M432: All 13 privilege checks passed — service_role CRUD granted, anon/authenticated fully denied, RLS enabled';
END $$;
