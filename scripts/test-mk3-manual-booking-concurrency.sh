#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════
# MK-3: Manual Booking Atomicity — Real PostgreSQL Concurrency Test
# Proves book_manual_slot_atomic prevents double-booking and atomically
# sets dashboard-specific fields (channel, confirmed_at, notes).
# ═══════════════════════════════════════════════════════════
set -euo pipefail

BIZ_OWNER='00000000-0000-0000-0000-0000000a3001'
BIZ_ID='00000000-0000-0000-0000-0000000a3002'
SVC_ID='00000000-0000-0000-0000-0000000a3003'
FAILED=0

cleanup() {
  echo "Cleaning up MK-3 test data..."
  psql -q -c "DELETE FROM bookings WHERE business_id = '$BIZ_ID'" 2>/dev/null || true
  psql -q -c "DELETE FROM services WHERE id = '$SVC_ID'" 2>/dev/null || true
  psql -q -c "DELETE FROM businesses WHERE id = '$BIZ_ID'" 2>/dev/null || true
  psql -q -c "DELETE FROM profiles WHERE id = '$BIZ_OWNER'" 2>/dev/null || true
  psql -q -c "ALTER TABLE auth.users DISABLE TRIGGER ALL; DELETE FROM auth.users WHERE id = '$BIZ_OWNER'; ALTER TABLE auth.users ENABLE TRIGGER ALL;" 2>/dev/null || true
  rm -f /tmp/mk3_*.txt
}
trap cleanup EXIT

echo "=== MK-3: Manual Booking Concurrency Tests ==="

# ── SETUP ──
psql -v ON_ERROR_STOP=1 -q <<SETUP
ALTER TABLE auth.users DISABLE TRIGGER ALL;
INSERT INTO auth.users (id) VALUES ('$BIZ_OWNER') ON CONFLICT DO NOTHING;
ALTER TABLE auth.users ENABLE TRIGGER ALL;
INSERT INTO profiles (id, first_name, last_name, email)
  VALUES ('$BIZ_OWNER', 'MK3', 'Test', 'mk3@test.local') ON CONFLICT DO NOTHING;
INSERT INTO businesses (id, name, slug, owner_id, address, city, neighborhood, phone, status, country_code)
  VALUES ('$BIZ_ID', 'MK3 Test Biz', 'mk3-test', '$BIZ_OWNER', '1 Test', 'Lagos', 'VI', '+0000', 'active', 'NG')
  ON CONFLICT DO NOTHING;
INSERT INTO services (id, business_id, name, price, duration_minutes, max_capacity, is_active)
  VALUES ('$SVC_ID', '$BIZ_ID', 'Test Haircut', 5000, 30, 1, true)
  ON CONFLICT DO NOTHING;
SETUP

# ════════════════════════════════════════
# TEST 1: Two concurrent bookings for capacity=1 slot
# ════════════════════════════════════════
echo ""
echo "--- Test 1: Two concurrent manual bookings, capacity=1 ---"

psql -v ON_ERROR_STOP=1 -q -c "DELETE FROM bookings WHERE business_id = '$BIZ_ID';"

# Session A: book_manual_slot_atomic with pg_sleep to hold advisory lock
psql -t -A <<SESSION_A > /tmp/mk3_a.txt 2>&1 &
BEGIN;
SELECT * FROM book_manual_slot_atomic(
  '$BIZ_ID'::uuid, '$BIZ_OWNER'::uuid, '$SVC_ID'::uuid, NULL::uuid,
  '2027-06-15'::date, '10:00', 1, 1,
  'Customer A', '+2348000000001', NULL,
  'Test notes A', 5000, NULL, 0, 30
);
SELECT pg_sleep(2);
COMMIT;
SESSION_A
PID_A=$!

sleep 0.5

# Session B: concurrent manual booking attempt
psql -t -A <<SESSION_B > /tmp/mk3_b.txt 2>&1 &
SELECT * FROM book_manual_slot_atomic(
  '$BIZ_ID'::uuid, '$BIZ_OWNER'::uuid, '$SVC_ID'::uuid, NULL::uuid,
  '2027-06-15'::date, '10:00', 1, 1,
  'Customer B', '+2348000000002', NULL,
  'Test notes B', 5000, NULL, 0, 30
);
SESSION_B
PID_B=$!

wait $PID_A || true
wait $PID_B || true

# Count bookings — must be exactly 1
BOOKING_COUNT=$(psql -t -A -c "SELECT COUNT(*) FROM bookings WHERE business_id='$BIZ_ID' AND date='2027-06-15' AND time='10:00:00' AND status IN ('confirmed','pending')")

echo "  Final booking count: $BOOKING_COUNT"

# Verify dashboard metadata on the winner
WINNER_CHANNEL=$(psql -t -A -c "SELECT channel FROM bookings WHERE business_id='$BIZ_ID' AND date='2027-06-15' AND time='10:00:00' AND status = 'confirmed' LIMIT 1")
WINNER_CONFIRMED=$(psql -t -A -c "SELECT confirmed_at IS NOT NULL FROM bookings WHERE business_id='$BIZ_ID' AND date='2027-06-15' AND time='10:00:00' AND status = 'confirmed' LIMIT 1")
WINNER_NOTES=$(psql -t -A -c "SELECT notes IS NOT NULL FROM bookings WHERE business_id='$BIZ_ID' AND date='2027-06-15' AND time='10:00:00' AND status = 'confirmed' LIMIT 1")

echo "  Winner channel: $WINNER_CHANNEL"
echo "  Winner confirmed_at set: $WINNER_CONFIRMED"
echo "  Winner notes set: $WINNER_NOTES"

if [ "$BOOKING_COUNT" -ne 1 ]; then echo "FAIL: exactly 1 booking expected, got $BOOKING_COUNT"; FAILED=1; fi
if [ "$WINNER_CHANNEL" != "dashboard" ]; then echo "FAIL: channel should be dashboard, got $WINNER_CHANNEL"; FAILED=1; fi
if [ "$WINNER_CONFIRMED" != "t" ]; then echo "FAIL: confirmed_at should be set"; FAILED=1; fi
if [ "$WINNER_NOTES" != "t" ]; then echo "FAIL: notes should be set"; FAILED=1; fi

[ "$FAILED" -eq 0 ] && echo "  ✅ Test 1 PASSED"

# ════════════════════════════════════════
# TEST 2: Both succeed for capacity=2
# ════════════════════════════════════════
echo ""
echo "--- Test 2: Two concurrent bookings, capacity=2 ---"

psql -v ON_ERROR_STOP=1 -q -c "DELETE FROM bookings WHERE business_id = '$BIZ_ID';"

psql -t -A <<SESSION_C > /tmp/mk3_c.txt 2>&1 &
BEGIN;
SELECT * FROM book_manual_slot_atomic(
  '$BIZ_ID'::uuid, '$BIZ_OWNER'::uuid, '$SVC_ID'::uuid, NULL::uuid,
  '2027-06-16'::date, '11:00', 1, 2,
  'Customer C', '+2348000000003', NULL,
  'Notes C', 5000, NULL, 0, 30
);
SELECT pg_sleep(2);
COMMIT;
SESSION_C
PID_C=$!
sleep 0.5

psql -t -A <<SESSION_D > /tmp/mk3_d.txt 2>&1 &
SELECT * FROM book_manual_slot_atomic(
  '$BIZ_ID'::uuid, '$BIZ_OWNER'::uuid, '$SVC_ID'::uuid, NULL::uuid,
  '2027-06-16'::date, '11:00', 1, 2,
  'Customer D', '+2348000000004', NULL,
  'Notes D', 5000, NULL, 0, 30
);
SESSION_D
PID_D=$!

wait $PID_C || true
wait $PID_D || true

BOOKING_COUNT2=$(psql -t -A -c "SELECT COUNT(*) FROM bookings WHERE business_id='$BIZ_ID' AND date='2027-06-16' AND time='11:00:00' AND status IN ('confirmed','pending')")
ALL_DASHBOARD=$(psql -t -A -c "SELECT COUNT(*) FROM bookings WHERE business_id='$BIZ_ID' AND date='2027-06-16' AND channel = 'dashboard'")

echo "  Final booking count: $BOOKING_COUNT2"
echo "  All have channel=dashboard: $ALL_DASHBOARD"

if [ "$BOOKING_COUNT2" -ne 2 ]; then echo "FAIL: expected 2 bookings, got $BOOKING_COUNT2"; FAILED=1; fi
if [ "$ALL_DASHBOARD" -ne 2 ]; then echo "FAIL: both should have channel=dashboard, got $ALL_DASHBOARD"; FAILED=1; fi

[ "$FAILED" -eq 0 ] && echo "  ✅ Test 2 PASSED"

# ════════════════════════════════════════
# TEST 3: Forced metadata failure => ZERO surviving bookings (rollback proof)
# ════════════════════════════════════════
echo ""
echo "--- Test 3: Forced metadata failure => atomic rollback ---"

psql -v ON_ERROR_STOP=1 -q -c "DELETE FROM bookings WHERE business_id = '$BIZ_ID';"

# Create a test-only trigger that forces the dashboard metadata UPDATE to fail
psql -v ON_ERROR_STOP=1 -q <<TRIGGER_SETUP
CREATE OR REPLACE FUNCTION _mk3_test_force_metadata_failure()
RETURNS TRIGGER AS \$t\$
BEGIN
  -- Only fire when the wrapper sets channel to dashboard
  IF NEW.channel = 'dashboard' AND OLD.channel = 'whatsapp' THEN
    RAISE EXCEPTION 'MK3_TEST: forced metadata failure for rollback proof';
  END IF;
  RETURN NEW;
END;
\$t\$ LANGUAGE plpgsql;

CREATE TRIGGER _mk3_test_metadata_fail
  BEFORE UPDATE ON bookings
  FOR EACH ROW EXECUTE FUNCTION _mk3_test_force_metadata_failure();
TRIGGER_SETUP

# Attempt a manual booking — should fail due to the trigger
RESULT=$(psql -t -A -c "SELECT * FROM book_manual_slot_atomic(
  '$BIZ_ID'::uuid, '$BIZ_OWNER'::uuid, '$SVC_ID'::uuid, NULL::uuid,
  '2027-06-17'::date, '10:00', 1, 1,
  'Rollback Customer', '+2348000000005', NULL,
  'Should not survive', 5000, NULL, 0, 30
)" 2>&1 || true)

echo "  RPC result: $(echo "$RESULT" | head -3)"

# Verify ZERO bookings survived (the INSERT from book_slot_atomic must have rolled back)
ROLLBACK_COUNT=$(psql -t -A -c "SELECT COUNT(*) FROM bookings WHERE business_id='$BIZ_ID' AND date='2027-06-17'")

echo "  Bookings after forced failure: $ROLLBACK_COUNT"

if [ "$ROLLBACK_COUNT" -ne 0 ]; then
  echo "FAIL: expected 0 bookings after metadata failure, got $ROLLBACK_COUNT"
  FAILED=1
fi

# Verify the error was the expected one
if echo "$RESULT" | grep -q "MK3_TEST: forced metadata failure"; then
  echo "  Expected error received: YES"
else
  echo "  Expected error received: NO"
  echo "FAIL: did not receive expected metadata failure error"
  FAILED=1
fi

# Cleanup: remove test trigger
psql -q -c "DROP TRIGGER IF EXISTS _mk3_test_metadata_fail ON bookings;" 2>/dev/null || true
psql -q -c "DROP FUNCTION IF EXISTS _mk3_test_force_metadata_failure();" 2>/dev/null || true

[ "$FAILED" -eq 0 ] && echo "  ✅ Test 3 PASSED"

# ════════════════════════════════════════
# FINAL RESULT
# ════════════════════════════════════════
echo ""
if [ "$FAILED" -eq 0 ]; then
  echo "✅ All MK-3 concurrency tests PASSED"
  exit 0
else
  echo "❌ Some MK-3 concurrency tests FAILED"
  exit 1
fi
