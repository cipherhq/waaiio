-- ═══════════════════════════════════════════════════════
-- 374: Normalize platform-role helper EXECUTE ACLs (#289)
--
-- Problem: Supabase Cloud default function privileges may leave
-- PUBLIC/anon EXECUTE grants on platform-role helpers. While the
-- helpers are fail-closed (return false for non-admin callers),
-- least-privilege requires revoking unnecessary EXECUTE.
--
-- Production evidence: these helpers are only called by:
--   1. RLS policies evaluated in authenticated context
--   2. SECURITY DEFINER RPCs that resolve internally
--   3. No direct application-code callers
--
-- Target ACL (proven by focused PostgreSQL evidence on #289):
--   PUBLIC:       no EXECUTE
--   anon:         no EXECUTE
--   authenticated: EXECUTE (required for RLS policy evaluation)
--   service_role:  no EXECUTE (has BYPASSRLS in production, never evaluates RLS)
--
-- No helper body changes. Definitions remain canonical, fail-closed,
-- SECURITY DEFINER, SET search_path = '', auth.users.raw_app_meta_data authority.
-- ═══════════════════════════════════════════════════════

-- ── is_admin() ──
REVOKE ALL ON FUNCTION public.is_admin() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_admin() FROM anon;
REVOKE ALL ON FUNCTION public.is_admin() FROM authenticated;
REVOKE ALL ON FUNCTION public.is_admin() FROM service_role;
GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated;

-- ── is_admin_or_support() ──
REVOKE ALL ON FUNCTION public.is_admin_or_support() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_admin_or_support() FROM anon;
REVOKE ALL ON FUNCTION public.is_admin_or_support() FROM authenticated;
REVOKE ALL ON FUNCTION public.is_admin_or_support() FROM service_role;
GRANT EXECUTE ON FUNCTION public.is_admin_or_support() TO authenticated;

-- ── is_admin_or_finance() ──
REVOKE ALL ON FUNCTION public.is_admin_or_finance() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_admin_or_finance() FROM anon;
REVOKE ALL ON FUNCTION public.is_admin_or_finance() FROM authenticated;
REVOKE ALL ON FUNCTION public.is_admin_or_finance() FROM service_role;
GRANT EXECUTE ON FUNCTION public.is_admin_or_finance() TO authenticated;

-- ── Verification ──
DO $$
DECLARE
  v_fn TEXT;
  v_fns TEXT[] := ARRAY['is_admin()', 'is_admin_or_support()', 'is_admin_or_finance()'];
BEGIN
  FOREACH v_fn IN ARRAY v_fns
  LOOP
    -- authenticated must have EXECUTE
    IF NOT has_function_privilege('authenticated', 'public.' || v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'MIGRATION 374 FAILED: authenticated lacks EXECUTE on %', v_fn;
    END IF;

    -- anon must NOT have EXECUTE
    IF has_function_privilege('anon', 'public.' || v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'MIGRATION 374 FAILED: anon still has EXECUTE on %', v_fn;
    END IF;

    -- service_role must NOT have EXECUTE
    IF has_function_privilege('service_role', 'public.' || v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'MIGRATION 374 FAILED: service_role still has EXECUTE on %', v_fn;
    END IF;
  END LOOP;

  RAISE NOTICE 'MIGRATION 374 VERIFICATION: All ACL checks passed — authenticated-only EXECUTE confirmed';
END;
$$;
