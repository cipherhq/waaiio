-- ═══════════════════════════════════════════════════════════════════
-- 432: P0 SECURITY — business_members authorization containment
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
-- HISTORICAL: 0 rows in business_members — no exploitation detected.
--
-- FIX:
--   1. Revoke INSERT/UPDATE/DELETE from authenticated + anon
--   2. Replace FOR ALL policy with SELECT-only for authenticated
--   3. All legitimate mutations go through service_role API routes:
--      • /api/team (POST=invite, DELETE=remove, PATCH=role change)
--      • /api/team/accept (POST=accept invite)
--
-- DEPENDENCIES: None. Migration 415 already granted service_role full DML.
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
