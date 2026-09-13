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
  active_capability TEXT NOT NULL DEFAULT '__none__',
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

-- Atomic persist RPC: summary + aggregates in one transaction (Correction 2)
CREATE OR REPLACE FUNCTION public.persist_flow_execution(
  p_execution_id TEXT,
  p_business_id UUID,
  p_completeness TEXT,
  p_total_messages INTEGER,
  p_resolved_count INTEGER,
  p_failure_count INTEGER,
  p_error_count INTEGER,
  p_started_at TIMESTAMPTZ,
  p_completed_at TIMESTAMPTZ,
  p_aggregates JSONB DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_agg JSONB;
  v_rows_affected INTEGER;
BEGIN
  -- Idempotent: if execution already exists, return without error
  INSERT INTO flow_execution_summaries (
    execution_id, business_id, completeness, total_messages,
    resolved_count, failure_count, error_count, started_at, completed_at
  ) VALUES (
    p_execution_id, p_business_id, p_completeness, p_total_messages,
    p_resolved_count, p_failure_count, p_error_count, p_started_at, p_completed_at
  ) ON CONFLICT (execution_id) DO NOTHING;

  GET DIAGNOSTICS v_rows_affected = ROW_COUNT;
  IF v_rows_affected = 0 THEN
    RETURN jsonb_build_object('persisted', false, 'reason', 'duplicate');
  END IF;

  -- Insert aggregates atomically with the summary
  IF p_aggregates IS NOT NULL AND jsonb_typeof(p_aggregates) = 'array' THEN
    FOR v_agg IN SELECT * FROM jsonb_array_elements(p_aggregates)
    LOOP
      INSERT INTO flow_execution_aggregates (
        execution_id, flow_type, step_name, message_type, is_template, active_capability,
        logical_count, resolved_count, failure_count, error_count
      ) VALUES (
        p_execution_id,
        v_agg->>'flow_type',
        v_agg->>'step_name',
        v_agg->>'message_type',
        (v_agg->>'is_template')::BOOLEAN,
        COALESCE(NULLIF(v_agg->>'active_capability', ''), '__none__'),
        (v_agg->>'logical_count')::INTEGER,
        (v_agg->>'resolved_count')::INTEGER,
        (v_agg->>'failure_count')::INTEGER,
        (v_agg->>'error_count')::INTEGER
      ) ON CONFLICT (execution_id, flow_type, step_name, message_type, is_template, active_capability) DO NOTHING;
    END LOOP;
  END IF;

  RETURN jsonb_build_object('persisted', true);
END;
$$;

REVOKE ALL ON FUNCTION public.persist_flow_execution FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.persist_flow_execution TO service_role;

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
