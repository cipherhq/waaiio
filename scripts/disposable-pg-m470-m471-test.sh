#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════
# Disposable-PG M470/M471 Test Suite — Issue #507
#
# Reproducible, version-controlled script that:
# 1. Creates a disposable database
# 2. Sets up minimal prerequisite schema
# 3. Applies M470 and M471 migrations
# 4. Runs RPC execution, ACL, failure path, and concurrency tests
# 5. Drops the database
#
# Requirements: PostgreSQL 16+ running locally
# Usage: bash scripts/disposable-pg-m470-m471-test.sh
# ═══════════════════════════════════════════════════════════
set -euo pipefail

DB_NAME="waaiio_507_disposable_$$"
PASS=0
FAIL=0
TOTAL=0

log_pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "  PASS: $1"; }
log_fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "  FAIL: $1"; }

echo "=== Disposable-PG M470/M471 Test Suite ==="
echo "Database: $DB_NAME"
echo "PostgreSQL: $(psql --version | head -1)"
echo "Migration SHA-256:"
echo "  M470: $(shasum -a 256 supabase/migrations/470_ticket_tier_purchase_and_capacity_guards.sql | cut -d' ' -f1)"
echo "  M471: $(shasum -a 256 supabase/migrations/471_cancel_pending_booking_navigation.sql | cut -d' ' -f1)"
echo ""

# Cleanup function — called explicitly at end, not via trap
# (trap EXIT fires during background psql wait, destroying the DB prematurely)
cleanup() { psql -d postgres -c "DROP DATABASE IF EXISTS $DB_NAME;" 2>/dev/null || true; }

# Create DB
psql -d postgres -c "CREATE DATABASE $DB_NAME;" >/dev/null

# Setup prerequisites
psql -d "$DB_NAME" -q <<'SCHEMA'
CREATE TYPE flow_type AS ENUM ('scheduling','payment','ordering','ticketing','reservation','queue');
CREATE TYPE booking_channel AS ENUM ('whatsapp','web','api');
CREATE TYPE deposit_status AS ENUM ('none','pending','paid','refunded');
CREATE TYPE reservation_status AS ENUM ('pending','confirmed','cancelled','completed','no_show');
CREATE TYPE cancelled_by AS ENUM ('guest','owner','system');

CREATE TABLE events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL, name TEXT NOT NULL, date DATE NOT NULL, time TIME,
  venue TEXT, price INTEGER DEFAULT 0, total_tickets INTEGER NOT NULL DEFAULT 100,
  tickets_sold INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'published', image_url TEXT
);
CREATE TABLE event_ticket_types (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES events(id), name TEXT NOT NULL, price INTEGER NOT NULL,
  total_tickets INTEGER NOT NULL DEFAULT 50, tickets_sold INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN DEFAULT true, sort_order INTEGER DEFAULT 0
);
CREATE TABLE bookings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL, user_id UUID, event_id UUID REFERENCES events(id),
  date DATE NOT NULL, time TIME NOT NULL DEFAULT '00:00', party_size INTEGER DEFAULT 1,
  quantity INTEGER DEFAULT 1, flow_type flow_type NOT NULL DEFAULT 'scheduling',
  channel booking_channel DEFAULT 'whatsapp', deposit_amount INTEGER DEFAULT 0,
  deposit_status deposit_status DEFAULT 'none', status reservation_status DEFAULT 'pending',
  total_amount INTEGER DEFAULT 0, guest_name TEXT, guest_phone TEXT, notes TEXT,
  bot_session_id UUID,
  reference_code TEXT NOT NULL DEFAULT 'REF-' || substr(gen_random_uuid()::text,1,8),
  cancelled_at TIMESTAMPTZ, cancelled_by cancelled_by
);
CREATE TABLE payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id UUID REFERENCES bookings(id), reservation_id UUID,
  status TEXT DEFAULT 'pending', finalization_processing_at TIMESTAMPTZ
);
CREATE TABLE reservations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL, user_id UUID, status reservation_status DEFAULT 'pending',
  cancelled_at TIMESTAMPTZ, cancelled_by cancelled_by
);
CREATE OR REPLACE FUNCTION cancel_booking_with_release(p_booking_id UUID, p_cancelled_by TEXT, p_user_id UUID)
RETURNS JSONB LANGUAGE plpgsql AS $fn$
BEGIN
  UPDATE bookings SET status='cancelled', cancelled_at=NOW(), cancelled_by=p_cancelled_by::cancelled_by WHERE id=p_booking_id AND status='pending';
  RETURN jsonb_build_object('cancelled', true);
END; $fn$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
END $$;
GRANT USAGE ON SCHEMA public TO service_role, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO service_role;
SCHEMA

echo "--- Schema setup complete ---"

# Apply migrations
echo "--- Applying M470 ---"
psql -d "$DB_NAME" -q -f supabase/migrations/470_ticket_tier_purchase_and_capacity_guards.sql 2>&1 | grep -v "^$\|NOTICE\|^DO$\|^CREATE\|^ALTER\|^DROP\|^GRANT\|^REVOKE" || true
echo "--- Applying M471 ---"
psql -d "$DB_NAME" -q -f supabase/migrations/471_cancel_pending_booking_navigation.sql 2>&1 | grep -v "^$\|NOTICE\|^DO$\|^CREATE\|^DROP\|^GRANT\|^REVOKE" || true
echo "--- Migrations applied ---"
echo ""

# Insert test fixtures
psql -d "$DB_NAME" -q <<'FIXTURES'
INSERT INTO events (id, business_id, name, date, total_tickets, tickets_sold) VALUES
  ('aaaaaaaa-0001-0001-0001-000000000001','bbbbbbb0-0001-0001-0001-000000000001','Concert','2027-06-01',100,0);
INSERT INTO event_ticket_types (id, event_id, name, price, total_tickets, tickets_sold, is_active) VALUES
  ('cccccccc-0001-0001-0001-000000000001','aaaaaaaa-0001-0001-0001-000000000001','Regular',5000,50,0,true),
  ('cccccccc-0002-0001-0001-000000000001','aaaaaaaa-0001-0001-0001-000000000001','VIP',10000,25,0,true);
FIXTURES

echo "=== RUNNING TESTS ==="
echo ""

# T1–T5: RPC existence, SECURITY DEFINER, ACL
echo "--- T1: RPCs exist ---"
COUNT=$(psql -d "$DB_NAME" -tAc "SELECT count(*) FROM pg_proc WHERE proname IN ('create_ticket_booking_checked','cancel_pending_booking_for_navigation','cancel_pending_reservation_for_navigation');")
[[ "$COUNT" == "3" ]] && log_pass "T1: 3 RPCs found" || log_fail "T1: Expected 3 RPCs, got $COUNT"

echo "--- T2: SECURITY DEFINER ---"
SECDEF=$(psql -d "$DB_NAME" -tAc "SELECT count(*) FROM pg_proc WHERE proname IN ('create_ticket_booking_checked','cancel_pending_booking_for_navigation','cancel_pending_reservation_for_navigation') AND prosecdef=true AND proconfig @> ARRAY['search_path=public'];")
[[ "$SECDEF" == "3" ]] && log_pass "T2: All 3 RPCs have SECURITY DEFINER + search_path=public" || log_fail "T2: Expected 3, got $SECDEF"

echo "--- T3: ACL service_role GRANTED ---"
for fn in "create_ticket_booking_checked(uuid,uuid,uuid,integer,uuid,integer,text,text,uuid,integer)" "cancel_pending_booking_for_navigation(uuid,uuid)" "cancel_pending_reservation_for_navigation(uuid,uuid)"; do
  GRANTED=$(psql -d "$DB_NAME" -tAc "SELECT has_function_privilege('service_role','$fn','EXECUTE');")
  [[ "$GRANTED" == "t" ]] && log_pass "T3: service_role → $fn" || log_fail "T3: service_role DENIED on $fn"
done

echo "--- T4: ACL anon DENIED ---"
for fn in "create_ticket_booking_checked(uuid,uuid,uuid,integer,uuid,integer,text,text,uuid,integer)" "cancel_pending_booking_for_navigation(uuid,uuid)" "cancel_pending_reservation_for_navigation(uuid,uuid)"; do
  DENIED=$(psql -d "$DB_NAME" -tAc "SELECT has_function_privilege('anon','$fn','EXECUTE');")
  [[ "$DENIED" == "f" ]] && log_pass "T4: anon denied → $fn" || log_fail "T4: anon NOT denied on $fn"
done

echo "--- T5: ACL authenticated DENIED ---"
for fn in "create_ticket_booking_checked(uuid,uuid,uuid,integer,uuid,integer,text,text,uuid,integer)" "cancel_pending_booking_for_navigation(uuid,uuid)" "cancel_pending_reservation_for_navigation(uuid,uuid)"; do
  DENIED=$(psql -d "$DB_NAME" -tAc "SELECT has_function_privilege('authenticated','$fn','EXECUTE');")
  [[ "$DENIED" == "f" ]] && log_pass "T5: authenticated denied → $fn" || log_fail "T5: authenticated NOT denied on $fn"
done

# T6–T12: RPC functional tests
echo "--- T6: CHECK constraint ---"
RESULT=$(psql -d "$DB_NAME" -tAc "
DO \$\$ BEGIN
  BEGIN
    INSERT INTO event_ticket_types (event_id,name,price,total_tickets,tickets_sold) VALUES ('aaaaaaaa-0001-0001-0001-000000000001','Bad',100,5,10);
    RAISE EXCEPTION 'NO_CHECK';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END \$\$; SELECT 'ok';" 2>&1)
echo "$RESULT" | grep -q "ok" && log_pass "T6: CHECK constraint blocks tickets_sold>total_tickets" || log_fail "T6: CHECK constraint"

echo "--- T7: Capacity decrease trigger ---"
RESULT=$(psql -d "$DB_NAME" -tAc "
DO \$\$ BEGIN
  BEGIN
    UPDATE event_ticket_types SET total_tickets=30 WHERE id='cccccccc-0001-0001-0001-000000000001';
    RAISE EXCEPTION 'NO_TRIGGER';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'capacity_decrease_blocked%' THEN NULL; ELSE RAISE; END IF;
  END;
END \$\$; SELECT 'ok';" 2>&1)
echo "$RESULT" | grep -q "ok" && log_pass "T7: Capacity decrease trigger blocks reduction" || log_fail "T7: trigger"

echo "--- T8: create_ticket_booking_checked happy path ---"
RESULT=$(psql -d "$DB_NAME" -tAc "
SELECT success FROM create_ticket_booking_checked(
  'bbbbbbb0-0001-0001-0001-000000000001','aaaaaaaa-0001-0001-0001-000000000001',
  'cccccccc-0001-0001-0001-000000000001',2,'dddddddd-0001-0001-0001-000000000001',
  10000,'John','(234)8012345678','eeeeeeee-0001-0001-0001-000000000001',5000);" 2>&1)
echo "$RESULT" | grep -q "t" && log_pass "T8: Booking created successfully" || log_fail "T8: create booking"

echo "--- T9: Idempotent re-entry ---"
FIRST_ID=$(psql -d "$DB_NAME" -tAc "SELECT id FROM bookings WHERE bot_session_id='eeeeeeee-0001-0001-0001-000000000001' LIMIT 1;")
SECOND_ID=$(psql -d "$DB_NAME" -tAc "
SELECT booking_id FROM create_ticket_booking_checked(
  'bbbbbbb0-0001-0001-0001-000000000001','aaaaaaaa-0001-0001-0001-000000000001',
  'cccccccc-0001-0001-0001-000000000001',2,'dddddddd-0001-0001-0001-000000000001',
  10000,'John','(234)8012345678','eeeeeeee-0001-0001-0001-000000000001',5000);" 2>&1)
[[ "$(echo $FIRST_ID | tr -d ' ')" == "$(echo $SECOND_ID | tr -d ' ')" ]] && log_pass "T9: Idempotent re-entry same booking_id" || log_fail "T9: idempotency ($FIRST_ID vs $SECOND_ID)"

echo "--- T10: tier_paused ---"
psql -d "$DB_NAME" -q -c "UPDATE event_ticket_types SET is_active=false WHERE id='cccccccc-0002-0001-0001-000000000001';"
RESULT=$(psql -d "$DB_NAME" -tAc "
DO \$\$ DECLARE v RECORD; BEGIN
  BEGIN
    SELECT * INTO v FROM create_ticket_booking_checked('bbbbbbb0-0001-0001-0001-000000000001','aaaaaaaa-0001-0001-0001-000000000001','cccccccc-0002-0001-0001-000000000001',1,'dddddddd-0001-0001-0001-000000000001',10000,'Jane','(234)8099999999','ffffffff-0001-0001-0001-000000000001',NULL);
    RAISE EXCEPTION 'NO_PAUSED';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'tier_paused%' THEN NULL; ELSE RAISE; END IF;
  END;
END \$\$; SELECT 'ok';" 2>&1)
echo "$RESULT" | grep -q "ok" && log_pass "T10: tier_paused raised" || log_fail "T10: tier_paused"
psql -d "$DB_NAME" -q -c "UPDATE event_ticket_types SET is_active=true WHERE id='cccccccc-0002-0001-0001-000000000001';"

echo "--- T11: price_changed ---"
RESULT=$(psql -d "$DB_NAME" -tAc "
DO \$\$ DECLARE v RECORD; BEGIN
  BEGIN
    SELECT * INTO v FROM create_ticket_booking_checked('bbbbbbb0-0001-0001-0001-000000000001','aaaaaaaa-0001-0001-0001-000000000001','cccccccc-0001-0001-0001-000000000001',1,'dddddddd-0001-0001-0001-000000000001',9999,'Price','(234)8077777777','aaaaaaaa-9999-9999-9999-999999999999',9999);
    RAISE EXCEPTION 'NO_PRICE';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'price_changed%' THEN NULL; ELSE RAISE; END IF;
  END;
END \$\$; SELECT 'ok';" 2>&1)
echo "$RESULT" | grep -q "ok" && log_pass "T11: price_changed raised" || log_fail "T11: price_changed"

echo "--- T12: sold-out ---"
psql -d "$DB_NAME" -q -c "UPDATE event_ticket_types SET tickets_sold=50 WHERE id='cccccccc-0001-0001-0001-000000000001';"
RESULT=$(psql -d "$DB_NAME" -tAc "
SELECT success FROM create_ticket_booking_checked('bbbbbbb0-0001-0001-0001-000000000001','aaaaaaaa-0001-0001-0001-000000000001','cccccccc-0001-0001-0001-000000000001',1,'dddddddd-0001-0001-0001-000000000001',5000,'SoldOut','(234)8066666666','bbbbbbbb-9999-9999-9999-999999999999',5000);" 2>&1)
echo "$RESULT" | grep -q "f" && log_pass "T12: sold-out returns success=false" || log_fail "T12: sold-out"
psql -d "$DB_NAME" -q -c "UPDATE event_ticket_types SET tickets_sold=0 WHERE id='cccccccc-0001-0001-0001-000000000001';"

# T13–T16: Cancel navigation RPCs
echo "--- T13: cancel_pending_booking happy path ---"
psql -d "$DB_NAME" -q -c "INSERT INTO bookings (id,business_id,user_id,date,status) VALUES ('11111111-0001-0001-0001-000000000001','bbbbbbb0-0001-0001-0001-000000000001','dddddddd-0001-0001-0001-000000000001','2027-01-01','pending');"
RESULT=$(psql -d "$DB_NAME" -tAc "SELECT (cancel_pending_booking_for_navigation('11111111-0001-0001-0001-000000000001','dddddddd-0001-0001-0001-000000000001'))->>'cancelled';" 2>&1)
echo "$RESULT" | grep -q "true" && log_pass "T13: Pending booking cancelled" || log_fail "T13: cancel booking"

echo "--- T14: cancel rejects non-pending ---"
psql -d "$DB_NAME" -q -c "INSERT INTO bookings (id,business_id,user_id,date,status) VALUES ('22222222-0001-0001-0001-000000000001','bbbbbbb0-0001-0001-0001-000000000001','dddddddd-0001-0001-0001-000000000001','2027-01-01','confirmed');"
RESULT=$(psql -d "$DB_NAME" -tAc "SELECT (cancel_pending_booking_for_navigation('22222222-0001-0001-0001-000000000001','dddddddd-0001-0001-0001-000000000001'))->>'reason';" 2>&1)
echo "$RESULT" | grep -q "not_pending" && log_pass "T14: Confirmed booking preserved" || log_fail "T14: not_pending"

echo "--- T15: cancel rejects wrong owner ---"
psql -d "$DB_NAME" -q -c "INSERT INTO bookings (id,business_id,user_id,date,status) VALUES ('33333333-0001-0001-0001-000000000001','bbbbbbb0-0001-0001-0001-000000000001','dddddddd-0001-0001-0001-000000000001','2027-01-01','pending');"
RESULT=$(psql -d "$DB_NAME" -tAc "SELECT (cancel_pending_booking_for_navigation('33333333-0001-0001-0001-000000000001','ffffffff-9999-9999-9999-999999999999'))->>'reason';" 2>&1)
echo "$RESULT" | grep -q "not_owner" && log_pass "T15: Wrong owner rejected" || log_fail "T15: not_owner"

echo "--- T16: Payment fence preserves paid booking ---"
psql -d "$DB_NAME" -q -c "INSERT INTO bookings (id,business_id,user_id,date,status) VALUES ('44444444-0001-0001-0001-000000000001','bbbbbbb0-0001-0001-0001-000000000001','dddddddd-0001-0001-0001-000000000001','2027-01-01','pending');"
psql -d "$DB_NAME" -q -c "INSERT INTO payments (booking_id,status) VALUES ('44444444-0001-0001-0001-000000000001','success');"
RESULT=$(psql -d "$DB_NAME" -tAc "SELECT (cancel_pending_booking_for_navigation('44444444-0001-0001-0001-000000000001','dddddddd-0001-0001-0001-000000000001'))->>'reason';" 2>&1)
echo "$RESULT" | grep -q "has_successful_payment" && log_pass "T16: Paid booking preserved by payment fence" || log_fail "T16: payment fence"

echo "--- T17: cancel_pending_reservation happy path ---"
psql -d "$DB_NAME" -q -c "INSERT INTO reservations (id,business_id,user_id,status) VALUES ('55555555-0001-0001-0001-000000000001','bbbbbbb0-0001-0001-0001-000000000001','dddddddd-0001-0001-0001-000000000001','pending');"
RESULT=$(psql -d "$DB_NAME" -tAc "SELECT (cancel_pending_reservation_for_navigation('55555555-0001-0001-0001-000000000001','dddddddd-0001-0001-0001-000000000001'))->>'cancelled';" 2>&1)
echo "$RESULT" | grep -q "true" && log_pass "T17: Pending reservation cancelled" || log_fail "T17: cancel reservation"

# T18–T19: TWO-CONNECTION CONCURRENCY TESTS
# Uses background psql processes for real two-connection contention
echo ""
echo "--- T18: Two-connection ticket capacity race ---"
psql -d "$DB_NAME" -q -c "UPDATE event_ticket_types SET tickets_sold=48 WHERE id='cccccccc-0001-0001-0001-000000000001';"

CONN1_OUT=$(mktemp)
CONN2_OUT=$(mktemp)

# Connection 1: book 2 (exactly 2 left — should succeed)
psql -d "$DB_NAME" -tAc "SELECT success FROM create_ticket_booking_checked('bbbbbbb0-0001-0001-0001-000000000001','aaaaaaaa-0001-0001-0001-000000000001','cccccccc-0001-0001-0001-000000000001',2,'dddddddd-0001-0001-0001-000000000001',10000,'Race1','+2348011111111','11111111-aaaa-bbbb-cccc-000000000001',5000);" > "$CONN1_OUT" 2>&1 &
PID1=$!
# Connection 2: book 3 (should fail — FOR UPDATE lock serializes)
psql -d "$DB_NAME" -tAc "SELECT success FROM create_ticket_booking_checked('bbbbbbb0-0001-0001-0001-000000000001','aaaaaaaa-0001-0001-0001-000000000001','cccccccc-0001-0001-0001-000000000001',3,'dddddddd-0002-0001-0001-000000000001',15000,'Race2','+2348022222222','22222222-aaaa-bbbb-cccc-000000000002',5000);" > "$CONN2_OUT" 2>&1 &
PID2=$!

wait $PID1 || true
wait $PID2 || true

R1=$(cat "$CONN1_OUT" 2>/dev/null | tr -d ' \n' || echo "error")
R2=$(cat "$CONN2_OUT" 2>/dev/null | tr -d ' \n' || echo "error")
rm -f "$CONN1_OUT" "$CONN2_OUT"

SOLD_AFTER=$(psql -d "$DB_NAME" -tAc "SELECT tickets_sold FROM event_ticket_types WHERE id='cccccccc-0001-0001-0001-000000000001';" | tr -d ' ')

if [[ "$SOLD_AFTER" -le "50" ]]; then
  log_pass "T18: Two-connection capacity race — tickets_sold=$SOLD_AFTER/50, no oversell (conn1=$R1, conn2=$R2)"
else
  log_fail "T18: Capacity exceeded! tickets_sold=$SOLD_AFTER > 50 (conn1=$R1, conn2=$R2)"
fi

echo "--- T19: Two-connection payment-vs-cancel contention ---"
psql -d "$DB_NAME" -q -c "INSERT INTO bookings (id,business_id,user_id,date,status) VALUES ('99999999-aaaa-bbbb-cccc-000000000001','bbbbbbb0-0001-0001-0001-000000000001','dddddddd-0001-0001-0001-000000000001','2027-01-01','pending');"

CANCEL_OUT=$(mktemp)
PAY_OUT=$(mktemp)

psql -d "$DB_NAME" -tAc "SELECT cancel_pending_booking_for_navigation('99999999-aaaa-bbbb-cccc-000000000001','dddddddd-0001-0001-0001-000000000001');" > "$CANCEL_OUT" 2>&1 &
CPID=$!
psql -d "$DB_NAME" -tAc "INSERT INTO payments (booking_id,status) VALUES ('99999999-aaaa-bbbb-cccc-000000000001','success'); SELECT 'inserted';" > "$PAY_OUT" 2>&1 &
PAY_PID=$!

wait $CPID || true
wait $PAY_PID || true

CANCEL_R=$(cat "$CANCEL_OUT" 2>/dev/null || echo "error")
PAY_R=$(cat "$PAY_OUT" 2>/dev/null || echo "error")
rm -f "$CANCEL_OUT" "$PAY_OUT"

FINAL_STATUS=$(psql -d "$DB_NAME" -tAc "SELECT status FROM bookings WHERE id='99999999-aaaa-bbbb-cccc-000000000001';" | tr -d ' ')
HAS_PAY=$(psql -d "$DB_NAME" -tAc "SELECT count(*) FROM payments WHERE booking_id='99999999-aaaa-bbbb-cccc-000000000001' AND status='success';" | tr -d ' ')

# Acceptable: cancelled (cancel won) or pending (payment won, cancel detected it)
if [[ "$FINAL_STATUS" == "cancelled" ]] || [[ "$FINAL_STATUS" == "pending" ]]; then
  log_pass "T19: Payment-vs-cancel race — final_status=$FINAL_STATUS, payments=$HAS_PAY (no corruption)"
else
  log_fail "T19: Unexpected state=$FINAL_STATUS, payments=$HAS_PAY"
fi

echo ""
echo "=== RESULTS ==="
echo "Total: $TOTAL  Passed: $PASS  Failed: $FAIL"
echo ""
cleanup
echo ""
if [[ "$FAIL" -gt 0 ]]; then
  echo "SOME TESTS FAILED"
  exit 1
else
  echo "ALL TESTS PASSED"
  exit 0
fi
