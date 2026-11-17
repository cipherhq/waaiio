-- M546: Custom Flow answers and private uploads (Issue #1085, Phase 3 of #1013).
--
-- Owner rules (#1079 comment 6936919531):
--   * Only the business owner and that business's own team see answers;
--     never another business.
--   * Answers are kept 12 months, then deleted automatically by the daily
--     /api/cron/custom-flow-answers-retention job. The owner can delete sooner.
--   * Uploads: photos and PDFs only, up to 10 MB, private, short-lived links.
--
-- Writers: only the custom-flow engine (service_role) inserts or updates.
-- Readers: the owner, or an active business_members row (M099/M433; the
-- team-read pattern is M168). Deleters: the owner only.
-- No SECURITY DEFINER functions (DB-001/DB-002/DB-006 not triggered).
-- No remote application authorized by this lane.
BEGIN;

CREATE TABLE public.custom_flow_answers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  flow_id uuid NOT NULL,
  flow_version integer NOT NULL CHECK (flow_version >= 1),
  -- One id per customer run through a flow; groups the run's answers.
  response_id uuid NOT NULL,
  session_id uuid,
  -- Raw inbound transport key, as stored on custom_flow_sessions (DB-005).
  customer_number text NOT NULL CHECK (length(btrim(customer_number)) > 0 AND length(customer_number) <= 20),
  node_id text NOT NULL CHECK (length(btrim(node_id)) > 0 AND length(node_id) <= 80),
  -- Snapshot of the question as asked, so later edits never relabel answers.
  question text NOT NULL CHECK (length(btrim(question)) > 0 AND length(question) <= 1000),
  answer_type text NOT NULL CHECK (answer_type IN ('yes_no', 'choice', 'date', 'text', 'file')),
  value_text text CHECK (value_text IS NULL OR length(value_text) <= 1000),
  value_date date,
  file_path text CHECK (file_path IS NULL OR (length(file_path) <= 300 AND position('..' IN file_path) = 0 AND position('\' IN file_path) = 0)),
  file_mime text CHECK (file_mime IS NULL OR file_mime IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')),
  file_size integer CHECK (file_size IS NULL OR (file_size > 0 AND file_size <= 10485760)),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- The value columns must match the answer type exactly.
  CHECK (CASE answer_type
    WHEN 'date' THEN value_date IS NOT NULL AND value_text IS NULL AND file_path IS NULL AND file_mime IS NULL AND file_size IS NULL
    WHEN 'file' THEN file_path IS NOT NULL AND file_mime IS NOT NULL AND file_size IS NOT NULL AND value_date IS NULL
    ELSE value_text IS NOT NULL AND length(btrim(value_text)) > 0 AND value_date IS NULL AND file_path IS NULL AND file_mime IS NULL AND file_size IS NULL
  END),
  -- A file always lives under its own business's folder.
  CHECK (file_path IS NULL OR file_path LIKE business_id::text || '/%'),
  -- Re-answering a question in the same run replaces the earlier answer.
  UNIQUE (response_id, node_id),
  -- Composite FKs: answers only attach to the same business's flow/session.
  FOREIGN KEY (flow_id, business_id) REFERENCES public.custom_flows(id, business_id) ON DELETE CASCADE,
  FOREIGN KEY (session_id, business_id) REFERENCES public.custom_flow_sessions(id, business_id) ON DELETE SET NULL (session_id)
);
CREATE INDEX custom_flow_answers_flow_idx ON public.custom_flow_answers(business_id, flow_id, created_at DESC);
CREATE INDEX custom_flow_answers_response_idx ON public.custom_flow_answers(response_id);
CREATE INDEX custom_flow_answers_created_idx ON public.custom_flow_answers(created_at);

ALTER TABLE public.custom_flow_answers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.custom_flow_answers FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, DELETE ON public.custom_flow_answers TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.custom_flow_answers TO service_role;

CREATE POLICY custom_flow_answers_team_read ON public.custom_flow_answers FOR SELECT TO authenticated
  USING (
    business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid())
    OR business_id IN (SELECT business_id FROM public.business_members WHERE user_id = auth.uid() AND status = 'active')
  );
CREATE POLICY custom_flow_answers_owner_delete ON public.custom_flow_answers FOR DELETE TO authenticated
  USING (business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid()));
CREATE POLICY custom_flow_answers_service ON public.custom_flow_answers FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ── Private uploads bucket (service-only; viewers get 300 s signed links) ──
INSERT INTO storage.buckets(id, name, public)
VALUES ('custom-flow-uploads', 'custom-flow-uploads', false)
ON CONFLICT (id) DO UPDATE SET public = false;
-- Supabase Storage enforces these too where its columns exist (defence in
-- depth; the engine checks type and size before it downloads anything).
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'storage' AND table_name = 'buckets' AND column_name = 'file_size_limit')
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'storage' AND table_name = 'buckets' AND column_name = 'allowed_mime_types') THEN
    EXECUTE $q$UPDATE storage.buckets SET file_size_limit = 10485760,
      allowed_mime_types = ARRAY['image/jpeg','image/png','image/webp','application/pdf'] WHERE id = 'custom-flow-uploads'$q$;
  END IF;
END $$;
DROP POLICY IF EXISTS "Service manages custom flow uploads" ON storage.objects;
CREATE POLICY "Service manages custom flow uploads" ON storage.objects
FOR ALL TO service_role USING (bucket_id = 'custom-flow-uploads')
WITH CHECK (bucket_id = 'custom-flow-uploads');

-- ── Fail-closed final-state verification ──
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'custom-flow-uploads' AND public) THEN
    RAISE EXCEPTION 'M546: custom-flow-uploads bucket unexpectedly public';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects'
      AND qual LIKE '%custom-flow-uploads%' AND NOT roles <@ ARRAY['service_role']::name[]) THEN
    RAISE EXCEPTION 'M546: a non-service storage policy reaches custom-flow-uploads';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.custom_flow_answers'::regclass) THEN
    RAISE EXCEPTION 'M546: RLS disabled on custom_flow_answers';
  END IF;
  IF has_table_privilege('anon', 'public.custom_flow_answers', 'SELECT')
     OR has_table_privilege('authenticated', 'public.custom_flow_answers', 'INSERT')
     OR has_table_privilege('authenticated', 'public.custom_flow_answers', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.custom_flow_answers', 'TRUNCATE') THEN
    RAISE EXCEPTION 'M546: custom_flow_answers grants wider than SELECT/DELETE for clients';
  END IF;
END $$;

COMMIT;
