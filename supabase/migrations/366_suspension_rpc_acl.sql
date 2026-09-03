-- ═══════════════════════════════════════════════════════
-- 366: Emergency Suspension RPC ACL Normalization (#287)
--
-- Corrects the EXECUTE privilege on toggle_messaging_suspension(uuid,boolean,text)
-- to match actual legitimate callers. Migration 363 intended to restrict EXECUTE
-- to authenticated only, but Supabase Cloud default function privileges
-- auto-granted EXECUTE to anon and service_role.
--
-- No legitimate anon or service_role caller exists. The sole production caller
-- is the Admin browser panel (admin/src/pages/Businesses.tsx) which invokes the
-- RPC via the authenticated PostgREST session.
--
-- The RPC body itself is NOT modified. The internal auth.uid() + is_admin()
-- authorization checks remain unchanged from Migration 363.
--
-- NOTE: Migration 363 line 132 contains a stale comment stating the column
-- UPDATE trigger "allows because current_user is superuser". The actual
-- guard boundary is function ownership (current_user = function owner),
-- not superuser status. Supabase Cloud postgres is non-superuser. This is
-- documentation debt only; the runtime behavior is correct.
-- ═══════════════════════════════════════════════════════

-- Normalize ACL: revoke from all roles, then grant only to authenticated.
-- Supabase default privileges require explicit per-role REVOKE.
REVOKE ALL ON FUNCTION public.toggle_messaging_suspension(UUID, BOOLEAN, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.toggle_messaging_suspension(UUID, BOOLEAN, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.toggle_messaging_suspension(UUID, BOOLEAN, TEXT) FROM authenticated;
REVOKE ALL ON FUNCTION public.toggle_messaging_suspension(UUID, BOOLEAN, TEXT) FROM service_role;
GRANT EXECUTE ON FUNCTION public.toggle_messaging_suspension(UUID, BOOLEAN, TEXT) TO authenticated;
