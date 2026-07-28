# Batch 3 Migration Read-Only Production Verification Evidence

## Summary
- **Task:** Batch 3 read-only production verification
- **Repository SHA:** 2f194c4f09456c5843f4ea6268474ce865652737
- **Linked Project:** cxcmiqotkowhxinjbytg
- **Batch Number:** 3
- **Timestamp (UTC):** 2026-07-28T19:47:09.267772+00:00
- **Status:** BATCH_03_READ_ONLY_VERIFICATION_COMPLETE

## Versions Verified (15)
139, 140, 141, 142, 143, 144, 145, 146, 147, 148, 149, 150, 151, 152, 153

## Migration-History Baseline
- Total remote count: **133**
- 101–246 tracked: **38**
- All Batch 3 versions absent: **Yes**
- All Batch 1+2 repaired versions intact: **Yes**

## Object Verification Results
- Total expected objects: **91**
- Passed: **88**
- Failed: **0**
- Superseded: **3**
- Ambiguous: **0**

## Migration Classifications

| Version | Filename | Classification | Objects | Passed | Superseded |
|---------|----------|----------------|---------|--------|------------|
| 139 | 139_fix_atomic_booking_type_cast.sql | VERIFIED_APPLIED_UNTRACKED | 1 | 1 | 0 |
| 140 | 140_fix_atomic_booking_for_update.sql | VERIFIED_APPLIED_UNTRACKED | 1 | 1 | 0 |
| 141 | 141_fix_atomic_booking_enum_casts.sql | VERIFIED_APPLIED_UNTRACKED | 1 | 1 | 0 |
| 142 | 142_checkin_checkout_noshow.sql | VERIFIED_APPLIED_UNTRACKED | 9 | 9 | 0 |
| 143 | 143_add_paypal_gateway.sql | VERIFIED_APPLIED_UNTRACKED | 1 | 1 | 0 |
| 144 | 144_rls_fix_permissive_policies.sql | VERIFIED_APPLIED_UNTRACKED | 6 | 6 | 0 |
| 145 | 145_saved_card_pin.sql | VERIFIED_APPLIED_UNTRACKED | 3 | 3 | 0 |
| 146 | 146_service_buffer_time.sql | VERIFIED_APPLIED_UNTRACKED | 1 | 1 | 0 |
| 147 | 147_auto_last_active_on_deactivate.sql | VERIFIED_APPLIED_UNTRACKED | 3 | 2 | 1 |
| 148 | 148_add_missing_fk_indexes.sql | VERIFIED_APPLIED_UNTRACKED | 40 | 40 | 0 |
| 149 | 149_public_event_booking_slugs.sql | VERIFIED_APPLIED_UNTRACKED | 11 | 9 | 2 |
| 150 | 150_group_bookings_waitlist_conversion.sql | VERIFIED_APPLIED_UNTRACKED | 4 | 4 | 0 |
| 151 | 151_llm_classifications_owner_rls.sql | VERIFIED_APPLIED_UNTRACKED | 1 | 1 | 0 |
| 152 | 152_catalog_sync.sql | VERIFIED_APPLIED_UNTRACKED | 8 | 8 | 0 |
| 153 | 153_payment_confirmation_dedup.sql | VERIFIED_APPLIED_UNTRACKED | 1 | 1 | 0 |

## Superseded Objects (3)

1. **Migration 147** — trigger `trg_bot_session_deactivate ON bot_sessions` (expected: dropped)
   - Verified state: superseded_with_equivalent_state
   - Superseding migration: 147_auto_last_active_on_deactivate.sql (same migration)
   - Rationale: DROP IF EXISTS + CREATE pattern replaces the trigger definition. The DROP is superseded by the CREATE in the same migration.
   - Impact: None — trigger exists with intended function.

2. **Migration 149** — policy `public_read_active_businesses ON businesses` (expected: exists)
   - Verified state: superseded_with_stricter_state
   - Replacement: `public.businesses_public` (security-barrier view)
   - Superseding migration: 293_fix_production_table_exposure.sql
   - Rationale: Migration 293 dropped the permissive public_read_active_businesses policy, revoked direct anonymous access to public.businesses, and created the security-barrier view public.businesses_public containing only approved public fields.
   - Impact: Anonymous public-business reads continue through public.businesses_public. Direct anonymous access to sensitive columns on public.businesses is removed. Authenticated and service-role base-table access remains explicitly granted.

3. **Migration 149** — trigger `trg_generate_event_slug ON events` (expected: dropped)
   - Verified state: superseded_with_equivalent_state
   - Superseding migration: 149_public_event_booking_slugs.sql (same migration)
   - Rationale: DROP IF EXISTS + CREATE pattern replaces the trigger. The DROP is superseded by the re-creation in the same migration.
   - Impact: None — trigger exists with intended function.

## Metadata Query Categories Used
- information_schema (tables, columns)
- pg_catalog (pg_proc, pg_indexes, pg_constraint, pg_policies, pg_trigger, pg_class)

## Confirmations
- All queries were read-only
- No migration-history repair occurred
- No schema or application data changed
- No customer record contents accessed
- No deployment occurred
- No token or authorization header recorded
- Batch 4 has not started
- Repair allowlist remains empty
