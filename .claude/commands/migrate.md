# Run Supabase Migration

Run a migration SQL file on the remote Supabase database.

## Usage
`/migrate <migration_file>`

Example: `/migrate 124_auto_reply.sql`

## Instructions

1. Find the migration file in `supabase/migrations/`. If the argument is just a number like `124`, find the file matching `124_*.sql`.
2. Read the SQL file to verify it looks correct.
3. Run it on the remote database using the Supabase Management API:

```bash
SQL=$(cat supabase/migrations/<filename>.sql)
curl -s -X POST "https://api.supabase.com/v1/projects/cxcmiqotkowhxinjbytg/database/query" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg q "$SQL" '{query: $q}')"
```

If `SUPABASE_ACCESS_TOKEN` is not set, check for it in `.env.local` or ask the user to provide it.

4. Verify the migration applied by running a quick check query (e.g., checking if a new table or column exists).
5. Report the result to the user.

If the migration fails, show the error and suggest fixes.
