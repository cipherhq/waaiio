-- ═══════════════════════════════════════════════════════
-- Migration 026: Chat Forwarding (WhatsApp message forwarding to business owner)
-- ═══════════════════════════════════════════════════════

-- 1. Add forwarding toggle to whatsapp_config
ALTER TABLE whatsapp_config ADD COLUMN IF NOT EXISTS forward_chat_to_phone boolean DEFAULT false;

-- 2. Chat forward usage tracking — per business per month
CREATE TABLE IF NOT EXISTS chat_forward_usage (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  month_key text NOT NULL, -- format: '2026-04'
  forward_count integer DEFAULT 0 NOT NULL,
  last_forwarded_at timestamptz,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  UNIQUE(business_id, month_key)
);

CREATE INDEX IF NOT EXISTS idx_chat_forward_usage_business ON chat_forward_usage(business_id);
CREATE INDEX IF NOT EXISTS idx_chat_forward_usage_month ON chat_forward_usage(business_id, month_key);

-- 3. RLS
ALTER TABLE chat_forward_usage ENABLE ROW LEVEL SECURITY;

CREATE POLICY "chat_forward_usage_owner_select" ON chat_forward_usage
  FOR SELECT USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
CREATE POLICY "chat_forward_usage_service_all" ON chat_forward_usage
  FOR ALL USING (true);

-- 4. Updated_at trigger
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_chat_forward_usage_updated_at') THEN
    CREATE TRIGGER trg_chat_forward_usage_updated_at
      BEFORE UPDATE ON chat_forward_usage FOR EACH ROW EXECUTE FUNCTION update_updated_at();
  END IF;
END$$;

-- 5. Atomic increment function for forwarding count
CREATE OR REPLACE FUNCTION increment_chat_forwards(p_business_id uuid)
RETURNS void AS $$
DECLARE
  v_month text := to_char(now(), 'YYYY-MM');
BEGIN
  INSERT INTO chat_forward_usage (business_id, month_key, forward_count, last_forwarded_at)
  VALUES (p_business_id, v_month, 1, now())
  ON CONFLICT (business_id, month_key)
  DO UPDATE SET
    forward_count = chat_forward_usage.forward_count + 1,
    last_forwarded_at = now();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
