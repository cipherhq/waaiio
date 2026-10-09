#!/usr/bin/env bash
# #598 / M434 -- executable, role-faithful PostgreSQL loyalty redemption proof.
# Run only against disposable CI PostgreSQL AFTER all migrations are applied.
set -euo pipefail

BIZ='59800000-0000-0000-0000-000000000001'
ACCOUNT='59810000-0000-0000-0000-000000000001'
ACCOUNT2='59810000-0000-0000-0000-000000000002'
RACE_ACCOUNT='59810000-0000-0000-0000-000000000003'
OTHER_BIZ='59800000-0000-0000-0000-000000000002'
PHONE='+2348000598001'
PHONE2='+2348000598002'
PHONE3='+2348000598003'

cleanup() {
  psql -q -v ON_ERROR_STOP=1 <<SQL >/dev/null 2>&1 || true
DELETE FROM public.loyalty_transactions WHERE business_id IN ('$BIZ', '$OTHER_BIZ');
DELETE FROM public.loyalty_points WHERE business_id IN ('$BIZ', '$OTHER_BIZ');
DELETE FROM public.businesses WHERE id IN ('$BIZ', '$OTHER_BIZ');
SQL
}
trap cleanup EXIT

# This is a local disposable DB seeded by ci-bootstrap-test-db.sh.
# Never run with project credentials or a live Supabase connection string.
psql -v ON_ERROR_STOP=1 -q <<SQL
INSERT INTO public.businesses
  (id, name, slug, owner_id, address, city, neighborhood, phone, status, country_code)
VALUES
  ('$BIZ', 'M434 CI', 'm434-local-test-one', '00000000-0000-0000-0000-000000000001', 'Test', 'Lagos', 'VI', '000', 'active', 'NG'),
  ('$OTHER_BIZ', 'M434 CI 2', 'm434-local-test-two', '00000000-0000-0000-0000-000000000001', 'Test', 'Lagos', 'VI', '001', 'active', 'NG');

INSERT INTO public.loyalty_points (id, business_id, customer_phone, points_balance, total_earned)
VALUES
  ('$ACCOUNT', '$BIZ', '$PHONE', 300, 300),
  ('$ACCOUNT2', '$BIZ', '$PHONE2', 250, 250),
  ('$RACE_ACCOUNT', '$BIZ', '$PHONE3', 250, 250);
SQL

# Assert actual final catalog, not a source-text grant string.
psql -v ON_ERROR_STOP=1 -q <<'SQL'
DO $$
DECLARE fn regprocedure := 'public.redeem_loyalty_reward_once(uuid,uuid,text,integer,text,text)'::regprocedure;
BEGIN
  IF NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = fn) THEN
    RAISE EXCEPTION 'M434 RPC must be SECURITY DEFINER';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = fn AND 'search_path=public, pg_temp' = ANY(p.proconfig)) THEN
    RAISE EXCEPTION 'M434 RPC must pin search_path';
  END IF;
  IF NOT has_function_privilege('service_role', fn, 'EXECUTE')
     OR has_function_privilege('anon', fn, 'EXECUTE')
     OR has_function_privilege('authenticated', fn, 'EXECUTE')
     OR has_function_privilege('public', fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'M434 RPC role grants are unsafe';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='idx_loyalty_reward_receipt_key' AND indexdef ILIKE '%UNIQUE%')
     OR NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='idx_loyalty_reward_receipt_code' AND indexdef ILIKE '%UNIQUE%') THEN
    RAISE EXCEPTION 'M434 receipt and code uniqueness not installed';
  END IF;
  RAISE NOTICE 'PASS: final-state ACL, search_path, receipt uniqueness';
END $$;
SQL

# Real SQL execution as the three relevant API roles.
for role in anon authenticated; do
  if output=$(psql -v ON_ERROR_STOP=1 -At -c "SET ROLE $role; SELECT public.redeem_loyalty_reward_once('$ACCOUNT', '$BIZ', '$PHONE', 200, 'bot:m434-denied', 'RW-ABC234');" 2>&1); then
    echo "FAIL: $role can execute the privileged redemption RPC: $output"
    exit 1
  fi
  if ! grep -qi 'permission denied' <<<"$output"; then
    echo "FAIL: $role denied for unexpected reason: $output"
    exit 1
  fi
done
echo 'PASS: anon and authenticated denied by real execution'

# Service-role RPC performs a REAL deduction and persistent INSERT, not a mock.
psql -v ON_ERROR_STOP=1 -q <<SQL
BEGIN;
SET LOCAL ROLE service_role;
DO \$m434\$
DECLARE result jsonb;
BEGIN
  result := public.redeem_loyalty_reward_once(
    '$ACCOUNT', '$BIZ', '$PHONE', 200, 'bot:m434-first', 'RW-ABC234');
  IF result->>'success' IS DISTINCT FROM 'true' OR result->>'replayed' IS DISTINCT FROM 'false'
     OR (result->>'points_balance')::integer <> 100 THEN
    RAISE EXCEPTION 'First debit and receipt failed: %', result;
  END IF;
END \$m434\$;
COMMIT;
SQL

psql -v ON_ERROR_STOP=1 -q <<SQL
DO \$m434\$
DECLARE result jsonb; raised boolean := false;
BEGIN
  -- A retry proposes a NEW code but must return the original durable receipt.
  result := public.redeem_loyalty_reward_once(
    '$ACCOUNT', '$BIZ', '$PHONE', 200, 'bot:m434-first', 'RW-XYZ234');
  IF result->>'success' IS DISTINCT FROM 'true' OR result->>'replayed' IS DISTINCT FROM 'true'
     OR result->>'code' <> 'RW-ABC234' OR (result->>'points_balance')::integer <> 100 THEN
    RAISE EXCEPTION 'Replay mutated reward: %', result;
  END IF;

  -- Insufficient balance, wrong business/phone, negative points cannot issue rewards.
  result := public.redeem_loyalty_reward_once(
    '$ACCOUNT', '$BIZ', '$PHONE', 200, 'bot:m434-lowbal', 'RW-DEF234');
  IF result->>'reason' <> 'insufficient_points' THEN RAISE EXCEPTION 'Insufficient balance not refused'; END IF;
  result := public.redeem_loyalty_reward_once(
    '$ACCOUNT', '$OTHER_BIZ', '$PHONE', 50, 'bot:m434-crossbiz', 'RW-EFG234');
  IF result->>'reason' <> 'account_not_found' THEN RAISE EXCEPTION 'Cross-tenant redeem not refused'; END IF;
  result := public.redeem_loyalty_reward_once(
    '$ACCOUNT', '$BIZ', '+2348000000000', 50, 'bot:m434-wrongph', 'RW-FGH234');
  IF result->>'reason' <> 'account_not_found' THEN RAISE EXCEPTION 'Wrong customer redeem not refused'; END IF;
  result := public.redeem_loyalty_reward_once(
    '$ACCOUNT', '$BIZ', '$PHONE', -1, 'bot:m434-negpts', 'RW-HJK234');
  IF result->>'reason' <> 'invalid_request' THEN RAISE EXCEPTION 'Invalid debit not refused'; END IF;

  -- Same idempotency key with different points must never debit again.
  BEGIN
    result := public.redeem_loyalty_reward_once(
      '$ACCOUNT', '$BIZ', '$PHONE', 50, 'bot:m434-first', 'RW-JKL234');
    RAISE EXCEPTION 'M434 must not accept replay key with changed point amount: %', result;
  EXCEPTION WHEN unique_violation THEN
    raised := true;
  END;
  IF NOT raised THEN RAISE EXCEPTION 'Different-points replay must fail'; END IF;

  -- Unique code collision must throw and rollback the preceding debit.
  raised := false;
  BEGIN
    result := public.redeem_loyalty_reward_once(
      '$ACCOUNT2', '$BIZ', '$PHONE2', 100, 'api:m434-codecollision', 'RW-ABC234');
    RAISE EXCEPTION 'M434 duplicate reward code unexpectedly succeeded';
  EXCEPTION WHEN unique_violation THEN
    raised := true;
  END;
  IF NOT raised THEN RAISE EXCEPTION 'Duplicate code not rejected'; END IF;

  IF (SELECT points_balance FROM public.loyalty_points WHERE id='$ACCOUNT') <> 100
     OR (SELECT points_balance FROM public.loyalty_points WHERE id='$ACCOUNT2') <> 250
     OR (SELECT count(*) FROM public.loyalty_transactions
         WHERE business_id='$BIZ' AND reason='redemption') <> 1 THEN
    RAISE EXCEPTION 'M434 rollback/receipt invariant failed';
  END IF;
  RAISE NOTICE 'PASS: persistent receipt, replay, cross-tenant denial, failed-insert rollback';
END \$m434\$;
SQL

# Real two-session contention: one debit must win, the other must see low balance.
# Both transactions independently call the RPC with separate keys.
psql -v ON_ERROR_STOP=1 -At <<SQL >/tmp/m434_winner_598.txt 2>&1 &
BEGIN;
SELECT public.redeem_loyalty_reward_once(
  '$RACE_ACCOUNT', '$BIZ', '$PHONE3', 200, 'bot:m434-race-a', 'RW-MNP234');
SELECT pg_sleep(2);
COMMIT;
SQL
first=$!
sleep 0.3
psql -v ON_ERROR_STOP=1 -At <<SQL >/tmp/m434_loser_598.txt 2>&1 &
SELECT public.redeem_loyalty_reward_once(
  '$RACE_ACCOUNT', '$BIZ', '$PHONE3', 200, 'bot:m434-race-b', 'RW-PQR234');
SQL
second=$!
wait "$first"
wait "$second"

if ! grep -q '"success": true' /tmp/m434_winner_598.txt || ! grep -q '"success": false' /tmp/m434_loser_598.txt; then
  echo 'FAIL: contention must yield one success and one rejection'
  cat /tmp/m434_winner_598.txt /tmp/m434_loser_598.txt
  exit 1
fi

psql -v ON_ERROR_STOP=1 -q <<SQL
DO \$m434\$
BEGIN
  IF (SELECT points_balance FROM public.loyalty_points WHERE id='$RACE_ACCOUNT') <> 50
     OR (SELECT total_redeemed FROM public.loyalty_points WHERE id='$RACE_ACCOUNT') <> 200
     OR (SELECT count(*) FROM public.loyalty_transactions
         WHERE business_id='$BIZ' AND customer_phone='$PHONE3' AND reason='redemption') <> 1 THEN
    RAISE EXCEPTION 'M434 concurrent debit/receipt final state is incorrect';
  END IF;
  RAISE NOTICE 'PASS: two-session concurrency; one debit, one receipt';
END \$m434\$;
SQL

rm -f /tmp/m434_winner_598.txt /tmp/m434_loser_598.txt
echo 'PASS: M434 real PostgreSQL atomicity, ACL and concurrency tests'
