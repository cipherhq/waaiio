#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════
# MK-3: Manual Booking Atomicity — Real PostgreSQL Concurrency Test
# Proves book_slot_atomic prevents double-booking when two concurrent
# dashboard requests target the last available capacity.
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
echo "--- Test 1: Two concurrent bookings, capacity=1 ---"

psql -v ON_ERROR_STOP=1 -q -c "DELETE FROM bookings WHERE business_id = '$BIZ_ID';"

# Session A: book_slot_atomic with pg_sleep to hold advisory lock
psql -t -A <<SESSION_A > /tmp/mk3_a.txt 2>&1 &
BEGIN;
SELECT * FROM book_slot_atomic(
  '$BIZ_ID'::uuid, '$BIZ_OWNER'::uuid, '$SVC_ID'::uuid, NULL::uuid,
  '2027-06-15'::date, '10:00', 1, 1,
  'scheduling', 0, 'none', 'confirmed',
  'Customer A', '+2348000000001', NULL,
  NULL, NULL, NULL,
  NULL, NULL, 5000, NULL,
  NULL, NULL, 0, 30, NULL
);
SELECT pg_sleep(2);
COMMIT;
SESSION_A
PID_A=$!

sleep 0.5

# Session B: concurrent booking attempt
psql -t -A <<SESSION_B > /tmp/mk3_b.txt 2>&1 &
SELECT * FROM book_slot_atomic(
  '$BIZ_ID'::uuid, '$BIZ_OWNER'::uuid, '$SVC_ID'::uuid, NULL::uuid,
  '2027-06-15'::date, '10:00', 1, 1,
  'scheduling', 0, 'none', 'confirmed',
  'Customer B', '+2348000000002', NULL,
  NULL, NULL, NULL,
  NULL, NULL, 5000, NULL,
  NULL, NULL, 0, 30, NULL
);
SESSION_B
PID_B=$!

wait $PID_A || true
wait $PID_B || true

echo "  Session A output: $(cat /tmp/mk3_a.txt | tr '\n' ' ')"
echo "  Session B output: $(cat /tmp/mk3_b.txt | tr '\n' ' ')"

# Count bookings — must be exactly 1
BOOKING_COUNT=$(psql -t -A -c "SELECT COUNT(*) FROM bookings WHERE business_id='$BIZ_ID' AND date='2027-06-15' AND time='10:00:00' AND status IN ('confirmed','pending')")

echo "  Final booking count: $BOOKING_COUNT"

# One should have slot_available=t, other slot_available=f
A_AVAIL=$(grep -o 't$\|f$' /tmp/mk3_a.txt | tail -1 || echo "?")
B_AVAIL=$(grep -o 't$\|f$' /tmp/mk3_b.txt | tail -1 || echo "?")

echo "  Session A slot_available: $A_AVAIL"
echo "  Session B slot_available: $B_AVAIL"

if [ "$BOOKING_COUNT" -ne 1 ]; then
  echo "FAIL: exactly 1 booking expected, got $BOOKING_COUNT"
  FAILED=1
fi

# Exactly one true, one false
AVAIL_COUNT=0
[ "$A_AVAIL" = "t" ] && AVAIL_COUNT=$((AVAIL_COUNT+1))
[ "$B_AVAIL" = "t" ] && AVAIL_COUNT=$((AVAIL_COUNT+1))

if [ "$AVAIL_COUNT" -ne 1 ]; then
  echo "FAIL: exactly one slot_available=true expected, got $AVAIL_COUNT"
  FAILED=1
fi

[ "$FAILED" -eq 0 ] && echo "  ✅ Test 1 PASSED"

# ════════════════════════════════════════
# TEST 2: Two concurrent bookings for capacity=2 (both succeed)
# ════════════════════════════════════════
echo ""
echo "--- Test 2: Two concurrent bookings, capacity=2 ---"

psql -v ON_ERROR_STOP=1 -q -c "DELETE FROM bookings WHERE business_id = '$BIZ_ID';"

psql -t -A <<SESSION_C > /tmp/mk3_c.txt 2>&1 &
BEGIN;
SELECT * FROM book_slot_atomic(
  '$BIZ_ID'::uuid, '$BIZ_OWNER'::uuid, '$SVC_ID'::uuid, NULL::uuid,
  '2027-06-16'::date, '11:00', 1, 2,
  'scheduling', 0, 'none', 'confirmed',
  'Customer C', '+2348000000003', NULL,
  NULL, NULL, NULL,
  NULL, NULL, 5000, NULL,
  NULL, NULL, 0, 30, NULL
);
SELECT pg_sleep(2);
COMMIT;
SESSION_C
PID_C=$!
sleep 0.5

psql -t -A <<SESSION_D > /tmp/mk3_d.txt 2>&1 &
SELECT * FROM book_slot_atomic(
  '$BIZ_ID'::uuid, '$BIZ_OWNER'::uuid, '$SVC_ID'::uuid, NULL::uuid,
  '2027-06-16'::date, '11:00', 1, 2,
  'scheduling', 0, 'none', 'confirmed',
  'Customer D', '+2348000000004', NULL,
  NULL, NULL, NULL,
  NULL, NULL, 5000, NULL,
  NULL, NULL, 0, 30, NULL
);
SESSION_D
PID_D=$!

wait $PID_C || true
wait $PID_D || true

BOOKING_COUNT2=$(psql -t -A -c "SELECT COUNT(*) FROM bookings WHERE business_id='$BIZ_ID' AND date='2027-06-16' AND time='11:00:00' AND status IN ('confirmed','pending')")

echo "  Final booking count: $BOOKING_COUNT2"

if [ "$BOOKING_COUNT2" -ne 2 ]; then
  echo "FAIL: expected 2 bookings, got $BOOKING_COUNT2"
  FAILED=1
fi

[ "$FAILED" -eq 0 ] && echo "  ✅ Test 2 PASSED"

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
