-- Demo / white-label lead capture
CREATE TABLE IF NOT EXISTS demo_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_name varchar(200) NOT NULL,
  contact_name varchar(200) NOT NULL,
  work_email varchar(254) NOT NULL,
  phone varchar(30) NOT NULL,
  industry varchar(50) NOT NULL,
  estimated_volume varchar(100),
  has_waba boolean,
  use_case varchar(50) DEFAULT 'own_business',   -- own_business | reselling
  notes text,
  status varchar(20) DEFAULT 'new',               -- new, contacted, qualified, closed
  metadata jsonb DEFAULT '{}',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE demo_requests ENABLE ROW LEVEL SECURITY;

-- Only service role (API route) can insert
CREATE POLICY "service_insert_demo_requests"
  ON demo_requests FOR INSERT
  TO service_role
  WITH CHECK (true);

-- Admin roles can view
CREATE POLICY "admin_select_demo_requests"
  ON demo_requests FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
        AND profiles.role IN ('admin', 'support', 'operations')
    )
  );

-- Admin can update status
CREATE POLICY "admin_update_demo_requests"
  ON demo_requests FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
        AND profiles.role IN ('admin', 'support')
    )
  );

-- Indexes
CREATE INDEX idx_demo_requests_status ON demo_requests (status);
CREATE INDEX idx_demo_requests_created ON demo_requests (created_at DESC);
CREATE INDEX idx_demo_requests_email ON demo_requests (work_email);

-- Updated_at trigger
CREATE TRIGGER set_demo_requests_updated_at
  BEFORE UPDATE ON demo_requests
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();
