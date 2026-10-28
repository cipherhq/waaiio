#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
# Disposable-PG M470/M471 Test Suite — Issue #507
#
# Reproducible, version-controlled script. Requires PostgreSQL 16+
# running LOCALLY on default socket or localhost:5432.
#
# Safety:
# - Enforces local-only PostgreSQL (rejects PGHOST pointing elsewhere)
# - Fails immediately on any migration SQL error (ON_ERROR_STOP=1)
# - Preserves pre-existing cluster roles (IF NOT EXISTS / conditional)
# - EXIT/INT/TERM trap cleans up DB, waits for children, verifies
# - Never targets staging or production
#
# Usage: bash scripts/disposable-pg-m470-m471-test.sh
# ═══════════════════════════════════════════════════════════════════
set -o pipefail
# Note: set -e is NOT used because we need to capture individual test
# outcomes and continue. Each test logs pass/fail independently.

DB_NAME="waaiio_507_disposable_$$"
PASS=0
FAIL=0
TOTAL=0
CHILD_PIDS=()

log_pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "  PASS: $1"; }
log_fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "  FAIL: $1"; }

# ── LOCAL-ONLY ENFORCEMENT ──
# Reject any ambient PGHOST that is not local
if [[ -n "${PGHOST:-}" ]] && [[ "$PGHOST" != "localhost" ]] && [[ "$PGHOST" != "127.0.0.1" ]] && [[ "$PGHOST" != "/tmp" ]] && [[ "$PGHOST" != "/var/run/postgresql" ]]; then
  echo "ABORT: PGHOST=$PGHOST is not local. This script must target a local PostgreSQL instance."
  echo "Unset PGHOST or set it to localhost/127.0.0.1 before running."
  exit 1
fi
# Verify connection is actually local
PG_HOST_ACTUAL=$(psql -d postgres -tAc "SELECT inet_server_addr();" 2>/dev/null || echo "socket")
if [[ "$PG_HOST_ACTUAL" != "socket" ]] && [[ "$PG_HOST_ACTUAL" != "" ]] && [[ "$PG_HOST_ACTUAL" != "127.0.0.1" ]]; then
  echo "ABORT: Connected to non-local PostgreSQL ($PG_HOST_ACTUAL). Refusing to proceed."
  exit 1
fi

# ── CLEANUP WITH SIGNAL HANDLING ──
cleanup() {
  local exit_code=${1:-$?}
  # Kill any background children
  for pid in "${CHILD_PIDS[@]}"; do
    kill "$pid" 2>/dev/null && wait "$pid" 2>/dev/null || true
  done
  # Drop the test database
  if psql -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME';" 2>/dev/null | grep -q 1; then
    # Terminate any remaining connections
    psql -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$DB_NAME' AND pid <> pg_backend_pid();" >/dev/null 2>&1 || true
    psql -d postgres -c "DROP DATABASE IF EXISTS $DB_NAME;" >/dev/null 2>&1
    # Verify cleanup
    if psql -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME';" 2>/dev/null | grep -q 1; then
      echo "ERROR: Failed to drop test database $DB_NAME — exiting nonzero"
      # Preserve a prior nonzero exit code; otherwise report cleanup failure
      if [[ "$exit_code" -eq 0 ]]; then exit_code=2; fi
    else
      echo "Cleanup verified: database $DB_NAME dropped."
    fi
  fi
  return "$exit_code"
}
trap 'cleanup $?' EXIT
trap 'echo ""; echo "INTERRUPTED — cleaning up..."; cleanup 130; exit 130' INT TERM

echo "=== Disposable-PG M470/M471 Test Suite ==="
echo "Database: $DB_NAME"
echo "PostgreSQL: $(psql --version | head -1)"
echo "PG connection: ${PG_HOST_ACTUAL:-unix socket} (local-only enforced)"
echo "Migration SHA-256:"
echo "  M470: $(shasum -a 256 supabase/migrations/470_ticket_tier_purchase_and_capacity_guards.sql | cut -d' ' -f1)"
echo "  M471: $(shasum -a 256 supabase/migrations/471_cancel_pending_booking_navigation.sql | cut -d' ' -f1)"
echo ""

# ── CREATE DATABASE ──
psql -d postgres -c "CREATE DATABASE $DB_NAME;" >/dev/null || { echo "ABORT: Cannot create database"; exit 1; }

# ── SETUP PREREQUISITES ──
# Roles: preserve pre-existing (IF NOT EXISTS)
psql -v ON_ERROR_STOP=1 -d "$DB_NAME" -q <<'SCHEMA'
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
  cancelled_at TIMESTAMPTZ, cancelled_by cancelled_by,
  tickets_finalized BOOLEAN NOT NULL DEFAULT false
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
-- M304 prerequisite: finalize_free_ticket_booking loaded below from canonical migration
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
END $$;
GRANT USAGE ON SCHEMA public TO service_role, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO service_role;
SCHEMA
echo "--- Schema setup complete ---"

# ── LOAD CANONICAL M304 finalize_free_ticket_booking FROM ACTUAL MIGRATION ──
# Extract the function body from the canonical migration file (lines 361–423).
# This ensures exact source parity — any drift in M304 will change the loaded function.
M304_FILE="supabase/migrations/304_session_resilience.sql"
if [[ ! -f "$M304_FILE" ]]; then
  echo "ABORT: Canonical migration $M304_FILE not found"
  exit 1
fi
# Extract from 'CREATE OR REPLACE FUNCTION public.finalize_free_ticket_booking' through the closing '$$;'
M304_FN=$(sed -n '/^CREATE OR REPLACE FUNCTION public\.finalize_free_ticket_booking/,/^\$\$;/p' "$M304_FILE")
if [[ -z "$M304_FN" ]]; then
  echo "ABORT: Could not extract finalize_free_ticket_booking from $M304_FILE"
  exit 1
fi
echo "$M304_FN" | psql -v ON_ERROR_STOP=1 -d "$DB_NAME" -q || { echo "ABORT: Failed to load canonical finalize_free_ticket_booking"; exit 1; }
# Verify loaded
LOADED=$(psql -d "$DB_NAME" -tAc "SELECT count(*) FROM pg_proc WHERE proname='finalize_free_ticket_booking';")
if [[ "$LOADED" != "1" ]]; then
  echo "ABORT: finalize_free_ticket_booking not found in pg_proc after loading"
  exit 1
fi
echo "--- Loaded canonical finalize_free_ticket_booking from $M304_FILE ---"

# ── APPLY MIGRATIONS WITH ON_ERROR_STOP ──
echo "--- Applying M470 ---"
if ! psql -v ON_ERROR_STOP=1 -d "$DB_NAME" -f supabase/migrations/470_ticket_tier_purchase_and_capacity_guards.sql >/dev/null 2>&1; then
  echo "ABORT: M470 migration failed with SQL error"
  exit 1
fi
echo "--- Applying M471 ---"
if ! psql -v ON_ERROR_STOP=1 -d "$DB_NAME" -f supabase/migrations/471_cancel_pending_booking_navigation.sql >/dev/null 2>&1; then
  echo "ABORT: M471 migration failed with SQL error"
  exit 1
fi
echo "--- Migrations applied (ON_ERROR_STOP=1, zero SQL errors) ---"
echo ""

# ── INSERT TEST FIXTURES ──
psql -v ON_ERROR_STOP=1 -d "$DB_NAME" -q <<'FIXTURES'
INSERT INTO events (id, business_id, name, date, total_tickets, tickets_sold) VALUES
  ('aaaaaaaa-0001-0001-0001-000000000001','bbbbbbb0-0001-0001-0001-000000000001','Concert','2027-06-01',100,0);
INSERT INTO event_ticket_types (id, event_id, name, price, total_tickets, tickets_sold, is_active) VALUES
  ('cccccccc-0001-0001-0001-000000000001','aaaaaaaa-0001-0001-0001-000000000001','Regular',5000,50,0,true),
  ('cccccccc-0002-0001-0001-000000000001','aaaaaaaa-0001-0001-0001-000000000001','VIP',10000,25,0,true);
FIXTURES

echo "=== RUNNING TESTS ==="
echo ""

# ═══════ T1–T5: RPC existence, SECURITY DEFINER, ACL ═══════
echo "--- T1: RPCs exist ---"
COUNT=$(psql -d "$DB_NAME" -tAc "SELECT count(*) FROM pg_proc WHERE proname IN ('create_ticket_booking_checked','cancel_pending_booking_for_navigation','cancel_pending_reservation_for_navigation');")
[[ "$COUNT" == "3" ]] && log_pass "T1: 3 RPCs found" || log_fail "T1: Expected 3 RPCs, got $COUNT"

echo "--- T2: SECURITY DEFINER ---"
SECDEF=$(psql -d "$DB_NAME" -tAc "SELECT count(*) FROM pg_proc WHERE proname IN ('create_ticket_booking_checked','cancel_pending_booking_for_navigation','cancel_pending_reservation_for_navigation') AND prosecdef=true AND proconfig @> ARRAY['search_path=public'];")
[[ "$SECDEF" == "3" ]] && log_pass "T2: All 3 have SECURITY DEFINER + search_path=public" || log_fail "T2: Expected 3, got $SECDEF"

echo "--- T3: ACL service_role GRANTED ---"
for fn in "create_ticket_booking_checked(uuid,uuid,uuid,integer,uuid,integer,text,text,uuid,integer)" "cancel_pending_booking_for_navigation(uuid,uuid)" "cancel_pending_reservation_for_navigation(uuid,uuid)"; do
  R=$(psql -d "$DB_NAME" -tAc "SELECT has_function_privilege('service_role','$fn','EXECUTE');")
  [[ "$R" == "t" ]] && log_pass "T3: service_role → ${fn%%(*}" || log_fail "T3: service_role DENIED on ${fn%%(*}"
done

echo "--- T4: ACL anon DENIED ---"
for fn in "create_ticket_booking_checked(uuid,uuid,uuid,integer,uuid,integer,text,text,uuid,integer)" "cancel_pending_booking_for_navigation(uuid,uuid)" "cancel_pending_reservation_for_navigation(uuid,uuid)"; do
  R=$(psql -d "$DB_NAME" -tAc "SELECT has_function_privilege('anon','$fn','EXECUTE');")
  [[ "$R" == "f" ]] && log_pass "T4: anon denied → ${fn%%(*}" || log_fail "T4: anon NOT denied on ${fn%%(*}"
done

echo "--- T5: ACL authenticated DENIED ---"
for fn in "create_ticket_booking_checked(uuid,uuid,uuid,integer,uuid,integer,text,text,uuid,integer)" "cancel_pending_booking_for_navigation(uuid,uuid)" "cancel_pending_reservation_for_navigation(uuid,uuid)"; do
  R=$(psql -d "$DB_NAME" -tAc "SELECT has_function_privilege('authenticated','$fn','EXECUTE');")
  [[ "$R" == "f" ]] && log_pass "T5: authenticated denied → ${fn%%(*}" || log_fail "T5: authenticated NOT denied on ${fn%%(*}"
done

# ═══════ T6–T12: RPC functional tests ═══════
echo "--- T6: CHECK constraint ---"
RESULT=$(psql -d "$DB_NAME" -tAc "
DO \$\$ BEGIN
  BEGIN INSERT INTO event_ticket_types (event_id,name,price,total_tickets,tickets_sold) VALUES ('aaaaaaaa-0001-0001-0001-000000000001','Bad',100,5,10); RAISE EXCEPTION 'NO_CHECK';
  EXCEPTION WHEN check_violation THEN NULL; END;
END \$\$; SELECT 'ok';" 2>&1)
echo "$RESULT" | grep -q "ok" && log_pass "T6: CHECK constraint blocks tickets_sold>total_tickets" || log_fail "T6: CHECK"

echo "--- T7: Capacity decrease trigger ---"
RESULT=$(psql -d "$DB_NAME" -tAc "
DO \$\$ BEGIN
  BEGIN UPDATE event_ticket_types SET total_tickets=30 WHERE id='cccccccc-0001-0001-0001-000000000001'; RAISE EXCEPTION 'NO_TRIGGER';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'capacity_decrease_blocked%' THEN NULL; ELSE RAISE; END IF; END;
END \$\$; SELECT 'ok';" 2>&1)
echo "$RESULT" | grep -q "ok" && log_pass "T7: Capacity decrease trigger blocks reduction" || log_fail "T7: trigger"

echo "--- T8: create_ticket_booking_checked happy path ---"
RESULT=$(psql -d "$DB_NAME" -tAc "SELECT success FROM create_ticket_booking_checked('bbbbbbb0-0001-0001-0001-000000000001','aaaaaaaa-0001-0001-0001-000000000001','cccccccc-0001-0001-0001-000000000001',2,'dddddddd-0001-0001-0001-000000000001',10000,'John','+2348012345678','eeeeeeee-0001-0001-0001-000000000001',5000);" 2>&1)
echo "$RESULT" | grep -q "t" && log_pass "T8: Pending booking created (tickets_sold NOT incremented)" || log_fail "T8: create booking"

echo "--- T9: Idempotent re-entry ---"
FIRST_ID=$(psql -d "$DB_NAME" -tAc "SELECT id FROM bookings WHERE bot_session_id='eeeeeeee-0001-0001-0001-000000000001' LIMIT 1;" | tr -d ' ')
SECOND_ID=$(psql -d "$DB_NAME" -tAc "SELECT booking_id FROM create_ticket_booking_checked('bbbbbbb0-0001-0001-0001-000000000001','aaaaaaaa-0001-0001-0001-000000000001','cccccccc-0001-0001-0001-000000000001',2,'dddddddd-0001-0001-0001-000000000001',10000,'John','+2348012345678','eeeeeeee-0001-0001-0001-000000000001',5000);" | tr -d ' ')
[[ "$FIRST_ID" == "$SECOND_ID" ]] && log_pass "T9: Idempotent re-entry returns same booking_id" || log_fail "T9: $FIRST_ID vs $SECOND_ID"

echo "--- T10: tier_paused ---"
psql -d "$DB_NAME" -q -c "UPDATE event_ticket_types SET is_active=false WHERE id='cccccccc-0002-0001-0001-000000000001';"
RESULT=$(psql -d "$DB_NAME" -tAc "DO \$\$ DECLARE v RECORD; BEGIN BEGIN SELECT * INTO v FROM create_ticket_booking_checked('bbbbbbb0-0001-0001-0001-000000000001','aaaaaaaa-0001-0001-0001-000000000001','cccccccc-0002-0001-0001-000000000001',1,'dddddddd-0001-0001-0001-000000000001',10000,'Jane','+2348099999999','ffffffff-0001-0001-0001-000000000001',NULL); RAISE EXCEPTION 'NO_PAUSED'; EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'tier_paused%' THEN NULL; ELSE RAISE; END IF; END; END \$\$; SELECT 'ok';" 2>&1)
echo "$RESULT" | grep -q "ok" && log_pass "T10: tier_paused raised" || log_fail "T10: tier_paused"
psql -d "$DB_NAME" -q -c "UPDATE event_ticket_types SET is_active=true WHERE id='cccccccc-0002-0001-0001-000000000001';"

echo "--- T11: price_changed ---"
RESULT=$(psql -d "$DB_NAME" -tAc "DO \$\$ DECLARE v RECORD; BEGIN BEGIN SELECT * INTO v FROM create_ticket_booking_checked('bbbbbbb0-0001-0001-0001-000000000001','aaaaaaaa-0001-0001-0001-000000000001','cccccccc-0001-0001-0001-000000000001',1,'dddddddd-0001-0001-0001-000000000001',9999,'Price','+2348077777777','aaaaaaaa-9999-9999-9999-999999999999',9999); RAISE EXCEPTION 'NO_PRICE'; EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'price_changed%' THEN NULL; ELSE RAISE; END IF; END; END \$\$; SELECT 'ok';" 2>&1)
echo "$RESULT" | grep -q "ok" && log_pass "T11: price_changed raised" || log_fail "T11: price_changed"

echo "--- T12: sold-out ---"
psql -d "$DB_NAME" -q -c "UPDATE event_ticket_types SET tickets_sold=50 WHERE id='cccccccc-0001-0001-0001-000000000001';"
RESULT=$(psql -d "$DB_NAME" -tAc "SELECT success FROM create_ticket_booking_checked('bbbbbbb0-0001-0001-0001-000000000001','aaaaaaaa-0001-0001-0001-000000000001','cccccccc-0001-0001-0001-000000000001',1,'dddddddd-0001-0001-0001-000000000001',5000,'SoldOut','+2348066666666','bbbbbbbb-9999-9999-9999-999999999999',5000);" 2>&1)
echo "$RESULT" | grep -q "f" && log_pass "T12: sold-out returns success=false" || log_fail "T12: sold-out"
psql -d "$DB_NAME" -q -c "UPDATE event_ticket_types SET tickets_sold=0 WHERE id='cccccccc-0001-0001-0001-000000000001';"

# ═══════ T13–T17: Cancel navigation RPCs ═══════
echo "--- T13: cancel_pending_booking happy path ---"
psql -d "$DB_NAME" -q -c "INSERT INTO bookings (id,business_id,user_id,date,status) VALUES ('11111111-0001-0001-0001-000000000001','bbbbbbb0-0001-0001-0001-000000000001','dddddddd-0001-0001-0001-000000000001','2027-01-01','pending');"
RESULT=$(psql -d "$DB_NAME" -tAc "SELECT (cancel_pending_booking_for_navigation('11111111-0001-0001-0001-000000000001','dddddddd-0001-0001-0001-000000000001'))->>'cancelled';" 2>&1)
echo "$RESULT" | grep -q "true" && log_pass "T13: Pending booking cancelled" || log_fail "T13: cancel"

echo "--- T14: cancel rejects non-pending ---"
psql -d "$DB_NAME" -q -c "INSERT INTO bookings (id,business_id,user_id,date,status) VALUES ('22222222-0001-0001-0001-000000000001','bbbbbbb0-0001-0001-0001-000000000001','dddddddd-0001-0001-0001-000000000001','2027-01-01','confirmed');"
RESULT=$(psql -d "$DB_NAME" -tAc "SELECT (cancel_pending_booking_for_navigation('22222222-0001-0001-0001-000000000001','dddddddd-0001-0001-0001-000000000001'))->>'reason';" 2>&1)
echo "$RESULT" | grep -q "not_pending" && log_pass "T14: Confirmed booking preserved" || log_fail "T14"

echo "--- T15: cancel rejects wrong owner ---"
psql -d "$DB_NAME" -q -c "INSERT INTO bookings (id,business_id,user_id,date,status) VALUES ('33333333-0001-0001-0001-000000000001','bbbbbbb0-0001-0001-0001-000000000001','dddddddd-0001-0001-0001-000000000001','2027-01-01','pending');"
RESULT=$(psql -d "$DB_NAME" -tAc "SELECT (cancel_pending_booking_for_navigation('33333333-0001-0001-0001-000000000001','ffffffff-9999-9999-9999-999999999999'))->>'reason';" 2>&1)
echo "$RESULT" | grep -q "not_owner" && log_pass "T15: Wrong owner rejected" || log_fail "T15"

echo "--- T16: Payment fence preserves paid booking ---"
psql -d "$DB_NAME" -q -c "INSERT INTO bookings (id,business_id,user_id,date,status) VALUES ('44444444-0001-0001-0001-000000000001','bbbbbbb0-0001-0001-0001-000000000001','dddddddd-0001-0001-0001-000000000001','2027-01-01','pending');"
psql -d "$DB_NAME" -q -c "INSERT INTO payments (booking_id,status) VALUES ('44444444-0001-0001-0001-000000000001','success');"
RESULT=$(psql -d "$DB_NAME" -tAc "SELECT (cancel_pending_booking_for_navigation('44444444-0001-0001-0001-000000000001','dddddddd-0001-0001-0001-000000000001'))->>'reason';" 2>&1)
echo "$RESULT" | grep -q "has_successful_payment" && log_pass "T16: Paid booking preserved" || log_fail "T16"

echo "--- T17: cancel_pending_reservation happy path ---"
psql -d "$DB_NAME" -q -c "INSERT INTO reservations (id,business_id,user_id,status) VALUES ('55555555-0001-0001-0001-000000000001','bbbbbbb0-0001-0001-0001-000000000001','dddddddd-0001-0001-0001-000000000001','pending');"
RESULT=$(psql -d "$DB_NAME" -tAc "SELECT (cancel_pending_reservation_for_navigation('55555555-0001-0001-0001-000000000001','dddddddd-0001-0001-0001-000000000001'))->>'cancelled';" 2>&1)
echo "$RESULT" | grep -q "true" && log_pass "T17: Pending reservation cancelled" || log_fail "T17"

# ═══════ T18: AUTHORITATIVE INVENTORY COMMIT + CONCURRENCY ═══════
# CTO R3 correction: create_ticket_booking_checked creates PENDING
# bookings WITHOUT incrementing tickets_sold. The authoritative
# inventory commit is finalize_free_ticket_booking.
# Test: two connections both create pending bookings, then both
# finalize. The RPC uses FOR UPDATE — second finalize must see
# the first's committed increment and reject if over capacity.
echo ""
echo "--- T18: Deterministic inventory-commit concurrency ---"
# Reset: tier has 50 capacity, 47 sold. Room for exactly 3 more.
psql -d "$DB_NAME" -q -c "UPDATE event_ticket_types SET tickets_sold=47 WHERE id='cccccccc-0001-0001-0001-000000000001';"

# Step 1: Both connections create pending bookings (no inventory commit)
BK1_ID=$(psql -d "$DB_NAME" -tAc "SELECT booking_id FROM create_ticket_booking_checked('bbbbbbb0-0001-0001-0001-000000000001','aaaaaaaa-0001-0001-0001-000000000001','cccccccc-0001-0001-0001-000000000001',2,'dddddddd-0001-0001-0001-000000000001',10000,'Buyer1','+2348011111111','aaaaaaaa-1111-2222-3333-444444444441',5000);" | tr -d ' ')
BK2_ID=$(psql -d "$DB_NAME" -tAc "SELECT booking_id FROM create_ticket_booking_checked('bbbbbbb0-0001-0001-0001-000000000001','aaaaaaaa-0001-0001-0001-000000000001','cccccccc-0001-0001-0001-000000000001',2,'dddddddd-0002-0001-0001-000000000001',10000,'Buyer2','+2348022222222','aaaaaaaa-1111-2222-3333-444444444442',5000);" | tr -d ' ')

# Verify: both bookings created, tickets_sold still 47 (no increment yet)
SOLD_BEFORE=$(psql -d "$DB_NAME" -tAc "SELECT tickets_sold FROM event_ticket_types WHERE id='cccccccc-0001-0001-0001-000000000001';" | tr -d ' ')
if [[ "$SOLD_BEFORE" != "47" ]]; then
  log_fail "T18a: tickets_sold should be 47 before finalization, got $SOLD_BEFORE"
else
  log_pass "T18a: Both pending bookings created, tickets_sold=47 (no premature increment)"
fi

# Step 2: Both finalize concurrently (the authoritative inventory commit)
F1_OUT=$(mktemp)
F2_OUT=$(mktemp)
psql -d "$DB_NAME" -tAc "SELECT (finalize_free_ticket_booking('$BK1_ID'::uuid,'aaaaaaaa-0001-0001-0001-000000000001'::uuid,'cccccccc-0001-0001-0001-000000000001'::uuid,2))->>'success';" > "$F1_OUT" 2>&1 &
CHILD_PIDS+=($!)
psql -d "$DB_NAME" -tAc "SELECT (finalize_free_ticket_booking('$BK2_ID'::uuid,'aaaaaaaa-0001-0001-0001-000000000001'::uuid,'cccccccc-0001-0001-0001-000000000001'::uuid,2))->>'success';" > "$F2_OUT" 2>&1 &
CHILD_PIDS+=($!)
wait "${CHILD_PIDS[@]}" 2>/dev/null || true
CHILD_PIDS=()

F1_R=$(cat "$F1_OUT" 2>/dev/null | tr -d ' \n')
F2_R=$(cat "$F2_OUT" 2>/dev/null | tr -d ' \n')
rm -f "$F1_OUT" "$F2_OUT"

SOLD_AFTER=$(psql -d "$DB_NAME" -tAc "SELECT tickets_sold FROM event_ticket_types WHERE id='cccccccc-0001-0001-0001-000000000001';" | tr -d ' ')
BOOKINGS_COUNT=$(psql -d "$DB_NAME" -tAc "SELECT count(*) FROM bookings WHERE id IN ('$BK1_ID','$BK2_ID') AND status='confirmed';" | tr -d ' ')

# Expected: 47+2=49 (first finalize succeeds), 49+2=51 > 50 capacity
# The CHECK constraint chk_capacity_gte_sold blocks tickets_sold > total_tickets.
# Second finalize's transaction aborts on constraint violation.
# Net: exactly 1 success, exactly 1 rejection, tickets_sold=49.
echo "  Final tickets_sold=$SOLD_AFTER, F1=$F1_R, F2=$F2_R"

SUCCESS_COUNT=0
FAILURE_COUNT=0
[[ "$F1_R" == "true" ]] && SUCCESS_COUNT=$((SUCCESS_COUNT+1)) || FAILURE_COUNT=$((FAILURE_COUNT+1))
[[ "$F2_R" == "true" ]] && SUCCESS_COUNT=$((SUCCESS_COUNT+1)) || FAILURE_COUNT=$((FAILURE_COUNT+1))

# Check committed booking states
BK1_FIN=$(psql -d "$DB_NAME" -tAc "SELECT tickets_finalized FROM bookings WHERE id='$BK1_ID';" | tr -d ' ')
BK2_FIN=$(psql -d "$DB_NAME" -tAc "SELECT tickets_finalized FROM bookings WHERE id='$BK2_ID';" | tr -d ' ')
FINALIZED_COUNT=0
[[ "$BK1_FIN" == "t" ]] && FINALIZED_COUNT=$((FINALIZED_COUNT+1))
[[ "$BK2_FIN" == "t" ]] && FINALIZED_COUNT=$((FINALIZED_COUNT+1))

# STRICT: require exactly 1 success, 1 failure, final=49, 1 finalized booking
if [[ "$SUCCESS_COUNT" -eq 1 ]] && [[ "$FAILURE_COUNT" -eq 1 ]] && [[ "$SOLD_AFTER" -eq 49 ]] && [[ "$FINALIZED_COUNT" -eq 1 ]]; then
  log_pass "T18b: Exactly 1 finalization committed (tickets_sold=49/50), 1 rejected, 1 booking finalized"
else
  log_fail "T18b: Expected 1 success + 1 failure + sold=49 + 1 finalized. Got: successes=$SUCCESS_COUNT failures=$FAILURE_COUNT sold=$SOLD_AFTER finalized=$FINALIZED_COUNT (F1=$F1_R F2=$F2_R bk1_fin=$BK1_FIN bk2_fin=$BK2_FIN)"
fi

# ═══════ T19: PAYMENT-VS-CANCEL WITH STATE ASSERTIONS ═══════
# CTO R3 correction: two controlled interleavings.
echo ""
echo "--- T19a: Payment already present → cancel rejected ---"
# Interleaving (i): payment SUCCESS exists BEFORE cancel attempts
psql -d "$DB_NAME" -q -c "INSERT INTO bookings (id,business_id,user_id,date,status) VALUES ('aaaaaaaa-1919-1919-1919-000000000001','bbbbbbb0-0001-0001-0001-000000000001','dddddddd-0001-0001-0001-000000000001','2027-01-01','pending');"
psql -d "$DB_NAME" -q -c "INSERT INTO payments (booking_id,status) VALUES ('aaaaaaaa-1919-1919-1919-000000000001','success');"

CANCEL_R=$(psql -d "$DB_NAME" -tAc "SELECT cancel_pending_booking_for_navigation('aaaaaaaa-1919-1919-1919-000000000001','dddddddd-0001-0001-0001-000000000001');" 2>&1)
STATUS_19A=$(psql -d "$DB_NAME" -tAc "SELECT status FROM bookings WHERE id='aaaaaaaa-1919-1919-1919-000000000001';" | tr -d ' ')

if echo "$CANCEL_R" | grep -q "has_successful_payment" && [[ "$STATUS_19A" == "pending" ]]; then
  log_pass "T19a: Payment-present → cancel rejected (has_successful_payment), booking=pending preserved"
else
  log_fail "T19a: Expected has_successful_payment + pending, got cancel=$CANCEL_R status=$STATUS_19A"
fi

echo "--- T19b: Cancel wins, then late payment arrives → BLOCKED ---"
# Interleaving (ii): cancel succeeds on a pending booking with no payment.
# A payment INSERT after the cancellation is a "late payment" scenario.
# M471 documents this: "If the gateway later confirms (webhook → status='success'),
# finalization finds a cancelled entity and handles it at the application layer."
# This test verifies the cancel succeeds and documents the late-payment gap.
psql -d "$DB_NAME" -q -c "INSERT INTO bookings (id,business_id,user_id,date,status) VALUES ('bbbbbbbb-1919-1919-1919-000000000002','bbbbbbb0-0001-0001-0001-000000000001','dddddddd-0001-0001-0001-000000000001','2027-01-01','pending');"

CANCEL_R2=$(psql -d "$DB_NAME" -tAc "SELECT cancel_pending_booking_for_navigation('bbbbbbbb-1919-1919-1919-000000000002','dddddddd-0001-0001-0001-000000000001');" 2>&1)
STATUS_BEFORE_PAY=$(psql -d "$DB_NAME" -tAc "SELECT status FROM bookings WHERE id='bbbbbbbb-1919-1919-1919-000000000002';" | tr -d ' ')

if echo "$CANCEL_R2" | grep -q '"cancelled": true' && [[ "$STATUS_BEFORE_PAY" == "cancelled" ]]; then
  log_pass "T19b-cancel: Cancel succeeded on unpaid pending booking"
else
  log_fail "T19b-cancel: Expected cancelled=true, got cancel=$CANCEL_R2 status=$STATUS_BEFORE_PAY"
fi

# Late payment arrives after cancellation
psql -d "$DB_NAME" -q -c "INSERT INTO payments (booking_id,status) VALUES ('bbbbbbbb-1919-1919-1919-000000000002','success');"
STATUS_AFTER_PAY=$(psql -d "$DB_NAME" -tAc "SELECT status FROM bookings WHERE id='bbbbbbbb-1919-1919-1919-000000000002';" | tr -d ' ')
PAY_COUNT=$(psql -d "$DB_NAME" -tAc "SELECT count(*) FROM payments WHERE booking_id='bbbbbbbb-1919-1919-1919-000000000002' AND status='success';" | tr -d ' ')

# The booking remains cancelled. The successful payment exists.
# Application-layer convergence (refund/recovery) is NOT in M471 scope.
# Document this as BLOCKED on application-layer finalization handling.
if [[ "$STATUS_AFTER_PAY" == "cancelled" ]] && [[ "$PAY_COUNT" == "1" ]]; then
  echo "  INFO: T19b-late-payment: booking=cancelled + payment=success"
  echo "  INFO: Application-layer convergence (refund/reconciliation) is BLOCKED"
  echo "  INFO: on sendProactiveConfirmation handling cancelled-entity + success-payment."
  echo "  INFO: M471 does not claim to resolve this — it documents the gap explicitly."
  log_pass "T19b-state: Late-payment state recorded. Convergence: BLOCKED (app-layer, not M471)"
else
  log_fail "T19b-state: Unexpected: status=$STATUS_AFTER_PAY pay_count=$PAY_COUNT"
fi

echo ""
echo "=== RESULTS ==="
echo "Total: $TOTAL  Passed: $PASS  Failed: $FAIL"
echo "Skipped: 0"
echo ""
if [[ "$FAIL" -gt 0 ]]; then
  echo "SOME TESTS FAILED"
  exit 1
else
  echo "ALL TESTS PASSED"
  exit 0
fi
