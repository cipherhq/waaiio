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

### B2. Run fail-closed canonical postcondition verifier

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f docs/sql/verify-production-321-322-postconditions.sql
```

This script raises an exception on ANY mismatch. It verifies:

**321 Promotions:** 8 tables, 9 enums, 11 functions, SECURITY DEFINER + search_path,
exact RPC privilege matrix using regprocedure signatures (9 service-role-only RPCs
including get_promo_campaign_aggregates and validate_promo_campaign_activation),
RLS on all 8 tables, exact canonical policy set with full definition verification
(13 policies — name, command, roles, USING expression references auth.uid() where
expected, service_role policies use USING(true)/WITH CHECK(true), no extras on the
exact 8 canonical 321 tables, unrelated promo_codes policies tolerated).

**322 Classes:** 2 class tables, bookings.class_session_id FK → class_sessions with
confdeltype='n' (SET NULL), idx_bookings_class_session, exactly 1 book_slot_atomic
overload (28 args), 9 RPCs with SECURITY DEFINER + search_path, exact privilege
matrix (8 service-role-only, get_upcoming_class_sessions: PUBLIC=no, anon=yes,
authenticated=yes, service_role=yes), RLS + FORCE ROW LEVEL SECURITY, exact
canonical policy set with full definition verification (4 policies — owner SELECT
references auth.uid(), service ALL uses USING(true)/WITH CHECK(true), no extras),
table grants (authenticated=SIUD, anon=none).

**323 get_bot_context:** exact 2-arg signature, SECURITY DEFINER + search_path,
PUBLIC/anon/authenticated=no EXECUTE, service_role=yes, no stale single-arg
overload, exactly 1 overload total.

**This verifier MUST complete successfully.** Any failed invariant = ABORT.

The verifier is source-controlled at `docs/sql/verify-production-321-322-postconditions.sql`
and matches the invariants proven by `production-drift-reconciliation.test.ts`.

For diagnostic purposes, the following human-readable queries may also be run:

```sql
-- Diagnostic: full function details (not authoritative — use verifier)
SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args,
  p.prosecdef, COALESCE(array_to_string(p.proconfig, ','), 'none') AS config,
  has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
  has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authed,
  has_function_privilege('service_role', p.oid, 'EXECUTE') AS svc
FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'public'
  AND p.proname IN (
    'claim_promo_code', 'admin_promo_governance', 'book_slot_atomic',
    'generate_class_sessions', 'create_class_atomic'
  )
ORDER BY p.proname;

-- Diagnostic: index definitions
SELECT tablename, indexname, indexdef FROM pg_indexes
WHERE tablename IN ('class_recurrence_rules', 'class_sessions')
ORDER BY tablename, indexname;

-- Diagnostic: policy definitions
SELECT c.relname, pol.polname, pol.polcmd::text,
  pg_get_expr(pol.polqual, pol.polrelid) AS using_expr,
  pg_get_expr(pol.polwithcheck, pol.polrelid) AS check_expr
FROM pg_policy pol JOIN pg_class c ON c.oid = pol.polrelid
WHERE c.relname IN ('class_recurrence_rules', 'class_sessions',
  'promo_campaigns', 'promo_redemptions')
ORDER BY c.relname, pol.polname;
```

### B3. Verify existing data intact

Compare to counts captured in Phase A5 (must be identical):

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

Only proceed after ALL of:
- B1: migration 325 applied successfully
- B2: canonical 321+322+323 postcondition verifier PASSED (all checks)
- B3: data counts unchanged from A5 captures

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
