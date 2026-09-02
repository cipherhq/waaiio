# Migration 355-364 Production Reconciliation Runbook

**All production steps require separate CTO/owner authorization.**

## Current State
- Last correct tracking: `354`
- Migration 355 SQL: **applied** (schema objects present)
- Migration 355 tracking: **INCORRECT** — recorded as `20260902052231`
- 356-364: **not applied**; 358 intentionally absent

## Pre-Repair Verification
```sql
SELECT version, name FROM supabase_migrations.schema_migrations
WHERE version ~ '^\d+$' AND version::int > 354
ORDER BY version::int;

SELECT version, name FROM supabase_migrations.schema_migrations
WHERE version !~ '^\d{1,4}$';
```

## History Repair

Step 1 — revert the erroneous timestamp entry:
```bash
supabase migration repair 20260902052231 --status reverted --linked
```

Step 2 — mark repository version 355 as applied (no SQL re-execution):
```bash
supabase migration repair 355 --status applied --linked
```

Step 3 — verify:
```sql
SELECT version, name FROM supabase_migrations.schema_migrations
WHERE version IN ('355', '20260902052231');
```

## Pending Migration Preflight

Before applying, verify the exact pending set:
```bash
supabase migration list --linked
```
Expected pending: **356, 357, 359, 360, 361, 362, 363, 364** (exactly 8).
If ANY other migration appears pending, STOP.

## Migration 359 Hold

Migration 359 (`config_versioning`) creates a `platform_config_versions` table and bootstraps
an initial authoritative snapshot from the 11 commercial keys in `platform_settings`.
Production currently has 10 of 11 keys; `minimum_bank_transfer` is absent.

The bootstrap succeeds with 10 keys (the snapshot is non-empty), but the initial snapshot
will not include `minimum_bank_transfer`. This is an incomplete-snapshot decision, not a
migration failure.

**Owner must choose before 359 can be applied:**
- **Option A:** Insert `minimum_bank_transfer` with value `{"NG": 10000, "GH": 600}` (canonical fallback from `lib/platformSettings.ts:124`) before applying 359. The initial snapshot includes all 11 commercial keys.
- **Option B:** Apply 359 without inserting the key. The initial snapshot includes 10 of 11 keys. `minimum_bank_transfer` can be added later via the admin `save_commercial_config` RPC, which will create a new versioned snapshot including it.

**Do not** mark 359 as applied without executing its SQL. That creates ledger/schema drift.

Until the owner decides, apply the other 7 migrations individually (skipping 359).

## Individual Migration Application Procedure

`supabase db push --linked` cannot skip migration 359. Migrations are applied individually
using the Management API query endpoint with an explicit PostgreSQL transaction.

### Transaction design

Each migration is wrapped in an explicit `BEGIN...COMMIT` block that includes both the
migration DDL and the ledger INSERT. This guarantees atomic commit: either both the schema
change and the ledger entry succeed, or neither does.

```sql
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- === Migration SQL (verbatim from supabase/migrations/N_name.sql) ===
<migration SQL here>

-- === Ledger recording (same transaction) ===
INSERT INTO supabase_migrations.schema_migrations (version, name)
VALUES ('N', 'N_name');

COMMIT;
```

**Transaction semantics** (proven via Supabase `postgres-meta` source → node-postgres → PostgreSQL simple query protocol):
- The Management API `POST /database/query` passes the SQL string unchanged to `pool.query()`
- node-postgres sends the full string as a single PostgreSQL simple-query 'Q' message
- PostgreSQL executes all statements on the same connection, honoring the explicit `BEGIN...COMMIT`
- `SET LOCAL` is scoped to the transaction and resets after COMMIT or ROLLBACK

### Failure and cleanup semantics

If any statement between `BEGIN` and `COMMIT` fails (DDL error, lock timeout, constraint violation):

1. PostgreSQL stops processing the remaining statements in the query string — `COMMIT` is never reached
2. The connection holds an aborted transaction (state `E` / `InFailedTransaction`)
3. The Management API's `pgMeta.end()` closes the connection, which causes PostgreSQL to roll back the aborted transaction
4. All DDL changes within the transaction are rolled back — no partial schema change
5. The ledger INSERT is also rolled back — no orphaned ledger entry
6. Any ACCESS EXCLUSIVE locks acquired during the transaction are released on rollback

**The operator does not need to perform manual cleanup after a failure.** The failed migration leaves no trace in the schema or ledger. The operator can investigate, resolve the root cause (e.g., wait for blocking transactions), and retry.

### Execution command

```bash
SQL=$(cat supabase/migrations/N_name.sql)

FULL_SQL="BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

${SQL}

INSERT INTO supabase_migrations.schema_migrations (version, name)
VALUES ('N', 'N_name');

COMMIT;"

RESPONSE=$(curl -s -w "\n%{http_code}" -X POST \
  "https://api.supabase.com/v1/projects/${SUPABASE_REF}/database/query" \
  -H "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg q "$FULL_SQL" '{query: $q}')")

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | head -n -1)

if [ "$HTTP_CODE" = "200" ]; then
  echo "HTTP 200 received — run postconditions to confirm committed state."
elif echo "$BODY" | grep -q "ERROR:"; then
  echo "CONFIRMED DATABASE ERROR: HTTP $HTTP_CODE"
  echo "$BODY"
  echo "The database returned a SQL error. The transaction was not committed."
  echo "Investigate the error, resolve the root cause, and retry."
  exit 1
else
  echo "AMBIGUOUS OUTCOME: HTTP $HTTP_CODE"
  echo "$BODY"
  echo "The HTTP response does not confirm whether the transaction committed."
  echo "This can occur on timeout, proxy 5xx, or client disconnect."
  echo "DO NOT RETRY. Run postconditions below to determine actual state."
fi
```

### Postconditions (REQUIRED after every attempt — success or ambiguous)

Postconditions must be run after EVERY migration attempt, including HTTP 200 responses.
An HTTP status code alone is not sufficient evidence of committed migration state.

```bash
# A. Ledger entry check (read-only)
curl -s -X POST "https://api.supabase.com/v1/projects/${SUPABASE_REF}/database/query" \
  -H "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"query": "SELECT version, name FROM supabase_migrations.schema_migrations WHERE version = '"'"'N'"'"'"}'

# B. Migration objects check (run the migration-specific verification from Post-Verification below)
```

**Interpreting postcondition results:**

| HTTP response | Ledger entry | Objects exist | State | Action |
|--------------|-------------|---------------|-------|--------|
| 200 | Present | Present | **Committed** | Proceed to next migration |
| 200 | Absent | Absent | **Not committed** (unexpected) | STOP — post evidence |
| Non-200 (confirmed SQL error) | Absent | Absent | **Rolled back** (confirmed) | Fix root cause, retry after postconditions confirm no committed state |
| Ambiguous (timeout/5xx) | Present | Present | **Committed** | Proceed |
| Ambiguous (timeout/5xx) | Absent | Absent | **UNKNOWN** | DO NOT RETRY — STOP for provider/connection reconciliation |
| Ambiguous (timeout/5xx) | Present | Absent (or vice versa) | **UNKNOWN (split)** | DO NOT RETRY — STOP — manual investigation required |
For any ambiguous transport outcome (timeout, proxy 5xx, client disconnect), the only
safe conclusion is **Committed** when both ledger and all migration objects are confirmed
present. All other ambiguous outcomes are **UNKNOWN** — do not retry, do not proceed.
Post exact evidence to Issue #218 and wait for provider/connection reconciliation.

## Application Order

**Critical barrier:** Migration 363 MUST be applied and verified BEFORE migration 362.

Applying 362 before 363 creates a window where inbound webhook messages are claimed and
completed but outbound responses fail (because `businesses.messaging_suspended` column is
absent), permanently losing those messages.

### Phase A — Urgent recovery (restores bot functionality)

**Step 1:** Apply migration **363** (`emergency_hard_stop`) — restores outbound messaging.
Verify: `businesses.messaging_suspended` column, `toggle_messaging_suspension` function, audit table, triggers.
**Do not proceed until verification passes.**

**Step 2:** Apply migration **362** (`webhook_claim_fencing`) — restores inbound webhook processing.
Verify: `claim_webhook_event`, `complete_webhook_event`, `fail_webhook_event` functions, `claim_token` column.

### Phase B — Full convergence

Apply in this order: **356**, **357**, **360**, **361**, **364**.
Verify postconditions after each.

### Phase C — Deferred migration 359

After owner decides on `minimum_bank_transfer` (Option A or B above), apply **359**.
After 359, verify with:
```bash
supabase migration list --linked
```
Expected: zero pending migrations.

### Lock contention notes

| Migration | Lock-acquiring DDL | Target table | Timeout behavior |
|-----------|-------------------|-------------|-----------------|
| 363 | `ALTER TABLE ADD COLUMN` + `CREATE TRIGGER` | `businesses` (high traffic) | `lock_timeout = 5s` → aborts and rolls back if blocked |
| 362 | `ALTER TABLE ADD COLUMN` + `DROP/ADD CONSTRAINT` | `processed_webhook_events` (low traffic) | Same |
| 356 | `ALTER TABLE ADD COLUMN` | `customer_profiles` | Same |
| 360 | `ALTER TABLE ADD COLUMN` | `orders` | Same |
| 357 | `DROP/CREATE FUNCTION` | No table lock | Near-instant |
| 361 | `CREATE TABLE` | No existing table lock | Near-instant |
| 364 | `DROP/CREATE FUNCTION` | No table lock | Near-instant |

If `lock_timeout` fires: the entire transaction rolls back automatically. Wait for the
blocking transaction to complete, then retry. Check `pg_stat_activity` for long-running
queries on the target table.

## Post-Verification

### 1. Migration history completeness
```sql
SELECT version FROM supabase_migrations.schema_migrations
WHERE version ~ '^\d+$' AND version::int BETWEEN 355 AND 364
ORDER BY version::int;
```
Expected: 355, 356, 357, 359, 360, 361, 362, 363, 364 (exactly 9 rows; 358 intentionally absent).

No stale timestamp entries remain:
```sql
SELECT version FROM supabase_migrations.schema_migrations
WHERE version !~ '^\d{1,4}$';
```
Expected: 0 rows (all timestamp entries should have been reverted).

### 2. Tables created (359, 360, 361, 363)
```sql
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN (
    'platform_config_versions',
    'order_tracking_notifications',
    'booking_confirmation_intents',
    'messaging_suspension_audit'
  )
ORDER BY table_name;
```
Expected: all 4 tables present.

### 3. Columns added
```sql
-- 355: refund columns on payments
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'payments'
  AND column_name IN ('refund_amount', 'refund_reason', 'refunded_by', 'refunded_at');

-- 355: refunds table columns added by migration
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'refunds'
  AND column_name IN ('dispatched_at', 'finalized_at', 'provider_refund_id', 'provider_status', 'recovery_token', 'recovery_claimed_at', 'connect_account_id', 'provider_connection_id');

-- 356: customer_profiles.user_id
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'customer_profiles' AND column_name = 'user_id';

-- 360: orders.tracking_revision
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'tracking_revision';

-- 362: processed_webhook_events.claim_token
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'processed_webhook_events' AND column_name = 'claim_token';

-- 363: businesses.messaging_suspended
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'businesses' AND column_name = 'messaging_suspended';
```

### 4. Functions — existence, SECURITY DEFINER status, and ownership
```sql
SELECT p.proname, p.prosecdef AS security_definer, r.rolname AS owner
FROM pg_proc p
JOIN pg_roles r ON p.proowner = r.oid
WHERE p.pronamespace = 'public'::regnamespace
  AND p.proname IN (
    -- 355: refund RPCs
    'claim_refund_dispatch',
    'recover_interrupted_dispatch',
    'recover_ambiguous_refund',
    'finalize_refund_execution',
    'reconcile_pending_refund',
    -- 356: customer/financial RPCs
    'get_business_transactions',
    'get_customer_history',
    'get_business_revenue_totals',
    'create_recurring_offer',
    -- 357: cancellation RPC
    'cancel_booking_with_release',
    -- 359: config versioning
    'prevent_config_version_mutation',
    'guard_config_version_insert',
    'guard_commercial_settings',
    'get_effective_config',
    'save_commercial_config',
    -- 360: order tracking RPCs
    'update_order_tracking',
    'claim_tracking_notification',
    'mark_tracking_notification_dispatched',
    'record_tracking_notification_outcome',
    -- 361: booking confirmation RPCs
    'claim_booking_confirmation',
    'mark_booking_confirmation_dispatched',
    'record_booking_confirmation_outcome',
    'expire_stale_booking_confirmations',
    -- 362: webhook claim RPCs
    'claim_webhook_event',
    'complete_webhook_event',
    'fail_webhook_event',
    -- 363: hard-stop
    'prevent_suspension_audit_mutation',
    'guard_messaging_suspended',
    'toggle_messaging_suspension',
    -- 364: CAS business_id extension
    'update_session_cas'
  )
ORDER BY p.proname;
```
Expected: 30 functions (5 from 355 + 4 from 356 + 1 from 357 + 5 from 359 + 4 from 360 + 4 from 361 + 3 from 362 + 3 from 363 + 1 from 364). All RPCs that mutate state must show `security_definer = true`. Trigger helpers (`prevent_*`, `guard_*`) do not require SECURITY DEFINER. Migration 364 replaces the 6-arg `update_session_cas` with a 7-arg version (`pronargs = 7`).

### 5. RLS enabled on new tables
```sql
SELECT relname, relrowsecurity
FROM pg_class
WHERE relnamespace = 'public'::regnamespace
  AND relname IN (
    'refunds',
    'platform_config_versions',
    'order_tracking_notifications',
    'booking_confirmation_intents',
    'messaging_suspension_audit'
  )
ORDER BY relname;
```
Expected: all 5 show `relrowsecurity = true`.

### 6. RLS policies
```sql
SELECT schemaname, tablename, policyname, cmd, roles
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN (
    'refunds',
    'refund_requests',
    'platform_config_versions',
    'order_tracking_notifications',
    'messaging_suspension_audit'
  )
ORDER BY tablename, policyname;
```
Expected policies:
- `refunds`: `refunds_owner_select` (SELECT), `refunds_admin_select` (SELECT)
- `refund_requests`: `refund_requests_admin_all` (ALL)
- `platform_config_versions`: `admin_read_config_versions` (SELECT)
- `order_tracking_notifications`: `otn_service_all` (ALL)
- `messaging_suspension_audit`: `admin_read_suspension_audit` (SELECT)

### 7. Triggers (359, 363)
```sql
SELECT trigger_name, event_manipulation, event_object_table, action_statement
FROM information_schema.triggers
WHERE trigger_schema = 'public'
  AND trigger_name IN (
    'trg_config_versions_no_update',
    'trg_config_versions_no_delete',
    'trg_guard_config_version_insert',
    'trg_guard_commercial_settings',
    'trg_suspension_audit_no_update',
    'trg_suspension_audit_no_delete',
    'trg_guard_messaging_suspended'
  )
ORDER BY event_object_table, trigger_name;
```
Expected: 7 triggers across `platform_config_versions`, `platform_settings`, `messaging_suspension_audit`, and `businesses`.

### 8. Key indexes
```sql
SELECT indexname, tablename
FROM pg_indexes
WHERE schemaname = 'public'
  AND indexname IN (
    'idx_refunds_payment_id',
    'idx_refunds_business_id',
    'idx_refunds_active_execution',
    'idx_customer_profiles_business_user',
    'idx_customer_profiles_user_id',
    'idx_otn_order_revision',
    'idx_otn_business_status',
    'idx_bci_status_lease',
    'idx_bci_booking_purpose'
  )
ORDER BY tablename, indexname;
```
Expected: 9 indexes.

### 9. Service-role-only function grants
```sql
SELECT p.proname,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_can_execute,
       has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_can_execute
FROM pg_proc p
WHERE p.pronamespace = 'public'::regnamespace
  AND p.proname IN (
    'claim_refund_dispatch',
    'recover_interrupted_dispatch',
    'recover_ambiguous_refund',
    'finalize_refund_execution',
    'reconcile_pending_refund',
    'update_order_tracking',
    'claim_tracking_notification',
    'mark_tracking_notification_dispatched',
    'record_tracking_notification_outcome',
    'claim_booking_confirmation',
    'mark_booking_confirmation_dispatched',
    'record_booking_confirmation_outcome',
    'expire_stale_booking_confirmations',
    'claim_webhook_event',
    'complete_webhook_event',
    'fail_webhook_event',
    'cancel_booking_with_release',
    'update_session_cas'
  )
ORDER BY p.proname;
```
Expected: all show `auth_can_execute = false`, `service_can_execute = true`.

### 9b. Migration 364 signature verification
```sql
SELECT proname, pronargs FROM pg_proc
WHERE pronamespace = 'public'::regnamespace AND proname = 'update_session_cas';
```
Expected: 1 row, `pronargs = 7` (the 7-arg version with `p_business_id UUID DEFAULT NULL`).

### 10. Advisors / lint
```bash
supabase db lint --linked --level warning --fail-on warning
```
**Failure policy:** the command must exit 0. Any non-zero exit (warning or error level findings) is a **STOP** condition — post the full output to Issue #256 and wait for CTO authorization before proceeding. Do not suppress or skip warnings.

## Failure Procedure
STOP. Post exact output to Issue #256. Wait for CTO authorization.
