-- ══ Multi-Agent Live Chat ══

-- 1. Add agent assignment to conversations
ALTER TABLE chat_conversations ADD COLUMN IF NOT EXISTS assigned_to UUID;
ALTER TABLE chat_conversations ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_chat_conversations_assigned ON chat_conversations(business_id, assigned_to);

-- 2. RLS: allow team members to view conversations for their business
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'chat_conversations' AND policyname = 'team_members_view_conversations') THEN
    CREATE POLICY team_members_view_conversations ON chat_conversations FOR SELECT
      USING (
        business_id IN (
          SELECT business_id FROM business_members WHERE user_id = auth.uid() AND status = 'active'
        )
      );
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'chat_messages' AND policyname = 'team_members_view_messages') THEN
    CREATE POLICY team_members_view_messages ON chat_messages FOR SELECT
      USING (
        business_id IN (
          SELECT business_id FROM business_members WHERE user_id = auth.uid() AND status = 'active'
        )
      );
  END IF;
END $$;

-- 3. Allow team members to insert outbound messages
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'chat_messages' AND policyname = 'team_members_send_messages') THEN
    CREATE POLICY team_members_send_messages ON chat_messages FOR INSERT
      WITH CHECK (
        direction = 'outbound' AND
        business_id IN (
          SELECT business_id FROM business_members WHERE user_id = auth.uid() AND status = 'active'
        )
      );
  END IF;
END $$;
