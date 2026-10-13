-- 447: Directory fuzzy search RPC
-- search_businesses_fuzzy — SECURITY INVOKER, service_role only
-- Uses pg_trgm similarity() on name, category::text, city
-- Applies directory eligibility inline

CREATE OR REPLACE FUNCTION public.search_businesses_fuzzy(
  p_query text,
  p_country text DEFAULT NULL,
  p_limit int DEFAULT 10,
  p_hidden_ids uuid[] DEFAULT ARRAY[]::uuid[]
)
RETURNS TABLE (
  id uuid,
  name text,
  bot_code text,
  category text,
  city text,
  state text,
  country_code text,
  match_score real
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN QUERY
  SELECT
    b.id,
    b.name::text,
    b.bot_code::text,
    b.category::text,
    b.city::text,
    b.state::text,
    b.country_code::text,
    GREATEST(
      similarity(b.name, p_query),
      similarity(b.category::text, p_query) * 0.8,
      similarity(COALESCE(b.city, ''), p_query) * 0.7
    ) AS match_score
  FROM public.businesses b
  WHERE b.status = 'active'
    AND b.bot_code IS NOT NULL
    AND COALESCE(b.discovery_enabled, true) = true
    AND b.messaging_suspended = false
    AND NOT (b.id = ANY(p_hidden_ids))
    AND (p_country IS NULL OR b.country_code = p_country)
    AND (
      similarity(b.name, p_query) > 0.3
      OR similarity(b.category::text, p_query) > 0.25
      OR similarity(COALESCE(b.city, ''), p_query) > 0.25
    )
  ORDER BY match_score DESC
  LIMIT LEAST(p_limit, 10);
END;
$$;

REVOKE ALL ON FUNCTION public.search_businesses_fuzzy(text, text, int, uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.search_businesses_fuzzy(text, text, int, uuid[]) FROM anon;
REVOKE ALL ON FUNCTION public.search_businesses_fuzzy(text, text, int, uuid[]) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.search_businesses_fuzzy(text, text, int, uuid[]) TO service_role;

-- Add trigram index on city if missing
CREATE INDEX IF NOT EXISTS idx_businesses_city_trgm ON businesses USING gin (city gin_trgm_ops);

-- Self-verification
DO $$
DECLARE
  fn_exists boolean;
  idx_exists boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public' AND p.proname = 'search_businesses_fuzzy'
  ) INTO fn_exists;

  SELECT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'idx_businesses_city_trgm'
  ) INTO idx_exists;

  IF fn_exists AND idx_exists THEN
    RAISE NOTICE '447: PASS — search_businesses_fuzzy + idx_businesses_city_trgm';
  ELSE
    RAISE EXCEPTION '447: FAIL — fn=%, idx=%', fn_exists, idx_exists;
  END IF;
END;
$$;
