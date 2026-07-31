# Batch 8 Production Verification Evidence

## Summary

- **Batch:** 8
- **Versions:** 227, 228, 229, 230, 231, 232, 233, 234, 235, 236, 237, 238, 239, 240, 241
- **Migration count:** 15
- **Object count:** 111
- **Compared property paths:** 222
- **Function objects validated with definition-level evidence:** 9

## Evidence Lineage (V1 → V2 → V3)

| Version | SHA-256 | Status |
|---------|---------|--------|
| V1 | `bc5ac3169b34c663e45707b25c4fb48c70e7f22b561f90155f7457a57ddd44f5` | Superseded |
| V2 | `8e136a202cbf49234ad14484ce6a7721f66de96ff18e416719bf8410b92936de` | Superseded |
| V3 (canonical) | `f2d54c694f97858fb523247834587bcc3257f8715446ce5d2034086870913c95` | Canonical |

V3 is the canonical evidence version. V1 and V2 are superseded but preserved for audit trail.
V3 adds per-object provenance fields: `migration_version`, `migration_filename`, `migration_checksum`, `expected_object_digest`.
Migration 236 has one comment-only raw-definition difference (normalized executable SQL identical; no committed matching blob exists).

## Results

| Metric | Count |
|--------|-------|
| exact_match | 106 |
| equivalent_stricter | 1 |
| superseded | 4 |
| failed | 0 |
| ambiguous | 0 |

## Classifications

All 15 migrations classified: **VERIFIED_APPLIED_UNTRACKED**

## Equivalent-Stricter Lineage

- **Migration 233** (`233_process_recurring_charge_rpc.sql`):
  - Object: `process_recurring_charge.revoke_public` (grant)
  - Tightened by Migration 295 (`295_restrict_recurring_charge_rpc_execute.sql`)
  - Migration 295 explicitly revokes EXECUTE from anon and authenticated, closing the Supabase ALTER DEFAULT PRIVILEGES gap
  - Current state is stricter

## Supersession

1. **Migration 229** (`229_attendance_log_rls.sql`):
   - Object: `attendance_log.service_insert` (policy)
   - Superseded by Migration 230 (`230_attendance_rls_hardening.sql`)
   - Unsafe policy WITH CHECK (true) dropped and replaced by hardened access

2. **Migration 231** (`231_create_catalog_order_atomic.sql`):
   - Object: `create_catalog_order_atomic` (function body)
   - Superseded by Migration 235 (`235_catalog_order_quantity_validation.sql`)
   - Function replaced with version adding quantity validation

3. **Migration 233** (`233_process_recurring_charge_rpc.sql`):
   - Object: `process_recurring_charge` (function body)
   - Superseded by Migration 244 (`244_payment_source_classification.sql`)
   - Function replaced with version adding payment_source = 'subscription'

4. **Migration 241** (`241_customer_consents.sql`):
   - Object: `customer_consents.customer_consents_service_insert` (policy)
   - Superseded by Migration 242 (`242_growth_credit_atomic.sql`)
   - Unsafe policy WITH CHECK (true) dropped

## Evidence

- **JSON evidence:** `docs/migrations/evidence/batch-08-production-verification.json`
- **V3 canonical SHA-256:** `f2d54c694f97858fb523247834587bcc3257f8715446ce5d2034086870913c95`
- **Superseded V2 SHA-256:** `8e136a202cbf49234ad14484ce6a7721f66de96ff18e416719bf8410b92936de`
- **Superseded V1 SHA-256:** `bc5ac3169b34c663e45707b25c4fb48c70e7f22b561f90155f7457a57ddd44f5`
- **Repository SHA:** `21cbf57ff76d30538fe493069148e673451431c6`
- **Project ref:** `cxcmiqotkowhxinjbytg`
- **Issue:** #53

## Production History

- Pre/post ordered snapshots: **exactly equal**
- Total remote count: 209
- Range 101-246 tracked count: 113
- Migration 298 occurrence count: 1
- Every Batch 8 version occurrence count: 0
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

- **Verified and approved for controlled migration-history repair**
- In active repair allowlist (15 versions)
- Next action: controlled one-by-one Batch 8 repair
