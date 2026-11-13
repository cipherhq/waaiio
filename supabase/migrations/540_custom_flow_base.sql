-- M540: Waaiio Custom Flow base tables (Issue #1013, Phase 1).
--
-- Data-driven WhatsApp flows: a flow definition (data, not code) per tenant,
-- editable data tables read live by published flows, per-customer sessions,
-- and a step log so a bad answer can be traced to a node and a table row.
-- No AfroFest or customer-specific content lives here — only the base schema.
-- No remote application authorized. No SECURITY DEFINER functions in this
-- migration (DB-001/DB-002/DB-006 not triggered).
BEGIN;

-- ── Flow definitions ────────────────────────────────────────────────
CREATE TABLE public.custom_flows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(btrim(name)) > 0 AND length(name) <= 120),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  greeting text CHECK (greeting IS NULL OR length(greeting) <= 1000),
  fallback_message text CHECK (fallback_message IS NULL OR length(fallback_message) <= 1000),
  entry_keyword text CHECK (entry_keyword IS NULL OR (entry_keyword = upper(btrim(entry_keyword)) AND length(entry_keyword) <= 40)),
  language text NOT NULL DEFAULT 'en' CHECK (length(language) <= 10),
  timezone text NOT NULL DEFAULT 'Africa/Lagos' CHECK (length(timezone) <= 64),
  currency text NOT NULL DEFAULT 'NGN' CHECK (length(currency) = 3),
  definition jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(definition) = 'object'),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  published_version integer CHECK (published_version IS NULL OR published_version >= 1),
  published_definition jsonb CHECK (published_definition IS NULL OR jsonb_typeof(published_definition) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'published' OR (published_version IS NOT NULL AND published_definition IS NOT NULL))
);
CREATE INDEX custom_flows_business_idx ON public.custom_flows(business_id);
CREATE INDEX custom_flows_business_status_idx ON public.custom_flows(business_id, status);
CREATE UNIQUE INDEX custom_flows_business_entry_keyword_idx ON public.custom_flows(business_id, entry_keyword) WHERE entry_keyword IS NOT NULL;
ALTER TABLE public.custom_flows ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.custom_flows FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.custom_flows TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.custom_flows TO service_role;
CREATE POLICY custom_flows_owner ON public.custom_flows FOR ALL TO authenticated
  USING (business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid()))
  WITH CHECK (business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid()));
CREATE POLICY custom_flows_service ON public.custom_flows FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE TRIGGER update_custom_flows_updated_at
  BEFORE UPDATE ON public.custom_flows
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ── Data tables belonging to a flow ─────────────────────────────────
CREATE TABLE public.custom_flow_tables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  flow_id uuid NOT NULL REFERENCES public.custom_flows(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(btrim(name)) > 0 AND length(name) <= 80),
  columns jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(columns) = 'array'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (flow_id, name)
);
CREATE INDEX custom_flow_tables_business_idx ON public.custom_flow_tables(business_id);
CREATE INDEX custom_flow_tables_flow_idx ON public.custom_flow_tables(flow_id);
ALTER TABLE public.custom_flow_tables ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.custom_flow_tables FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.custom_flow_tables TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.custom_flow_tables TO service_role;
CREATE POLICY custom_flow_tables_owner ON public.custom_flow_tables FOR ALL TO authenticated
  USING (business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid()))
  WITH CHECK (business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid()));
CREATE POLICY custom_flow_tables_service ON public.custom_flow_tables FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE TRIGGER update_custom_flow_tables_updated_at
  BEFORE UPDATE ON public.custom_flow_tables
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ── Rows of a data table (read live by Lookup/List nodes) ───────────
CREATE TABLE public.custom_flow_table_rows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id uuid NOT NULL REFERENCES public.custom_flow_tables(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  row_code text NOT NULL CHECK (length(btrim(row_code)) > 0 AND length(row_code) <= 40),
  data jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(data) = 'object'),
  position integer NOT NULL DEFAULT 0,
  hidden boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (table_id, row_code)
);
CREATE INDEX custom_flow_table_rows_business_idx ON public.custom_flow_table_rows(business_id);
CREATE INDEX custom_flow_table_rows_table_idx ON public.custom_flow_table_rows(table_id, position);
ALTER TABLE public.custom_flow_table_rows ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.custom_flow_table_rows FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.custom_flow_table_rows TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.custom_flow_table_rows TO service_role;
CREATE POLICY custom_flow_table_rows_owner ON public.custom_flow_table_rows FOR ALL TO authenticated
  USING (business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid()))
  WITH CHECK (business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid()));
CREATE POLICY custom_flow_table_rows_service ON public.custom_flow_table_rows FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE TRIGGER update_custom_flow_table_rows_updated_at
  BEFORE UPDATE ON public.custom_flow_table_rows
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ── Per-customer custom flow sessions ───────────────────────────────
-- whatsapp_number stores the RAW inbound transport key (no '+' prefix
-- normalization) — DB-005: session lookup uses exact match on raw Meta `from`.
CREATE TABLE public.custom_flow_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  whatsapp_number text NOT NULL CHECK (length(btrim(whatsapp_number)) > 0 AND length(whatsapp_number) <= 20),
  flow_id uuid NOT NULL REFERENCES public.custom_flows(id) ON DELETE CASCADE,
  flow_version integer NOT NULL CHECK (flow_version >= 1),
  current_node_id text NOT NULL CHECK (length(btrim(current_node_id)) > 0 AND length(current_node_id) <= 80),
  fields jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(fields) = 'object'),
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  is_active boolean NOT NULL DEFAULT true,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX custom_flow_sessions_business_idx ON public.custom_flow_sessions(business_id);
CREATE UNIQUE INDEX custom_flow_sessions_active_idx ON public.custom_flow_sessions(business_id, whatsapp_number) WHERE is_active;
ALTER TABLE public.custom_flow_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.custom_flow_sessions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.custom_flow_sessions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.custom_flow_sessions TO service_role;
CREATE POLICY custom_flow_sessions_owner_read ON public.custom_flow_sessions FOR SELECT TO authenticated
  USING (business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid()));
CREATE POLICY custom_flow_sessions_service ON public.custom_flow_sessions FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE TRIGGER update_custom_flow_sessions_updated_at
  BEFORE UPDATE ON public.custom_flow_sessions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ── Step log (append-only; a bad answer traces to a node + row) ─────
CREATE TABLE public.custom_flow_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  flow_id uuid NOT NULL REFERENCES public.custom_flows(id) ON DELETE CASCADE,
  session_id uuid REFERENCES public.custom_flow_sessions(id) ON DELETE SET NULL,
  node_id text CHECK (node_id IS NULL OR length(node_id) <= 80),
  direction text NOT NULL CHECK (direction IN ('in', 'out')),
  input text,
  output text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX custom_flow_logs_business_idx ON public.custom_flow_logs(business_id, created_at DESC);
CREATE INDEX custom_flow_logs_session_idx ON public.custom_flow_logs(session_id, created_at);
ALTER TABLE public.custom_flow_logs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.custom_flow_logs FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.custom_flow_logs TO authenticated;
GRANT SELECT, INSERT ON public.custom_flow_logs TO service_role;
CREATE POLICY custom_flow_logs_owner_read ON public.custom_flow_logs FOR SELECT TO authenticated
  USING (business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid()));
CREATE POLICY custom_flow_logs_service ON public.custom_flow_logs FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMIT;
