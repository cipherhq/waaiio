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
