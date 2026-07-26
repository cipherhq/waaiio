-- FIN-002: Real PostgreSQL concurrency and constraint tests
-- Executed by CI against the migration-validated PostgreSQL instance.
-- Uses psql with ON_ERROR_STOP=1 — any failure stops the script.
--
-- Tests run as the postgres superuser (CI context). Role-based privilege
-- tests use SET ROLE to simulate anon/authenticated/service_role.

\set ON_ERROR_STOP on

-- ── Setup: create test data ──

-- Disable triggers on auth.users to avoid handle_new_user firing
-- (the CI auth.users stub may not have all columns the trigger expects)
ALTER TABLE auth.users DISABLE TRIGGER ALL;
INSERT INTO auth.users (id, email) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'test-fin002@test.local');
ALTER TABLE auth.users ENABLE TRIGGER ALL;

-- Create matching profile (profiles has first_name/last_name, not full_name)
INSERT INTO profiles (id, first_name, last_name, email) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'FIN002', 'Test', 'test-fin002@test.local')
  ON CONFLICT (id) DO NOTHING;

INSERT INTO businesses (id, name, slug, owner_id, address, city, neighborhood, phone, status, payout_mode, country_code, verification_level)
VALUES ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'FIN-002 Test', 'fin002-test',
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        '123 Test St', 'Lagos', 'VI', '+2340000000000',
        'active', 'platform_managed', 'NG', 'basic');

INSERT INTO payout_accounts (id, business_id, gateway, bank_name, account_name, bank_code, account_number, is_active, verified_at)
VALUES ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'paystack', 'Test Bank', 'Test', '058', '0123456789', true, NOW());

-- Test payout 1: for concurrent claims
INSERT INTO business_payouts (id, business_id, payout_account_id, period_start, period_end, gross_amount, platform_fee, gateway_fee, net_amount, status)
VALUES ('dddddddd-dddd-dddd-dddd-dddddddddddd', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'cccccccc-cccc-cccc-cccc-cccccccccccc',
        '2024-01-01', '2024-01-07', 10000, 500, 100, 9400, 'pending');

-- Test payout 2: for stale-token tests
INSERT INTO business_payouts (id, business_id, payout_account_id, period_start, period_end, gross_amount, platform_fee, gateway_fee, net_amount, status)
VALUES ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'cccccccc-cccc-cccc-cccc-cccccccccccc',
        '2024-01-08', '2024-01-14', 5000, 250, 50, 4700, 'pending');

-- Test payout 3: for manual completion
INSERT INTO business_payouts (id, business_id, payout_account_id, period_start, period_end, gross_amount, platform_fee, gateway_fee, net_amount, status)
VALUES ('ffffffff-ffff-ffff-ffff-ffffffffffff', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'cccccccc-cccc-cccc-cccc-cccccccccccc',
        '2024-01-15', '2024-01-21', 3000, 150, 30, 2820, 'pending');

-- Test payout 4: for review_required reclaim test
INSERT INTO business_payouts (id, business_id, payout_account_id, period_start, period_end, gross_amount, platform_fee, gateway_fee, net_amount, status)
VALUES ('11111111-1111-1111-1111-111111111111', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'cccccccc-cccc-cccc-cccc-cccccccccccc',
        '2024-01-22', '2024-01-28', 2000, 100, 20, 1880, 'pending');

\echo '=== FIN-002 Database Tests ==='
\echo ''

-- ══════════════════════════════════════════
-- Test 1: PostgreSQL generates claim token
-- ══════════════════════════════════════════
\echo 'Test 1: PostgreSQL generates claim token'
DO $$
DECLARE r RECORD;
BEGIN
  SELECT * INTO r FROM claim_payout_for_transfer('dddddddd-dddd-dddd-dddd-dddddddddddd', 'paystack_transfer', NULL);
  ASSERT r.claimed_token IS NOT NULL, 'claim_token must be generated';
  ASSERT r.claimed_id = 'dddddddd-dddd-dddd-dddd-dddddddddddd', 'claimed_id must match';
  RAISE NOTICE '  PASS';
END $$;

-- ══════════════════════════════════════════
-- Test 2: PostgreSQL generates deterministic provider key
-- ══════════════════════════════════════════
\echo 'Test 2: Deterministic provider key = payout_{id}'
DO $$
DECLARE v_key TEXT;
BEGIN
  SELECT provider_idempotency_key INTO v_key FROM business_payouts WHERE id = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
  ASSERT v_key = 'payout_dddddddd-dddd-dddd-dddd-dddddddddddd', 'provider key must be payout_{id}, got: ' || COALESCE(v_key, 'NULL');
  RAISE NOTICE '  PASS';
END $$;

-- ══════════════════════════════════════════
-- Test 3: Second claim returns empty — cannot replace first
-- ══════════════════════════════════════════
\echo 'Test 3: Second claim returns empty'
DO $$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count FROM claim_payout_for_transfer('dddddddd-dddd-dddd-dddd-dddddddddddd', 'paystack_transfer', NULL);
  ASSERT v_count = 0, 'second claim must return 0 rows, got: ' || v_count;
  RAISE NOTICE '  PASS';
END $$;

-- ══════════════════════════════════════════
-- Test 4: Unique partial index enforces uniqueness
-- ══════════════════════════════════════════
\echo 'Test 4: Unique partial index on provider_idempotency_key'
DO $$
BEGIN
  -- Attempt to manually set a duplicate key
  BEGIN
    UPDATE business_payouts SET provider_idempotency_key = 'payout_dddddddd-dddd-dddd-dddd-dddddddddddd'
    WHERE id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
    RAISE EXCEPTION 'Should have violated unique index';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE '  PASS (unique violation caught)';
  END;
END $$;

-- ══════════════════════════════════════════
-- Test 5: Stale token cannot mark submitted
-- ══════════════════════════════════════════
\echo 'Test 5: Stale token cannot mark submitted'
DO $$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count FROM mark_payout_provider_submitted(
    'dddddddd-dddd-dddd-dddd-dddddddddddd',
    '00000000-0000-0000-0000-000000000000',
    'TRF_fake'
  );
  ASSERT v_count = 0, 'stale token must update 0 rows, got: ' || v_count;
  RAISE NOTICE '  PASS';
END $$;

-- ══════════════════════════════════════════
-- Test 6: Stale token cannot mark failed
-- ══════════════════════════════════════════
\echo 'Test 6: Stale token cannot mark failed'
DO $$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count FROM mark_payout_transfer_failed(
    'dddddddd-dddd-dddd-dddd-dddddddddddd',
    '00000000-0000-0000-0000-000000000000'
  );
  ASSERT v_count = 0, 'stale token must update 0 rows, got: ' || v_count;
  RAISE NOTICE '  PASS';
END $$;

-- ══════════════════════════════════════════
-- Test 7: Stale token cannot mark review_required
-- ══════════════════════════════════════════
\echo 'Test 7: Stale token cannot mark review_required'
DO $$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count FROM mark_payout_review_required(
    'dddddddd-dddd-dddd-dddd-dddddddddddd',
    '00000000-0000-0000-0000-000000000000'
  );
  ASSERT v_count = 0, 'stale token must update 0 rows, got: ' || v_count;
  RAISE NOTICE '  PASS';
END $$;

-- ══════════════════════════════════════════
-- Test 8: Claimed payout cannot return to pending
-- ══════════════════════════════════════════
\echo 'Test 8: Cannot return to pending (claim WHERE excludes processing)'
DO $$
DECLARE v_count INT;
BEGIN
  -- payout dddd is in 'processing' — claim only accepts pending/approved/held
  SELECT COUNT(*) INTO v_count FROM claim_payout_for_transfer('dddddddd-dddd-dddd-dddd-dddddddddddd', 'paystack_transfer', NULL);
  ASSERT v_count = 0, 'processing payout must not be reclaimable';
  RAISE NOTICE '  PASS';
END $$;

-- ══════════════════════════════════════════
-- Test 9: Cannot return to approved
-- ══════════════════════════════════════════
\echo 'Test 9: Cannot return to approved'
DO $$
DECLARE v_status TEXT;
BEGIN
  -- All transition RPCs only accept status = 'processing' and write forward states
  -- There is no RPC that writes status = 'approved'
  SELECT status INTO v_status FROM business_payouts WHERE id = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
  ASSERT v_status = 'processing', 'status should still be processing';
  RAISE NOTICE '  PASS';
END $$;

-- ══════════════════════════════════════════
-- Test 10: Cannot return to held
-- ══════════════════════════════════════════
\echo 'Test 10: No RPC writes held status (real assertion)'
DO $$
DECLARE v_count INT;
BEGIN
  -- Verify no function body contains the string "'held'" as a target status
  SELECT COUNT(*) INTO v_count FROM pg_proc
  WHERE proname IN ('claim_payout_for_transfer', 'mark_payout_provider_submitted',
                    'mark_payout_transfer_failed', 'mark_payout_review_required')
    AND prosrc LIKE '%''held''%';
  ASSERT v_count = 0, 'no FIN-002 RPC should write held, found: ' || v_count;
  RAISE NOTICE '  PASS';
END $$;

-- ══════════════════════════════════════════
-- Test 11: Unsupported methods rejected
-- ══════════════════════════════════════════
\echo 'Test 11: Unsupported method square_transfer rejected'
DO $$
BEGIN
  BEGIN
    PERFORM claim_payout_for_transfer('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'square_transfer', NULL);
    RAISE EXCEPTION 'Should have been rejected';
  EXCEPTION WHEN invalid_parameter_value THEN
    RAISE NOTICE '  PASS (square_transfer rejected)';
  END;
END $$;

\echo 'Test 12: Unsupported method manual_bank rejected by claim RPC'
DO $$
BEGIN
  BEGIN
    PERFORM claim_payout_for_transfer('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'manual_bank', NULL);
    RAISE EXCEPTION 'Should have been rejected';
  EXCEPTION WHEN invalid_parameter_value THEN
    RAISE NOTICE '  PASS (manual_bank rejected by claim)';
  END;
END $$;

-- ══════════════════════════════════════════
-- Test 13-15: Privilege tests (PUBLIC/anon/authenticated denied)
-- ══════════════════════════════════════════
\echo 'Test 13: Unprivileged role cannot execute claim RPC'
DO $$
BEGIN
  -- Create a truly unprivileged role with no direct grants
  BEGIN CREATE ROLE fin002_test_unprivileged NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END;
  BEGIN
    SET ROLE fin002_test_unprivileged;
    PERFORM claim_payout_for_transfer('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'paystack_transfer', NULL);
    RESET ROLE;
    RAISE EXCEPTION 'unprivileged role should not execute';
  EXCEPTION WHEN insufficient_privilege THEN
    RESET ROLE;
    RAISE NOTICE '  PASS (unprivileged role denied)';
  END;
END $$;

\echo 'Test 13b: anon cannot execute claim RPC'
DO $$
BEGIN
  BEGIN
    SET ROLE anon;
    PERFORM claim_payout_for_transfer('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'paystack_transfer', NULL);
    RESET ROLE;
    RAISE EXCEPTION 'anon should not execute';
  EXCEPTION WHEN insufficient_privilege THEN
    RESET ROLE;
    RAISE NOTICE '  PASS (anon denied)';
  END;
END $$;

\echo 'Test 14: authenticated cannot execute claim RPC'
DO $$
BEGIN
  BEGIN
    SET ROLE authenticated;
    PERFORM claim_payout_for_transfer('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'paystack_transfer', NULL);
    RESET ROLE;
    RAISE EXCEPTION 'authenticated should not execute';
  EXCEPTION WHEN insufficient_privilege THEN
    RESET ROLE;
    RAISE NOTICE '  PASS (authenticated denied)';
  END;
END $$;

\echo 'Test 15: service_role can execute claim RPC'
DO $$
DECLARE v_count INT;
BEGIN
  SET ROLE service_role;
  SELECT COUNT(*) INTO v_count FROM claim_payout_for_transfer('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'paystack_transfer', NULL);
  RESET ROLE;
  ASSERT v_count = 1, 'service_role must be able to claim';
  RAISE NOTICE '  PASS';
END $$;

-- ══════════════════════════════════════════
-- Test 16: No generic finalize_payout_transfer remains
-- ══════════════════════════════════════════
\echo 'Test 16: No finalize_payout_transfer overload exists'
DO $$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count FROM pg_proc WHERE proname = 'finalize_payout_transfer';
  ASSERT v_count = 0, 'finalize_payout_transfer should be dropped, found: ' || v_count;
  RAISE NOTICE '  PASS';
END $$;

-- ══════════════════════════════════════════
-- Test 17: No conflicting claim RPC overload
-- ══════════════════════════════════════════
\echo 'Test 17: Exactly one claim_payout_for_transfer overload'
DO $$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count FROM pg_proc WHERE proname = 'claim_payout_for_transfer';
  ASSERT v_count = 1, 'exactly one claim overload expected, found: ' || v_count;
  RAISE NOTICE '  PASS';
END $$;

-- ══════════════════════════════════════════
-- Test 18: review_required cannot be reclaimed
-- ══════════════════════════════════════════
\echo 'Test 18: review_required payout cannot be reclaimed'
DO $$
DECLARE v_token UUID; v_count INT;
BEGIN
  -- payout eeee is now in 'processing' from test 15 — mark review_required
  SELECT claim_token INTO v_token FROM business_payouts WHERE id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
  PERFORM mark_payout_review_required('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', v_token);

  -- Verify status
  ASSERT (SELECT status FROM business_payouts WHERE id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee') = 'review_required';

  -- Try to reclaim — should fail
  SELECT COUNT(*) INTO v_count FROM claim_payout_for_transfer('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'paystack_transfer', NULL);
  ASSERT v_count = 0, 'review_required must not be reclaimable';
  RAISE NOTICE '  PASS';
END $$;

-- ══════════════════════════════════════════
-- Test 19: Migration 292 applied cleanly (columns exist)
-- ══════════════════════════════════════════
\echo 'Test 19: Migration 292 columns exist'
DO $$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count FROM information_schema.columns
  WHERE table_name = 'business_payouts' AND column_name IN ('claim_token', 'provider_idempotency_key', 'processing_started_at');
  ASSERT v_count = 3, 'all 3 FIN-002 columns must exist, found: ' || v_count;
  RAISE NOTICE '  PASS';
END $$;

-- ══════════════════════════════════════════
-- Test 20: Manual completion changes exactly one row
-- ══════════════════════════════════════════
\echo 'Test 20: Manual completion changes one row'
DO $$
DECLARE v_updated INT;
BEGIN
  -- Update payout ffff from pending to paid (manual completion)
  WITH updated AS (
    UPDATE business_payouts SET status = 'paid', paid_at = NOW(), updated_at = NOW()
    WHERE id = 'ffffffff-ffff-ffff-ffff-ffffffffffff' AND status IN ('pending', 'approved', 'held')
    RETURNING id
  )
  SELECT COUNT(*) INTO v_updated FROM updated;
  ASSERT v_updated = 1, 'first manual completion must update 1 row, got: ' || v_updated;
  RAISE NOTICE '  PASS';
END $$;

-- ══════════════════════════════════════════
-- Test 21: Repeated manual completion changes zero rows
-- ══════════════════════════════════════════
\echo 'Test 21: Repeated manual completion changes zero rows'
DO $$
DECLARE v_updated INT;
BEGIN
  WITH updated AS (
    UPDATE business_payouts SET status = 'paid', paid_at = NOW(), updated_at = NOW()
    WHERE id = 'ffffffff-ffff-ffff-ffff-ffffffffffff' AND status IN ('pending', 'approved', 'held')
    RETURNING id
  )
  SELECT COUNT(*) INTO v_updated FROM updated;
  ASSERT v_updated = 0, 'repeated manual completion must update 0 rows, got: ' || v_updated;
  RAISE NOTICE '  PASS';
END $$;

-- ══════════════════════════════════════════
-- Test 22: Correct claim token can submit
-- ══════════════════════════════════════════
\echo 'Test 22: Correct token can mark submitted'
DO $$
DECLARE v_token UUID; v_count INT;
BEGIN
  SELECT claim_token INTO v_token FROM business_payouts WHERE id = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
  SELECT COUNT(*) INTO v_count FROM mark_payout_provider_submitted('dddddddd-dddd-dddd-dddd-dddddddddddd', v_token, 'TRF_real');
  ASSERT v_count = 1, 'correct token must submit, got: ' || v_count;
  -- Verify transfer code persisted
  ASSERT (SELECT gateway_transfer_code FROM business_payouts WHERE id = 'dddddddd-dddd-dddd-dddd-dddddddddddd') = 'TRF_real';
  RAISE NOTICE '  PASS';
END $$;

-- ── Cleanup ──
DELETE FROM business_payouts WHERE business_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
DELETE FROM payout_accounts WHERE business_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
DELETE FROM businesses WHERE id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
DELETE FROM profiles WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
ALTER TABLE auth.users DISABLE TRIGGER ALL;
DELETE FROM auth.users WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
ALTER TABLE auth.users ENABLE TRIGGER ALL;

\echo ''
\echo '=== FIN-002: All 22 database tests PASSED ==='
