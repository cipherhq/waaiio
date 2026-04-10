-- ═══════════════════════════════════════════════════════
-- Migration 035: Broadcast Usage Tracking
-- Per-business monthly tracking for broadcast sends & recipients
-- ═══════════════════════════════════════════════════════

-- 1. Broadcast usage tracking — per business per month
CREATE TABLE IF NOT EXISTS broadcast_usage (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  month_key text NOT NULL,           -- format: '2026-04'
  broadcast_count integer DEFAULT 0 NOT NULL,
  recipient_count integer DEFAULT 0 NOT NULL,
  last_broadcast_at timestamptz,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  UNIQUE(business_id, month_key)
);

-- 2. Indexes
CREATE INDEX IF NOT EXISTS idx_broadcast_usage_business ON broadcast_usage(business_id);
CREATE INDEX IF NOT EXISTS idx_broadcast_usage_month ON broadcast_usage(business_id, month_key);

-- 3. RLS
ALTER TABLE broadcast_usage ENABLE ROW LEVEL SECURITY;

CREATE POLICY "broadcast_usage_owner_select" ON broadcast_usage
  FOR SELECT USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
CREATE POLICY "broadcast_usage_service_all" ON broadcast_usage
  FOR ALL USING (true);

-- 4. Updated_at trigger
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_broadcast_usage_updated_at') THEN
    CREATE TRIGGER trg_broadcast_usage_updated_at
      BEFORE UPDATE ON broadcast_usage FOR EACH ROW EXECUTE FUNCTION update_updated_at();
  END IF;
END$$;

-- 5. Atomic increment function for broadcast usage
CREATE OR REPLACE FUNCTION increment_broadcast_usage(
  p_business_id uuid,
  p_recipient_count integer
) RETURNS void AS $$
DECLARE
  v_month text := to_char(now(), 'YYYY-MM');
BEGIN
  INSERT INTO broadcast_usage (business_id, month_key, broadcast_count, recipient_count, last_broadcast_at)
  VALUES (p_business_id, v_month, 1, p_recipient_count, now())
  ON CONFLICT (business_id, month_key)
  DO UPDATE SET
    broadcast_count = broadcast_usage.broadcast_count + 1,
    recipient_count = broadcast_usage.recipient_count + p_recipient_count,
    last_broadcast_at = now();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
