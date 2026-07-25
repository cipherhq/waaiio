# Migration Registry

## Naming Convention

Waaiio uses **sequential numeric prefixes**: `NNN_description.sql`

Examples: `247_admin_role_escalation_fix.sql`, `248_otp_delivery_tracking.sql`

### Why Not Timestamps?

Supabase CLI generates timestamp-based filenames by default (e.g., `20260725123456_name.sql`). However, the existing 248 migrations use sequential `NNN_` prefixes. Timestamp-based names sort incorrectly against sequential names in ASCII order (`20260725...` < `248_...`), which would break CI migration application order.

**Decision:** Continue sequential naming. Use an explicit reservation process to prevent collisions.

## Current State

| Version | Name | Status | PR |
|---------|------|--------|-----|
| 248 | `otp_delivery_tracking` | Applied to production | #38 |
| 247 | `admin_role_escalation_fix` | Applied to production | #36 |
| 246 | `phone_otp_challenges` | Applied to production | #35 |
| 245 | `fix_book_slot_atomic_overloads` | Applied to production | — |
| 244 | `payment_source_classification` | Applied to production | — |

**Next available version:** 249

## Reservation Process

Before creating a migration:

1. **Check current main:** `git fetch origin main && ls supabase/migrations/ | tail -5`
2. **Check open PRs:** Search for migrations in open PRs that may claim the next version
3. **Check this registry:** Verify no reservation exists for the version you plan to use
4. **Reserve:** Add your reservation to this section before pushing

### Active Reservations

None.

### Reservation Format

```
| Version | Description | Branch | Reserved By | Date |
|---------|-------------|--------|-------------|------|
| 249 | example_migration | fix/example | claude | 2026-07-25 |
```

## Rules

1. **Never reuse a version** from a previously applied migration
2. **Never reuse a version** from an unmerged PR's migration (treat as reserved until the PR is closed)
3. **Never modify** a migration that has been applied to production
4. **One migration concern per PR** — do not bundle unrelated schema changes
5. **Record production application** — after applying a migration, update `engineering-status.json`

## Stranded Migrations

PR #21 (`fix/combined-18-19-20`) contains migrations 244-291. These versions conflict with main's 244-248. If any of this work is extracted, migrations must be renumbered starting from the next available version at extraction time.

**Do not apply stranded migrations without renumbering and independent review.**

## Rollback Policy

- Migrations are forward-only in production
- If a migration causes issues, create a new forward-fix migration
- Never `DROP` or `ALTER` a production migration file retroactively
- Document rollback procedures in the PR description before applying
