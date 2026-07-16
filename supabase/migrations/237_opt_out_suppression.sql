-- Opt-out suppression table for STOP/UNSUBSCRIBE compliance
CREATE TABLE IF NOT EXISTS messaging_opt_outs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  phone TEXT NOT NULL,
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
  channel TEXT DEFAULT 'whatsapp',
  opt_out_type TEXT DEFAULT 'all' CHECK (opt_out_type IN ('all', 'marketing', 'promotional')),
  opted_out_at TIMESTAMPTZ DEFAULT NOW(),
  source_message_id TEXT,
  resubscribed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- One opt-out per phone per business per channel
CREATE UNIQUE INDEX IF NOT EXISTS idx_opt_out_unique
  ON messaging_opt_outs(phone, COALESCE(business_id, '00000000-0000-0000-0000-000000000000'::UUID), channel)
  WHERE resubscribed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_opt_out_phone ON messaging_opt_outs(phone, channel);

ALTER TABLE messaging_opt_outs ENABLE ROW LEVEL SECURITY;

-- Only service role manages opt-outs (bot handler)
-- No INSERT/UPDATE/DELETE policy for anon/authenticated
CREATE POLICY "owners_read" ON messaging_opt_outs FOR SELECT
  USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));
