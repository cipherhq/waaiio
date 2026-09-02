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
```sql
SELECT version FROM supabase_migrations.schema_migrations
WHERE version ~ '^\d+$' AND version::int BETWEEN 355 AND 363
ORDER BY version::int;
```
Expected: 355, 356, 357, 359, 360, 361, 362, 363 (8 rows).

### Migration 363 postconditions
```sql
SELECT column_name, data_type, column_default FROM information_schema.columns
WHERE table_schema='public' AND table_name='businesses' AND column_name='messaging_suspended';

SELECT proname, prosecdef FROM pg_proc
WHERE pronamespace='public'::regnamespace AND proname='toggle_messaging_suspension';
```

### Security review
Use the Supabase Dashboard Database Advisors page or the supported CLI lint equivalent for the current project version.

## Failure Procedure
STOP. Post exact output to Issue #256. Wait for CTO authorization.
