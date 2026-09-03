-- ═══════════════════════════════════════════════════════
-- 365: Platform Role Authority Migration (#217)
--
-- Eliminates all profiles.role authorization paths.
-- Canonical authority: auth.users.raw_app_meta_data.role
--
-- Changes:
-- 1. Add has_platform_role(text[]) helper — exact role array matching
-- 2. Redefine is_support() to read canonical source
-- 3. Replace 4 inline RLS policies with has_platform_role() calls
-- 4. Normalize ACLs for touched helpers
-- ═══════════════════════════════════════════════════════

-- ── 1. has_platform_role(text[]) ──
-- Exact role-set matching against canonical authority.
-- Fail-closed: returns false on NULL uid, missing user, or NULL role.
-- No RLS recursion: auth.users has no RLS.

CREATE OR REPLACE FUNCTION public.has_platform_role(p_roles text[])
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

  RETURN COALESCE(v_role = ANY(p_roles), false);
END;
$$;

-- ACL: Supabase default privileges auto-grant EXECUTE to anon/authenticated/service_role.
-- Explicitly revoke from all, then grant only to accepted callers.
REVOKE ALL ON FUNCTION public.has_platform_role(text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.has_platform_role(text[]) FROM anon;
REVOKE ALL ON FUNCTION public.has_platform_role(text[]) FROM authenticated;
REVOKE ALL ON FUNCTION public.has_platform_role(text[]) FROM service_role;
GRANT EXECUTE ON FUNCTION public.has_platform_role(text[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.has_platform_role(text[]) TO service_role;

-- ── 2. Redefine is_support() ──
-- Was: reads profiles.role (untrusted, migration 069)
-- Now: reads auth.users.raw_app_meta_data (canonical)
-- Semantics unchanged: admin + support

CREATE OR REPLACE FUNCTION public.is_support()
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

  RETURN COALESCE(v_role IN ('admin', 'support'), false);
END;
$$;

-- Normalize ACL (was PUBLIC — migration 069 never restricted it)
REVOKE ALL ON FUNCTION public.is_support() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_support() FROM anon;
REVOKE ALL ON FUNCTION public.is_support() FROM authenticated;
REVOKE ALL ON FUNCTION public.is_support() FROM service_role;
GRANT EXECUTE ON FUNCTION public.is_support() TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_support() TO service_role;

-- ── 3. Replace inline RLS policies ──
-- Each policy preserves its exact current authorized role set.
-- Source changes from profiles.role (untrusted) to has_platform_role() (canonical).

-- demo_requests SELECT: admin/support/operations (NOT finance)
DROP POLICY IF EXISTS "admin_select_demo_requests" ON demo_requests;
CREATE POLICY "admin_select_demo_requests" ON demo_requests
  FOR SELECT USING (has_platform_role(ARRAY['admin','support','operations']));

-- demo_requests UPDATE: admin/support only (NOT finance/operations)
DROP POLICY IF EXISTS "admin_update_demo_requests" ON demo_requests;
CREATE POLICY "admin_update_demo_requests" ON demo_requests
  FOR UPDATE USING (has_platform_role(ARRAY['admin','support']));

-- attendance_log SELECT: admin/operations only (NOT support/finance)
DROP POLICY IF EXISTS "admin_ops_read" ON attendance_log;
CREATE POLICY "admin_ops_read" ON attendance_log
  FOR SELECT USING (has_platform_role(ARRAY['admin','operations']));

-- ai_classification_log SELECT: admin/operations only (NOT support/finance)
DROP POLICY IF EXISTS "admin_read" ON ai_classification_log;
CREATE POLICY "admin_read" ON ai_classification_log
  FOR SELECT USING (has_platform_role(ARRAY['admin','operations']));
