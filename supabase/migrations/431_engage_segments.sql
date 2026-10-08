-- E1 Engage Segments (#557)
-- Saved dynamic segment definitions for audience preview.
-- No RPC, no SECURITY DEFINER functions. Simple DDL only.

CREATE TABLE public.engage_segments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  expression JSONB NOT NULL,
  is_dynamic BOOLEAN NOT NULL DEFAULT true,
  created_by UUID NOT NULL REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_engage_segments_business
  ON public.engage_segments(business_id);

CREATE TRIGGER update_engage_segments_updated_at
  BEFORE UPDATE ON public.engage_segments
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

ALTER TABLE public.engage_segments ENABLE ROW LEVEL SECURITY;

-- Defense-in-depth only: all access through service client after API authorization.
-- No permissive direct-client policy. Dashboard/API goes through server routes.
CREATE POLICY engage_segments_owner_defense
  ON public.engage_segments FOR ALL
  USING (business_id IN (SELECT id FROM businesses WHERE owner_id = auth.uid()));

COMMENT ON TABLE public.engage_segments IS
  'E1 Engage: saved dynamic audience segment definitions. All CRUD through API routes after requireCapabilityWithRole authorization.';

-- ══════════════════════════════════════════════════════════
-- Privilege contract: service_role CRUD for API routes,
-- deny anon/authenticated direct table access.
-- API authorization handled by requireCapabilityWithRole in route handlers.
-- ══════════════════════════════════════════════════════════
REVOKE ALL ON TABLE public.engage_segments FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.engage_segments TO service_role;

-- Verification block
DO $$
BEGIN
  -- service_role: all four CRUD allowed
  IF NOT has_table_privilege('service_role', 'public.engage_segments', 'SELECT') THEN
    RAISE EXCEPTION 'M431: service_role must have SELECT on engage_segments';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.engage_segments', 'INSERT') THEN
    RAISE EXCEPTION 'M431: service_role must have INSERT on engage_segments';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.engage_segments', 'UPDATE') THEN
    RAISE EXCEPTION 'M431: service_role must have UPDATE on engage_segments';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.engage_segments', 'DELETE') THEN
    RAISE EXCEPTION 'M431: service_role must have DELETE on engage_segments';
  END IF;

  -- anon: denied
  IF has_table_privilege('anon', 'public.engage_segments', 'SELECT') THEN
    RAISE EXCEPTION 'M431: anon must NOT have SELECT on engage_segments';
  END IF;
  IF has_table_privilege('anon', 'public.engage_segments', 'INSERT') THEN
    RAISE EXCEPTION 'M431: anon must NOT have INSERT on engage_segments';
  END IF;

  -- authenticated: denied
  IF has_table_privilege('authenticated', 'public.engage_segments', 'SELECT') THEN
    RAISE EXCEPTION 'M431: authenticated must NOT have SELECT on engage_segments';
  END IF;
  IF has_table_privilege('authenticated', 'public.engage_segments', 'INSERT') THEN
    RAISE EXCEPTION 'M431: authenticated must NOT have INSERT on engage_segments';
  END IF;

  -- RLS enabled
  IF NOT (SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'engage_segments') THEN
    RAISE EXCEPTION 'M431: RLS must be enabled on engage_segments';
  END IF;

  RAISE NOTICE 'M431: All privilege checks passed — service_role CRUD, anon/authenticated denied, RLS enabled';
END $$;
