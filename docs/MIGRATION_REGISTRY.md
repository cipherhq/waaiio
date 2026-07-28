# Migration Registry

## Naming Convention

Waaiio uses **sequential numeric prefixes**: `NNN_description.sql`

Examples: `247_admin_role_escalation_fix.sql`, `248_otp_delivery_tracking.sql`

### Why Not Timestamps?

Supabase CLI generates timestamp-based filenames by default (e.g., `20260725123456_name.sql`). However, the existing 248 migrations use sequential `NNN_` prefixes. Timestamp-based names sort incorrectly against sequential names in ASCII order (`20260725...` < `248_...`), which would break CI migration application order.

**Decision:** Continue sequential naming. Use an explicit reservation process to prevent collisions.

## Current State

| Version | Name | Status | PR | Notes |
|---------|------|--------|----|-------|
| 297 | `complete_migration_115_trigger` | Applied to production (verified) | #63 | Forward fix: creates missing properties_updated_at trigger on public.properties, completing Migration 115's schema intent. Uses existing update_updated_at() function. Idempotent. No data backfill required. Production-verified 2026-07-28. |
| 296 | `restrict_sensitive_rpc_execution` | Applied to production (verified) | #62 | Forward fix: revokes pre-existing direct anon/authenticated EXECUTE grants on 7 SECURITY DEFINER RPCs (book_slot_atomic, restore_stock, restore_variant_stock, restore_tickets_sold, redeem_loyalty_points, increment_campaign_donation, upsert_customer_profile). All confirmed service-role-only via application caller audit. |
| 295 | `restrict_recurring_charge_rpc_execute` | Applied to production (verified) | #61 | Forward fix: revokes pre-existing direct anon/authenticated EXECUTE grants on process_recurring_charge that survived Migration 244's REVOKE FROM PUBLIC |
| 294 | `complete_migration_119_index` | Applied to production (verified) | #56 | Completes missing idx_form_responses_business from Migration 119 |
| 293 | `fix_production_table_exposure` | Applied to production (verified) | #54 | Security remediation — production-verified per PR #55 |
| 292 | `atomic_payout_claim` | Applied to production | #50 | |
| 248 | `otp_delivery_tracking` | Applied to production | #38 | |
| 247 | `admin_role_escalation_fix` | Applied to production | #36 | |
| 246 | `phone_otp_challenges` | Applied to production | #35 | |
| 245 | `fix_book_slot_atomic_overloads` | Applied to production | — | |
| 244 | `payment_source_classification` | Applied to production (verified) | — | Production-verified 2026-07-27. payment_source column, process_recurring_charge RPC update, backfill. Permission gap fixed by Migration 295. |
| 200 | `partner_events_api` | Applied to production (verified) | — | Production-verified 2026-07-27. api_key_id nullable UUID with FK to api_keys(id) ON DELETE SET NULL; partial B-tree index exists; event count remained 14; existing events remain NULL. |
| 199 | `campaign_donation_toggles` | Applied to production (verified) | #58 | Adds allow_after_end_date and allow_after_goal_met BOOLEAN columns to campaigns. Production-verified 2026-07-27. |
| 182 | `recurring_bookings` | Individually verified and recorded | — | Recurring bookings schema verified present in production. Individually recorded 2026-07-28. |
| 181 | `recurring_charge_rpc` | Individually verified and recorded | — | process_recurring_charge RPC verified present in production. Individually recorded 2026-07-28. |
| 176 | `api_keys` | Individually verified and recorded | — | API keys table verified present in production. Individually recorded 2026-07-28. |
| 119 | `forms` | Applied (completed by Migration 294) | #56 | All statements satisfied: tables, policies, indexes exist. Final missing index supplied by Migration 294. Individually recorded as applied. |
| 115 | `properties` | Fully satisfied and individually recorded | #63 | All 12 durable schema effects present. Missing trigger supplied by Migration 297 (production-verified 2026-07-28). |

**Next available version:** 298

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
- Document forward-recovery procedures in the PR description before applying
- **Never restore a rollback that recreates a policy confirmed to expose credentials or sensitive data**
- For security migrations: rollback plan must retain restrictive DB changes; only application code may be rolled back

## Bulk Repair Prohibition

Per Issue #53 preflight findings:
- Migrations 101–246 must **NOT** be bulk-repaired via `supabase migration repair`
- Migration 115 fully satisfied and individually recorded (completed by Migration 297, PR #63)
- Migration 119 fully satisfied and individually recorded (completed by Migration 294)
- Migration 199 is production-verified (PR #58)
- Migration 200 is production-verified (2026-07-27)
- Migration 244 is production-verified (2026-07-27)
- Migrations 176, 181, 182 individually verified and recorded (2026-07-28)
- Any repair must follow the controlled repair runbook (`docs/migrations/101-246-repair-runbook.md`)

## Remaining Untracked Migrations (101-246)

Of the 146 migrations in the 101-246 range:
- **8 aligned/tracked:** 115, 119, 176, 181, 182, 199, 200, 244
- **15 verified and approved for repair (Batch 1, not yet repaired):** 102, 103, 104, 106, 108, 109, 110, 111, 112, 113, 114, 116, 117, 118, 120
- **109 remaining candidates pending verification:** Batches 2-9 per verification candidates (`docs/migrations/101-246-verification-candidates.json`)
- **12 not verifiable safely:** 101, 105, 107, 126, 160, 163, 164, 187, 216, 217, 222, 226
- **2 superseded:** 122 (by 233), 130 (by 233)
