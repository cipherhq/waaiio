-- ═══════════════════════════════════════════════════════
-- 269: Privilege assertions for payment RPCs
-- Verifies apply_invoice_payment and apply_campaign_donation
-- are restricted to service_role only.
-- ═══════════════════════════════════════════════════════
DO $$
DECLARE
  v_oid OID;
  v_fn_names TEXT[] := ARRAY['apply_invoice_payment', 'apply_campaign_donation'];
  v_fn TEXT;
BEGIN
  FOREACH v_fn IN ARRAY v_fn_names LOOP
    SELECT p.oid INTO v_oid
    FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public' AND p.proname = v_fn
    LIMIT 1;

    IF v_oid IS NULL THEN
      RAISE EXCEPTION 'Function % not found', v_fn;
    END IF;

    IF has_function_privilege('anon', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION '% is executable by anon — must be service_role only', v_fn;
    END IF;
    IF has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION '% is executable by authenticated — must be service_role only', v_fn;
    END IF;
    IF NOT has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION '% is NOT executable by service_role', v_fn;
    END IF;
  END LOOP;

  RAISE NOTICE 'Payment RPC privilege assertions passed (% RPCs verified)', array_length(v_fn_names, 1);
END $$;
