-- Track where bot sessions end for funnel analysis
CREATE TABLE IF NOT EXISTS flow_dropoffs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
  flow_type TEXT,
  step_id TEXT,
  reason TEXT NOT NULL, -- 'completed', 'cancelled', 'restarted', 'error', 'timeout', 'tier_restricted', 'abuse', 'webhook_confirmed'
  capability TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes for analytics queries
CREATE INDEX idx_flow_dropoffs_business ON flow_dropoffs (business_id, created_at DESC);
CREATE INDEX idx_flow_dropoffs_reason ON flow_dropoffs (reason, created_at DESC);
CREATE INDEX idx_flow_dropoffs_step ON flow_dropoffs (flow_type, step_id, reason);

-- RLS
ALTER TABLE flow_dropoffs ENABLE ROW LEVEL SECURITY;

-- Business owners can read their own analytics
CREATE POLICY "owners_read_own_dropoffs" ON flow_dropoffs
  FOR SELECT USING (
    business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid())
  );

-- Service role full access (cron, bot)
CREATE POLICY "service_role_all_dropoffs" ON flow_dropoffs
  FOR ALL USING (auth.role() = 'service_role');

-- Admin read access
CREATE POLICY "admin_read_dropoffs" ON flow_dropoffs
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin', 'support', 'operations'))
  );

-- Auto-cleanup: drop entries older than 90 days (run via cron)
-- Not implemented here — add to cleanup cron if needed
