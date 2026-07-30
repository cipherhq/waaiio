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
| 298 | `complete_order_payment_backfill` | Applied to production and forensically verified | #73 | Applied through Supabase Management API SQL (not CLI `migration up --linked`). Recorded through `migration repair --status applied 298`. Dry run had shown 79 migrations; approved procedure required stopping; procedure deviation occurred. Resulting production state verified correct. Exactly 11 order_id values populated. business_id was not populated or inferred. Pending rows now zero. Populated consistent count now 39. Canonical evidence: corrected forensic JSON. Original execution evidence preserved as superseded. Migration 298 must not be rerun. |
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
| 120 | `auto_approve` | Batch 1 repaired (tracked) | — | Remote history repair completed 2026-07-28. No SQL executed. |
| 119 | `forms` | Applied (completed by Migration 294) | #56 | All statements satisfied: tables, policies, indexes exist. Final missing index supplied by Migration 294. Individually recorded as applied. |
| 118 | `event_self_checkin` | Batch 1 repaired (tracked) | — | Remote history repair completed 2026-07-28. No SQL executed. |
| 117 | `appointments_table` | Batch 1 repaired (tracked) | — | Remote history repair completed 2026-07-28. No SQL executed. |
| 116 | `document_share_improvements` | Batch 1 repaired (tracked) | — | Remote history repair completed 2026-07-28. No SQL executed. |
| 115 | `properties` | Fully satisfied and individually recorded | #63 | All 12 durable schema effects present. Missing trigger supplied by Migration 297 (production-verified 2026-07-28). |
| 114 | `event_ticket_types` | Batch 1 repaired (tracked) | — | Remote history repair completed 2026-07-28. No SQL executed. |
| 113 | `add_missing_capability_enum_values` | Batch 1 repaired (tracked) | — | Remote history repair completed 2026-07-28. No SQL executed. |
| 112 | `campaign_donation_limits` | Batch 1 repaired (tracked) | — | Remote history repair completed 2026-07-28. No SQL executed. |
| 111 | `feedback_improvements` | Batch 1 repaired (tracked) | — | Remote history repair completed 2026-07-28. No SQL executed. |
| 110 | `queue_realtime` | Batch 1 repaired (tracked) | — | Remote history repair completed 2026-07-28. No SQL executed. |
| 109 | `campaign_donations` | Batch 1 repaired (tracked) | — | Remote history repair completed 2026-07-28. No SQL executed. |
| 108 | `refund_requests` | Batch 1 repaired (tracked) | — | Remote history repair completed 2026-07-28. No SQL executed. |
| 106 | `new_subcategories` | Batch 1 repaired (tracked) | — | Remote history repair completed 2026-07-28. No SQL executed. |
| 104 | `event_services_category` | Batch 1 repaired (tracked) | — | Remote history repair completed 2026-07-28. No SQL executed. |
| 103 | `service_features` | Batch 1 repaired (tracked) | — | Remote history repair completed 2026-07-28. No SQL executed. |
| 138 | `dashboard_aggregate_rpcs` | Batch 2 repaired (tracked) | — | Remote history repair completed 2026-07-28. No SQL executed. |
| 137 | `atomic_booking_slot` | Batch 2 repaired (tracked) | — | Remote history repair completed 2026-07-28. No SQL executed. |
| 136 | `fix_session_race_and_booking_race` | Batch 2 repaired (tracked) | — | Remote history repair completed 2026-07-28. No SQL executed. |
| 135 | `drop_permissive_storage_policy` | Batch 2 repaired (tracked) | — | Remote history repair completed 2026-07-28. No SQL executed. |
| 134 | `add_new_capability_enum_values` | Batch 2 repaired (tracked) | — | Remote history repair completed 2026-07-28. No SQL executed. |
| 133 | `storage_bucket_security` | Batch 2 repaired (tracked) | — | Remote history repair completed 2026-07-28. No SQL executed. |
| 132 | `reservation_checkin_flow` | Batch 2 repaired (tracked) | — | Remote history repair completed 2026-07-28. No SQL executed. |
| 131 | `standalone_invites` | Batch 2 repaired (tracked) | — | Remote history repair completed 2026-07-28. No SQL executed. |
| 129 | `payout_adjustments` | Batch 2 repaired (tracked) | — | Remote history repair completed 2026-07-28. No SQL executed. |
| 128 | `platform_fee_refund` | Batch 2 repaired (tracked) | — | Remote history repair completed 2026-07-28. No SQL executed. |
| 127 | `notification_preferences` | Batch 2 repaired (tracked) | — | Remote history repair completed 2026-07-28. No SQL executed. |
| 125 | `membership_tiers` | Batch 2 repaired (tracked) | — | Remote history repair completed 2026-07-28. No SQL executed. |
| 124 | `auto_reply` | Batch 2 repaired (tracked) | — | Remote history repair completed 2026-07-28. No SQL executed. |
| 123 | `add_assigned_channel_id` | Batch 2 repaired (tracked) | — | Remote history repair completed 2026-07-28. No SQL executed. |
| 121 | `property_blocked_dates` | Batch 2 repaired (tracked) | — | Remote history repair completed 2026-07-28. No SQL executed. |
| 153 | `payment_confirmation_dedup` | Batch 3 repaired (tracked) | — | Remote history repair completed 2026-07-28. No SQL executed. |
| 152 | `catalog_sync` | Batch 3 repaired (tracked) | — | Remote history repair completed 2026-07-28. No SQL executed. |
| 151 | `llm_classifications_owner_rls` | Batch 3 repaired (tracked) | — | Remote history repair completed 2026-07-28. No SQL executed. |
| 150 | `group_bookings_waitlist_conversion` | Batch 3 repaired (tracked) | — | Remote history repair completed 2026-07-28. No SQL executed. |
| 149 | `public_event_booking_slugs` | Batch 3 repaired (tracked) | — | Remote history repair completed 2026-07-28. No SQL executed. |
| 148 | `add_missing_fk_indexes` | Batch 3 repaired (tracked) | — | Remote history repair completed 2026-07-28. No SQL executed. |
| 147 | `auto_last_active_on_deactivate` | Batch 3 repaired (tracked) | — | Remote history repair completed 2026-07-28. No SQL executed. |
| 146 | `service_buffer_time` | Batch 3 repaired (tracked) | — | Remote history repair completed 2026-07-28. No SQL executed. |
| 145 | `saved_card_pin` | Batch 3 repaired (tracked) | — | Remote history repair completed 2026-07-28. No SQL executed. |
| 144 | `rls_fix_permissive_policies` | Batch 3 repaired (tracked) | — | Remote history repair completed 2026-07-28. No SQL executed. |
| 143 | `add_paypal_gateway` | Batch 3 repaired (tracked) | — | Remote history repair completed 2026-07-28. No SQL executed. |
| 142 | `checkin_checkout_noshow` | Batch 3 repaired (tracked) | — | Remote history repair completed 2026-07-28. No SQL executed. |
| 141 | `fix_atomic_booking_enum_casts` | Batch 3 repaired (tracked) | — | Remote history repair completed 2026-07-28. No SQL executed. |
| 140 | `fix_atomic_booking_for_update` | Batch 3 repaired (tracked) | — | Remote history repair completed 2026-07-28. No SQL executed. |
| 139 | `fix_atomic_booking_type_cast` | Batch 3 repaired (tracked) | — | Remote history repair completed 2026-07-28. No SQL executed. |
| 171 | `subscription_payments` | Batch 4 repaired (tracked) | — | Remote history repair completed 2026-07-29. No SQL executed. |
| 170 | `subscription_expired_status` | Batch 4 repaired (tracked) | — | Remote history repair completed 2026-07-29. No SQL executed. |
| 169 | `scheduled_broadcasts` | Batch 4 repaired (tracked) | — | Remote history repair completed 2026-07-29. No SQL executed. |
| 168 | `multi_agent_chat` | Batch 4 repaired (tracked) | — | Remote history repair completed 2026-07-29. No SQL executed. |
| 167 | `order_payment_fixes` | Batch 4 repaired (tracked) | — | Remote history repair completed 2026-07-29. No SQL executed. |
| 166 | `fix_appointment_booking` | Batch 4 repaired (tracked) | — | Remote history repair completed 2026-07-29. No SQL executed. |
| 165 | `auto_customer_profile` | Batch 4 repaired (tracked) | — | Remote history repair completed 2026-07-29. No SQL executed. |
| 162 | `pre_booking_questions_and_followup` | Batch 4 repaired (tracked) | — | Remote history repair completed 2026-07-29. No SQL executed. |
| 161 | `admin_roles_finance_operations` | Batch 4 repaired (tracked) | — | Remote history repair completed 2026-07-29. No SQL executed. |
| 159 | `payout_dedup_constraint` | Batch 4 repaired (tracked) | — | Remote history repair completed 2026-07-29. No SQL executed. |
| 158 | `platform_fee_dedup_and_campaign_atomic` | Batch 4 repaired (tracked) | — | Remote history repair completed 2026-07-29. No SQL executed. |
| 157 | `atomic_loyalty_points_redemption` | Batch 4 repaired (tracked) | — | Remote history repair completed 2026-07-29. No SQL executed. |
| 156 | `atomic_form_response_count` | Batch 4 repaired (tracked) | — | Remote history repair completed 2026-07-29. No SQL executed. |
| 155 | `class_booking_multi_location` | Batch 4 repaired (tracked) | — | Remote history repair completed 2026-07-29. No SQL executed. |
| 154 | `service_packages` | Batch 4 repaired (tracked) | — | Remote history repair completed 2026-07-29. No SQL executed. |
| 190 | `gateway_fees_and_custom_overrides` | Batch 5 verified (repair pending) | — | Production verified 2026-07-29. 5/5 objects passed. Not yet remotely tracked. |
| 189 | `waiver_access_token` | Batch 5 verified (repair pending) | — | Production verified 2026-07-29. 3/3 objects passed. Not yet remotely tracked. |
| 188 | `waiver_template_pdf_url` | Batch 5 verified (repair pending) | — | Production verified 2026-07-29. 1/1 objects passed. Not yet remotely tracked. |
| 186 | `waivers` | Batch 5 verified (repair pending) | — | Production verified 2026-07-29. 12/12 objects passed. Not yet remotely tracked. |
| 185 | `add_dashboard_booking_channel` | Batch 5 verified (repair pending) | — | Production verified 2026-07-29. 1/1 objects passed. Not yet remotely tracked. |
| 184 | `campaign_soft_delete` | Batch 5 verified (repair pending) | — | Production verified 2026-07-29. 4/4 objects passed. Not yet remotely tracked. |
| 183 | `check_constraints_and_cascade_fixes` | Batch 5 verified (repair pending) | — | Production verified 2026-07-29. 6/6 objects passed. Not yet remotely tracked. |
| 180 | `api_keys_external_booking` | Batch 5 verified (repair pending) | — | Production verified 2026-07-29. 6/6 objects passed. Not yet remotely tracked. |
| 179 | `capability_custom_label` | Batch 5 verified (repair pending) | — | Production verified 2026-07-29. 1/1 objects passed. Not yet remotely tracked. |
| 178 | `capability_sort_order` | Batch 5 verified (repair pending) | — | Production verified 2026-07-29. 2/2 objects passed. Not yet remotely tracked. |
| 177 | `add_missing_capability_types` | Batch 5 verified (repair pending) | — | Production verified 2026-07-29. 5/5 objects passed. Not yet remotely tracked. |
| 175 | `public_property_read` | Batch 5 verified (repair pending) | — | Production verified 2026-07-29. 1/1 objects passed. Not yet remotely tracked. |
| 174 | `contract_references` | Batch 5 verified (repair pending) | — | Production verified 2026-07-29. 2/2 objects passed. Not yet remotely tracked. |
| 173 | `restore_stock_rpc` | Batch 5 verified (repair pending) | — | Production verified 2026-07-29. 3/3 objects passed. Not yet remotely tracked. |
| 172 | `recurring_billing` | Batch 5 verified (repair pending) | — | Production verified 2026-07-29. 3/3 objects passed. Not yet remotely tracked. |
| 102 | `service_availability` | Batch 1 repaired (tracked) | — | Remote history repair completed 2026-07-28. No SQL executed. |

**Batch 1 repair summary:** 15 versions (102-120) now tracked in remote schema_migrations.
**Batch 2 repair summary:** 15 versions (121-138) now tracked in remote schema_migrations. Remote count 118 -> 133 (+15). 101-246 tracked count 23 -> 38 (+15).
**Batch 3 repair summary:** 15 versions (139-153) now tracked in remote schema_migrations. Remote count 133 -> 148 (+15). 101-246 tracked count 38 -> 53 (+15).
**Batch 4 repair summary:** 15 versions (154-171) now tracked in remote schema_migrations. Remote count 148 -> 163 (+15). 101-246 tracked count 53 -> 68 (+15). 60 total completed migration-history repairs.

**Next available version:** 299

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
- **68 aligned/tracked:** Batches 1-4 repaired (60 versions) + 8 individually tracked (115, 119, 176, 181, 182, 199, 200, 244)
- **15 verified and pending repair:** Batch 5 (172, 173, 174, 175, 177, 178, 179, 180, 183, 184, 185, 186, 188, 189, 190) — 55/55 object checks passed, 383 compared leaf-property paths (52 exact match, 3 equivalent stricter), 0 failed, 0 ambiguous. Evidence: `docs/migrations/evidence/batch-05-production-verification.json` (V3 digest: `c2c0c052af94ccdb96b3e6e7d798c4c0ee4a0df4f10b4dfec43f2b86c22a5450`). No migration SQL executed. No schema or data change. Not yet remotely tracked. Batch 6 not started.
- **49 remaining candidates pending verification:** Batches 6-9 per verification candidates (`docs/migrations/101-246-verification-candidates.json`)
- **12 not verifiable safely:** 101, 105, 107, 126, 160, 163, 164, 187, 216, 217, 222, 226
- **2 superseded:** 122 (by 233), 130 (by 233)
