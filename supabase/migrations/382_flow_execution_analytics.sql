-- M382: Bot Flow Execution Analytics (#267)
-- Minimal dedicated analytics storage for customer-facing bot-flow message instrumentation.

CREATE TABLE IF NOT EXISTS public.flow_execution_summaries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id TEXT NOT NULL UNIQUE,
  business_id UUID NOT NULL REFERENCES businesses(id),
  completeness TEXT NOT NULL CHECK (completeness IN ('complete', 'incomplete')),
  total_messages INTEGER NOT NULL DEFAULT 0,
  resolved_count INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX idx_flow_exec_business ON flow_execution_summaries (business_id, created_at DESC);

ALTER TABLE flow_execution_summaries ENABLE ROW LEVEL SECURITY;

-- Service-only writes
CREATE POLICY "flow_exec_service_write" ON flow_execution_summaries
  FOR ALL USING (false) WITH CHECK (false);

-- Tenant-scoped reads: business owners can read their own
CREATE POLICY "flow_exec_owner_read" ON flow_execution_summaries
  FOR SELECT USING (
    business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid())
  );

-- Admin reads
CREATE POLICY "flow_exec_admin_read" ON flow_execution_summaries
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin', 'finance'))
  );

CREATE TABLE IF NOT EXISTS public.flow_execution_aggregates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id TEXT NOT NULL REFERENCES flow_execution_summaries(execution_id),
  flow_type TEXT NOT NULL,
  step_name TEXT NOT NULL,
  message_type TEXT NOT NULL CHECK (message_type IN ('text', 'buttons', 'list', 'image', 'document', 'template', 'other')),
  is_template BOOLEAN NOT NULL DEFAULT false,
  active_capability TEXT,
  logical_count INTEGER NOT NULL DEFAULT 0,
  resolved_count INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT uq_flow_exec_agg UNIQUE (execution_id, flow_type, step_name, message_type, is_template, active_capability)
);

CREATE INDEX idx_flow_exec_agg_exec ON flow_execution_aggregates (execution_id);

ALTER TABLE flow_execution_aggregates ENABLE ROW LEVEL SECURITY;

-- Same policies as summaries (via execution_id join)
CREATE POLICY "flow_agg_service_write" ON flow_execution_aggregates
  FOR ALL USING (false) WITH CHECK (false);

CREATE POLICY "flow_agg_owner_read" ON flow_execution_aggregates
  FOR SELECT USING (
    execution_id IN (
      SELECT execution_id FROM flow_execution_summaries
      WHERE business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid())
    )
  );

CREATE POLICY "flow_agg_admin_read" ON flow_execution_aggregates
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin', 'finance'))
  );

-- Self-verification
DO $$
DECLARE v_count INTEGER;
BEGIN
  SELECT count(*) INTO v_count FROM information_schema.tables WHERE table_name = 'flow_execution_summaries';
  IF v_count = 0 THEN RAISE EXCEPTION 'M382: flow_execution_summaries not found'; END IF;
  SELECT count(*) INTO v_count FROM information_schema.tables WHERE table_name = 'flow_execution_aggregates';
  IF v_count = 0 THEN RAISE EXCEPTION 'M382: flow_execution_aggregates not found'; END IF;
END;
$$;
