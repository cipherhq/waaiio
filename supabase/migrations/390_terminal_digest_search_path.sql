-- Migration 390: Production pgcrypto search-path hotfix
--
-- Production installs pgcrypto in schema "extensions".
-- M385 initialize_terminal_effects() and M388 finalize_payment_confirmation()
-- are SECURITY DEFINER functions with search_path=public and call digest() unqualified.
-- In production this caused payment confirmation to fail with:
--   function digest(text, unknown) does not exist
--
-- Keep the existing function bodies unchanged. Extend only their function-local
-- search_path so the canonical pgcrypto digest() can resolve.

ALTER FUNCTION public.initialize_terminal_effects(
  uuid, uuid, text[], text[], text[], text[], integer
) SET search_path = public, extensions;

ALTER FUNCTION public.finalize_payment_confirmation(
  uuid, uuid
) SET search_path = public, extensions;

-- Self-verification: pgcrypto must be installed in extensions and both functions
-- must carry the corrected function-local search_path.
DO $$
DECLARE
  v_pgcrypto_schema text;
  v_init_config text[];
  v_final_config text[];
BEGIN
  SELECT n.nspname INTO v_pgcrypto_schema
  FROM pg_extension e
  JOIN pg_namespace n ON n.oid = e.extnamespace
  WHERE e.extname = 'pgcrypto';

  IF v_pgcrypto_schema IS NULL THEN
    RAISE EXCEPTION 'M390: pgcrypto is not installed';
  END IF;

  -- Local Supabase commonly installs pgcrypto in public while hosted
  -- production may install it in extensions. The function search_path below
  -- supports both topologies without weakening function authority.
  IF v_pgcrypto_schema NOT IN ('public', 'extensions') THEN
    RAISE EXCEPTION 'M390: unsupported pgcrypto schema: %', v_pgcrypto_schema;
  END IF;

  SELECT p.proconfig INTO v_init_config
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.oid = 'public.initialize_terminal_effects(uuid,uuid,text[],text[],text[],text[],integer)'::regprocedure;

  SELECT p.proconfig INTO v_final_config
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.oid = 'public.finalize_payment_confirmation(uuid,uuid)'::regprocedure;

  IF NOT ('search_path=public, extensions' = ANY(v_init_config)) THEN
    RAISE EXCEPTION 'M390: initialize_terminal_effects search_path not corrected: %', v_init_config;
  END IF;

  IF NOT ('search_path=public, extensions' = ANY(v_final_config)) THEN
    RAISE EXCEPTION 'M390: finalize_payment_confirmation search_path not corrected: %', v_final_config;
  END IF;

  -- Verify unqualified digest resolves under the exact function search_path.
  PERFORM set_config('search_path', 'public, extensions', true);
  PERFORM digest('waaiio-m390-probe'::text, 'sha256'::text);
END;
$$;