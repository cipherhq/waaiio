-- Restrict process_recurring_charge RPC execution permissions
--
-- Migration 244 applied REVOKE ALL ON FUNCTION process_recurring_charge FROM PUBLIC
-- and GRANT EXECUTE TO service_role. However, production verification found that
-- anon and authenticated still have direct EXECUTE grants that pre-date Migration 244.
--
-- REVOKE ... FROM PUBLIC only removes the PUBLIC pseudo-role grant; it does NOT
-- remove direct role-specific grants to anon or authenticated. This forward migration
-- explicitly revokes those direct grants.
--
-- This migration does NOT modify the function body, owner, SECURITY DEFINER setting,
-- search_path, or any finance logic. It only adjusts EXECUTE privileges.
--
-- Idempotency: REVOKE is naturally idempotent in PostgreSQL (revoking a privilege
-- that doesn't exist is a no-op). Role existence checks prevent errors in bare
-- PostgreSQL CI environments where Supabase roles may not exist.

DO $$
BEGIN
  -- REVOKE from PUBLIC always works (idempotent, no role check needed)
  REVOKE EXECUTE ON FUNCTION public.process_recurring_charge(text, text, text, text, text, bigint, text, text, text, text) FROM PUBLIC;

  -- Revoke direct grant from anon (if role exists)
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE EXECUTE ON FUNCTION public.process_recurring_charge(text, text, text, text, text, bigint, text, text, text, text) FROM anon;
  END IF;

  -- Revoke direct grant from authenticated (if role exists)
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE EXECUTE ON FUNCTION public.process_recurring_charge(text, text, text, text, text, bigint, text, text, text, text) FROM authenticated;
  END IF;

  -- Ensure service_role retains EXECUTE (idempotent grant)
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.process_recurring_charge(text, text, text, text, text, bigint, text, text, text, text) TO service_role;
  END IF;
END
$$;
