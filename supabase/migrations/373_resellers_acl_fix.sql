-- ═══════════════════════════════════════════════════════
-- 373: Fix missing GRANT SELECT on resellers for authenticated role
--
-- Root cause: Migration 205 created RLS policies on businesses that
-- reference the resellers table (e.g. "Resellers view sub-businesses"
-- does: reseller_id IN (SELECT id FROM resellers WHERE user_id = auth.uid())).
-- However, the authenticated role was never granted SELECT on resellers,
-- causing "permission denied for table resellers" when any businesses
-- RLS policy evaluation touches the reseller subquery.
--
-- This defect was masked in production Supabase where the authenticated
-- role has broader default grants, and in monolithic CI where earlier
-- test steps accidentally established the necessary permissions.
--
-- Fix: grant SELECT to authenticated (matches canonical Supabase semantics).
-- The "Resellers manage own record" RLS policy already restricts visibility
-- to user_id = auth.uid(), so this grant does not expose data beyond
-- the existing policy boundary.
-- ═══════════════════════════════════════════════════════

-- Grant SELECT so RLS policy subqueries can execute
GRANT SELECT ON public.resellers TO authenticated;

-- Verification
DO $$
DECLARE
  v_count INTEGER;
BEGIN
  SELECT count(*) INTO v_count
  FROM information_schema.role_table_grants
  WHERE table_schema = 'public'
    AND table_name = 'resellers'
    AND grantee = 'authenticated'
    AND privilege_type = 'SELECT';

  IF v_count = 0 THEN
    RAISE EXCEPTION 'MIGRATION 373 VERIFICATION FAILED: authenticated role does not have SELECT on resellers';
  END IF;

  RAISE NOTICE 'MIGRATION 373 VERIFICATION: authenticated has SELECT on resellers';
END;
$$;
