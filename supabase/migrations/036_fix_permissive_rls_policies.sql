-- Migration: Fix remaining overly-permissive RLS policies
-- These policies used USING (true) or WITH CHECK (true) allowing unrestricted access.
-- Tighten them to require service_role for server-only operations.

-- ============================================================
-- 1. chat_conversations — restrict service INSERT/UPDATE to service_role
-- ============================================================
DROP POLICY IF EXISTS "chat_conversations_service_insert" ON chat_conversations;
CREATE POLICY "chat_conversations_service_insert" ON chat_conversations
  FOR INSERT WITH CHECK (auth.role() = 'service_role');

DROP POLICY IF EXISTS "chat_conversations_service_update" ON chat_conversations;
CREATE POLICY "chat_conversations_service_update" ON chat_conversations
  FOR UPDATE USING (auth.role() = 'service_role');

-- ============================================================
-- 2. chat_forward_usage — restrict ALL to service_role
-- ============================================================
DROP POLICY IF EXISTS "chat_forward_usage_service_all" ON chat_forward_usage;
CREATE POLICY "chat_forward_usage_service_all" ON chat_forward_usage
  FOR ALL USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- ============================================================
-- 3. capability_overrides — restrict ALL to service_role
-- ============================================================
DROP POLICY IF EXISTS "capability_overrides_service_all" ON capability_overrides;
CREATE POLICY "capability_overrides_service_all" ON capability_overrides
  FOR ALL USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- ============================================================
-- 4. broadcast_usage — restrict ALL to service_role
-- ============================================================
DROP POLICY IF EXISTS "broadcast_usage_service_all" ON broadcast_usage;
CREATE POLICY "broadcast_usage_service_all" ON broadcast_usage
  FOR ALL USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- ============================================================
-- 5. canned_responses — add owner-based RLS if missing
--    (bot needs service_role to read, owners need direct access)
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'canned_responses' AND policyname = 'canned_responses_owner_select'
  ) THEN
    EXECUTE 'CREATE POLICY "canned_responses_owner_select" ON canned_responses
      FOR SELECT USING (
        business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid())
        OR auth.role() = ''service_role''
      )';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'canned_responses' AND policyname = 'canned_responses_owner_modify'
  ) THEN
    EXECUTE 'CREATE POLICY "canned_responses_owner_modify" ON canned_responses
      FOR ALL USING (
        business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid())
        OR auth.role() = ''service_role''
      )
      WITH CHECK (
        business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid())
        OR auth.role() = ''service_role''
      )';
  END IF;
END $$;
