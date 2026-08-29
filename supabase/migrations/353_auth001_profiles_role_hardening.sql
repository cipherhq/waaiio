-- ══════════════════════════════════════════════════════════════════════
-- 353 — AUTH-001 Convergence: profiles role-escalation hardening
-- ══════════════════════════════════════════════════════════════════════
--
-- Context: Migration 247_admin_role_escalation_fix.sql applied the
-- AUTH-001 fix on production, but staging had a different migration
-- with the same 247 number (migration number collision). As a result,
-- staging never received the AUTH-001 protections.
--
-- This migration is fully idempotent — every statement uses
-- DROP IF EXISTS / CREATE OR REPLACE / REVOKE (idempotent by nature)
-- so it safely converges both environments:
--   - Production (already has 247 protections) → no-op re-application
--   - Staging (missing 247 protections)        → applies all fixes
--
-- What it does NOT touch (tracked separately):
--   - is_admin_or_finance() — already correct
--   - is_support() — tracked in Issue #217
--   - 30+ inline RLS policies — tracked in Issue #217
-- ══════════════════════════════════════════════════════════════════════

-- ══════════════════════════════════════════════════════════
-- A. Replace the permissive FOR ALL policy with restricted policies
-- ══════════════════════════════════════════════════════════

-- Drop the overly-permissive FOR ALL policy that allows role self-escalation
DROP POLICY IF EXISTS "Users manage own profile" ON public.profiles;

-- Drop-before-create for idempotency on the replacement policies
DROP POLICY IF EXISTS "profiles_select_own" ON public.profiles;
CREATE POLICY "profiles_select_own"
  ON public.profiles FOR SELECT
  USING (id = auth.uid());

DROP POLICY IF EXISTS "profiles_update_own" ON public.profiles;
CREATE POLICY "profiles_update_own"
  ON public.profiles FOR UPDATE
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid());

-- No INSERT policy for authenticated users.
-- Profiles are created exclusively by the trusted handle_new_user() trigger
-- (SECURITY DEFINER, fired on auth.users INSERT).

-- ══════════════════════════════════════════════════════════
-- B. Column-level least privilege for authenticated users
-- ══════════════════════════════════════════════════════════

-- Revoke broad table privileges from authenticated, grant only what's needed.
-- Approved UPDATE fields: first_name, last_name, email, phone, last_login_at, updated_at.
-- NOT approved: role, id, created_at.
-- No INSERT grant — profiles created by trusted trigger only.
REVOKE ALL ON TABLE public.profiles FROM authenticated;
GRANT SELECT ON TABLE public.profiles TO authenticated;
GRANT UPDATE (first_name, last_name, email, phone, last_login_at, updated_at)
  ON TABLE public.profiles TO authenticated;

-- Preserve full access for service_role (admin provisioning, bot user creation)
GRANT ALL ON TABLE public.profiles TO service_role;

-- ══════════════════════════════════════════════════════════
-- C. Defense-in-depth triggers: reject unauthorized role changes
-- ══════════════════════════════════════════════════════════

-- UPDATE trigger: reject role changes from untrusted clients
CREATE OR REPLACE FUNCTION public.protect_profiles_role()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- Allow if role is not being changed
  IF OLD.role IS NOT DISTINCT FROM NEW.role THEN
    RETURN NEW;
  END IF;

  -- Allow if the current session is service_role (trusted server-side operations)
  IF current_setting('request.jwt.claim.role', true) = 'service_role' THEN
    RETURN NEW;
  END IF;

  -- Allow if executed by the database owner (migrations, maintenance)
  IF current_setting('role', true) NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;

  -- Reject: untrusted client attempting to change role
  RAISE EXCEPTION 'Unauthorized: profile role cannot be changed by the client'
    USING ERRCODE = '42501'; -- insufficient_privilege
END;
$$;

REVOKE EXECUTE ON FUNCTION public.protect_profiles_role() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.protect_profiles_role() FROM anon;
REVOKE EXECUTE ON FUNCTION public.protect_profiles_role() FROM authenticated;

DROP TRIGGER IF EXISTS trg_protect_profiles_role ON public.profiles;
CREATE TRIGGER trg_protect_profiles_role
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.protect_profiles_role();

-- INSERT trigger: normalize role on any direct insert (defense-in-depth)
CREATE OR REPLACE FUNCTION public.protect_profiles_role_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- Allow service_role and database owner to insert any role
  IF current_setting('request.jwt.claim.role', true) = 'service_role' THEN
    RETURN NEW;
  END IF;
  IF current_setting('role', true) NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;

  -- Force default role for untrusted clients
  NEW.role := 'restaurant_owner';
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.protect_profiles_role_insert() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.protect_profiles_role_insert() FROM anon;
REVOKE EXECUTE ON FUNCTION public.protect_profiles_role_insert() FROM authenticated;

DROP TRIGGER IF EXISTS trg_protect_profiles_role_insert ON public.profiles;
CREATE TRIGGER trg_protect_profiles_role_insert
  BEFORE INSERT ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.protect_profiles_role_insert();

-- ══════════════════════════════════════════════════════════
-- D. Redefine is_admin() to use auth.users raw_app_meta_data
-- ══════════════════════════════════════════════════════════

-- The canonical administrator authority is auth.users.raw_app_meta_data.role.
-- (Supabase stores app_metadata in the raw_app_meta_data column.)
-- profiles.role is no longer trusted for platform admin decisions.
--
-- This uses a SECURITY DEFINER function that reads auth.users directly,
-- which is the authoritative server-side source. Changes take effect
-- immediately on the next query — no token refresh required.

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_role text;
BEGIN
  SELECT raw_app_meta_data ->> 'role'
  INTO v_role
  FROM auth.users
  WHERE id = auth.uid();

  RETURN COALESCE(v_role = 'admin', false);
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION public.is_admin_or_support()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_role text;
BEGIN
  SELECT raw_app_meta_data ->> 'role'
  INTO v_role
  FROM auth.users
  WHERE id = auth.uid();

  RETURN COALESCE(v_role IN ('admin', 'support', 'finance', 'operations'), false);
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$$;

-- Restrict function execution
REVOKE EXECUTE ON FUNCTION public.is_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.is_admin_or_support() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_admin_or_support() TO authenticated, service_role;

-- ══════════════════════════════════════════════════════════
-- E. Verification: fail loudly if any protection is missing
-- ══════════════════════════════════════════════════════════

DO $$
DECLARE
  v_can_update_role boolean;
  v_update_trigger_exists boolean;
  v_insert_trigger_exists boolean;
  v_is_admin_secdef boolean;
BEGIN
  -- Check 1: authenticated must NOT be able to UPDATE the role column
  SELECT has_column_privilege('authenticated', 'public.profiles', 'role', 'UPDATE')
  INTO v_can_update_role;

  IF v_can_update_role THEN
    RAISE EXCEPTION '[AUTH-001 VERIFY] FAILED: authenticated can still UPDATE profiles.role';
  END IF;

  -- Check 2: BEFORE UPDATE trigger must exist
  SELECT EXISTS (
    SELECT 1 FROM information_schema.triggers
    WHERE event_object_schema = 'public'
      AND event_object_table = 'profiles'
      AND trigger_name = 'trg_protect_profiles_role'
      AND action_timing = 'BEFORE'
      AND event_manipulation = 'UPDATE'
  ) INTO v_update_trigger_exists;

  IF NOT v_update_trigger_exists THEN
    RAISE EXCEPTION '[AUTH-001 VERIFY] FAILED: trg_protect_profiles_role trigger missing';
  END IF;

  -- Check 3: BEFORE INSERT trigger must exist
  SELECT EXISTS (
    SELECT 1 FROM information_schema.triggers
    WHERE event_object_schema = 'public'
      AND event_object_table = 'profiles'
      AND trigger_name = 'trg_protect_profiles_role_insert'
      AND action_timing = 'BEFORE'
      AND event_manipulation = 'INSERT'
  ) INTO v_insert_trigger_exists;

  IF NOT v_insert_trigger_exists THEN
    RAISE EXCEPTION '[AUTH-001 VERIFY] FAILED: trg_protect_profiles_role_insert trigger missing';
  END IF;

  -- Check 4: is_admin() must be SECURITY DEFINER
  SELECT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'is_admin'
      AND p.proargtypes::text = ''
      AND p.prosecdef = true
  ) INTO v_is_admin_secdef;

  IF NOT v_is_admin_secdef THEN
    RAISE EXCEPTION '[AUTH-001 VERIFY] FAILED: is_admin() is not SECURITY DEFINER';
  END IF;

  RAISE NOTICE '[AUTH-001 VERIFY] All checks passed — profiles role hardening is active';
END;
$$;
