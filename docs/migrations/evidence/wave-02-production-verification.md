# Wave 2 Production Verification Evidence

## Summary

- **Wave:** 2
- **Batches:** 8 and 9
- **Versions (19):** 227, 228, 229, 230, 231, 232, 233, 234, 235, 236, 237, 238, 239, 240, 241, 242, 243, 245, 246
- **Total objects:** 153
- **Total function objects validated with definition-level evidence:** 13
- **Total compared property paths:** 370

## Evidence Lineage (V1 → V2 → V3)

| Version | SHA-256 | Status |
|---------|---------|--------|
| V1 | `8008cd5817061972b5e6973fa7da59464d3483798e62fb803604cdefbe1413ae` | Superseded |
| V2 | `d3adc5de8895e38519ce33206b8a211dd9b88caa1b0cdbd322a7fe645cf239e1` | Superseded |
| V3 (canonical) | `3d8550b4967ed4fd95769575e2a70b60e091b904867c3804ca276d243be2d70d` | Canonical |

V3 is the canonical evidence version. V1 and V2 are superseded but preserved for audit trail.
V3 adds per-object provenance fields: `migration_version`, `migration_filename`, `migration_checksum`, `expected_object_digest`.
No new production query occurred for V3. No repair occurred.

## Combined Results

| Metric | Count |
|--------|-------|
| exact_match | 140 |
| equivalent_stricter | 2 |
| superseded | 11 |
| failed | 0 |
| ambiguous | 0 |

## Batch Evidence

| Batch | Objects | Exact | Equiv-Stricter | Superseded | Paths | SHA-256 |
|-------|---------|-------|----------------|------------|-------|---------|
| 8 | 111 | 106 | 1 | 4 | 222 | `f2d54c694f97858fb523247834587bcc3257f8715446ce5d2034086870913c95` |
| 9 | 42 | 34 | 1 | 7 | 148 | `ca531e1e6f23307d14948b89d854a985d6a56495539c072eb2ce3d17334a35c5` |

## Wave Evidence

- **JSON evidence:** `docs/migrations/evidence/wave-02-production-verification.json`
- **V3 canonical SHA-256:** `3d8550b4967ed4fd95769575e2a70b60e091b904867c3804ca276d243be2d70d`
- **Superseded V2 SHA-256:** `d3adc5de8895e38519ce33206b8a211dd9b88caa1b0cdbd322a7fe645cf239e1`
- **Superseded V1 SHA-256:** `8008cd5817061972b5e6973fa7da59464d3483798e62fb803604cdefbe1413ae`
- **Repository SHA:** `21cbf57ff76d30538fe493069148e673451431c6`
- **Project ref:** `cxcmiqotkowhxinjbytg`
- **Issue:** #53

## Production History

- Pre/post ordered snapshots: **exactly equal**
- Total remote count: 209 total / 113 in 101-246
- Migration 298 occurrence count: 1
- Every Wave 2 version occurrence count: 0
- No history version added, removed, or changed
- All safety confirmations: true
- Worker-output paths isolated from canonical evidence

## Equivalent-Stricter (2 objects)

1. **Migration 233** (`233_process_recurring_charge_rpc.sql`):
   - Object: `process_recurring_charge.revoke_public` (grant)
   - Tightened by Migration 295 (`295_restrict_recurring_charge_rpc_execute.sql`)
   - Migration 295 explicitly revokes EXECUTE from anon and authenticated, closing the Supabase ALTER DEFAULT PRIVILEGES gap

2. **Migration 245** (`245_fix_book_slot_atomic_overloads.sql`):
   - Object: `book_slot_atomic` execute grants (grant)
   - Tightened by Migration 296 (`296_restrict_sensitive_rpc_execution.sql`)
   - Migration 296 explicitly revokes EXECUTE from anon and authenticated with role-existence guards

## Superseded (11 objects)

### Batch 8 (4 objects)

1. **Migration 229**: `attendance_log.service_insert` (policy) -- superseded by Migration 230 (`230_attendance_rls_hardening.sql`). Unsafe policy WITH CHECK (true) dropped and replaced by hardened access.
2. **Migration 231**: `create_catalog_order_atomic` (function body) -- superseded by Migration 235 (`235_catalog_order_quantity_validation.sql`). Function replaced with version adding quantity validation.
3. **Migration 233**: `process_recurring_charge` (function body) -- superseded by Migration 244 (`244_payment_source_classification.sql`). Function replaced with version adding payment_source = 'subscription'.
4. **Migration 241**: `customer_consents.customer_consents_service_insert` (policy) -- superseded by Migration 242 (`242_growth_credit_atomic.sql`). Unsafe policy WITH CHECK (true) dropped.

### Batch 9 (7 objects)

All from **Migration 242** (`242_growth_credit_atomic.sql`), superseded by **Migration 243** (`243_growth_credit_hardening.sql`):

1. `reserve_credits_atomic` function body -- replaced with full reservation lifecycle
2. `reserve_credits_atomic` grants -- re-applied after CREATE OR REPLACE
3. `consume_credits_atomic` function body -- replaced with reservation verification
4. `consume_credits_atomic` grants -- re-applied after CREATE OR REPLACE
5. `uq_growth_campaign_dedup` unique constraint -- dropped and replaced by `idx_campaign_idempotency`
6. `release_expired_credits` function body -- replaced
7. `release_expired_credits` grants -- re-applied after CREATE OR REPLACE

## Current State After This PR

| Classification | Count |
|----------------|-------|
| ALIGNED_TRACKED | 113 |
| VERIFIED_APPLIED_UNTRACKED | 19 |
| PENDING_PRODUCTION_REVERIFICATION | 0 |
| NOT_VERIFIABLE_SAFELY | 12 |
| SUPERSEDED_WITH_EQUIVALENT_STATE | 2 |

- Active repair allowlist: 15 (Batch 8 only)
- Batch 9: verified but inactive, blocked by Batch 8
- Completed repairs: 105
- All actionable verification candidates complete
- Issue #53 remains open
