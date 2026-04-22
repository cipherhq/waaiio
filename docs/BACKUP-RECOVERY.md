# Database Backup & Recovery

## Automatic Backups (Supabase)

Supabase provides automatic daily backups on Pro and Team plans:
- **Frequency:** Daily
- **Retention:** 7 days (Pro), 14 days (Team)
- **Type:** Physical backups (full database snapshot)
- **Access:** Supabase Dashboard → Settings → Database → Backups

### Point-in-Time Recovery (PITR)
Available on Pro plan with PITR add-on:
- Restore to any second within the retention window
- Enable via Supabase Dashboard → Settings → Database → Point-in-Time Recovery

## Manual Backup (pg_dump)

For additional safety, run a logical backup:

```bash
# Set your database URL (find in Supabase Dashboard → Settings → Database → Connection string)
export DATABASE_URL="postgresql://postgres.[project-ref]:[password]@aws-0-[region].pooler.supabase.com:6543/postgres"

# Full backup
pg_dump "$DATABASE_URL" --format=custom --no-owner --no-privileges -f backup_$(date +%Y%m%d_%H%M%S).dump

# Schema only
pg_dump "$DATABASE_URL" --schema-only --no-owner -f schema_$(date +%Y%m%d).sql

# Data only (specific tables)
pg_dump "$DATABASE_URL" --data-only --table=businesses --table=bookings --table=payments -f critical_data_$(date +%Y%m%d).dump
```

## Automated Backup Cron

Add to `vercel.json` if you want a daily export to Supabase Storage:

```json
{
  "path": "/api/cron/backup",
  "schedule": "0 2 * * *"
}
```

## Recovery Procedures

### Scenario 1: Restore from Supabase Backup
1. Go to Supabase Dashboard → Settings → Database → Backups
2. Select the backup to restore
3. Click "Restore" — this replaces the current database

### Scenario 2: Restore from pg_dump
```bash
# Restore full backup
pg_restore --dbname="$DATABASE_URL" --no-owner --no-privileges --clean backup_20260422.dump

# Restore specific tables
pg_restore --dbname="$DATABASE_URL" --no-owner --table=payments backup_20260422.dump
```

### Scenario 3: Restore specific data (accidental deletion)
```bash
# 1. Restore backup to a temporary database
pg_restore --dbname="postgresql://...temp_db" backup_20260422.dump

# 2. Copy specific rows from temp to production
psql "$DATABASE_URL" -c "INSERT INTO payments SELECT * FROM dblink('...temp_db', 'SELECT * FROM payments WHERE id = ...') AS t(...);"
```

### Scenario 4: Rollback a bad migration
```bash
# Check migration history
supabase db migrations list

# Migrations are sequential — to undo, create a new migration that reverses the changes
supabase db diff -f rollback_077

# Or restore from backup if the migration was destructive
```

## Critical Tables (backup priority)

| Table | Priority | Why |
|-------|----------|-----|
| `businesses` | Critical | Core business data |
| `payments` | Critical | Financial records |
| `bookings` | Critical | Customer appointments |
| `subscriptions` | Critical | Revenue data |
| `profiles` | Critical | User accounts |
| `platform_fees` | High | Revenue tracking |
| `business_payouts` | High | Payout records |
| `invoices` | High | Invoice records |
| `bot_sessions` | Medium | Active conversations (ephemeral) |
| `alerts` | Low | Operational alerts |
| `llm_classifications` | Low | Analytics data |

## Monitoring

- **Supabase Dashboard:** Check database size, connection count, and backup status
- **Sentry:** Monitors for database errors in API routes
- **Alerts table:** Payment failures are logged and visible in admin dashboard
