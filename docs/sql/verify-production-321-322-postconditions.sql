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

  -- 321-POL: Every promo table has at least 1 policy
  SELECT COUNT(*) INTO v_count
  FROM (
    SELECT c.relname
    FROM pg_class c JOIN pg_namespace n ON c.relnamespace = n.oid
    WHERE n.nspname = 'public'
      AND c.relname IN (
        'promo_campaigns', 'promo_prizes', 'promo_code_batches',
        'promo_campaign_codes', 'promo_redemptions',
        'promo_verification_attempts', 'promo_eligibility_acks',
        'promo_pending_eligibility'
      )
    EXCEPT
    SELECT DISTINCT c.relname
    FROM pg_policy pol JOIN pg_class c ON c.oid = pol.polrelid
    WHERE c.relname LIKE 'promo_%'
  ) missing;
  IF v_count > 0 THEN
    RAISE EXCEPTION '321-POL FAIL: % promo tables have no RLS policies', v_count;
  END IF;
  RAISE NOTICE '321-POL PASS: all promo tables have policies';

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

  -- 322-POL: Both class tables have at least 1 policy
  SELECT COUNT(*) INTO v_count
  FROM (
    SELECT c.relname
    FROM pg_class c JOIN pg_namespace n ON c.relnamespace = n.oid
    WHERE n.nspname = 'public'
      AND c.relname IN ('class_recurrence_rules', 'class_sessions')
    EXCEPT
    SELECT DISTINCT c.relname
    FROM pg_policy pol JOIN pg_class c ON c.oid = pol.polrelid
    WHERE c.relname IN ('class_recurrence_rules', 'class_sessions')
  ) missing;
  IF v_count > 0 THEN
    RAISE EXCEPTION '322-POL FAIL: % class tables have no RLS policies', v_count;
  END IF;
  RAISE NOTICE '322-POL PASS: class tables have policies';

  RAISE NOTICE '══ ALL POSTCONDITION CHECKS PASSED ══';
END;
$verify$;
