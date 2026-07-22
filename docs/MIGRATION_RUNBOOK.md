# Production Migration Runbook

## Current State

- **Production**: 87 migrations applied, latest version **100**
- **Codebase**: 265 versions across 252 migration files
- **Pending**: 152 migrations (101–265)
- **DO NOT APPLY WITHOUT FOLLOWING THIS RUNBOOK**

## Pre-Migration Checklist

### 1. Verify Current State

```bash
# Get a fresh Supabase access token from https://supabase.com/dashboard/account/tokens
export SUPABASE_ACCESS_TOKEN=<new_token>

# Verify applied migrations
curl -s -X POST "https://api.supabase.com/v1/projects/cxcmiqotkowhxinjbytg/database/query" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query": "SELECT COUNT(*) as total, MAX(version::integer) as latest FROM supabase_migrations.schema_migrations"}' 

# Expected: total=87, latest=100
```

### 2. Backup Production Database

```bash
# Option A: Supabase Dashboard
# Go to Settings → Database → Backups → Create backup

# Option B: pg_dump via connection string
pg_dump "$PRODUCTION_DATABASE_URL" --format=custom --file=waaiio_backup_$(date +%Y%m%d_%H%M%S).dump

# Verify backup is valid
pg_restore --list waaiio_backup_*.dump | head -20
```

### 3. Create Staging Clone

```bash
# Option A: Supabase branching (if available)
supabase db branch create staging-migration-test

# Option B: Restore backup to a new project
# Create a new Supabase project for staging
# Restore the backup there
pg_restore --dbname="$STAGING_DATABASE_URL" --clean waaiio_backup_*.dump
```

### 4. Validate on Staging

```bash
# Apply all pending migrations to staging (fail-fast)
for f in supabase/migrations/*.sql; do
  VERSION=$(basename "$f" | cut -d'_' -f1)
  if [ "$VERSION" -gt 100 ]; then
    echo "Applying $f..."
    SQL=$(cat "$f")
    RESULT=$(curl -s -X POST "https://api.supabase.com/v1/projects/$STAGING_REF/database/query" \
      -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
      -H "Content-Type: application/json" \
      -d "$(jq -n --arg q "$SQL" '{query: $q}')")
    
    if echo "$RESULT" | grep -q "error"; then
      echo "❌ FAILED: $f"
      echo "$RESULT"
      echo "STOPPING. Fix this migration before continuing."
      exit 1
    fi
    echo "✅ Applied: $(basename $f)"
  fi
done
echo "All migrations applied successfully on staging."
```

### 5. Verify Staging

```bash
# Check migration count
curl -s -X POST "https://api.supabase.com/v1/projects/$STAGING_REF/database/query" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query": "SELECT COUNT(*) as total, MAX(version::integer) as latest FROM supabase_migrations.schema_migrations"}'

# Expected: latest=265

# Verify key tables exist
curl -s -X POST "https://api.supabase.com/v1/projects/$STAGING_REF/database/query" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query": "SELECT tablename FROM pg_tables WHERE schemaname = '\''public'\'' ORDER BY tablename"}'

# Run the application against staging and verify core flows work
```

## Production Execution

### 6. Schedule Maintenance Window

- Notify team of planned migration
- Choose a low-traffic period
- Have the backup ready and verified

### 7. Apply to Production (Fail-Fast)

```bash
# Apply one migration at a time, stopping on any error
for f in supabase/migrations/*.sql; do
  VERSION=$(basename "$f" | cut -d'_' -f1)
  if [ "$VERSION" -gt 100 ]; then
    echo "Applying $f to PRODUCTION..."
    SQL=$(cat "$f")
    RESULT=$(curl -s -X POST "https://api.supabase.com/v1/projects/cxcmiqotkowhxinjbytg/database/query" \
      -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
      -H "Content-Type: application/json" \
      -d "$(jq -n --arg q "$SQL" '{query: $q}')")
    
    if echo "$RESULT" | grep -q "error"; then
      echo "❌ FAILED AT: $f"
      echo "$RESULT"
      echo ""
      echo "PRODUCTION MIGRATION STOPPED."
      echo "Last successful migration: VERSION $((VERSION - 1))"
      echo "See Rollback section below."
      exit 1
    fi
    echo "✅ $VERSION applied"
  fi
done
echo "✅ All production migrations applied successfully."
```

### 8. Verify Production

```bash
# Verify migration count
# Expected: latest=265

# Smoke test the application
# - Login works
# - Dashboard loads
# - Booking flow works
# - Payment pages load
# - Admin panel loads
```

## Rollback / Recovery

### If a migration fails mid-way:

1. **Do NOT continue** — the remaining migrations may depend on the failed one
2. **Identify what was applied** — check schema_migrations for the latest version
3. **Assess the damage**:
   - If the failed migration was DDL (ALTER TABLE, CREATE TABLE): the partial change may need manual reversal
   - If it was a function (CREATE OR REPLACE FUNCTION): the old function still works
   - If it was data (INSERT, UPDATE): may need manual data correction

### Full rollback to backup:

```bash
# Only if necessary — this loses all data changes since the backup
pg_restore --dbname="$PRODUCTION_DATABASE_URL" --clean waaiio_backup_*.dump
```

### Partial rollback:

Most migrations are additive (ADD COLUMN, CREATE TABLE, CREATE FUNCTION). These don't break existing functionality. The application will continue working with the old code until the new code is deployed.

## Important Notes

- **Never apply migrations directly to production without staging validation**
- **ENABLE_PAYOUTS must remain false** until payout safety tests pass
- **The application must be deployed AFTER migrations** (new code expects new schema)
- **Some migrations create SECURITY DEFINER functions** — verify privileges after application
- **Migration 265 runs database assertions** — if it fails, earlier migrations have issues

## Migration Categories (101–265)

| Range | Category | Risk |
|-------|----------|------|
| 101-120 | Feature tables (auto_approve, bookings, etc.) | Low |
| 121-160 | Capabilities, membership, packages, check-in | Low |
| 161-176 | Admin roles, booking functions | Medium (enum + function) |
| 177-230 | Various features | Low |
| 231-243 | Atomic RPCs (catalog, recurring, credits) | Medium (functions) |
| 244-252 | Financial integrity (platform fees, payouts) | High (financial) |
| 253-265 | Function splits, privileges, assertions | Medium (security) |
