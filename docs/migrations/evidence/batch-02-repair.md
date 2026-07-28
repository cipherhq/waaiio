# Batch 2 Migration-History Repair Evidence

## Summary
- **Task:** Batch 2 migration-history repair (metadata only)
- **Repository SHA:** 7bd276ed6f10927827ffffdd8ee39ed294207dae
- **Linked Project:** cxcmiqotkowhxinjbytg
- **Timestamp (UTC):** 2026-07-28T17:49:35.034574+00:00
- **Status:** BATCH_02_REPAIR_COMPLETE

## Approved Versions (15)
121, 123, 124, 125, 127, 128, 129, 131, 132, 133, 134, 135, 136, 137, 138

## Pre-Repair Baseline
- Total remote migration count: **118**
- Versions 101-246 tracked: **23**
- All 15 Batch 2 versions: **absent**
- All 15 Batch 1 versions: **present**

## Repair Results (all exit status 0)

| Version | File | Post-Total | Post-Range | Delta |
|---------|------|------------|------------|-------|
| 121 | 121_property_blocked_dates.sql | 119 | 24 | +1 |
| 123 | 123_add_assigned_channel_id.sql | 120 | 25 | +1 |
| 124 | 124_auto_reply.sql | 121 | 26 | +1 |
| 125 | 125_membership_tiers.sql | 122 | 27 | +1 |
| 127 | 127_notification_preferences.sql | 123 | 28 | +1 |
| 128 | 128_platform_fee_refund.sql | 124 | 29 | +1 |
| 129 | 129_payout_adjustments.sql | 125 | 30 | +1 |
| 131 | 131_standalone_invites.sql | 126 | 31 | +1 |
| 132 | 132_reservation_checkin_flow.sql | 127 | 32 | +1 |
| 133 | 133_storage_bucket_security.sql | 128 | 33 | +1 |
| 134 | 134_add_new_capability_enum_values.sql | 129 | 34 | +1 |
| 135 | 135_drop_permissive_storage_policy.sql | 130 | 35 | +1 |
| 136 | 136_fix_session_race_and_booking_race.sql | 131 | 36 | +1 |
| 137 | 137_atomic_booking_slot.sql | 132 | 37 | +1 |
| 138 | 138_dashboard_aggregate_rpcs.sql | 133 | 38 | +1 |

## Post-Repair State
- Total remote migration count: **133** (118 + 15)
- Versions 101-246 tracked: **38** (23 + 15)
- New versions: 121, 123, 124, 125, 127, 128, 129, 131, 132, 133, 134, 135, 136, 137, 138
- Batch 1 versions intact: **Yes**
- Pre-existing versions intact: **Yes**
- All approved versions appear exactly once: **Yes**
- Lost versions: **None**

## Confirmations
- No migration SQL executed
- No schema or application data modified
- No customer record contents accessed
- No deployment occurred
- No repository files modified
- No token or authorization header recorded in evidence
- No unrelated migration version changed
- Repository validator passed (post-repair)
- Governance validator passed (pre-repair)
- Batch 3 has not started
- Issue #53 remains open
