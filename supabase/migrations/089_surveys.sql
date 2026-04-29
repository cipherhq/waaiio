-- ═══════════════════════════════════════════════════════
-- 089: Survey Capability
-- ═══════════════════════════════════════════════════════

-- surveys: business-created survey definitions
CREATE TABLE IF NOT EXISTS surveys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  title text NOT NULL,
  description text,
  questions jsonb NOT NULL DEFAULT '[]',
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'closed')),
  total_responses integer DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- survey_responses: one row per customer per survey
CREATE TABLE IF NOT EXISTS survey_responses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  survey_id uuid NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  customer_phone text NOT NULL,
  customer_name text,
  answers jsonb NOT NULL DEFAULT '{}',
  completed boolean DEFAULT false,
  started_at timestamptz DEFAULT now(),
  completed_at timestamptz,
  UNIQUE(survey_id, customer_phone)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_surveys_business ON surveys(business_id);
CREATE INDEX IF NOT EXISTS idx_surveys_status ON surveys(business_id, status);
CREATE INDEX IF NOT EXISTS idx_survey_responses_survey ON survey_responses(survey_id);
CREATE INDEX IF NOT EXISTS idx_survey_responses_business ON survey_responses(business_id);

-- RLS
ALTER TABLE surveys ENABLE ROW LEVEL SECURITY;
ALTER TABLE survey_responses ENABLE ROW LEVEL SECURITY;

CREATE POLICY surveys_owner ON surveys FOR ALL USING (
  business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid())
);
CREATE POLICY survey_responses_owner ON survey_responses FOR ALL USING (
  business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid())
);
CREATE POLICY surveys_service ON surveys FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY survey_responses_service ON survey_responses FOR ALL USING (auth.role() = 'service_role');
