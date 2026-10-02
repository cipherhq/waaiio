-- 425: Normalize service_role ACL on export_rate_limits to M424 contract
--
-- Production divergence: ALTER DEFAULT PRIVILEGES (supabase_admin + postgres)
-- granted ALL table privileges to service_role when M424 created the table.
-- M424's REVOKE ALL stripped anon/authenticated but did not strip service_role's
-- inherited DELETE/TRUNCATE/REFERENCES/TRIGGER/MAINTAIN.
--
-- M424 intended contract: service_role = SELECT, INSERT, UPDATE only.
-- Application code uses only SELECT + UPSERT (no DELETE path exists).
--
-- Fix: REVOKE ALL then re-GRANT exactly SELECT/INSERT/UPDATE.
-- This directly encodes M424's intended final state and is idempotent.
--
-- Scope: table-specific only. No ALTER DEFAULT PRIVILEGES modification.
-- No application code changes. No RLS policy changes. No data changes.

-- ══════════════════════════════════════════════════════════
-- ACL normalization
-- ══════════════════════════════════════════════════════════

REVOKE ALL ON TABLE public.export_rate_limits FROM service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.export_rate_limits TO service_role;

-- ══════════════════════════════════════════════════════════
-- Verification
-- ══════════════════════════════════════════════════════════
DO $$
BEGIN
  -- 1. service_role has SELECT
  IF NOT has_table_privilege('service_role', 'public.export_rate_limits', 'SELECT') THEN
    RAISE EXCEPTION 'M425: service_role must have SELECT on export_rate_limits';
  END IF;

  -- 2. service_role has INSERT
  IF NOT has_table_privilege('service_role', 'public.export_rate_limits', 'INSERT') THEN
    RAISE EXCEPTION 'M425: service_role must have INSERT on export_rate_limits';
  END IF;

  -- 3. service_role has UPDATE
  IF NOT has_table_privilege('service_role', 'public.export_rate_limits', 'UPDATE') THEN
    RAISE EXCEPTION 'M425: service_role must have UPDATE on export_rate_limits';
  END IF;

  -- 4. service_role does NOT have DELETE
  IF has_table_privilege('service_role', 'public.export_rate_limits', 'DELETE') THEN
    RAISE EXCEPTION 'M425: service_role must NOT have DELETE on export_rate_limits';
  END IF;

  -- 5. service_role does NOT have TRUNCATE
  IF has_table_privilege('service_role', 'public.export_rate_limits', 'TRUNCATE') THEN
    RAISE EXCEPTION 'M425: service_role must NOT have TRUNCATE on export_rate_limits';
  END IF;

  -- 6. service_role does NOT have REFERENCES
  IF has_table_privilege('service_role', 'public.export_rate_limits', 'REFERENCES') THEN
    RAISE EXCEPTION 'M425: service_role must NOT have REFERENCES on export_rate_limits';
  END IF;

  -- 7. service_role does NOT have TRIGGER
  IF has_table_privilege('service_role', 'public.export_rate_limits', 'TRIGGER') THEN
    RAISE EXCEPTION 'M425: service_role must NOT have TRIGGER on export_rate_limits';
  END IF;

  -- 8. anon has NO access
  IF has_table_privilege('anon', 'public.export_rate_limits', 'SELECT') THEN
    RAISE EXCEPTION 'M425: anon must NOT have SELECT on export_rate_limits';
  END IF;

  -- 9. authenticated has NO access
  IF has_table_privilege('authenticated', 'public.export_rate_limits', 'SELECT') THEN
    RAISE EXCEPTION 'M425: authenticated must NOT have SELECT on export_rate_limits';
  END IF;

  -- 10. RLS remains enabled
  IF NOT (SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'export_rate_limits') THEN
    RAISE EXCEPTION 'M425: RLS must remain enabled on export_rate_limits';
  END IF;

  -- 11. service_role does NOT have MAINTAIN (PG17+ only)
  IF current_setting('server_version_num')::int >= 170000 THEN
    IF has_table_privilege('service_role', 'public.export_rate_limits', 'MAINTAIN') THEN
      RAISE EXCEPTION 'M425: service_role must NOT have MAINTAIN on export_rate_limits';
    END IF;
  END IF;

  -- 12. Service-only RLS policy remains intact
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polrelid = 'public.export_rate_limits'::regclass
      AND polname = 'export_rate_limits_service_only'
      AND pg_get_expr(polqual, polrelid) LIKE '%service_role%'
  ) THEN
    RAISE EXCEPTION 'M425: export_rate_limits_service_only policy must exist with service_role predicate';
  END IF;

  RAISE NOTICE 'M425: All 12 checks passed — export_rate_limits service_role ACL normalized to SELECT/INSERT/UPDATE only';
END $$;
