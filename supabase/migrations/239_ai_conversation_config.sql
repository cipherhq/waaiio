-- AI conversation configuration per business
-- Controls the conversational AI layer behavior

CREATE TABLE IF NOT EXISTS ai_conversation_config (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  assistant_name TEXT DEFAULT 'Assistant',
  greeting TEXT,
  tone TEXT DEFAULT 'friendly' CHECK (tone IN ('friendly', 'professional', 'casual')),
  ai_enabled BOOLEAN DEFAULT true,
  faq_enabled BOOLEAN DEFAULT true,
  knowledge_enabled BOOLEAN DEFAULT true,
  corrections_enabled BOOLEAN DEFAULT true,
  temporary_questions_enabled BOOLEAN DEFAULT true,
  auto_route_threshold NUMERIC(3,2) DEFAULT 0.85
    CHECK (auto_route_threshold >= 0.60 AND auto_route_threshold <= 1.0),
  clarification_threshold NUMERIC(3,2) DEFAULT 0.60
    CHECK (clarification_threshold >= 0.30 AND clarification_threshold <= 0.85),
  fallback_behavior TEXT DEFAULT 'menu'
    CHECK (fallback_behavior IN ('menu', 'human_handoff', 'clarification')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(business_id)
);

ALTER TABLE ai_conversation_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "owners_manage" ON ai_conversation_config FOR ALL
  USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));

-- Location fields for marketplace search
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS latitude NUMERIC(10,7),
  ADD COLUMN IF NOT EXISTS longitude NUMERIC(10,7);

-- Marketplace discovery fields on businesses
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS discovery_enabled BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS discovery_description TEXT,
  ADD COLUMN IF NOT EXISTS discovery_keywords TEXT[],
  ADD COLUMN IF NOT EXISTS price_band TEXT CHECK (price_band IS NULL OR price_band IN ('budget', 'mid', 'premium', 'luxury')),
  ADD COLUMN IF NOT EXISTS supports_delivery BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS delivery_radius_km NUMERIC(5,1),
  ADD COLUMN IF NOT EXISTS max_group_size INTEGER,
  ADD COLUMN IF NOT EXISTS is_verified BOOLEAN DEFAULT false;

-- Full-text search indexes for marketplace
CREATE INDEX IF NOT EXISTS idx_businesses_name_trgm ON businesses USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_businesses_discovery ON businesses (discovery_enabled, status, category) WHERE discovery_enabled = true AND status = 'active';

-- Location-based search (if lat/lng columns exist)
CREATE INDEX IF NOT EXISTS idx_businesses_location ON businesses (latitude, longitude) WHERE latitude IS NOT NULL AND longitude IS NOT NULL;

-- AI classification log for analytics
CREATE TABLE IF NOT EXISTS ai_classification_log (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  business_id UUID REFERENCES businesses(id) ON DELETE SET NULL,
  customer_phone_hash TEXT, -- hashed, not raw
  intent TEXT,
  confidence NUMERIC(3,2),
  source TEXT DEFAULT 'regex' CHECK (source IN ('regex', 'llm', 'hybrid', 'deterministic')),
  entities JSONB DEFAULT '{}',
  recommended_action TEXT,
  flow_entered TEXT,
  was_correct BOOLEAN, -- for labeling/training
  latency_ms INTEGER,
  model TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_class_log_business ON ai_classification_log(business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_class_log_intent ON ai_classification_log(intent, created_at DESC);

ALTER TABLE ai_classification_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admin_read" ON ai_classification_log FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM profiles WHERE profiles.id = auth.uid() AND profiles.role IN ('admin', 'operations')
  ));
