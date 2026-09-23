-- Migration 397: Restore initialize_terminal_effects search_path
--
-- Root cause (#365): M394 recreated initialize_terminal_effects with
-- search_path = public, overwriting M390's public, extensions setting.
-- The unqualified digest() call fails in production where pgcrypto
-- is installed in schema "extensions".
--
-- This migration uses ALTER FUNCTION — it does NOT change the function
-- body, grants, owner, SECURITY DEFINER status, or any other attribute.
-- It restores only the search_path that M390 originally set and M394
-- accidentally removed.
--
-- finalize_payment_confirmation is NOT affected — M394 did not recreate
-- it, so M390's ALTER is still in effect.

ALTER FUNCTION public.initialize_terminal_effects(
  uuid, uuid, text[], text[], text[], text[], integer
) SET search_path = public, extensions;

-- ═══════════════════════════════════════════════════════════════════
-- Self-verification
-- ═══════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_init_config text[];
  v_final_config text[];
  v_pgcrypto_schema text;
BEGIN
  -- 1. Verify the exact regprocedure exists
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.oid = 'public.initialize_terminal_effects(uuid,uuid,text[],text[],text[],text[],integer)'::regprocedure
  ) THEN
    RAISE EXCEPTION 'M397: initialize_terminal_effects(uuid,uuid,text[],text[],text[],text[],integer) does not exist';
  END IF;

  -- 2. Verify search_path = public, extensions on initialize_terminal_effects
  SELECT p.proconfig INTO v_init_config
  FROM pg_proc p
  WHERE p.oid = 'public.initialize_terminal_effects(uuid,uuid,text[],text[],text[],text[],integer)'::regprocedure;

  IF NOT ('search_path=public, extensions' = ANY(v_init_config)) THEN
    RAISE EXCEPTION 'M397: initialize_terminal_effects search_path not restored. proconfig = %', v_init_config;
  END IF;

  -- 3. Verify finalize_payment_confirmation also has the correct search_path (not changed, just verified)
  SELECT p.proconfig INTO v_final_config
  FROM pg_proc p
  WHERE p.oid = 'public.finalize_payment_confirmation(uuid,uuid)'::regprocedure;

  IF NOT ('search_path=public, extensions' = ANY(v_final_config)) THEN
    RAISE EXCEPTION 'M397: finalize_payment_confirmation search_path unexpectedly wrong. proconfig = %', v_final_config;
  END IF;

  -- 4. Verify digest() resolves (pgcrypto must be reachable)
  SELECT n.nspname INTO v_pgcrypto_schema
  FROM pg_extension e
  JOIN pg_namespace n ON n.oid = e.extnamespace
  WHERE e.extname = 'pgcrypto';

  IF v_pgcrypto_schema IS NULL THEN
    RAISE EXCEPTION 'M397: pgcrypto extension is not installed';
  END IF;

  -- 5. Probe digest() resolution with the function's search_path
  PERFORM set_config('search_path', 'public, extensions', true);
  PERFORM digest('m397-verification-probe'::text, 'sha256'::text);

  RAISE NOTICE 'M397: verification passed. initialize_terminal_effects search_path restored. pgcrypto in schema "%".', v_pgcrypto_schema;
END $$;
