# Migration 355-363 Production Reconciliation Runbook

**All production steps require separate CTO/owner authorization.**

## Current State
- Last correct tracking: `354`
- Migration 355 SQL: **applied** (schema present)
- Migration 355 tracking: **INCORRECT** — `20260902052231` instead of `355`
- 356-363: **not applied**
- Intentionally absent: `358`

## Repair Steps

### Step 1: Revert timestamp entry
```bash
supabase migration repair --status reverted 20260902052231 --linked
```

### Step 2: Mark 355 as applied
```bash
supabase migration repair --status applied 355 --linked
```

### Step 3: Verify repair
```sql
SELECT version, name FROM supabase_migrations.schema_migrations
WHERE version IN ('355', '20260902052231');
```
Expected: `version = '355'` only.

## Apply Pending (356-363)
```bash
supabase migration list --linked  -- verify pending set
supabase db push --linked         -- applies ALL pending
```
Note: `db push` applies all pending migrations, not one at a time.

## Post-Verification
```sql
SELECT version FROM supabase_migrations.schema_migrations
WHERE version ~ '^\d+$' AND version::int BETWEEN 355 AND 363
ORDER BY version::int;
```
Expected: `355, 356, 357, 359, 360, 361, 362, 363` (8 rows).

### Migration 363 postconditions
```sql
SELECT column_name, data_type, column_default FROM information_schema.columns
WHERE table_schema='public' AND table_name='businesses' AND column_name='messaging_suspended';

SELECT proname, prosecdef FROM pg_proc
WHERE pronamespace='public'::regnamespace AND proname='toggle_messaging_suspension';

SELECT tgname FROM pg_trigger WHERE tgrelid='public.businesses'::regclass AND tgname='trg_guard_messaging_suspended';
```

### Security advisors
```bash
supabase inspect db lint --linked
```

## Failure: STOP and post to Issue #256.
