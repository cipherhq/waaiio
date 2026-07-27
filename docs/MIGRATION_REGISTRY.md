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
| 293 | `fix_production_table_exposure` | Pending | — |
| 292 | `atomic_payout_claim` | Applied to production | #50 |
| 248 | `otp_delivery_tracking` | Applied to production | #38 |
| 247 | `admin_role_escalation_fix` | Applied to production | #36 |
| 246 | `phone_otp_challenges` | Applied to production | #35 |
| 245 | `fix_book_slot_atomic_overloads` | Applied to production | — |
| 244 | `payment_source_classification` | Applied to production | — |

**Next available version:** 294

## Reservation Process

Before creating a migration:

1. **Check current main:** `git fetch origin main && ls supabase/migrations/ | tail -5`
2. **Check open PRs:** Search for migrations in open PRs that may claim the next version
3. **Check this registry:** Verify no reservation exists for the version you plan to use
4. **Reserve:** Add your reservation to this section before pushing

### Active Reservations

| Version | Description | Branch | Reserved by | Date |
|---------|-------------|--------|-------------|------|
| 292 | atomic_payout_execution | fix/fin-002-atomic-payout | claude | 2026-07-26 |

### Stranded Reservations (PR #21)

While PR #21 (`fix/combined-18-19-20`) remains open, versions 249-291 are reserved by that branch. These cannot be reused until PR #21 is closed or the migrations are explicitly released.

| Range | Status | Reason |
|-------|--------|--------|
| 244-248 | **Direct collision** with main | Main already applied these versions with different content |
| 249-291 | **Stranded / reserved** by open PR #21 | Branch occupies these versions; must not be reused while PR is open |

### Reservation Format

```
| Version | Description | Branch | Reserved By | Date |
|---------|-------------|--------|-------------|------|
| 292 | example_migration | fix/example | claude | 2026-07-25 |
```

## Rules

1. **Never reuse a version** from a previously applied migration
2. **Never reuse a version** from an open PR's migration (treat as reserved until the PR is closed)
3. **Never modify** a migration that has been applied to production
4. **One migration concern per PR** — do not bundle unrelated schema changes
5. **Record production application** — after applying a migration, update `engineering-status.json`

## Stranded Migrations

PR #21 (`fix/combined-18-19-20`) contains migrations across versions 244-291:

- **244-248:** Direct collision with main — main has different migrations at these versions. PR #21's versions for 244-248 are obsolete.
- **249-291:** New migrations that do not exist on main. These are stranded — the work may be valid but the versions are occupied by an open PR.

If any PR #21 migration work is extracted into a new PR, it must be renumbered starting from 292 (or whatever the next available version is at extraction time).

**Do not apply stranded migrations without renumbering and independent review.**

## Rollback Policy

- Migrations are forward-only in production
- If a migration causes issues, create a new forward-fix migration
- Never `DROP` or `ALTER` a production migration file retroactively
- Document rollback procedures in the PR description before applying
