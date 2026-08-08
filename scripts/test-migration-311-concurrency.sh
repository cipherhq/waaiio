#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════
# Migration 311: Reseller Payout Concurrency Tests
# Real two-session PostgreSQL contention using background psql processes.
# Pattern follows FIN-002 proven architecture.
# ═══════════════════════════════════════════════════════════
set -euo pipefail

RESELLER_ID='00000000-0000-0000-0000-000000000311'
PAYOUT_A='00000000-0000-0000-0000-00000000031a'
PAYOUT_B='00000000-0000-0000-0000-00000000031b'
ADMIN_ID='00000000-0000-0000-0000-000000000001'
FAILED=0

cleanup() {
  echo "Cleaning up migration 311 test data..."
  psql -q -c "DELETE FROM reseller_payouts WHERE reseller_id = '$RESELLER_ID'" 2>/dev/null || true
  psql -q -c "DELETE FROM platform_fees WHERE reseller_id = '$RESELLER_ID'" 2>/dev/null || true
  psql -q -c "DELETE FROM resellers WHERE id IN ('$RESELLER_ID', '00000000-0000-0000-0000-000000000313')" 2>/dev/null || true
  rm -f /tmp/m311_*.txt
}
trap cleanup EXIT

echo "=== Migration 311: Reseller Payout Concurrency Tests ==="

# ── SETUP ──
psql -v ON_ERROR_STOP=1 -q <<SETUP
DELETE FROM reseller_payouts WHERE reseller_id = '$RESELLER_ID';
DELETE FROM platform_fees WHERE reseller_id = '$RESELLER_ID';
DELETE FROM resellers WHERE id = '$RESELLER_ID';
INSERT INTO resellers (id, company_name, contact_email, commission_percentage)
  VALUES ('$RESELLER_ID', 'M311 Test Reseller', 'm311@test.local', 10);
-- Seed 1000 in commission earnings
INSERT INTO platform_fees (business_id, payment_id, fee_amount, reseller_id, reseller_commission)
  VALUES (
    (SELECT id FROM businesses LIMIT 1),
    'test-m311-' || gen_random_uuid()::text,
    100, '$RESELLER_ID', 1000
  );
SETUP

# ════════════════════════════════════════
# TEST 1: 700 + 700 on 1000 balance
# ════════════════════════════════════════
echo ""
echo "--- Test 1: 700 + 700 on 1000 (overspend prevention) ---"

psql -v ON_ERROR_STOP=1 -q <<SEED1
DELETE FROM reseller_payouts WHERE reseller_id = '$RESELLER_ID';
INSERT INTO reseller_payouts (id, reseller_id, period_start, period_end, gross_commission, net_amount, status)
VALUES
  ('$PAYOUT_A', '$RESELLER_ID', '2026-01-01', '2026-01-15', 700, 700, 'approved'),
  ('$PAYOUT_B', '$RESELLER_ID', '2026-01-15', '2026-02-01', 700, 700, 'approved');
SEED1

# Session A: mark_paid with pg_sleep to hold advisory lock
psql -t -A <<SESSION_A > /tmp/m311_a1.txt 2>&1 &
BEGIN;
SELECT mark_reseller_payout_paid('$PAYOUT_A', '$ADMIN_ID');
SELECT pg_sleep(2);
COMMIT;
SESSION_A
PID_A=$!

sleep 0.5

# Session B: concurrent mark_paid
psql -t -A <<SESSION_B > /tmp/m311_b1.txt 2>&1 &
SELECT mark_reseller_payout_paid('$PAYOUT_B', '$ADMIN_ID');
SESSION_B
PID_B=$!

wait $PID_A || true
wait $PID_B || true

RESULT_A=$(grep -oP '"success"\s*:\s*(true|false)' /tmp/m311_a1.txt | head -1 | grep -oP 'true|false')
RESULT_B=$(grep -oP '"success"\s*:\s*(true|false)' /tmp/m311_b1.txt | head -1 | grep -oP 'true|false')
PAID_COUNT=$(psql -t -A -c "SELECT COUNT(*) FROM reseller_payouts WHERE reseller_id='$RESELLER_ID' AND status='paid'")
TOTAL_PAID=$(psql -t -A -c "SELECT COALESCE(SUM(net_amount),0) FROM reseller_payouts WHERE reseller_id='$RESELLER_ID' AND status='paid'")

SUCCESSES=0
[ "$RESULT_A" = "true" ] && SUCCESSES=$((SUCCESSES+1))
[ "$RESULT_B" = "true" ] && SUCCESSES=$((SUCCESSES+1))

echo "  Session A success: $RESULT_A"
echo "  Session B success: $RESULT_B"
echo "  Paid count: $PAID_COUNT"
echo "  Total paid: $TOTAL_PAID"

if [ "$SUCCESSES" -ne 1 ]; then echo "FAIL: exactly one should succeed, got $SUCCESSES"; FAILED=1; fi
if [ "$PAID_COUNT" -ne 1 ]; then echo "FAIL: exactly one paid row, got $PAID_COUNT"; FAILED=1; fi
if [ "$TOTAL_PAID" -ne 700 ]; then echo "FAIL: total paid should be 700, got $TOTAL_PAID"; FAILED=1; fi

[ "$FAILED" -eq 0 ] && echo "  ✅ Test 1 PASSED"

# ════════════════════════════════════════
# TEST 2: 400 + 600 on 1000 (both fit)
# ════════════════════════════════════════
echo ""
echo "--- Test 2: 400 + 600 on 1000 (both should succeed) ---"

psql -v ON_ERROR_STOP=1 -q <<SEED2
DELETE FROM reseller_payouts WHERE reseller_id = '$RESELLER_ID';
INSERT INTO reseller_payouts (id, reseller_id, period_start, period_end, gross_commission, net_amount, status)
VALUES
  ('$PAYOUT_A', '$RESELLER_ID', '2026-03-01', '2026-03-15', 400, 400, 'approved'),
  ('$PAYOUT_B', '$RESELLER_ID', '2026-03-15', '2026-04-01', 600, 600, 'approved');
SEED2

# Deterministic overlap: Session A holds advisory lock with pg_sleep
psql -t -A <<SESSION_A2 > /tmp/m311_a2.txt 2>&1 &
BEGIN;
SELECT mark_reseller_payout_paid('$PAYOUT_A', '$ADMIN_ID');
SELECT pg_sleep(2);
COMMIT;
SESSION_A2
PID_A=$!
sleep 0.5
# Session B blocks on advisory lock until A commits
psql -t -A -c "SELECT mark_reseller_payout_paid('$PAYOUT_B', '$ADMIN_ID')" > /tmp/m311_b2.txt 2>&1 &
PID_B=$!
wait $PID_A || true
wait $PID_B || true

RESULT_A=$(grep -oP '"success"\s*:\s*(true|false)' /tmp/m311_a2.txt | head -1 | grep -oP 'true|false')
RESULT_B=$(grep -oP '"success"\s*:\s*(true|false)' /tmp/m311_b2.txt | head -1 | grep -oP 'true|false')
TOTAL_PAID=$(psql -t -A -c "SELECT COALESCE(SUM(net_amount),0) FROM reseller_payouts WHERE reseller_id='$RESELLER_ID' AND status='paid'")

echo "  Session A success: $RESULT_A"
echo "  Session B success: $RESULT_B"
echo "  Total paid: $TOTAL_PAID"

if [ "$RESULT_A" != "true" ] || [ "$RESULT_B" != "true" ]; then echo "FAIL: both should succeed"; FAILED=1; fi
if [ "$TOTAL_PAID" -ne 1000 ]; then echo "FAIL: total paid should be 1000, got $TOTAL_PAID"; FAILED=1; fi

[ "$FAILED" -eq 0 ] && echo "  ✅ Test 2 PASSED"

# ════════════════════════════════════════
# TEST 3: Same payout called twice
# ════════════════════════════════════════
echo ""
echo "--- Test 3: Same payout concurrency ---"

psql -v ON_ERROR_STOP=1 -q <<SEED3
DELETE FROM reseller_payouts WHERE reseller_id = '$RESELLER_ID';
INSERT INTO reseller_payouts (id, reseller_id, period_start, period_end, gross_commission, net_amount, status)
VALUES ('$PAYOUT_A', '$RESELLER_ID', '2026-05-01', '2026-05-15', 500, 500, 'approved');
SEED3

psql -t -A <<SESSION_A3 > /tmp/m311_a3.txt 2>&1 &
BEGIN;
SELECT mark_reseller_payout_paid('$PAYOUT_A', '$ADMIN_ID');
SELECT pg_sleep(2);
COMMIT;
SESSION_A3
PID_A=$!
sleep 0.5
psql -t -A -c "SELECT mark_reseller_payout_paid('$PAYOUT_A', '$ADMIN_ID')" > /tmp/m311_b3.txt 2>&1 &
PID_B=$!
wait $PID_A || true
wait $PID_B || true

RESULT_A=$(grep -oP '"success"\s*:\s*(true|false)' /tmp/m311_a3.txt | head -1 | grep -oP 'true|false')
RESULT_B=$(grep -oP '"success"\s*:\s*(true|false)' /tmp/m311_b3.txt | head -1 | grep -oP 'true|false')
PAID_COUNT=$(psql -t -A -c "SELECT COUNT(*) FROM reseller_payouts WHERE id='$PAYOUT_A' AND status='paid'")

echo "  Session A success: $RESULT_A"
echo "  Session B success: $RESULT_B"
echo "  Paid count: $PAID_COUNT"

SUCCESSES=0
[ "$RESULT_A" = "true" ] && SUCCESSES=$((SUCCESSES+1))
[ "$RESULT_B" = "true" ] && SUCCESSES=$((SUCCESSES+1))

if [ "$SUCCESSES" -ne 1 ]; then echo "FAIL: exactly one should succeed, got $SUCCESSES"; FAILED=1; fi
if [ "$PAID_COUNT" -ne 1 ]; then echo "FAIL: should be exactly 1 paid, got $PAID_COUNT"; FAILED=1; fi

[ "$FAILED" -eq 0 ] && echo "  ✅ Test 3 PASSED"

# ════════════════════════════════════════
# TEST 4: Concurrent overlapping period INSERT
# ════════════════════════════════════════
echo ""
echo "--- Test 4: Overlapping period concurrency ---"

psql -v ON_ERROR_STOP=1 -q <<SEED4
DELETE FROM reseller_payouts WHERE reseller_id = '$RESELLER_ID';
SEED4

psql -t -A <<INSERT_A > /tmp/m311_a4.txt 2>&1 &
BEGIN;
INSERT INTO reseller_payouts (reseller_id, period_start, period_end, net_amount, status)
  VALUES ('$RESELLER_ID', '2026-12-01', '2026-12-15', 100, 'pending');
SELECT pg_sleep(2);
COMMIT;
INSERT_A
PID_A=$!
sleep 0.5
# Session B: expected to fail with exclusion constraint (23P01)
psql -t -A -c "INSERT INTO reseller_payouts (reseller_id, period_start, period_end, net_amount, status) VALUES ('$RESELLER_ID', '2026-12-10', '2026-12-20', 100, 'pending')" > /tmp/m311_b4.txt 2>&1 || true
PID_B_EXIT=$?
wait $PID_A || true

ROW_COUNT=$(psql -t -A -c "SELECT COUNT(*) FROM reseller_payouts WHERE reseller_id='$RESELLER_ID' AND period_start >= '2026-12-01' AND status != 'rejected'")

echo "  Active payout rows: $ROW_COUNT"

# Verify the loser got an exclusion constraint violation
if grep -q "exclusion" /tmp/m311_b4.txt || grep -q "23P01" /tmp/m311_b4.txt; then
  echo "  Loser received exclusion constraint violation (23P01) — correct"
else
  echo "  Session B output: $(cat /tmp/m311_b4.txt)"
  echo "FAIL: loser did not receive exclusion constraint violation"
  FAILED=1
fi

if [ "$ROW_COUNT" -ne 1 ]; then echo "FAIL: exactly one overlapping payout should exist, got $ROW_COUNT"; FAILED=1; fi

[ "$FAILED" -eq 0 ] && echo "  ✅ Test 4 PASSED"

# ════════════════════════════════════════
# FINAL RESULT
# ════════════════════════════════════════
echo ""
if [ "$FAILED" -eq 0 ]; then
  echo "✅ All Migration 311 concurrency tests PASSED"
  exit 0
else
  echo "❌ Some Migration 311 concurrency tests FAILED"
  exit 1
fi
