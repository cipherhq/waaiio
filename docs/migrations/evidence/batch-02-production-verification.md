# Migration Verification — Batch 02

**Main SHA:** bb4a4e98582205efa75c68db2ae70c97c5393e8d
**Linked project:** cxcmiqotkowhxinjbytg
**Date:** 2026-07-28T14:42:57.387751+00:00
**Versions:** 121, 123, 124, 125, 127, 128, 129, 131, 132, 133, 134, 135, 136, 137, 138
**Total object checks:** 63
**Passed:** 63
**Failed:** 0

## Classifications

| Version | Filename | Objects | Pass | Fail | Classification |
|---|---|---|---|---|---|
| 121 | 121_property_blocked_dates.sql | 5 | 5 | 0 | VERIFIED_APPLIED_UNTRACKED |
| 123 | 123_add_assigned_channel_id.sql | 4 | 4 | 0 | VERIFIED_APPLIED_UNTRACKED |
| 124 | 124_auto_reply.sql | 1 | 1 | 0 | VERIFIED_APPLIED_UNTRACKED |
| 125 | 125_membership_tiers.sql | 6 | 6 | 0 | VERIFIED_APPLIED_UNTRACKED |
| 127 | 127_notification_preferences.sql | 1 | 1 | 0 | VERIFIED_APPLIED_UNTRACKED |
| 128 | 128_platform_fee_refund.sql | 3 | 3 | 0 | VERIFIED_APPLIED_UNTRACKED |
| 129 | 129_payout_adjustments.sql | 7 | 7 | 0 | VERIFIED_APPLIED_UNTRACKED |
| 131 | 131_standalone_invites.sql | 8 | 8 | 0 | VERIFIED_APPLIED_UNTRACKED |
| 132 | 132_reservation_checkin_flow.sql | 5 | 5 | 0 | VERIFIED_APPLIED_UNTRACKED |
| 133 | 133_storage_bucket_security.sql | 7 | 7 | 0 | VERIFIED_APPLIED_UNTRACKED |
| 134 | 134_add_new_capability_enum_values.sql | 4 | 4 | 0 | VERIFIED_APPLIED_UNTRACKED |
| 135 | 135_drop_permissive_storage_policy.sql | 1 | 1 | 0 | VERIFIED_APPLIED_UNTRACKED |
| 136 | 136_fix_session_race_and_booking_race.sql | 2 | 2 | 0 | VERIFIED_APPLIED_UNTRACKED |
| 137 | 137_atomic_booking_slot.sql | 3 | 3 | 0 | VERIFIED_APPLIED_UNTRACKED |
| 138 | 138_dashboard_aggregate_rpcs.sql | 6 | 6 | 0 | VERIFIED_APPLIED_UNTRACKED |

## Summary

| Classification | Count |
|---|---|
| VERIFIED_APPLIED_UNTRACKED | 15 |

## Confirmations

- All production queries were read-only metadata catalog checks
- No migration-history repair occurred
- No schema or application data changed
- No customer-record contents accessed
- No deployment occurred
- No token value or authorization header recorded
- Batch 3 did not start