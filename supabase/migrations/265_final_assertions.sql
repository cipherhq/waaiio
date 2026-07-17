-- ═══════════════════════════════════════════════════════
-- 265: Final database assertions
-- ═══════════════════════════════════════════════════════
-- Verifies that the migration chain produced the expected state.
-- Fails the migration if any assertion is violated.

DO $$
DECLARE
  v_count INTEGER;
  v_overloads INTEGER;
BEGIN
  -- 1. Exactly one book_slot_atomic overload (26-param version)
  SELECT COUNT(*) INTO v_overloads
  FROM pg_proc p
  JOIN pg_namespace n ON p.pronamespace = n.oid
  WHERE n.nspname = 'public' AND p.proname = 'book_slot_atomic';

  IF v_overloads != 1 THEN
    RAISE EXCEPTION 'Expected 1 book_slot_atomic overload, found %', v_overloads;
  END IF;

  -- 2. book_slot_atomic has correct EXECUTE privilege (service_role only)
  -- Verify PUBLIC cannot execute it
  SELECT COUNT(*) INTO v_count
  FROM information_schema.routine_privileges
  WHERE routine_schema = 'public' AND routine_name = 'book_slot_atomic'
    AND grantee = 'PUBLIC' AND privilege_type = 'EXECUTE';

  IF v_count > 0 THEN
    RAISE EXCEPTION 'book_slot_atomic is still executable by PUBLIC';
  END IF;

  -- 3. Membership tier auto-upgrade trigger exists
  SELECT COUNT(*) INTO v_count
  FROM pg_trigger
  WHERE tgname = 'trg_auto_upgrade_membership_tier';

  IF v_count = 0 THEN
    RAISE EXCEPTION 'Missing trigger: trg_auto_upgrade_membership_tier';
  END IF;

  -- 4. All three growth-credit CHECK constraints exist
  SELECT COUNT(*) INTO v_count
  FROM pg_constraint
  WHERE conname IN ('chk_credits_amount_positive', 'chk_credits_remaining_non_negative', 'chk_credits_remaining_lte_amount');

  IF v_count < 3 THEN
    RAISE EXCEPTION 'Expected 3 growth-credit CHECK constraints, found %', v_count;
  END IF;

  -- 5. Required financial indexes exist
  SELECT COUNT(*) INTO v_count
  FROM pg_indexes
  WHERE indexname IN (
    'idx_platform_fees_payment_unique',
    'idx_package_session_log_booking_unique',
    'idx_campaign_idempotency'
  );

  IF v_count < 3 THEN
    RAISE EXCEPTION 'Missing financial indexes, found % of 3', v_count;
  END IF;

  -- 6. platform_fees.payment_id column exists
  SELECT COUNT(*) INTO v_count
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'platform_fees' AND column_name = 'payment_id';

  IF v_count = 0 THEN
    RAISE EXCEPTION 'Missing column: platform_fees.payment_id';
  END IF;

  RAISE NOTICE 'All database assertions passed';
END $$;
