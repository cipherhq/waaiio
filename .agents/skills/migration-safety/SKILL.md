---
name: migration-safety
description: "Safe database migration practice. Run before applying any migration to staging or production, and before recording one as applied."
---

# Migration Safety

> MANDATORY before applying or recording any migration.

1. Never record a migration as applied unless its FULL content ran. A truncated pre-check or partial run must never be logged under the migration's name.
2. If a migration cannot be executed fully through the approved method (for example a tool size limit), STOP. Obtain Owner authorization before using any other execution mechanism. A tool limitation or permission error is never permission to switch methods. Preserve migration ordering, transaction semantics where supported, migration-history integrity, and rollback evidence. Never mark a migration applied solely because SQL was submitted: verify successful completion and reconcile migration history.
3. Before any production migration, confirm backups / point-in-time recovery are enabled and a restore path has been verified.
4. Any migration that touches permissions, GRANT/REVOKE, or RLS gets an explicit before-and-after check that service_role retains needed access and authenticated does not gain unintended access.
5. Apply to staging first, verify, then production. Track which migrations are staging-only and never apply them to production.
6. After applying, verify the change is really present (function length, marker count, table or policy exists), not just "no error returned".

Output: migration, full content run?, permission/RLS impact, verified present?, staging-only?
