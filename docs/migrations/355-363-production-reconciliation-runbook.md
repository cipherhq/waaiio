# Migration 355-363 Production Reconciliation Runbook

**All production steps require separate CTO/owner authorization.**

## Current State
- Last correct tracking: `354`
- Migration 355 SQL: **applied** (schema objects present)
- Migration 355 tracking: **INCORRECT** — recorded as `20260902052231`
- 356-363: **not applied**; 358 intentionally absent

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
Expected pending: **356, 357, 359, 360, 361, 362, 363** (exactly 7).
If ANY other migration appears pending, STOP.

Then verify with dry-run:
```bash
supabase db push --linked --dry-run
```

## Apply Pending Migrations

`supabase db push --linked` applies ALL local pending migrations in numeric order. It is not single-migration.
```bash
supabase db push --linked
```

## Post-Verification

### 1. Migration history completeness
```sql
SELECT version FROM supabase_migrations.schema_migrations
WHERE version ~ '^\d+$' AND version::int BETWEEN 355 AND 363
ORDER BY version::int;
```
Expected: 355, 356, 357, 359, 360, 361, 362, 363 (exactly 8 rows; 358 intentionally absent).

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
    'toggle_messaging_suspension'
  )
ORDER BY p.proname;
```
Expected: 29 functions (5 from 355 + 4 from 356 + 1 from 357 + 5 from 359 + 4 from 360 + 4 from 361 + 3 from 362 + 3 from 363). All RPCs that mutate state must show `security_definer = true`. Trigger helpers (`prevent_*`, `guard_*`) do not require SECURITY DEFINER.

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
    'cancel_booking_with_release'
  )
ORDER BY p.proname;
```
Expected: all show `auth_can_execute = false`, `service_can_execute = true`.

### 10. Advisors / lint
```bash
supabase db lint --linked --level warning --fail-on warning
```
**Failure policy:** the command must exit 0. Any non-zero exit (warning or error level findings) is a **STOP** condition — post the full output to Issue #256 and wait for CTO authorization before proceeding. Do not suppress or skip warnings.

## Failure Procedure
STOP. Post exact output to Issue #256. Wait for CTO authorization.
