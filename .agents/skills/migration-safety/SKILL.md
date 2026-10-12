---
name: migration-safety
description: "Safe database migration practice. Run before applying any migration to staging or production, and before recording one as applied."
---

# Migration Safety

> MANDATORY before applying or recording any migration.

1. Never record a migration as applied unless its FULL content ran. A truncated pre-check or partial run must never be logged under the migration's name.
2. If a tool size limit prevents the full file from running, stop and apply it directly (for example the Supabase SQL Editor). Do not log a partial run.
3. Any migration that touches permissions, GRANT/REVOKE, or RLS gets an explicit before-and-after check that service_role retains needed access and authenticated does not gain unintended access.
4. Apply to staging first, verify, then production. Track which migrations are staging-only and never apply them to production.
5. After applying, verify the change is really present (function length, marker count, table or policy exists), not just "no error returned".

Output: migration, full content run?, permission/RLS impact, verified present?, staging-only?
