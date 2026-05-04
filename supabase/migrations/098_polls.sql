-- ═══════════════════════════════════════════════════════
-- 098: Polls / Voting Capability
-- ═══════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS polls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  question text NOT NULL,
  options jsonb NOT NULL DEFAULT '[]',
  -- options: ["Jollof Rice", "Pepper Soup", "Suya Platter"]
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'closed')),
  total_votes integer DEFAULT 0,
  -- Settings
  allow_change_vote boolean DEFAULT false,
  show_results text DEFAULT 'after_vote' CHECK (show_results IN ('after_vote', 'always', 'after_close')),
  closes_at timestamptz,
  -- Metadata
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS poll_votes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  poll_id uuid NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  customer_phone text NOT NULL,
  customer_name text,
  option_index integer NOT NULL,
  voted_at timestamptz DEFAULT now(),
  UNIQUE(poll_id, customer_phone)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_polls_business ON polls(business_id);
CREATE INDEX IF NOT EXISTS idx_polls_status ON polls(business_id, status);
CREATE INDEX IF NOT EXISTS idx_poll_votes_poll ON poll_votes(poll_id);
CREATE INDEX IF NOT EXISTS idx_poll_votes_phone ON poll_votes(poll_id, customer_phone);

-- RLS
ALTER TABLE polls ENABLE ROW LEVEL SECURITY;
ALTER TABLE poll_votes ENABLE ROW LEVEL SECURITY;

CREATE POLICY polls_owner ON polls FOR ALL USING (
  business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid())
);
CREATE POLICY poll_votes_owner ON poll_votes FOR ALL USING (
  business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid())
);
CREATE POLICY polls_service ON polls FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY poll_votes_service ON poll_votes FOR ALL USING (auth.role() = 'service_role');
