# Batch 5 Production Verification Summary

## Evidence Lineage

- **Canonical evidence:** V2 (this file supersedes the V1 temporary evidence)
- **V1 temporary evidence SHA-256:** `92039f91091c0fa5f411f2ad1360b7a9d1d7634edbd81913d5f392182eef1f77`
- **V2 repository evidence SHA-256:** `bf528a884c0361b4d601232074b6d78194930b413726922d624f1fa932a4d2a8`
- **Evidence file:** `docs/migrations/evidence/batch-05-production-verification.json`

## Verification Scope

- **Batch:** 5
- **Versions (15):** 172, 173, 174, 175, 177, 178, 179, 180, 183, 184, 185, 186, 188, 189, 190
- **Repository SHA:** `906878f94141e39ecc3fe19e4cf6ddc714a3811c`
- **Linked project ref:** `cxcmiqotkowhxinjbytg`
- **Verification timestamp:** 2026-07-29T22:09:39.973603+00:00

## Results

- **Total object checks:** 55
- **Detailed property checks:** 383
- **Passed:** 55
- **Superseded:** 0
- **Failed:** 0
- **Ambiguous:** 0
- **All 15 classifications:** VERIFIED_APPLIED_UNTRACKED

### Per-Migration Object and Property Counts

| Version | Filename | Objects | Passed | Superseded | Failed | Ambiguous | Detailed Properties |
|---------|----------|---------|--------|------------|--------|-----------|---------------------|
| 172 | 172_recurring_billing.sql | 3 | 3 | 0 | 0 | 0 | 27 |
| 173 | 173_restore_stock_rpc.sql | 3 | 3 | 0 | 0 | 0 | 42 |
| 174 | 174_contract_references.sql | 2 | 2 | 0 | 0 | 0 | 20 |
| 175 | 175_public_property_read.sql | 1 | 1 | 0 | 0 | 0 | 8 |
| 177 | 177_add_missing_capability_types.sql | 5 | 5 | 0 | 0 | 0 | 15 |
| 178 | 178_capability_sort_order.sql | 2 | 2 | 0 | 0 | 0 | 15 |
| 179 | 179_capability_custom_label.sql | 1 | 1 | 0 | 0 | 0 | 9 |
| 180 | 180_api_keys_external_booking.sql | 6 | 6 | 0 | 0 | 0 | 28 |
| 183 | 183_check_constraints_and_cascade_fixes.sql | 6 | 6 | 0 | 0 | 0 | 38 |
| 184 | 184_campaign_soft_delete.sql | 4 | 4 | 0 | 0 | 0 | 31 |
| 185 | 185_add_dashboard_booking_channel.sql | 1 | 1 | 0 | 0 | 0 | 3 |
| 186 | 186_waivers.sql | 12 | 12 | 0 | 0 | 0 | 65 |
| 188 | 188_waiver_template_pdf_url.sql | 1 | 1 | 0 | 0 | 0 | 9 |
| 189 | 189_waiver_access_token.sql | 3 | 3 | 0 | 0 | 0 | 25 |
| 190 | 190_gateway_fees_and_custom_overrides.sql | 5 | 5 | 0 | 0 | 0 | 48 |

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
