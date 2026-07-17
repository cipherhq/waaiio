-- ═══════════════════════════════════════════════════════
-- 265: Final database assertions
-- ═══════════════════════════════════════════════════════
DO $$
DECLARE
  v_count INTEGER;
  v_overloads INTEGER;
  v_has_priv BOOLEAN;
BEGIN
  -- 1. Exactly one book_slot_atomic overload
  SELECT COUNT(*) INTO v_overloads
  FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
  WHERE n.nspname = 'public' AND p.proname = 'book_slot_atomic';
  IF v_overloads != 1 THEN
    RAISE EXCEPTION 'Expected 1 book_slot_atomic overload, found %', v_overloads;
  END IF;

  -- 2. book_slot_atomic: verify exact 26-parameter signature exists
  SELECT COUNT(*) INTO v_count
  FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
  WHERE n.nspname = 'public' AND p.proname = 'book_slot_atomic'
    AND pronargs = 26;
  IF v_count != 1 THEN
    RAISE EXCEPTION 'Expected book_slot_atomic with 26 params, found % matches', v_count;
  END IF;

  -- 3. book_slot_atomic: PUBLIC cannot execute
  SELECT has_function_privilege('anon', oid, 'EXECUTE') INTO v_has_priv
  FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
  WHERE n.nspname = 'public' AND p.proname = 'book_slot_atomic';
  IF v_has_priv THEN
    RAISE EXCEPTION 'book_slot_atomic is executable by anon';
  END IF;

  -- 4. book_slot_atomic: authenticated cannot execute
  SELECT has_function_privilege('authenticated', oid, 'EXECUTE') INTO v_has_priv
  FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
  WHERE n.nspname = 'public' AND p.proname = 'book_slot_atomic';
  IF v_has_priv THEN
    RAISE EXCEPTION 'book_slot_atomic is executable by authenticated';
  END IF;

  -- 5. book_slot_atomic: service_role CAN execute
  SELECT has_function_privilege('service_role', oid, 'EXECUTE') INTO v_has_priv
  FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
  WHERE n.nspname = 'public' AND p.proname = 'book_slot_atomic';
  IF NOT v_has_priv THEN
    RAISE EXCEPTION 'book_slot_atomic is NOT executable by service_role';
  END IF;

  -- 6. Membership tier auto-upgrade trigger exists
  SELECT COUNT(*) INTO v_count FROM pg_trigger
  WHERE tgname = 'trg_auto_upgrade_membership_tier';
  IF v_count = 0 THEN
    RAISE EXCEPTION 'Missing trigger: trg_auto_upgrade_membership_tier';
  END IF;

  -- 7. All three growth-credit CHECK constraints exist
  SELECT COUNT(*) INTO v_count FROM pg_constraint
  WHERE conname IN ('chk_credits_amount_positive', 'chk_credits_remaining_non_negative', 'chk_credits_remaining_lte_amount');
  IF v_count < 3 THEN
    RAISE EXCEPTION 'Expected 3 growth-credit CHECK constraints, found %', v_count;
  END IF;

  -- 8. Required financial indexes exist
  SELECT COUNT(*) INTO v_count FROM pg_indexes
  WHERE indexname IN ('idx_platform_fees_payment_unique', 'idx_package_session_log_booking_unique', 'idx_campaign_idempotency');
  IF v_count < 3 THEN
    RAISE EXCEPTION 'Missing financial indexes, found % of 3', v_count;
  END IF;

  -- 9. platform_fees.payment_id column exists
  SELECT COUNT(*) INTO v_count FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'platform_fees' AND column_name = 'payment_id';
  IF v_count = 0 THEN
    RAISE EXCEPTION 'Missing column: platform_fees.payment_id';
  END IF;

  -- 10. deduct_package_session: anon denied
  SELECT has_function_privilege('anon', oid, 'EXECUTE') INTO v_has_priv
  FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
  WHERE n.nspname = 'public' AND p.proname = 'deduct_package_session' LIMIT 1;
  IF v_has_priv THEN
    RAISE EXCEPTION 'deduct_package_session is executable by anon';
  END IF;

  -- 11. create_payout_with_adjustments: anon denied
  SELECT has_function_privilege('anon', oid, 'EXECUTE') INTO v_has_priv
  FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
  WHERE n.nspname = 'public' AND p.proname = 'create_payout_with_adjustments' LIMIT 1;
  IF v_has_priv THEN
    RAISE EXCEPTION 'create_payout_with_adjustments is executable by anon';
  END IF;

  RAISE NOTICE 'All 11 database assertions passed';
END $$;
