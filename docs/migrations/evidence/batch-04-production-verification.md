# Batch 4 Migration Read-Only Production Verification Evidence

## Summary
- **Task:** Batch 4 read-only production verification
- **Repository SHA:** 87c8d87ce1034bd5c054b9dc9e4663150fd716f8
- **Linked Project:** cxcmiqotkowhxinjbytg
- **Batch Number:** 4
- **Timestamp (UTC):** 2026-07-29T00:47:15.959504+00:00
- **Status:** BATCH_04_READ_ONLY_VERIFICATION_COMPLETE

## Versions Verified (15)
154, 155, 156, 157, 158, 159, 161, 162, 165, 166, 167, 168, 169, 170, 171

## Migration-History Baseline
- Total remote count: **148**
- 101-246 tracked: **53**
- All 15 Batch 4 versions absent: **Yes**
- All prior repaired versions intact: **Yes**

## Object Verification Results
- Total expected objects: **55**
- Passed: **53**
- Failed: **0**
- Superseded: **2**
- Ambiguous: **0**

## Migration Classifications

| Version | Filename | Classification | Objects | Passed | Superseded |
|---------|----------|----------------|---------|--------|------------|
| 154 | 154_service_packages.sql | VERIFIED_APPLIED_UNTRACKED | 12 | 12 | 0 |
| 155 | 155_class_booking_multi_location.sql | VERIFIED_APPLIED_UNTRACKED | 3 | 2 | 1 |
| 156 | 156_atomic_form_response_count.sql | VERIFIED_APPLIED_UNTRACKED | 1 | 1 | 0 |
| 157 | 157_atomic_loyalty_points_redemption.sql | VERIFIED_APPLIED_UNTRACKED | 1 | 1 | 0 |
| 158 | 158_platform_fee_dedup_and_campaign_atomic.sql | VERIFIED_APPLIED_UNTRACKED | 4 | 4 | 0 |
| 159 | 159_payout_dedup_constraint.sql | VERIFIED_APPLIED_UNTRACKED | 1 | 1 | 0 |
| 161 | 161_admin_roles_finance_operations.sql | VERIFIED_APPLIED_UNTRACKED | 3 | 3 | 0 |
| 162 | 162_pre_booking_questions_and_followup.sql | VERIFIED_APPLIED_UNTRACKED | 3 | 3 | 0 |
| 165 | 165_auto_customer_profile.sql | VERIFIED_APPLIED_UNTRACKED | 2 | 2 | 0 |
| 166 | 166_fix_appointment_booking.sql | VERIFIED_APPLIED_UNTRACKED | 2 | 1 | 1 |
| 167 | 167_order_payment_fixes.sql | VERIFIED_APPLIED_UNTRACKED | 2 | 2 | 0 |
| 168 | 168_multi_agent_chat.sql | VERIFIED_APPLIED_UNTRACKED | 6 | 6 | 0 |
| 169 | 169_scheduled_broadcasts.sql | VERIFIED_APPLIED_UNTRACKED | 6 | 6 | 0 |
| 170 | 170_subscription_expired_status.sql | VERIFIED_APPLIED_UNTRACKED | 1 | 1 | 0 |
| 171 | 171_subscription_payments.sql | VERIFIED_APPLIED_UNTRACKED | 8 | 8 | 0 |

## Superseded Objects (2)

1. **Migration 155** — function `book_slot_atomic` (expected: exists)
   - Verified state: superseded_with_equivalent_state
   - Superseding migration: 176_buffer_time_atomic.sql
   - Rationale: Migration 176 replaced book_slot_atomic with CREATE OR REPLACE, preserving all parameters added by earlier migrations including p_location_id (from 155) and p_appointment_id (from 166), while adding p_buffer_minutes and p_duration. The current production function contains all parameters from the earlier version.
   - Impact: None — all parameters and logic from migration 155 are preserved.

2. **Migration 166** — function `book_slot_atomic` (expected: exists)
   - Verified state: superseded_with_equivalent_state
   - Superseding migration: 176_buffer_time_atomic.sql
   - Rationale: Migration 176 replaced book_slot_atomic with CREATE OR REPLACE, preserving all parameters added by earlier migrations including p_location_id (from 155) and p_appointment_id (from 166), while adding p_buffer_minutes and p_duration. The current production function contains all parameters from the earlier version.
   - Impact: None — all parameters and logic from migration 166 are preserved.

## Migration-History Post-Verification
- Total remote count: **148** (unchanged)
- 101-246 tracked: **53** (unchanged)
- All Batch 4 versions still absent: **Yes**

## Metadata Query Categories Used
- information_schema (tables, columns with nullability)
- pg_catalog (pg_proc with identity arguments, pg_indexes, pg_constraint, pg_policies, pg_trigger, pg_class, pg_enum + pg_type)

## Confirmations
- All queries were read-only
- No migration-history repair occurred
- No migration SQL executed
- No `supabase db push` executed
- No schema or application data changed
- No customer record contents accessed
- No deployment occurred
- No token or authorization header recorded
- Batch 5 has not started
- Repair allowlist remains empty (populated only after evidence PR merge)

## Next Step
Independent review and merge of the Batch 4 verification-evidence PR, followed by separately approved migration-history repair.
