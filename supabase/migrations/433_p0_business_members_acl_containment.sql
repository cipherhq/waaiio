-- ═══════════════════════════════════════════════════════════════════
-- 433: P0 SECURITY — business_members authorization containment
-- ═══════════════════════════════════════════════════════════════════
--
-- ROOT CAUSE (099_business_members.sql):
--   CREATE POLICY business_members_manage ON business_members FOR ALL USING (
--     business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid())
--     OR user_id = auth.uid()
--   );
--
--   FOR ALL + "OR user_id = auth.uid()" allows any authenticated user to
--   INSERT themselves as an active member of ANY business. The USING clause
--   doubles as WITH CHECK on INSERT when no explicit WITH CHECK is set.
--
--   Combined with production default privileges granting full DML
--   (authenticated=arwdDxtm), this is a direct authorization bypass.
--
-- DOWNSTREAM IMPACT if exploited:
--   • chat_conversations: team_members_view_conversations (SELECT)
--   • chat_messages: team_members_view_messages (SELECT)
--   • chat_messages: team_members_send_messages (INSERT outbound)
--   • promo_campaigns/prizes/code_batches/redemptions/verification_attempts (SELECT)
--
-- FIX:
--   1. Revoke INSERT/UPDATE/DELETE from authenticated + anon
--   2. Replace FOR ALL policy with SELECT-only for authenticated
--   3. All legitimate mutations go through service_role API routes:
--      • /api/team (POST=invite, DELETE=remove, PATCH=role change)
--      • /api/team/accept (POST=accept invite)
--
-- DEPENDENCIES: M099 (creates table+policy), M415 (service_role grants).
--   M432 (engage_segments_acl, PR #581) is independent — no interaction.
-- ROLLBACK: Re-grant and recreate the old policy (not recommended).
-- ═══════════════════════════════════════════════════════════════════

-- Phase 1: Revoke client-side DML privileges
-- These were inherited from ALTER DEFAULT PRIVILEGES, not explicit GRANTs.
-- REVOKE is idempotent — safe to run even if already revoked.
REVOKE INSERT, UPDATE, DELETE ON public.business_members FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.business_members FROM anon;

-- Phase 2: Replace overly permissive FOR ALL policy with SELECT-only
DROP POLICY IF EXISTS business_members_manage ON business_members;

-- Authenticated users can read:
--   • All members of businesses they own (for team management dashboard)
--   • Their own membership row (for role/status checks)
CREATE POLICY business_members_select ON business_members
  FOR SELECT TO authenticated
  USING (
    business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid())
    OR user_id = auth.uid()
  );

-- service_role retains full access via existing business_members_service policy
-- (created in 099, unchanged: FOR ALL USING (auth.role() = 'service_role'))

-- Phase 3: Fail-closed verification assertions
DO $$
BEGIN
  -- Verify authenticated cannot INSERT
  IF has_table_privilege('authenticated', 'public.business_members', 'INSERT') THEN
    RAISE EXCEPTION 'M433: authenticated must NOT have INSERT on business_members';
  END IF;

  -- Verify authenticated cannot UPDATE
  IF has_table_privilege('authenticated', 'public.business_members', 'UPDATE') THEN
    RAISE EXCEPTION 'M433: authenticated must NOT have UPDATE on business_members';
  END IF;

  -- Verify authenticated cannot DELETE
  IF has_table_privilege('authenticated', 'public.business_members', 'DELETE') THEN
    RAISE EXCEPTION 'M433: authenticated must NOT have DELETE on business_members';
  END IF;

  -- Verify authenticated retains SELECT (needed for dashboard reads)
  IF NOT has_table_privilege('authenticated', 'public.business_members', 'SELECT') THEN
    RAISE EXCEPTION 'M433: authenticated must retain SELECT on business_members';
  END IF;

  -- Verify anon has no DML
  IF has_table_privilege('anon', 'public.business_members', 'INSERT') THEN
    RAISE EXCEPTION 'M433: anon must NOT have INSERT on business_members';
  END IF;
  IF has_table_privilege('anon', 'public.business_members', 'UPDATE') THEN
    RAISE EXCEPTION 'M433: anon must NOT have UPDATE on business_members';
  END IF;
  IF has_table_privilege('anon', 'public.business_members', 'DELETE') THEN
    RAISE EXCEPTION 'M433: anon must NOT have DELETE on business_members';
  END IF;

  -- Verify service_role retains full access
  IF NOT has_table_privilege('service_role', 'public.business_members', 'INSERT') THEN
    RAISE EXCEPTION 'M433: service_role must retain INSERT on business_members';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.business_members', 'SELECT') THEN
    RAISE EXCEPTION 'M433: service_role must retain SELECT on business_members';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.business_members', 'UPDATE') THEN
    RAISE EXCEPTION 'M433: service_role must retain UPDATE on business_members';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.business_members', 'DELETE') THEN
    RAISE EXCEPTION 'M433: service_role must retain DELETE on business_members';
  END IF;

  -- Verify RLS still enabled
  IF NOT (SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'business_members') THEN
    RAISE EXCEPTION 'M433: RLS must remain enabled on business_members';
  END IF;

  -- Verify the old vulnerable policy no longer exists
  IF EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'business_members' AND policyname = 'business_members_manage') THEN
    RAISE EXCEPTION 'M433: vulnerable business_members_manage policy must be dropped';
  END IF;

  -- Verify the new SELECT-only policy exists
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'business_members' AND policyname = 'business_members_select' AND cmd = 'SELECT') THEN
    RAISE EXCEPTION 'M433: business_members_select SELECT policy must exist';
  END IF;

  RAISE NOTICE 'M433: All 14 privilege + policy assertions passed — business_members containment verified';
END $$;
