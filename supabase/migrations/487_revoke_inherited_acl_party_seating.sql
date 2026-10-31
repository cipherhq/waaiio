-- M487: Revoke excess inherited ACL on party_tables and seating_resources
--
-- M457 and M476 granted authenticated but never revoked PUBLIC/anon.
-- M486 established the clean pattern (REVOKE FROM PUBLIC, anon first).
-- This migration brings the two older tables in line.
--
-- Intended access preserved:
--   party_tables:       authenticated → SELECT, INSERT, UPDATE, DELETE (dashboard CRUD, RLS-gated)
--                        service_role  → ALL (RPCs, atomic commit)
--   seating_resources:  authenticated → SELECT, INSERT, UPDATE (dashboard CRUD, RLS-gated)
--                        service_role  → SELECT, INSERT, UPDATE (bot, admin routes)
--
-- RLS policies: untouched (owner, admin, service_role policies remain).
BEGIN;

-- ═══════════════════════════════════════════════════════
-- 1. party_tables — revoke PUBLIC/anon, add explicit service_role
-- ═══════════════════════════════════════════════════════
REVOKE ALL ON public.party_tables FROM PUBLIC, anon;

-- Re-state authenticated grants (idempotent; M457 line 47 already granted these)
GRANT SELECT, INSERT, UPDATE, DELETE ON public.party_tables TO authenticated;

-- Explicit service_role grant (previously relied on BYPASSRLS only)
GRANT ALL ON public.party_tables TO service_role;

-- ═══════════════════════════════════════════════════════
-- 2. seating_resources — revoke PUBLIC/anon
-- ═══════════════════════════════════════════════════════
REVOKE ALL ON public.seating_resources FROM PUBLIC, anon;

-- Re-state authenticated grants (idempotent; M476 line 91)
GRANT SELECT, INSERT, UPDATE ON public.seating_resources TO authenticated;

-- Re-state service_role grants (idempotent; M476 line 347)
GRANT SELECT, INSERT, UPDATE ON public.seating_resources TO service_role;

-- ═══════════════════════════════════════════════════════
-- 3. Self-check: verify grants and denials
-- ═══════════════════════════════════════════════════════
DO $$
DECLARE
  v_pub  BOOLEAN;
  v_anon BOOLEAN;
  v_auth BOOLEAN;
  v_srvc BOOLEAN;
BEGIN
  -- party_tables: PUBLIC must have no grants
  SELECT EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
    WHERE table_schema = 'public' AND table_name = 'party_tables'
      AND grantee = 'PUBLIC'
  ) INTO v_pub;
  IF v_pub THEN
    RAISE EXCEPTION 'M487 SELF-CHECK FAILED: PUBLIC still has grants on party_tables';
  END IF;

  -- party_tables: anon must have no grants
  SELECT EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
    WHERE table_schema = 'public' AND table_name = 'party_tables'
      AND grantee = 'anon'
  ) INTO v_anon;
  IF v_anon THEN
    RAISE EXCEPTION 'M487 SELF-CHECK FAILED: anon still has grants on party_tables';
  END IF;

  -- party_tables: authenticated must have SELECT
  SELECT EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
    WHERE table_schema = 'public' AND table_name = 'party_tables'
      AND grantee = 'authenticated' AND privilege_type = 'SELECT'
  ) INTO v_auth;
  IF NOT v_auth THEN
    RAISE EXCEPTION 'M487 SELF-CHECK FAILED: authenticated lost SELECT on party_tables';
  END IF;

  -- party_tables: service_role must have SELECT
  SELECT EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
    WHERE table_schema = 'public' AND table_name = 'party_tables'
      AND grantee = 'service_role' AND privilege_type = 'SELECT'
  ) INTO v_srvc;
  IF NOT v_srvc THEN
    RAISE EXCEPTION 'M487 SELF-CHECK FAILED: service_role lost SELECT on party_tables';
  END IF;

  -- seating_resources: PUBLIC must have no grants
  SELECT EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
    WHERE table_schema = 'public' AND table_name = 'seating_resources'
      AND grantee = 'PUBLIC'
  ) INTO v_pub;
  IF v_pub THEN
    RAISE EXCEPTION 'M487 SELF-CHECK FAILED: PUBLIC still has grants on seating_resources';
  END IF;

  -- seating_resources: anon must have no grants
  SELECT EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
    WHERE table_schema = 'public' AND table_name = 'seating_resources'
      AND grantee = 'anon'
  ) INTO v_anon;
  IF v_anon THEN
    RAISE EXCEPTION 'M487 SELF-CHECK FAILED: anon still has grants on seating_resources';
  END IF;

  -- seating_resources: authenticated must have SELECT
  SELECT EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
    WHERE table_schema = 'public' AND table_name = 'seating_resources'
      AND grantee = 'authenticated' AND privilege_type = 'SELECT'
  ) INTO v_auth;
  IF NOT v_auth THEN
    RAISE EXCEPTION 'M487 SELF-CHECK FAILED: authenticated lost SELECT on seating_resources';
  END IF;

  -- seating_resources: service_role must have SELECT
  SELECT EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
    WHERE table_schema = 'public' AND table_name = 'seating_resources'
      AND grantee = 'service_role' AND privilege_type = 'SELECT'
  ) INTO v_srvc;
  IF NOT v_srvc THEN
    RAISE EXCEPTION 'M487 SELF-CHECK FAILED: service_role lost SELECT on seating_resources';
  END IF;

  -- RLS must still be enabled on both tables
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'party_tables' AND c.relrowsecurity = true
  ) THEN
    RAISE EXCEPTION 'M487 SELF-CHECK FAILED: RLS disabled on party_tables';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'seating_resources' AND c.relrowsecurity = true
  ) THEN
    RAISE EXCEPTION 'M487 SELF-CHECK FAILED: RLS disabled on seating_resources';
  END IF;

  RAISE NOTICE 'M487 SELF-CHECK PASSED: PUBLIC/anon revoked, authenticated/service_role preserved, RLS intact';
END;
$$;

COMMIT;
