-- Scheduled broadcasts table for businesses
CREATE TABLE IF NOT EXISTS business_broadcasts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  created_by UUID NOT NULL REFERENCES auth.users(id),
  message TEXT NOT NULL,
  template_name TEXT,
  audience_filter JSONB DEFAULT '{}',
  phones TEXT[] NOT NULL DEFAULT '{}',
  recipient_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'sending', 'sent', 'failed', 'cancelled')),
  scheduled_at TIMESTAMPTZ NOT NULL,
  sent_at TIMESTAMPTZ,
  sent_count INTEGER DEFAULT 0,
  failed_count INTEGER DEFAULT 0,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for cron to find due broadcasts
CREATE INDEX idx_business_broadcasts_scheduled ON business_broadcasts (status, scheduled_at)
  WHERE status = 'scheduled';

CREATE INDEX idx_business_broadcasts_business ON business_broadcasts (business_id, created_at DESC);

-- RLS
ALTER TABLE business_broadcasts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "business_broadcasts_owner" ON business_broadcasts
  FOR ALL USING (
    business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid())
  );

CREATE POLICY "business_broadcasts_admin" ON business_broadcasts
  FOR ALL USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin', 'support', 'operations'))
  );
