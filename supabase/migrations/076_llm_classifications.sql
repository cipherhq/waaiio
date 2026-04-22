-- LLM classification logs for intent detection
CREATE TABLE IF NOT EXISTS llm_classifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID REFERENCES businesses(id) ON DELETE SET NULL,
  business_category TEXT,
  user_message TEXT NOT NULL,
  detected_intent TEXT,
  detected_flow TEXT,
  entities JSONB DEFAULT '{}',
  confidence REAL NOT NULL DEFAULT 0,
  language TEXT,
  regex_attempted BOOLEAN DEFAULT true,
  regex_matched BOOLEAN DEFAULT false,
  llm_used BOOLEAN DEFAULT false,
  latency_ms INTEGER,
  model TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_llm_classifications_created ON llm_classifications(created_at DESC);
CREATE INDEX idx_llm_classifications_business ON llm_classifications(business_id);
CREATE INDEX idx_llm_classifications_confidence ON llm_classifications(confidence);

ALTER TABLE llm_classifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access" ON llm_classifications
  FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Admin read access" ON llm_classifications
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin', 'support'))
  );
