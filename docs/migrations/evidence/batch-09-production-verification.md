# Batch 9 Production Verification Evidence

## Summary

- **Batch:** 9
- **Versions:** 242, 243, 245, 246
- **Migration count:** 4
- **Object count:** 42
- **Compared property paths:** 139

## Results

| Metric | Count |
|--------|-------|
| exact_match | 34 |
| equivalent_stricter | 1 |
| superseded | 7 |
| failed | 0 |
| ambiguous | 0 |

## Classifications

All 4 migrations classified: **VERIFIED_APPLIED_UNTRACKED**

## Equivalent-Stricter Lineage

- **Migration 245** (`245_fix_book_slot_atomic_overloads.sql`):
  - Object: `book_slot_atomic` execute grants (grant)
  - Tightened by Migration 296 (`296_restrict_sensitive_rpc_execution.sql`)
  - Migration 296 explicitly revokes EXECUTE from anon and authenticated with role-existence guards
  - Current state is stricter while preserving authorised execution

## Supersession

All 7 superseded objects originate from **Migration 242** (`242_growth_credit_atomic.sql`), superseded by **Migration 243** (`243_growth_credit_hardening.sql`):

1. `reserve_credits_atomic` function body -- replaced by Migration 243 with full reservation lifecycle (campaign locking, double-reservation prevention, reservation_id tracking)
2. `reserve_credits_atomic` grants -- re-applied by Migration 243 after CREATE OR REPLACE which resets default grants
3. `consume_credits_atomic` function body -- replaced by Migration 243 with reservation verification (campaign locking, reservation status checks, consumable limit enforcement)
4. `consume_credits_atomic` grants -- re-applied by Migration 243 after CREATE OR REPLACE which resets default grants
5. `uq_growth_campaign_dedup` unique constraint -- dropped and replaced by `idx_campaign_idempotency` in Migration 243
6. `release_expired_credits` function body -- replaced by Migration 243
7. `release_expired_credits` grants -- re-applied by Migration 243

## Evidence

- **JSON evidence:** `docs/migrations/evidence/batch-09-production-verification.json`
- **Evidence SHA-256:** `531f94b3c11e2c0c02d078e37a6e71f950d59fd9741818d1b81f93e34f51eff7`
- **Repository SHA:** `21cbf57ff76d30538fe493069148e673451431c6`
- **Project ref:** `cxcmiqotkowhxinjbytg`
- **Issue:** #53

## Production History

- Pre/post ordered snapshots: **exactly equal**
- Total remote count: 209
- Range 101-246 tracked count: 113
- Migration 298 occurrence count: 1
- Every Batch 9 version occurrence count: 0
- No history version added, removed, or changed

## Safety

- No production write
- No repair
- No schema or data change
- No migration SQL executed
- No deployment
- Worker-output paths isolated from canonical evidence
- Issue #53 remains open

## Repair Status

- **Verified but waiting for Batch 8 repair closeout**
- Not in active repair allowlist
- Activation blocked by Batch 8
