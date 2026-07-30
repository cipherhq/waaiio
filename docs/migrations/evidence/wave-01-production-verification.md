# Wave 1 Production Verification Evidence

## Summary

- **Wave:** 1
- **Batches:** 6 and 7
- **Versions (30):** 191, 192, 193, 194, 195, 196, 197, 198, 201, 202, 203, 204, 205, 206, 207, 208, 209, 210, 211, 212, 213, 214, 215, 218, 219, 220, 221, 223, 224, 225
- **Total objects:** 212
- **Total compared property paths:** 891

## Combined Results

| Metric | Count |
|--------|-------|
| exact_match | 211 |
| equivalent_stricter | 0 |
| superseded | 1 |
| failed | 0 |
| ambiguous | 0 |

## Batch Evidence

| Batch | Objects | Exact | Superseded | Paths | SHA-256 |
|-------|---------|-------|------------|-------|---------|
| 6 | 129 | 129 | 0 | 550 | `0fc3ff1f5f56644c0570a6f6ff30f7961a873dae29aab02abe7fa83cd3c60cf6` |
| 7 | 83 | 82 | 1 | 341 | `ef3822deec7191c1a6b5fee69afd8c0c97fb588b6458cdc7aa86feeda5b66c00` |

## Wave Evidence

- **JSON evidence:** `docs/migrations/evidence/wave-01-production-verification.json`
- **Wave SHA-256:** `c78e0c2677eb5cbe75ef883b3a5f99c68e97fc1ff6a66e005ac8854c23cbe5a7`
- **Repository SHA:** `9c2746253a11122d770bf619b4a96d862413636c`
- **Project ref:** `cxcmiqotkowhxinjbytg`
- **Issue:** #53

## Production History

- Pre/post ordered snapshots: **exactly equal**
- Total remote count: 179
- Range 101–246 tracked count: 83
- Migration 298 occurrence count: 1
- Every Wave 1 version occurrence count: 0
- No history version added, removed, or changed
- All safety confirmations: true

## Supersession (Migration 223)

- Object: `businesses:public_read_active_businesses` (policy on businesses table)
- Original migration: `223_security_fix_exposed_tables.sql`
- Superseding migration: `293_fix_production_table_exposure.sql`
- Result: superseded with stricter role-based access
- Authenticated and service-role application access remains supported

## Evidence-Generation Lineage

- Original coordinator evidence was followed by a late Worker B overwrite
- The overwrite omitted required coordinator validation fields and used different classifications
- Original coordinator Batch 7 bytes were not recoverable
- Final Batch 6 and Batch 7 JSON files were regenerated from the retained original read-only query results using the same validated builder
- Wave summary was regenerated after both final evidence files
- No new production query was executed during regeneration
- Final canonical SHA-256 values:
  - Batch 6: `0fc3ff1f5f56644c0570a6f6ff30f7961a873dae29aab02abe7fa83cd3c60cf6`
  - Batch 7: `ef3822deec7191c1a6b5fee69afd8c0c97fb588b6458cdc7aa86feeda5b66c00`
  - Wave: `c78e0c2677eb5cbe75ef883b3a5f99c68e97fc1ff6a66e005ac8854c23cbe5a7`
- Superseded (non-canonical) SHA values: Batch 6 `5f6808fb...`, Batch 7 `49db2d39...` (original), `c70565cf...` (Worker B overwrite), Wave `19aef8d6...`

## Current State After This PR

| Classification | Count |
|----------------|-------|
| ALIGNED_TRACKED | 83 |
| VERIFIED_APPLIED_UNTRACKED | 30 |
| PENDING_PRODUCTION_REVERIFICATION | 19 |
| NOT_VERIFIABLE_SAFELY | 12 |
| SUPERSEDED_WITH_EQUIVALENT_STATE | 2 |

- Active repair allowlist: 15 (Batch 6 only)
- Batch 7: verified but inactive, blocked by Batch 6
- Completed repairs: 75
- Batches 8 and 9: not started
- Issue #53 remains open
