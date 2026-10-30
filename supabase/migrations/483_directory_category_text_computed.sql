-- M483: Computed text field for businesses.category enum
--
-- PostgREST cannot apply ILIKE/pattern operators to enum columns.
-- This SECURITY INVOKER computed field exposes category as filterable text
-- via PostgREST's automatic computed-field discovery.
--
-- Reference: https://docs.postgrest.org/en/stable/references/api/computed_fields.html

-- Drop any prior version to ensure clean signature
DROP FUNCTION IF EXISTS public.category_text(public.businesses);

CREATE OR REPLACE FUNCTION public.category_text(public.businesses)
RETURNS text
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$ SELECT ($1.category)::text; $$;

COMMENT ON FUNCTION public.category_text(public.businesses)
  IS 'Computed text field: exposes business_category enum as filterable text for PostgREST ILIKE queries';

-- Restricted grants: service_role only (all directory callers use createServiceClient)
REVOKE ALL ON FUNCTION public.category_text(public.businesses) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.category_text(public.businesses) FROM anon;
REVOKE ALL ON FUNCTION public.category_text(public.businesses) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.category_text(public.businesses) TO service_role;

-- Explicit PostgREST schema cache reload
NOTIFY pgrst, 'reload schema';

-- ── Data-independent final-state self-test ──
DO $$
DECLARE
  fn_oid oid;
  fn_rettype text;
  fn_volatile char;
  fn_security text;
  fn_config text[];
  fn_regproc regprocedure;
  svc_has boolean;
  anon_has boolean;
  auth_has boolean;
  pub_has boolean;
  eval_result text;
BEGIN
  -- 1. Verify function exists via to_regprocedure (exact signature match)
  fn_regproc := to_regprocedure('public.category_text(public.businesses)');
  ASSERT fn_regproc IS NOT NULL,
    'M483: category_text(businesses) must exist';

  -- 2. Verify return type, volatility, security, search_path
  SELECT p.oid, t.typname, p.provolatile,
         CASE WHEN p.prosecdef THEN 'definer' ELSE 'invoker' END,
         p.proconfig
  INTO fn_oid, fn_rettype, fn_volatile, fn_security, fn_config
  FROM pg_proc p
  JOIN pg_type t ON p.prorettype = t.oid
  WHERE p.oid = fn_regproc;

  ASSERT fn_rettype = 'text',
    'M483: must return text, got ' || fn_rettype;
  ASSERT fn_volatile = 's',
    'M483: must be STABLE, got ' || fn_volatile;
  ASSERT fn_security = 'invoker',
    'M483: must be SECURITY INVOKER';
  ASSERT fn_config @> ARRAY['search_path=public'],
    'M483: must have SET search_path = public';

  -- 3. Verify ACL: service_role YES, anon/authenticated/PUBLIC NO
  SELECT has_function_privilege('service_role',
    'public.category_text(public.businesses)', 'EXECUTE')
  INTO svc_has;
  ASSERT svc_has, 'M483: service_role must have EXECUTE';

  SELECT has_function_privilege('anon',
    'public.category_text(public.businesses)', 'EXECUTE')
  INTO anon_has;
  ASSERT NOT anon_has, 'M483: anon must NOT have EXECUTE';

  SELECT has_function_privilege('authenticated',
    'public.category_text(public.businesses)', 'EXECUTE')
  INTO auth_has;
  ASSERT NOT auth_has, 'M483: authenticated must NOT have EXECUTE';

  -- 4. Evaluate with synthetic row via jsonb_populate_record (no tenant data read)
  SELECT public.category_text(
    jsonb_populate_record(
      NULL::public.businesses,
      '{"category": "shop"}'::jsonb
    )
  ) INTO eval_result;
  ASSERT eval_result = 'shop',
    'M483: category_text(synthetic shop) must return ''shop'', got ' || COALESCE(eval_result, 'NULL');

  RAISE NOTICE 'M483: PASS — category_text: text/STABLE/INVOKER/search_path=public, service_role ACL, synthetic eval OK';
END $$;
