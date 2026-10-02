-- 421: platform_settings security reconciliation
--
-- Launch blocker: middleware reads signup_open and maintenance_mode via SSR
-- client (anon role for unauthenticated visitors). The current
-- public_read_config_settings allowlist only has 4 keys, and anon cannot
-- EXECUTE is_admin(), so the admin_all_platform_settings policy errors
-- instead of returning false.
--
-- Fix:
-- 1. Grant anon + authenticated SELECT (for RLS reads).
-- 2. Revoke INSERT/UPDATE/DELETE from anon + authenticated.
-- 3. Rewrite admin_all_platform_settings to target authenticated only.
-- 4. Expand public_read_config_settings to 6 keys (add signup_open, maintenance_mode).
-- 5. Grant service_role INSERT + DELETE (for OTP upsert/delete and export rate limit,
--    until those are migrated out of platform_settings).
--
-- Preserves: RLS enabled, commercial-key trigger guard, SECURITY DEFINER RPCs.
-- Idempotent: GRANT/REVOKE are no-ops when state already matches.
-- Works on both staging (no table privileges) and production (broad ALTER DEFAULT PRIVILEGES).

-- ══════════════════════════════════════════════════════════
-- Table-level privilege reconciliation
-- ══════════════════════════════════════════════════════════

-- anon: SELECT only (for public_read_config_settings RLS policy)
GRANT SELECT ON public.platform_settings TO anon;
REVOKE INSERT, UPDATE, DELETE ON public.platform_settings FROM anon;

-- authenticated: SELECT only (for admin_all + public_read RLS policies;
-- admin writes go through service_role server routes or SECURITY DEFINER RPCs)
GRANT SELECT ON public.platform_settings TO authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.platform_settings FROM authenticated;

-- service_role: full CRUD for server-authorized operations
-- SELECT: M408 (existing)
-- UPDATE: M420 (existing, site-announcement)
-- INSERT: OTP upsert, export rate limit (until migrated out)
-- DELETE: OTP cleanup, export rate limit (until migrated out)
GRANT INSERT, DELETE ON public.platform_settings TO service_role;

-- ══════════════════════════════════════════════════════════
-- RLS policy reconciliation
-- ══════════════════════════════════════════════════════════

-- Drop and recreate admin_all_platform_settings targeting authenticated only.
-- The old policy targets all roles (polroles = {-}), which forces anon to
-- evaluate is_admin() — anon lacks EXECUTE on is_admin(), causing a
-- "permission denied for function is_admin" error on every query.
DROP POLICY IF EXISTS admin_all_platform_settings ON public.platform_settings;
CREATE POLICY admin_all_platform_settings ON public.platform_settings
  FOR ALL
  TO authenticated
  USING (is_admin())
  WITH CHECK (is_admin());

-- Drop and recreate public_read_config_settings with 6 keys.
-- Add signup_open and maintenance_mode for middleware access.
DROP POLICY IF EXISTS public_read_config_settings ON public.platform_settings;
CREATE POLICY public_read_config_settings ON public.platform_settings
  FOR SELECT
  USING (
    (key)::text = ANY (ARRAY[
      'pricing_tiers', 'broadcast_limits', 'trial_days', 'booking_defaults',
      'signup_open', 'maintenance_mode'
    ]::text[])
  );

-- ══════════════════════════════════════════════════════════
-- Verification
-- ══════════════════════════════════════════════════════════
DO $$
BEGIN
  -- 1. RLS still enabled
  IF NOT (SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'platform_settings') THEN
    RAISE EXCEPTION 'M421: RLS must remain enabled on platform_settings';
  END IF;

  -- 2. anon CAN SELECT (for public config reads via RLS)
  IF NOT has_table_privilege('anon', 'public.platform_settings', 'SELECT') THEN
    RAISE EXCEPTION 'M421: anon must have SELECT on platform_settings';
  END IF;

  -- 3. anon CANNOT INSERT/UPDATE/DELETE
  IF has_table_privilege('anon', 'public.platform_settings', 'INSERT') THEN
    RAISE EXCEPTION 'M421: anon must NOT have INSERT on platform_settings';
  END IF;
  IF has_table_privilege('anon', 'public.platform_settings', 'UPDATE') THEN
    RAISE EXCEPTION 'M421: anon must NOT have UPDATE on platform_settings';
  END IF;
  IF has_table_privilege('anon', 'public.platform_settings', 'DELETE') THEN
    RAISE EXCEPTION 'M421: anon must NOT have DELETE on platform_settings';
  END IF;

  -- 4. authenticated CAN SELECT
  IF NOT has_table_privilege('authenticated', 'public.platform_settings', 'SELECT') THEN
    RAISE EXCEPTION 'M421: authenticated must have SELECT on platform_settings';
  END IF;

  -- 5. authenticated CANNOT INSERT/UPDATE/DELETE
  IF has_table_privilege('authenticated', 'public.platform_settings', 'INSERT') THEN
    RAISE EXCEPTION 'M421: authenticated must NOT have INSERT on platform_settings';
  END IF;
  IF has_table_privilege('authenticated', 'public.platform_settings', 'UPDATE') THEN
    RAISE EXCEPTION 'M421: authenticated must NOT have UPDATE on platform_settings';
  END IF;
  IF has_table_privilege('authenticated', 'public.platform_settings', 'DELETE') THEN
    RAISE EXCEPTION 'M421: authenticated must NOT have DELETE on platform_settings';
  END IF;

  -- 6. service_role has full CRUD
  IF NOT has_table_privilege('service_role', 'public.platform_settings', 'SELECT') THEN
    RAISE EXCEPTION 'M421: service_role must have SELECT on platform_settings';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.platform_settings', 'INSERT') THEN
    RAISE EXCEPTION 'M421: service_role must have INSERT on platform_settings';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.platform_settings', 'UPDATE') THEN
    RAISE EXCEPTION 'M421: service_role must have UPDATE on platform_settings';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.platform_settings', 'DELETE') THEN
    RAISE EXCEPTION 'M421: service_role must have DELETE on platform_settings';
  END IF;

  -- 7. admin_all_platform_settings policy exists and targets authenticated only
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polrelid = 'public.platform_settings'::regclass
      AND polname = 'admin_all_platform_settings'
      AND polroles @> ARRAY[(SELECT oid FROM pg_roles WHERE rolname = 'authenticated')]
  ) THEN
    RAISE EXCEPTION 'M421: admin_all_platform_settings must exist and target authenticated';
  END IF;

  -- 8. public_read_config_settings policy exists
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polrelid = 'public.platform_settings'::regclass
      AND polname = 'public_read_config_settings'
  ) THEN
    RAISE EXCEPTION 'M421: public_read_config_settings must exist';
  END IF;

  RAISE NOTICE 'M421: All checks passed — platform_settings security reconciliation complete';
END $$;
