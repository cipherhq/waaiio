# Migration Verification — Batch 01

**Main SHA:** 761fdf8895079488ead7f8e4d5e359e4262a89ae
**Date:** 2026-07-28 11:58:03 UTC
**Versions:** 102, 103, 104, 106, 108, 109, 110, 111, 112, 113, 114, 116, 117, 118, 120
**Total object checks:** 94
**Passed:** 93
**Failed:** 1 (1 superseded by migration 144)

## Classifications

| Version | Filename | Objects | Passed | Failed | Classification |
|---|---|---|---|---|---|
| 102 | 102_service_availability.sql | 6 | 6 | 0 | VERIFIED_APPLIED_UNTRACKED |
| 103 | 103_service_features.sql | 18 | 17 | 1 | VERIFIED_APPLIED_UNTRACKED |
| 104 | 104_event_services_category.sql | 1 | 1 | 0 | VERIFIED_APPLIED_UNTRACKED |
| 106 | 106_new_subcategories.sql | 18 | 18 | 0 | VERIFIED_APPLIED_UNTRACKED |
| 108 | 108_refund_requests.sql | 6 | 6 | 0 | VERIFIED_APPLIED_UNTRACKED |
| 109 | 109_campaign_donations.sql | 7 | 7 | 0 | VERIFIED_APPLIED_UNTRACKED |
| 110 | 110_queue_realtime.sql | 1 | 1 | 0 | VERIFIED_APPLIED_UNTRACKED |
| 111 | 111_feedback_improvements.sql | 4 | 4 | 0 | VERIFIED_APPLIED_UNTRACKED |
| 112 | 112_campaign_donation_limits.sql | 2 | 2 | 0 | VERIFIED_APPLIED_UNTRACKED |
| 113 | 113_add_missing_capability_enum_values.sql | 3 | 3 | 0 | VERIFIED_APPLIED_UNTRACKED |
| 114 | 114_event_ticket_types.sql | 9 | 9 | 0 | VERIFIED_APPLIED_UNTRACKED |
| 116 | 116_document_share_improvements.sql | 5 | 5 | 0 | VERIFIED_APPLIED_UNTRACKED |
| 117 | 117_appointments_table.sql | 11 | 11 | 0 | VERIFIED_APPLIED_UNTRACKED |
| 118 | 118_event_self_checkin.sql | 1 | 1 | 0 | VERIFIED_APPLIED_UNTRACKED |
| 120 | 120_auto_approve.sql | 2 | 2 | 0 | VERIFIED_APPLIED_UNTRACKED |

## Summary

| Classification | Count |
|---|---|
| VERIFIED_APPLIED_UNTRACKED | 15 |

## Failed/Ambiguous Objects

| Version | Type | Name | Note |
|---|---|---|---|
| 103 | policy | service_addons_select | service_addons_select superseded by service_addons_owner_read (mig 144) |

## Confirmation

- No production writes occurred
- No migration repair executed
- No customer or transaction records accessed
- Approved repair allowlist remains empty