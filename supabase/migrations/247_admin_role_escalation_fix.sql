-- AUTH-001: Prevent authenticated users from self-escalating to platform administrator.
--
-- Root cause: The "Users manage own profile" policy grants FOR ALL (including UPDATE)
-- on all columns. An authenticated user can SET role = 'admin' on their own profile,
-- causing is_admin() to return true and granting full platform admin access.
--
-- Fix:
-- 1. Replace FOR ALL with operation-specific policies (SELECT, UPDATE only).
-- 2. Remove authenticated INSERT (profiles created by trusted auth trigger only).
-- 3. Restrict UPDATE to approved personal fields only (column-level grant).
-- 4. Add BEFORE UPDATE and BEFORE INSERT triggers that reject unauthorized role changes.
-- 5. Redefine is_admin() to use auth.users raw_app_meta_data instead of profiles.role.

-- ══════════════════════════════════════════════════════════
-- A. Replace the permissive FOR ALL policy with restricted policies
-- ══════════════════════════════════════════════════════════

DROP POLICY IF EXISTS "Users manage own profile" ON public.profiles;

-- Users can always read their own profile
CREATE POLICY "profiles_select_own"
  ON public.profiles FOR SELECT
  USING (id = auth.uid());

-- No INSERT policy for authenticated users.
-- Profiles are created exclusively by the trusted handle_new_user() trigger
-- (SECURITY DEFINER, fired on auth.users INSERT). No application code
-- directly INSERTs into profiles from an authenticated browser client.

-- Users can update their own profile (column restriction enforced separately)
CREATE POLICY "profiles_update_own"
  ON public.profiles FOR UPDATE
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid());

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
