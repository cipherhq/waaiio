-- ══════════════════════════════════════════════════════════════
-- READ-ONLY production postcondition verifier for migrations 321+322
-- ══════════════════════════════════════════════════════════════
-- Run AFTER migration 325 and BEFORE migration-history reconciliation.
-- Raises an exception on ANY mismatch. Successful completion = PASS.
-- Does NOT modify any data or schema.
--
-- Usage:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f verify-production-321-322-postconditions.sql
-- ══════════════════════════════════════════════════════════════

DO $verify$
DECLARE
  v_count INTEGER;
  v_text TEXT;
  v_bool BOOLEAN;
BEGIN
  RAISE NOTICE '── MIGRATION 321: Promotions ──';

  -- 321-T: 8 promo tables
  SELECT COUNT(*) INTO v_count FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name IN (
    'promo_campaigns', 'promo_prizes', 'promo_code_batches',
    'promo_campaign_codes', 'promo_redemptions',
    'promo_verification_attempts', 'promo_eligibility_acks',
    'promo_pending_eligibility'
  );
  IF v_count != 8 THEN
    RAISE EXCEPTION '321-T FAIL: expected 8 promo tables, found %', v_count;
  END IF;
  RAISE NOTICE '321-T PASS: 8 promo tables';

  -- 321-E: 9 promo enums
  SELECT COUNT(*) INTO v_count FROM pg_type
  WHERE typname IN (
    'promo_campaign_status', 'promo_code_entry_mode', 'promo_prize_type',
    'promo_batch_status', 'promo_batch_source', 'promo_code_status',
    'promo_code_outcome', 'promo_fulfillment_status', 'promo_attempt_result'
  );
  IF v_count != 9 THEN
    RAISE EXCEPTION '321-E FAIL: expected 9 promo enums, found %', v_count;
  END IF;
  RAISE NOTICE '321-E PASS: 9 promo enums';

  -- 321-F: 11 promo functions exist
  SELECT COUNT(DISTINCT p.proname) INTO v_count
  FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
  WHERE n.nspname = 'public' AND p.proname IN (
    'claim_promo_code', 'validate_promo_campaign_activation',
    'admin_promo_governance', 'activate_promo_campaign',
    'commit_promo_code_chunk', 'commit_promo_import_chunk',
    'get_promo_campaign_aggregates', 'reset_promo_failed_batch',
    'create_promo_batch_atomic', 'update_promo_campaign_updated_at',
    'validate_promo_campaign_status_transition'
  );
  IF v_count != 11 THEN
    RAISE EXCEPTION '321-F FAIL: expected 11 promo functions, found %', v_count;
  END IF;
  RAISE NOTICE '321-F PASS: 11 promo functions';

  -- 321-SEC: All SECURITY DEFINER promo RPCs have search_path=public
  SELECT COUNT(*) INTO v_count
  FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
  WHERE n.nspname = 'public'
    AND p.proname IN (
      'claim_promo_code', 'validate_promo_campaign_activation',
      'admin_promo_governance', 'activate_promo_campaign',
      'commit_promo_code_chunk', 'commit_promo_import_chunk',
      'get_promo_campaign_aggregates', 'reset_promo_failed_batch',
      'create_promo_batch_atomic'
    )
    AND p.prosecdef = true
    AND p.proconfig @> ARRAY['search_path=public'];
  IF v_count != 9 THEN
    RAISE EXCEPTION '321-SEC FAIL: expected 9 SECURITY DEFINER promo RPCs with search_path=public, found %', v_count;
  END IF;
  RAISE NOTICE '321-SEC PASS: 9 promo RPCs SECURITY DEFINER + search_path';

  -- 321-GRANT-SVC: 8 service-role-only promo RPCs (using exact signatures)
  -- These must have: anon=no, authenticated=no, service_role=yes
  DECLARE
    v_svc_only_promo TEXT[] := ARRAY[
      'claim_promo_code(uuid,uuid,text,text,text)',
      'admin_promo_governance(uuid,text,uuid,text,text)',
      'activate_promo_campaign(uuid,uuid,text)',
      'commit_promo_code_chunk(uuid,integer,jsonb,integer)',
      'commit_promo_import_chunk(uuid,jsonb)',
      'get_promo_campaign_aggregates(uuid[])',
      'reset_promo_failed_batch(uuid)',
      'create_promo_batch_atomic(uuid,promo_batch_source,integer)'
    ];
    v_fn TEXT;
  BEGIN
    FOREACH v_fn IN ARRAY v_svc_only_promo LOOP
      IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
        WHERE n.nspname = 'public' AND p.oid = ('public.' || v_fn)::regprocedure) THEN
        RAISE EXCEPTION '321-GRANT-SVC FAIL: function % not found', v_fn;
      END IF;
      IF has_function_privilege('anon', ('public.' || v_fn)::regprocedure, 'EXECUTE') THEN
        RAISE EXCEPTION '321-GRANT-SVC FAIL: anon can EXECUTE %', v_fn;
      END IF;
      IF has_function_privilege('authenticated', ('public.' || v_fn)::regprocedure, 'EXECUTE') THEN
        RAISE EXCEPTION '321-GRANT-SVC FAIL: authenticated can EXECUTE %', v_fn;
      END IF;
      IF NOT has_function_privilege('service_role', ('public.' || v_fn)::regprocedure, 'EXECUTE') THEN
        RAISE EXCEPTION '321-GRANT-SVC FAIL: service_role cannot EXECUTE %', v_fn;
      END IF;
    END LOOP;
    RAISE NOTICE '321-GRANT-SVC PASS: 8 service-role-only promo RPCs';
  END;

  -- 321-GRANT-VAL: validate_promo_campaign_activation is also service-role-only
  -- Canonical 321: GRANT authenticated then REVOKE authenticated (net effect: service_role only)
  DECLARE
    v_validate_oid OID;
  BEGIN
    SELECT p.oid INTO v_validate_oid
    FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public' AND p.oid = 'public.validate_promo_campaign_activation(uuid)'::regprocedure;
    IF NOT FOUND THEN
      RAISE EXCEPTION '321-GRANT-VAL FAIL: validate_promo_campaign_activation(uuid) not found';
    END IF;
    IF has_function_privilege('anon', v_validate_oid, 'EXECUTE') THEN
      RAISE EXCEPTION '321-GRANT-VAL FAIL: anon can EXECUTE validate_promo_campaign_activation';
    END IF;
    IF has_function_privilege('authenticated', v_validate_oid, 'EXECUTE') THEN
      RAISE EXCEPTION '321-GRANT-VAL FAIL: authenticated can EXECUTE validate_promo_campaign_activation (should be revoked per canonical 321)';
    END IF;
    IF NOT has_function_privilege('service_role', v_validate_oid, 'EXECUTE') THEN
      RAISE EXCEPTION '321-GRANT-VAL FAIL: service_role cannot EXECUTE validate_promo_campaign_activation';
    END IF;
    RAISE NOTICE '321-GRANT-VAL PASS: validate_promo_campaign_activation grants correct (anon=no, authenticated=no, service_role=yes)';
  END;

  -- 321-RLS: All 8 promo tables have RLS enabled
  SELECT COUNT(*) INTO v_count
  FROM pg_class c JOIN pg_namespace n ON c.relnamespace = n.oid
  WHERE n.nspname = 'public'
    AND c.relname IN (
      'promo_campaigns', 'promo_prizes', 'promo_code_batches',
      'promo_campaign_codes', 'promo_redemptions',
      'promo_verification_attempts', 'promo_eligibility_acks',
      'promo_pending_eligibility'
    )
    AND c.relrowsecurity = true;
  IF v_count != 8 THEN
    RAISE EXCEPTION '321-RLS FAIL: expected 8 promo tables with RLS, found %', v_count;
  END IF;
  RAISE NOTICE '321-RLS PASS: 8 promo tables have RLS';

  -- 321-POL: Canonical policy set for each promo table
  -- Canonical 321 creates exactly these policies (name, table, command):
  -- Tables with _select + _service: promo_campaigns, promo_prizes, promo_code_batches,
  --   promo_redemptions, promo_verification_attempts
  -- Tables with _service only: promo_campaign_codes, promo_eligibility_acks, promo_pending_eligibility
  DECLARE
    v_expected_policies TEXT[] := ARRAY[
      'promo_campaigns|promo_campaigns_select|r',
      'promo_campaigns|promo_campaigns_service|*',
      'promo_prizes|promo_prizes_select|r',
      'promo_prizes|promo_prizes_service|*',
      'promo_code_batches|promo_code_batches_select|r',
      'promo_code_batches|promo_code_batches_service|*',
      'promo_campaign_codes|promo_campaign_codes_service|*',
      'promo_redemptions|promo_redemptions_select|r',
      'promo_redemptions|promo_redemptions_service|*',
      'promo_verification_attempts|promo_attempts_select|r',
      'promo_verification_attempts|promo_attempts_service|*',
      'promo_eligibility_acks|promo_elig_acks_service|*',
      'promo_pending_eligibility|promo_pending_elig_service|*'
    ];
    v_pol TEXT;
    v_pol_parts TEXT[];
  BEGIN
    -- Verify each canonical policy exists
    FOREACH v_pol IN ARRAY v_expected_policies LOOP
      v_pol_parts := string_to_array(v_pol, '|');
      IF NOT EXISTS (
        SELECT 1 FROM pg_policy pol
        JOIN pg_class c ON c.oid = pol.polrelid
        WHERE c.relname = v_pol_parts[1]
          AND pol.polname = v_pol_parts[2]
          AND pol.polcmd::text = v_pol_parts[3]
      ) THEN
        RAISE EXCEPTION '321-POL FAIL: missing canonical policy % on %', v_pol_parts[2], v_pol_parts[1];
      END IF;
    END LOOP;

    -- Verify NO unexpected extra policies on promo tables
    SELECT COUNT(*) INTO v_count
    FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    WHERE c.relname LIKE 'promo_%'
      AND NOT (c.relname || '|' || pol.polname || '|' || pol.polcmd::text) = ANY(v_expected_policies);
    IF v_count > 0 THEN
      RAISE EXCEPTION '321-POL FAIL: % unexpected extra policies on promo tables', v_count;
    END IF;
    RAISE NOTICE '321-POL PASS: canonical promo policy set (13 policies, no extras)';
  END;

  RAISE NOTICE '── MIGRATION 322: Classes ──';

  -- 322-T: class_recurrence_rules and class_sessions exist
  SELECT COUNT(*) INTO v_count FROM information_schema.tables
  WHERE table_schema = 'public'
    AND table_name IN ('class_recurrence_rules', 'class_sessions');
  IF v_count != 2 THEN
    RAISE EXCEPTION '322-T FAIL: expected 2 class tables, found %', v_count;
  END IF;
  RAISE NOTICE '322-T PASS: 2 class tables';

  -- 322-FK: bookings.class_session_id FK -> class_sessions with ON DELETE SET NULL (confdeltype='n')
  SELECT ref_c.relname, con.confdeltype::text
  INTO v_text, v_text
  FROM pg_constraint con
  JOIN pg_class c ON c.oid = con.conrelid
  JOIN pg_class ref_c ON ref_c.oid = con.confrelid
  JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(con.conkey)
  WHERE c.relname = 'bookings' AND a.attname = 'class_session_id' AND con.contype = 'f';
  IF NOT FOUND THEN
    RAISE EXCEPTION '322-FK FAIL: bookings.class_session_id FK not found';
  END IF;
  -- Re-query to get both values separately
  SELECT ref_c.relname INTO v_text
  FROM pg_constraint con
  JOIN pg_class c ON c.oid = con.conrelid
  JOIN pg_class ref_c ON ref_c.oid = con.confrelid
  JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(con.conkey)
  WHERE c.relname = 'bookings' AND a.attname = 'class_session_id' AND con.contype = 'f';
  IF v_text != 'class_sessions' THEN
    RAISE EXCEPTION '322-FK FAIL: FK target is %, expected class_sessions', v_text;
  END IF;
  SELECT con.confdeltype::text INTO v_text
  FROM pg_constraint con
  JOIN pg_class c ON c.oid = con.conrelid
  JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(con.conkey)
  WHERE c.relname = 'bookings' AND a.attname = 'class_session_id' AND con.contype = 'f';
  IF v_text != 'n' THEN
    RAISE EXCEPTION '322-FK FAIL: confdeltype is %, expected n (SET NULL)', v_text;
  END IF;
  RAISE NOTICE '322-FK PASS: bookings.class_session_id -> class_sessions ON DELETE SET NULL';

  -- 322-IDX: idx_bookings_class_session exists
  SELECT COUNT(*) INTO v_count FROM pg_indexes
  WHERE tablename = 'bookings' AND indexname = 'idx_bookings_class_session';
  IF v_count != 1 THEN
    RAISE EXCEPTION '322-IDX FAIL: idx_bookings_class_session missing';
  END IF;
  RAISE NOTICE '322-IDX PASS: idx_bookings_class_session exists';

  -- 322-F: 9 class RPCs exist
  SELECT COUNT(DISTINCT p.proname) INTO v_count
  FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
  WHERE n.nspname = 'public' AND p.proname IN (
    'generate_class_sessions', 'get_upcoming_class_sessions',
    'book_slot_atomic', 'book_manual_slot_atomic',
    'reschedule_booking_atomic', 'create_class_atomic',
    'create_class_recurrence_atomic', 'update_class_session_atomic',
    'reconcile_class_recurrence'
  );
  IF v_count != 9 THEN
    RAISE EXCEPTION '322-F FAIL: expected 9 class RPCs, found %', v_count;
  END IF;
  RAISE NOTICE '322-F PASS: 9 class RPCs';

  -- 322-SEC: All 9 class RPCs are SECURITY DEFINER with search_path=public
  SELECT COUNT(*) INTO v_count
  FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
  WHERE n.nspname = 'public'
    AND p.proname IN (
      'generate_class_sessions', 'get_upcoming_class_sessions',
      'book_slot_atomic', 'book_manual_slot_atomic',
      'reschedule_booking_atomic', 'create_class_atomic',
      'create_class_recurrence_atomic', 'update_class_session_atomic',
      'reconcile_class_recurrence'
    )
    AND p.prosecdef = true
    AND p.proconfig @> ARRAY['search_path=public'];
  IF v_count != 9 THEN
    RAISE EXCEPTION '322-SEC FAIL: expected 9 SECURITY DEFINER class RPCs with search_path=public, found %', v_count;
  END IF;
  RAISE NOTICE '322-SEC PASS: 9 class RPCs SECURITY DEFINER + search_path';

  -- 322-GRANT-SVC: 8 sensitive class RPCs — service-role-only (using exact signatures)
  DECLARE
    v_svc_only_class TEXT[] := ARRAY[
      'book_slot_atomic(uuid,uuid,uuid,uuid,date,text,integer,integer,text,integer,text,text,text,text,text,text,text,date,jsonb,uuid,integer,text,uuid,uuid,integer,integer,uuid,uuid)',
      'book_manual_slot_atomic(uuid,uuid,uuid,uuid,date,text,integer,integer,text,text,text,text,integer,text,integer,integer,uuid,uuid)',
      'reschedule_booking_atomic(uuid,uuid,date,text,integer,uuid)',
      'create_class_atomic(uuid,text,integer,integer,integer,text,time without time zone,uuid,uuid,integer,text)',
      'create_class_recurrence_atomic(uuid,uuid,text,time without time zone,uuid,uuid,integer,date,date)',
      'update_class_session_atomic(uuid,uuid,text,text,integer,uuid,boolean)',
      'reconcile_class_recurrence(uuid,uuid,text,text,time without time zone,uuid,uuid,integer,date,date,boolean,boolean)',
      'generate_class_sessions(uuid,integer)'
    ];
    v_fn TEXT;
  BEGIN
    FOREACH v_fn IN ARRAY v_svc_only_class LOOP
      IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
        WHERE n.nspname = 'public' AND p.oid = ('public.' || v_fn)::regprocedure) THEN
        RAISE EXCEPTION '322-GRANT-SVC FAIL: function % not found', v_fn;
      END IF;
      IF has_function_privilege('anon', ('public.' || v_fn)::regprocedure, 'EXECUTE') THEN
        RAISE EXCEPTION '322-GRANT-SVC FAIL: anon can EXECUTE %', v_fn;
      END IF;
      IF has_function_privilege('authenticated', ('public.' || v_fn)::regprocedure, 'EXECUTE') THEN
        RAISE EXCEPTION '322-GRANT-SVC FAIL: authenticated can EXECUTE %', v_fn;
      END IF;
      IF NOT has_function_privilege('service_role', ('public.' || v_fn)::regprocedure, 'EXECUTE') THEN
        RAISE EXCEPTION '322-GRANT-SVC FAIL: service_role cannot EXECUTE %', v_fn;
      END IF;
    END LOOP;
    RAISE NOTICE '322-GRANT-SVC PASS: 8 service-role-only class RPCs';
  END;

  -- 322-GRANT-DISC: get_upcoming_class_sessions is intentionally public for discovery
  -- Canonical 322: GRANT anon, authenticated, service_role
  DECLARE
    v_disc_oid OID;
  BEGIN
    SELECT p.oid INTO v_disc_oid
    FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public' AND p.oid = 'public.get_upcoming_class_sessions(uuid,integer)'::regprocedure;
    IF NOT FOUND THEN
      RAISE EXCEPTION '322-GRANT-DISC FAIL: get_upcoming_class_sessions(uuid,integer) not found';
    END IF;
    IF NOT has_function_privilege('anon', v_disc_oid, 'EXECUTE') THEN
      RAISE EXCEPTION '322-GRANT-DISC FAIL: anon cannot EXECUTE get_upcoming_class_sessions (should be allowed for discovery)';
    END IF;
    IF NOT has_function_privilege('authenticated', v_disc_oid, 'EXECUTE') THEN
      RAISE EXCEPTION '322-GRANT-DISC FAIL: authenticated cannot EXECUTE get_upcoming_class_sessions (should be allowed for discovery)';
    END IF;
    IF NOT has_function_privilege('service_role', v_disc_oid, 'EXECUTE') THEN
      RAISE EXCEPTION '322-GRANT-DISC FAIL: service_role cannot EXECUTE get_upcoming_class_sessions';
    END IF;
    RAISE NOTICE '322-GRANT-DISC PASS: get_upcoming_class_sessions grants correct (anon=yes, authenticated=yes, service_role=yes)';
  END;

  -- 322-RLS: class tables have RLS + FORCE ROW LEVEL SECURITY
  SELECT COUNT(*) INTO v_count
  FROM pg_class c JOIN pg_namespace n ON c.relnamespace = n.oid
  WHERE n.nspname = 'public'
    AND c.relname IN ('class_recurrence_rules', 'class_sessions')
    AND c.relrowsecurity = true
    AND c.relforcerowsecurity = true;
  IF v_count != 2 THEN
    RAISE EXCEPTION '322-RLS FAIL: expected 2 class tables with RLS+FORCE, found %', v_count;
  END IF;
  RAISE NOTICE '322-RLS PASS: class tables have RLS + FORCE ROW LEVEL SECURITY';

  -- 322-POL: Canonical policy set for class tables
  -- Canonical 322 end state (after DROP POLICY hardening):
  -- class_recurrence_rules: crr_owner_select (s), crr_service_all (*)
  -- class_sessions: cs_owner_select (s), cs_service_all (*)
  -- INSERT/UPDATE/DELETE owner policies were DROPPED for RLS hardening
  DECLARE
    v_class_expected_policies TEXT[] := ARRAY[
      'class_recurrence_rules|crr_owner_select|r',
      'class_recurrence_rules|crr_service_all|*',
      'class_sessions|cs_owner_select|r',
      'class_sessions|cs_service_all|*'
    ];
    v_cpol TEXT;
    v_cpol_parts TEXT[];
  BEGIN
    FOREACH v_cpol IN ARRAY v_class_expected_policies LOOP
      v_cpol_parts := string_to_array(v_cpol, '|');
      IF NOT EXISTS (
        SELECT 1 FROM pg_policy pol
        JOIN pg_class c ON c.oid = pol.polrelid
        WHERE c.relname = v_cpol_parts[1]
          AND pol.polname = v_cpol_parts[2]
          AND pol.polcmd::text = v_cpol_parts[3]
      ) THEN
        RAISE EXCEPTION '322-POL FAIL: missing canonical policy % on %', v_cpol_parts[2], v_cpol_parts[1];
      END IF;
    END LOOP;

    -- No unexpected extra policies on class tables
    SELECT COUNT(*) INTO v_count
    FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    WHERE c.relname IN ('class_recurrence_rules', 'class_sessions')
      AND NOT (c.relname || '|' || pol.polname || '|' || pol.polcmd::text) = ANY(v_class_expected_policies);
    IF v_count > 0 THEN
      RAISE EXCEPTION '322-POL FAIL: % unexpected extra policies on class tables', v_count;
    END IF;
    RAISE NOTICE '322-POL PASS: canonical class policy set (4 policies, no extras)';
  END;

  -- 322-OVERLOAD: Exactly one book_slot_atomic overload with canonical 28-arg signature
  SELECT COUNT(*) INTO v_count
  FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
  WHERE n.nspname = 'public' AND p.proname = 'book_slot_atomic';
  IF v_count != 1 THEN
    RAISE EXCEPTION '322-OVERLOAD FAIL: expected exactly 1 book_slot_atomic overload, found %', v_count;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public' AND p.proname = 'book_slot_atomic' AND p.pronargs = 28
  ) THEN
    RAISE EXCEPTION '322-OVERLOAD FAIL: canonical 28-arg book_slot_atomic not found';
  END IF;
  RAISE NOTICE '322-OVERLOAD PASS: exactly 1 book_slot_atomic overload (28 args)';

  -- 322-DISC-PUB: get_upcoming_class_sessions PUBLIC must NOT have EXECUTE
  DECLARE
    v_disc_pub_oid OID;
  BEGIN
    SELECT p.oid INTO v_disc_pub_oid
    FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public' AND p.oid = 'public.get_upcoming_class_sessions(uuid,integer)'::regprocedure;
    IF has_function_privilege('public', v_disc_pub_oid, 'EXECUTE') THEN
      RAISE EXCEPTION '322-DISC-PUB FAIL: PUBLIC can EXECUTE get_upcoming_class_sessions (should be revoked)';
    END IF;
    RAISE NOTICE '322-DISC-PUB PASS: PUBLIC cannot EXECUTE get_upcoming_class_sessions';
  END;

  -- 322-TGRANT: Canonical table grants from migration 322
  -- authenticated must have SELECT, INSERT, UPDATE, DELETE on class_sessions and class_recurrence_rules
  -- anon must NOT have any DML on these tables
  DECLARE
    v_tbl TEXT;
    v_priv TEXT;
  BEGIN
    FOREACH v_tbl IN ARRAY ARRAY['class_sessions', 'class_recurrence_rules'] LOOP
      FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
        IF NOT has_table_privilege('authenticated', 'public.' || v_tbl, v_priv) THEN
          RAISE EXCEPTION '322-TGRANT FAIL: authenticated cannot % on %', v_priv, v_tbl;
        END IF;
      END LOOP;
      -- anon must NOT have any DML
      FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
        IF has_table_privilege('anon', 'public.' || v_tbl, v_priv) THEN
          RAISE EXCEPTION '322-TGRANT FAIL: anon has % on % (not canonical)', v_priv, v_tbl;
        END IF;
      END LOOP;
    END LOOP;
    RAISE NOTICE '322-TGRANT PASS: class table grants canonical (authenticated=SIUD, anon=none)';
  END;

  RAISE NOTICE '══ ALL 321+322 POSTCONDITION CHECKS PASSED ══';
END;
$verify$;

-- ══════════════════════════════════════════════════════════════
-- MIGRATION 323: get_bot_context canonical end-state verification
-- ══════════════════════════════════════════════════════════════

DO $verify_323$
DECLARE
  v_count INTEGER;
BEGIN
  RAISE NOTICE '── MIGRATION 323: get_bot_context ──';

  -- 323-SIG: Canonical 2-arg signature exists
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public' AND p.oid = 'public.get_bot_context(text,uuid)'::regprocedure
  ) THEN
    RAISE EXCEPTION '323-SIG FAIL: public.get_bot_context(text,uuid) not found';
  END IF;
  RAISE NOTICE '323-SIG PASS: get_bot_context(text,uuid) exists';

  -- 323-SEC: SECURITY DEFINER + search_path=public
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public'
      AND p.oid = 'public.get_bot_context(text,uuid)'::regprocedure
      AND p.prosecdef = true
      AND p.proconfig @> ARRAY['search_path=public']
  ) THEN
    RAISE EXCEPTION '323-SEC FAIL: get_bot_context missing SECURITY DEFINER or search_path=public';
  END IF;
  RAISE NOTICE '323-SEC PASS: SECURITY DEFINER + search_path=public';

  -- 323-GRANT: Exact privilege matrix
  DECLARE
    v_oid OID;
  BEGIN
    SELECT p.oid INTO v_oid FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public' AND p.oid = 'public.get_bot_context(text,uuid)'::regprocedure;

    IF has_function_privilege('public', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION '323-GRANT FAIL: PUBLIC can EXECUTE get_bot_context';
    END IF;
    IF has_function_privilege('anon', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION '323-GRANT FAIL: anon can EXECUTE get_bot_context';
    END IF;
    IF has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION '323-GRANT FAIL: authenticated can EXECUTE get_bot_context';
    END IF;
    IF NOT has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION '323-GRANT FAIL: service_role cannot EXECUTE get_bot_context';
    END IF;
    RAISE NOTICE '323-GRANT PASS: PUBLIC=no, anon=no, authenticated=no, service_role=yes';
  END;

  -- 323-OLD: Old single-arg overload must NOT exist
  SELECT COUNT(*) INTO v_count
  FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
  WHERE n.nspname = 'public' AND p.proname = 'get_bot_context' AND p.pronargs = 1;
  IF v_count > 0 THEN
    RAISE EXCEPTION '323-OLD FAIL: stale get_bot_context(text) overload still exists';
  END IF;

  -- Also verify exactly one overload total
  SELECT COUNT(*) INTO v_count
  FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
  WHERE n.nspname = 'public' AND p.proname = 'get_bot_context';
  IF v_count != 1 THEN
    RAISE EXCEPTION '323-OLD FAIL: expected exactly 1 get_bot_context overload, found %', v_count;
  END IF;
  RAISE NOTICE '323-OLD PASS: no stale overloads, exactly 1 canonical function';

  RAISE NOTICE '══ ALL 323 POSTCONDITION CHECKS PASSED ══';
END;
$verify_323$;
