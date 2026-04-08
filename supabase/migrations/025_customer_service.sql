-- ═══════════════════════════════════════════════════════
-- Migration 025: Customer Service (Chat Conversations, Canned Responses, Handoff)
-- ═══════════════════════════════════════════════════════

-- 1. Chat Conversations table — tracks conversation state for human handoff
CREATE TABLE IF NOT EXISTS chat_conversations (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  customer_phone text NOT NULL,
  customer_name text,
  status text DEFAULT 'open' NOT NULL CHECK (status IN ('open', 'pending', 'resolved')),
  escalated_from_step text,
  escalated_at timestamptz,
  resolved_at timestamptz,
  resolved_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  bot_session_id uuid REFERENCES bot_sessions(id) ON DELETE SET NULL,
  session_context jsonb DEFAULT '{}'::jsonb,
  last_message_at timestamptz DEFAULT now(),
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  UNIQUE(business_id, customer_phone)
);

CREATE INDEX IF NOT EXISTS idx_chat_conversations_business ON chat_conversations(business_id);
CREATE INDEX IF NOT EXISTS idx_chat_conversations_status ON chat_conversations(business_id, status);
CREATE INDEX IF NOT EXISTS idx_chat_conversations_last_msg ON chat_conversations(business_id, last_message_at DESC);

-- Enable realtime for chat_conversations
ALTER PUBLICATION supabase_realtime ADD TABLE chat_conversations;

-- 2. Canned Responses table — quick reply templates
CREATE TABLE IF NOT EXISTS canned_responses (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  title text NOT NULL,
  message_text text NOT NULL,
  shortcut text,
  sort_order integer DEFAULT 0,
  is_active boolean DEFAULT true NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_canned_responses_business ON canned_responses(business_id);

-- 3. Alter chat_messages: add conversation_id FK
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS conversation_id uuid REFERENCES chat_conversations(id) ON DELETE SET NULL;

-- 4. Alter bot_sessions: add handed_off flag
ALTER TABLE bot_sessions ADD COLUMN IF NOT EXISTS handed_off boolean DEFAULT false;

-- 5. RLS Policies

-- chat_conversations
ALTER TABLE chat_conversations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "chat_conversations_owner_select" ON chat_conversations
  FOR SELECT USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
CREATE POLICY "chat_conversations_owner_insert" ON chat_conversations
  FOR INSERT WITH CHECK (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
CREATE POLICY "chat_conversations_owner_update" ON chat_conversations
  FOR UPDATE USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
CREATE POLICY "chat_conversations_owner_delete" ON chat_conversations
  FOR DELETE USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
CREATE POLICY "chat_conversations_service_insert" ON chat_conversations
  FOR INSERT WITH CHECK (true);
CREATE POLICY "chat_conversations_service_update" ON chat_conversations
  FOR UPDATE USING (true);

-- canned_responses
ALTER TABLE canned_responses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "canned_responses_owner_select" ON canned_responses
  FOR SELECT USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
CREATE POLICY "canned_responses_owner_insert" ON canned_responses
  FOR INSERT WITH CHECK (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
CREATE POLICY "canned_responses_owner_update" ON canned_responses
  FOR UPDATE USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
CREATE POLICY "canned_responses_owner_delete" ON canned_responses
  FOR DELETE USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));

-- 6. Updated_at triggers
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_chat_conversations_updated_at') THEN
    CREATE TRIGGER trg_chat_conversations_updated_at
      BEFORE UPDATE ON chat_conversations FOR EACH ROW EXECUTE FUNCTION update_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_canned_responses_updated_at') THEN
    CREATE TRIGGER trg_canned_responses_updated_at
      BEFORE UPDATE ON canned_responses FOR EACH ROW EXECUTE FUNCTION update_updated_at();
  END IF;
END$$;

-- 7. Backfill: create conversations for existing chat_messages
INSERT INTO chat_conversations (business_id, customer_phone, customer_name, status, last_message_at)
SELECT DISTINCT ON (business_id, customer_phone)
  business_id,
  customer_phone,
  customer_name,
  'open',
  MAX(created_at)
FROM chat_messages
GROUP BY business_id, customer_phone, customer_name
ON CONFLICT (business_id, customer_phone) DO NOTHING;

-- Link existing chat_messages to their conversations
UPDATE chat_messages cm
SET conversation_id = cc.id
FROM chat_conversations cc
WHERE cm.business_id = cc.business_id
  AND cm.customer_phone = cc.customer_phone
  AND cm.conversation_id IS NULL;
