# Check Database Schema

Query the remote Supabase database to inspect table structure.

## Usage
`/check-schema <table_name>`

Example: `/check-schema businesses`

## Instructions

1. Query the remote database for the table's columns:

```bash
curl -s -X POST "https://api.supabase.com/v1/projects/cxcmiqotkowhxinjbytg/database/query" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query": "SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name = '"'"'<table_name>'"'"' AND table_schema = '"'"'public'"'"' ORDER BY ordinal_position"}'
```

2. Also check for constraints:

```bash
curl -s -X POST "https://api.supabase.com/v1/projects/cxcmiqotkowhxinjbytg/database/query" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query": "SELECT con.conname, con.contype, pg_get_constraintdef(con.oid) FROM pg_constraint con JOIN pg_class rel ON rel.oid = con.conrelid WHERE rel.relname = '"'"'<table_name>'"'"'"}'
```

3. Check for indexes:

```bash
curl -s -X POST "https://api.supabase.com/v1/projects/cxcmiqotkowhxinjbytg/database/query" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query": "SELECT indexname, indexdef FROM pg_indexes WHERE tablename = '"'"'<table_name>'"'"'"}'
```

4. Format the results as a clean table showing:
   - Column name
   - Type
   - Nullable
   - Default
   - Constraints

If `SUPABASE_ACCESS_TOKEN` is not set, fall back to checking migration files in `supabase/migrations/` for the table definition.
