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

  -- 321-GRANT: Sensitive promo RPCs not executable by anon/authenticated
  SELECT COUNT(*) INTO v_count
  FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
  WHERE n.nspname = 'public'
    AND p.proname IN (
      'claim_promo_code', 'admin_promo_governance', 'activate_promo_campaign',
      'commit_promo_code_chunk', 'commit_promo_import_chunk',
      'reset_promo_failed_batch', 'create_promo_batch_atomic'
    )
    AND (has_function_privilege('anon', p.oid, 'EXECUTE')
      OR has_function_privilege('authenticated', p.oid, 'EXECUTE'));
  IF v_count > 0 THEN
    RAISE EXCEPTION '321-GRANT FAIL: % promo RPCs are executable by anon or authenticated', v_count;
  END IF;
  -- service_role must have EXECUTE
  SELECT COUNT(*) INTO v_count
  FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
  WHERE n.nspname = 'public'
    AND p.proname IN (
      'claim_promo_code', 'admin_promo_governance', 'activate_promo_campaign',
      'commit_promo_code_chunk', 'commit_promo_import_chunk',
      'reset_promo_failed_batch', 'create_promo_batch_atomic'
    )
    AND has_function_privilege('service_role', p.oid, 'EXECUTE');
  IF v_count != 7 THEN
    RAISE EXCEPTION '321-GRANT FAIL: expected 7 promo RPCs executable by service_role, found %', v_count;
  END IF;
  RAISE NOTICE '321-GRANT PASS: promo RPCs grant restrictions correct';

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

  -- 322-GRANT: Sensitive class RPCs not executable by anon or authenticated
  -- (get_upcoming_class_sessions is intentionally granted to anon/authenticated for discovery)
  SELECT COUNT(*) INTO v_count
  FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
  WHERE n.nspname = 'public'
    AND p.proname IN (
      'book_slot_atomic', 'book_manual_slot_atomic',
      'reschedule_booking_atomic', 'create_class_atomic',
      'create_class_recurrence_atomic', 'update_class_session_atomic',
      'reconcile_class_recurrence', 'generate_class_sessions'
    )
    AND (has_function_privilege('anon', p.oid, 'EXECUTE')
      OR has_function_privilege('authenticated', p.oid, 'EXECUTE'));
  IF v_count > 0 THEN
    RAISE EXCEPTION '322-GRANT FAIL: % sensitive class RPCs are executable by anon or authenticated', v_count;
  END IF;
  -- service_role must have EXECUTE on all 9
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
    AND has_function_privilege('service_role', p.oid, 'EXECUTE');
  IF v_count != 9 THEN
    RAISE EXCEPTION '322-GRANT FAIL: expected 9 class RPCs executable by service_role, found %', v_count;
  END IF;
  RAISE NOTICE '322-GRANT PASS: class RPC grant restrictions correct';

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
