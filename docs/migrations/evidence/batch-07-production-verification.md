# Batch 7 Production Verification Evidence

## Summary

- **Batch:** 7
- **Versions:** 208, 209, 210, 211, 212, 213, 214, 215, 218, 219, 220, 221, 223, 224, 225
- **Migration count:** 15
- **Object count:** 83
- **Compared property paths:** 341

## Results

| Metric | Count |
|--------|-------|
| exact_match | 82 |
| equivalent_stricter | 0 |
| superseded | 1 |
| failed | 0 |
| ambiguous | 0 |

## Classifications

All 15 migrations classified: **VERIFIED_APPLIED_UNTRACKED**

## Supersession

- **Migration 223** (`223_security_fix_exposed_tables.sql`):
  - Object: `businesses:public_read_active_businesses` (policy)
  - Superseded by Migration 293 (`293_fix_production_table_exposure.sql`)
  - Policy was dropped by Migration 293 and not recreated with that name
  - Views and grants redefined, policies further restricted
  - Authenticated and service-role application access remains supported

## Evidence

- **JSON evidence:** `docs/migrations/evidence/batch-07-production-verification.json`
- **Evidence SHA-256:** `ef3822deec7191c1a6b5fee69afd8c0c97fb588b6458cdc7aa86feeda5b66c00`
- **Repository SHA:** `9c2746253a11122d770bf619b4a96d862413636c`
- **Project ref:** `cxcmiqotkowhxinjbytg`
- **Issue:** #53

## Production History

- Pre/post ordered snapshots: **exactly equal**
- Total remote count: 179
- Range 101–246 tracked count: 83
- Migration 298 occurrence count: 1
- Every Batch 7 version occurrence count: 0
- No history version added, removed, or changed

## Safety

- No production write
- No repair
- No schema or data change
- No migration SQL executed
- No deployment
- Issue #53 remains open
- Batches 8 and 9 were not started

## Repair Status

- **Verified but waiting for Batch 6 repair closeout**
- Not in active repair allowlist
- Not eligible for repair until Batch 6 repair evidence is merged
- Activation blocked by Batch 6
