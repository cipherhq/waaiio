# Production Drift Reconciliation Runbook: Migrations 321-324

**DOCUMENTATION ONLY -- DO NOT EXECUTE WITHOUT EXPLICIT AUTHORIZATION**

**Scope:** Converge production database from partially-applied 321/322 state to fully-reconciled 324 state using migration 325.

**Prerequisites:** PR #141 merged to main, migration 325 tested via `production-drift-reconciliation.test.ts`.

---

## PHASE A -- PRE-FLIGHT (READ ONLY)

All commands in this phase are read-only. No schema changes.

### A1. Verify approved main SHA

```bash
git log --oneline -1 origin/main
# Must match the exact approved SHA containing migration 325
```

### A2. Verify PR #141 merged

```bash
gh pr view 141 --json state,mergeCommit
# state must be "MERGED"
```

### A3. Read production migration ledger

```sql
SELECT version, name FROM supabase_migrations.schema_migrations
WHERE version IN ('321', '322', '323', '324', '325')
ORDER BY version;
```

**Expected:** 321, 322, 323 are NOT present (applied outside ledger). 324 and 325 are NOT present (not yet applied).

**ABORT if:** Any of 321-323 are already in the ledger (reconciliation already done or different state than tested).

### A4. Read production schema postconditions

Verify the drift fixture matches production reality:

```sql
-- Tables that should exist from partial 322 application
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN ('class_recurrence_rules', 'class_sessions')
ORDER BY table_name;

-- bookings.class_session_id should exist
SELECT column_name FROM information_schema.columns
WHERE table_name = 'bookings' AND column_name = 'class_session_id';

-- Promo tables that should exist from partial 321 application
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name LIKE 'promo_%'
ORDER BY table_name;
```

**ABORT if:** class_recurrence_rules or class_sessions missing (fixture assumes present).

### A5. Capture BEFORE data counts

Record these values BEFORE any schema changes. They will be compared
to post-325 values in Phase B4 to prove no data loss.

```sql
-- Record these exact counts before migration 325:
SELECT 'class_recurrence_rules' AS table_name, COUNT(*) AS row_count FROM class_recurrence_rules
UNION ALL
SELECT 'class_sessions', COUNT(*) FROM class_sessions
UNION ALL
SELECT 'bookings_with_class_session', COUNT(*) FROM bookings WHERE class_session_id IS NOT NULL;
```

Save the output. These are production-state values — do not hardcode expectations.

### A6. Capture function signatures and security

```sql
SELECT p.proname,
  pg_get_function_identity_arguments(p.oid) AS args,
  CASE WHEN p.prosecdef THEN 'DEFINER' ELSE 'INVOKER' END AS security,
  COALESCE(array_to_string(p.proconfig, ','), 'none') AS config
FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'public'
  AND p.proname IN (
    'generate_class_sessions', 'get_upcoming_class_sessions',
    'book_slot_atomic', 'book_manual_slot_atomic',
    'reschedule_booking_atomic', 'create_class_atomic',
    'create_class_recurrence_atomic', 'update_class_session_atomic',
    'reconcile_class_recurrence',
    'claim_promo_code', 'validate_promo_campaign_activation',
    'admin_promo_governance', 'activate_promo_campaign'
  )
ORDER BY p.proname;
```

**ABORT if:** Observed state differs materially from the tested drift fixture (e.g., tables missing that fixture assumes present, extra columns not accounted for, functions with different arg counts).

### A7. Capture payment confirmation RPC grant state

```sql
SELECT p.proname,
  has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
  has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authed,
  has_function_privilege('service_role', p.oid, 'EXECUTE') AS svc
FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'public'
  AND p.proname IN (
    'claim_payment_confirmation', 'renew_payment_confirmation_claim',
    'finalize_payment_confirmation', 'release_payment_confirmation'
  );
```

**Expected before 324:** anon=true, authenticated=true, service_role=true (overly permissive).

---

## PHASE B -- SCHEMA CONVERGENCE

### B1. Apply migration 325

```bash
SQL=$(cat supabase/migrations/325_production_drift_reconciliation.sql)
curl -s -X POST "https://api.supabase.com/v1/projects/cxcmiqotkowhxinjbytg/database/query" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg q "$SQL" '{query: $q}')"
```

### B2. Verify 321 Promotions postconditions

**Tables (expect 8):**

```sql
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN (
    'promo_campaigns', 'promo_prizes', 'promo_code_batches',
    'promo_campaign_codes', 'promo_redemptions',
    'promo_verification_attempts', 'promo_eligibility_acks',
    'promo_pending_eligibility'
  )
ORDER BY table_name;
```

**ABORT if count != 8.**

**Enums (expect 9):**

```sql
SELECT typname FROM pg_type
WHERE typname IN (
  'promo_campaign_status', 'promo_code_entry_mode', 'promo_prize_type',
  'promo_batch_status', 'promo_batch_source', 'promo_code_status',
  'promo_code_outcome', 'promo_fulfillment_status', 'promo_attempt_result'
)
ORDER BY typname;
```

**ABORT if count != 9.**

**Columns, constraints, indexes (concise metadata check):**

```sql
-- Promo table column counts (structure integrity)
SELECT t.table_name, COUNT(*) AS col_count
FROM information_schema.columns c
JOIN information_schema.tables t ON t.table_name = c.table_name
WHERE t.table_schema = 'public' AND t.table_name LIKE 'promo_%'
GROUP BY t.table_name ORDER BY t.table_name;

-- PK/FK/UNIQUE/CHECK constraint counts per promo table
SELECT c.relname AS table_name, con.contype::text AS constraint_type, COUNT(*)
FROM pg_constraint con
JOIN pg_class c ON c.oid = con.conrelid
WHERE c.relname LIKE 'promo_%'
GROUP BY c.relname, con.contype ORDER BY c.relname, con.contype;

-- Index count per promo table
SELECT tablename, COUNT(*) AS idx_count
FROM pg_indexes WHERE tablename LIKE 'promo_%'
GROUP BY tablename ORDER BY tablename;
```

**Functions (expect 11), security, grants:**

```sql
SELECT p.proname,
  pg_get_function_identity_arguments(p.oid) AS args,
  p.prosecdef AS security_definer,
  COALESCE(array_to_string(p.proconfig, ','), 'none') AS config,
  has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec,
  has_function_privilege('service_role', p.oid, 'EXECUTE') AS svc_exec
FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'public'
  AND p.proname IN (
    'claim_promo_code', 'validate_promo_campaign_activation',
    'admin_promo_governance', 'activate_promo_campaign',
    'commit_promo_code_chunk', 'commit_promo_import_chunk',
    'get_promo_campaign_aggregates', 'reset_promo_failed_batch',
    'create_promo_batch_atomic', 'update_promo_campaign_updated_at',
    'validate_promo_campaign_status_transition'
  )
ORDER BY p.proname;
```

**ABORT if:** count != 11, or any SECURITY DEFINER function is missing, or config missing search_path=public.

**RLS + policies:**

```sql
-- RLS enabled on all promo tables
SELECT c.relname, c.relrowsecurity
FROM pg_class c WHERE c.relname LIKE 'promo_%'
  AND c.relkind = 'r' ORDER BY c.relname;

-- Policy count per promo table
SELECT c.relname, COUNT(*) AS policy_count
FROM pg_policy pol
JOIN pg_class c ON c.oid = pol.polrelid
WHERE c.relname LIKE 'promo_%'
GROUP BY c.relname ORDER BY c.relname;
```

**ABORT if:** Any promo table has relrowsecurity=false or zero policies.

### B3. Verify 322 Classes postconditions

**Tables and columns:**

```sql
-- class_recurrence_rules columns
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'class_recurrence_rules' ORDER BY ordinal_position;

-- class_sessions columns
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'class_sessions' ORDER BY ordinal_position;
```

**bookings.class_session_id — FK, ON DELETE, index:**

```sql
-- FK exists with ON DELETE SET NULL
SELECT con.conname,
  a.attname AS source_column,
  cf.relname AS target_table,
  con.confdeltype::text AS on_delete
FROM pg_constraint con
JOIN pg_class c ON c.oid = con.conrelid
JOIN pg_class cf ON cf.oid = con.confrelid
JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(con.conkey)
WHERE c.relname = 'bookings' AND a.attname = 'class_session_id' AND con.contype = 'f';
-- Must show: target_table=class_sessions, on_delete=a (SET NULL)

-- Index exists
SELECT indexname FROM pg_indexes
WHERE tablename = 'bookings' AND indexname = 'idx_bookings_class_session';
```

**ABORT if:** FK missing, target != class_sessions, on_delete != 'a', or index missing.

**Constraints and indexes on class tables:**

```sql
-- Constraint counts (PK, FK, UNIQUE, CHECK)
SELECT c.relname, con.contype::text, COUNT(*)
FROM pg_constraint con
JOIN pg_class c ON c.oid = con.conrelid
WHERE c.relname IN ('class_recurrence_rules', 'class_sessions')
GROUP BY c.relname, con.contype ORDER BY c.relname, con.contype;

-- Index definitions
SELECT tablename, indexname, indexdef
FROM pg_indexes
WHERE tablename IN ('class_recurrence_rules', 'class_sessions')
ORDER BY tablename, indexname;
```

**RPCs — signatures, security, grants (expect 9):**

```sql
SELECT p.proname,
  pg_get_function_identity_arguments(p.oid) AS args,
  p.prosecdef AS security_definer,
  COALESCE(array_to_string(p.proconfig, ','), 'none') AS config,
  has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec,
  has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authed_exec,
  has_function_privilege('service_role', p.oid, 'EXECUTE') AS svc_exec
FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'public'
  AND p.proname IN (
    'generate_class_sessions', 'get_upcoming_class_sessions',
    'book_slot_atomic', 'book_manual_slot_atomic',
    'reschedule_booking_atomic', 'create_class_atomic',
    'create_class_recurrence_atomic', 'update_class_session_atomic',
    'reconcile_class_recurrence'
  )
ORDER BY p.proname;
```

**ABORT if:** count != 9, or any is missing SECURITY DEFINER, or config missing search_path=public.

**RLS + FORCE ROW LEVEL SECURITY:**

```sql
SELECT relname, relrowsecurity, relforcerowsecurity
FROM pg_class WHERE relname IN ('class_recurrence_rules', 'class_sessions');
-- Both must be true/true
```

**ABORT if:** Either table has relrowsecurity=false or relforcerowsecurity=false.

**Policies (full definition check):**

```sql
SELECT c.relname, pol.polname, pol.polcmd::text,
  pg_get_expr(pol.polqual, pol.polrelid) AS using_expr,
  pg_get_expr(pol.polwithcheck, pol.polrelid) AS check_expr
FROM pg_policy pol
JOIN pg_class c ON c.oid = pol.polrelid
WHERE c.relname IN ('class_recurrence_rules', 'class_sessions')
ORDER BY c.relname, pol.polname;
```

**Table grants:**

```sql
SELECT grantee, table_name, privilege_type
FROM information_schema.table_privileges
WHERE table_schema = 'public'
  AND table_name IN ('class_recurrence_rules', 'class_sessions')
  AND grantee IN ('anon', 'authenticated', 'service_role')
ORDER BY table_name, grantee, privilege_type;
```

### B4. Verify existing data intact

Compare to counts captured in Phase A5:

```sql
SELECT 'class_recurrence_rules' AS table_name, COUNT(*) AS row_count FROM class_recurrence_rules
UNION ALL
SELECT 'class_sessions', COUNT(*) FROM class_sessions
UNION ALL
SELECT 'bookings_with_class_session', COUNT(*) FROM bookings WHERE class_session_id IS NOT NULL;
```

**ABORT if:** Any count differs from the A5 pre-migration values.

---

## PHASE C -- MIGRATION HISTORY RECONCILIATION

Only proceed after Phase B postconditions pass.

### C1. Record migrations 321, 322, 323 in ledger

```bash
supabase migration repair --status applied 321 --project-ref cxcmiqotkowhxinjbytg
supabase migration repair --status applied 322 --project-ref cxcmiqotkowhxinjbytg
supabase migration repair --status applied 323 --project-ref cxcmiqotkowhxinjbytg
supabase migration repair --status applied 325 --project-ref cxcmiqotkowhxinjbytg
```

### C2. Verify ledger entries

```sql
SELECT version FROM supabase_migrations.schema_migrations
WHERE version IN ('321', '322', '323', '325')
ORDER BY version;
-- Expected: 321, 322, 323, 325
```

**ABORT if:** Any entry missing after repair commands.

---

## PHASE D -- MIGRATION 324

### D1. Apply migration 324

```bash
SQL=$(cat supabase/migrations/324_payment_confirmation_rpc_grants.sql)
curl -s -X POST "https://api.supabase.com/v1/projects/cxcmiqotkowhxinjbytg/database/query" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg q "$SQL" '{query: $q}')"
```

### D2. Verify grant restrictions

```sql
SELECT
  p.proname,
  has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
  has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authed,
  has_function_privilege('service_role', p.oid, 'EXECUTE') AS svc
FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'public'
  AND p.proname IN (
    'claim_payment_confirmation', 'renew_payment_confirmation_claim',
    'finalize_payment_confirmation', 'release_payment_confirmation'
  );
-- All must show: anon=false, authed=false, svc=true
```

### D3. Record migration 324 in ledger

```bash
supabase migration repair --status applied 324 --project-ref cxcmiqotkowhxinjbytg
```

**ABORT if:** Any function shows anon=true or authenticated=true.

---

## PHASE E -- APPLICATION DEPLOYMENT

### E1. Verify approved application SHA

```bash
git log --oneline -1 origin/main
# Must match the exact approved SHA
```

### E2. Deploy

Deploy after all database verification passes. Use standard Vercel deployment.

### E3. Smoke tests

1. **WhatsApp "Hi"**: Send "Hi" to the bot number, verify menu response
2. **Class booking flow**: Navigate to a class, book a session, verify booking created
3. **Payment confirmation**: Trigger a test payment, verify claim/finalize lifecycle
4. **Dashboard access**: Log in, verify class sessions page loads with data

**ABORT on any invariant failure** -- roll back deployment if smoke tests fail.

---

## ABORT CONDITIONS

Stop and escalate if any of these occur:

1. Pre-flight schema state does not match the tested drift fixture
2. Migration 325 SQL execution returns any error
3. Any postcondition table, column, function, or constraint is missing after 325
4. Data counts change (rows deleted or corrupted)
5. RLS or FORCE ROW LEVEL SECURITY not enabled on class tables
6. Function security (DEFINER/search_path) does not match canonical
7. Payment RPCs accessible to anon or authenticated after 324
8. Migration ledger entries missing after repair commands
9. Application deployment fails or smoke tests fail
10. Any step produces unexpected output not covered by this runbook
