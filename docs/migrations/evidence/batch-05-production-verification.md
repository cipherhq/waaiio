# Batch 5 Production Verification Summary

## Verification Scope

- **Batch:** 5
- **Versions (15):** 172, 173, 174, 175, 177, 178, 179, 180, 183, 184, 185, 186, 188, 189, 190
- **Repository SHA:** `906878f94141e39ecc3fe19e4cf6ddc714a3811c`
- **Linked project ref:** `cxcmiqotkowhxinjbytg`
- **Verification timestamp:** 2026-07-29T20:29:01.725537+00:00

## Results

- **Total object checks:** 55
- **Passed:** 55
- **Superseded:** 0
- **Failed:** 0
- **Ambiguous:** 0
- **All 15 classifications:** VERIFIED_APPLIED_UNTRACKED

### Per-Migration Object Counts

| Version | Filename | Objects | Passed | Superseded | Failed | Ambiguous |
|---------|----------|---------|--------|------------|--------|-----------|
| 172 | 172_recurring_billing.sql | 3 | 3 | 0 | 0 | 0 |
| 173 | 173_restore_stock_rpc.sql | 3 | 3 | 0 | 0 | 0 |
| 174 | 174_contract_references.sql | 2 | 2 | 0 | 0 | 0 |
| 175 | 175_public_property_read.sql | 1 | 1 | 0 | 0 | 0 |
| 177 | 177_add_missing_capability_types.sql | 5 | 5 | 0 | 0 | 0 |
| 178 | 178_capability_sort_order.sql | 2 | 2 | 0 | 0 | 0 |
| 179 | 179_capability_custom_label.sql | 1 | 1 | 0 | 0 | 0 |
| 180 | 180_api_keys_external_booking.sql | 6 | 6 | 0 | 0 | 0 |
| 183 | 183_check_constraints_and_cascade_fixes.sql | 6 | 6 | 0 | 0 | 0 |
| 184 | 184_campaign_soft_delete.sql | 4 | 4 | 0 | 0 | 0 |
| 185 | 185_add_dashboard_booking_channel.sql | 1 | 1 | 0 | 0 | 0 |
| 186 | 186_waivers.sql | 12 | 12 | 0 | 0 | 0 |
| 188 | 188_waiver_template_pdf_url.sql | 1 | 1 | 0 | 0 | 0 |
| 189 | 189_waiver_access_token.sql | 3 | 3 | 0 | 0 | 0 |
| 190 | 190_gateway_fees_and_custom_overrides.sql | 5 | 5 | 0 | 0 | 0 |

## Migration History State

- **Total remote migration count:** 164 (unchanged pre/post)
- **101-246 tracked count:** 68 (unchanged pre/post)
- **Migration 298 occurrences:** 1 (pre and post)
- **All Batch 5 version occurrences:** 0 (pre and post — remain untracked pending repair)
- **Pre/post tracked snapshots:** identical
- **Migration history unchanged:** true

## Safety Confirmations

- All queries were read-only (metadata catalog queries only)
- No record contents or customer data were accessed
- No write query was executed
- No migration SQL was executed
- No migration repair was performed
- No `migration up` was executed
- No `supabase db push` was executed
- No Management API write was performed
- No schema or data was changed
- No migration history was changed
- No repository change was made during verification
- No commit, push, or PR was created during verification
- No deployment occurred
- No token was recorded in evidence
- Issue #53 remains open
- Batch 6 was not started

## Evidence Integrity

- **Evidence file:** `docs/migrations/evidence/batch-05-production-verification.json`
- **Evidence SHA-256:** `92039f91091c0fa5f411f2ad1360b7a9d1d7634edbd81913d5f392182eef1f77`
