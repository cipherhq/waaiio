# Migration 101-246 Controlled Repair Runbook

## Purpose

This runbook governs the controlled verification and repair of 124 migration-history candidates (101-246) in the Supabase remote `schema_migrations` table.

**Important:** The 124 candidates have SQL-derived expected objects (tables, columns, indexes, etc.) but have NOT yet been verified against production. No repair may begin until read-only production verification confirms each candidate's expected objects actually exist.

## Constraints

1. **No blind bulk repair.** Every version must be individually verified against production before repair.
2. **Two-step process.** Step 1: read-only production verification. Step 2: migration-history repair. Step 2 requires Step 1.
3. **Maximum 15 versions per batch.** Each verification or repair batch covers at most 15 versions.
4. **Checksum verification required.** Before verifying or repairing any version, confirm the local file checksum matches the manifest using `shasum -a 256` or `npm run verify:migration-repair-plan`.
5. **No SQL execution.** `supabase migration repair` only inserts a row into `schema_migrations` — it does not execute the migration SQL.
6. **No customer data access.** Verification queries metadata catalogs only (information_schema, pg_indexes, pg_proc, pg_policies, pg_trigger, pg_constraint).
7. **Stop on any failure.** If any version in a batch fails verification or repair, stop the entire batch and investigate.
8. **Issue #53 stays open** until all approved repairs and intentional exclusions are fully documented.

## Current State

- **38 ALIGNED_TRACKED:** 102, 103, 104, 106, 108, 109, 110, 111, 112, 113, 114, 115, 116, 117, 118, 119, 120, 121, 123, 124, 125, 127, 128, 129, 131, 132, 133, 134, 135, 136, 137, 138, 176, 181, 182, 199, 200, 244
- **0 VERIFIED_APPLIED_UNTRACKED:** (all verified batches repaired)
- **94 PENDING_PRODUCTION_REVERIFICATION:** require read-only verification
- **12 NOT_VERIFIABLE_SAFELY:** 101, 105, 107, 126, 160, 163, 164, 187, 216, 217, 222, 226
- **2 SUPERSEDED:** 122, 130
- **Active repair allowlist: 0** (cleared after Batch 2 repair)

## Batch Status

### Batch 1 — Verification: COMPLETE | Repair: COMPLETE
- **Versions:** 102, 103, 104, 106, 108, 109, 110, 111, 112, 113, 114, 116, 117, 118, 120
- **Object checks:** 94 (93 passed, 1 superseded)
- **Supersession:** Migration 103 `service_addons_select` policy replaced by `service_addons_owner_read` (Migration 144, security tightening). No application behaviour impact.
- **Verification evidence:** `docs/migrations/evidence/batch-01-production-verification.json`
- **Repair evidence:** `docs/migrations/evidence/batch-01-repair.json`
- **Remote count:** 103 -> 118 (+15)
- **101-246 tracked count:** 8 -> 23 (+15)
- All 15 versions appear exactly once in remote schema_migrations
- No migration SQL executed. No schema or data change. No deployment.

### Batch 2 — Verification: COMPLETE | Repair: COMPLETE
- **Versions:** 121, 123, 124, 125, 127, 128, 129, 131, 132, 133, 134, 135, 136, 137, 138
- **Object checks:** 63 (63 passed, 0 superseded, 0 failed)
- **Verification evidence:** `docs/migrations/evidence/batch-02-production-verification.json`
- **Repair evidence:** `docs/migrations/evidence/batch-02-repair.json`
- **Remote count:** 118 -> 133 (+15)
- **101-246 tracked count:** 23 -> 38 (+15)
- All 15 versions appear exactly once in remote schema_migrations
- No migration SQL executed. No schema or data change. No deployment.

### Batches 3-9 — Verification: NOT STARTED
- 94 candidates remain across 7 batches
- Verification will proceed after Batch 2 repair evidence is reviewed and merged

## Step 1 — Read-Only Production Verification

For each batch of no more than 15 candidates:

### 1a. Select batch from verification candidates
```bash
# Candidates are listed in docs/migrations/101-246-verification-candidates.json
```

### 1b. Run read-only verification queries
For each candidate, query production metadata to confirm every expected object exists:
```bash
# Example: verify table exists
# SELECT 1 FROM information_schema.tables WHERE table_name = 'expected_table';

# Example: verify column exists
# SELECT 1 FROM information_schema.columns WHERE table_name = 'tbl' AND column_name = 'col';

# Example: verify index exists
# SELECT 1 FROM pg_indexes WHERE indexname = 'expected_index';
```

Do not read customer record contents. Query only catalog tables.

### 1c. Record evidence
For each verified object, record:
- object_type, object_name, verified_state, verification_source, verified_at (UTC)

### 1d. Update manifest
Update `docs/migrations/101-246-production-reconciliation.json`:
- Set `evidence_source: "production_verified"`
- Add production evidence to the evidence array
- Set `current_classification: "VERIFIED_APPLIED_UNTRACKED"`
- Set `repair_eligible: true`, `repair_status: "approved_for_repair"`, `confidence: "HIGH"`

### 1e. Commit and review
Commit evidence as a PR. Review before proceeding to Step 2.

## Step 2 — Production Migration-History Repair

Only after Step 1 evidence is reviewed and merged:

### 2a. Pre-flight
```bash
npm run verify:migration-repair-plan
```

### 2b. Execute repair
For each approved version N:
```bash
# Verify checksum (macOS-compatible)
shasum -a 256 supabase/migrations/N_*.sql

# Execute repair (marks as applied, does NOT run SQL)
npx supabase migration repair --status applied N --linked
```

### 2c. Post-repair verification
```bash
# Verify each repaired version appears exactly once in schema_migrations
# Verify total count increased by batch size
# Verify no unrelated migrations were affected
```

### 2d. Record results
- Update manifest: `repair_status: "completed"`
- Update OPS-001 in engineering ledgers
- Update Issue #53 with batch completion details
- Add CHANGELOG.md entry

## Proposed Verification Batches

### Batch 1 (15 versions)
102, 103, 104, 106, 108, 109, 110, 111, 112, 113, 114, 116, 117, 118, 120

### Batch 2 (15 versions)
121, 123, 124, 125, 127, 128, 129, 131, 132, 133, 134, 135, 136, 137, 138

### Batch 3 (15 versions)
139, 140, 141, 142, 143, 144, 145, 146, 147, 148, 149, 150, 151, 152, 153

### Batch 4 (15 versions)
154, 155, 156, 157, 158, 159, 161, 162, 165, 166, 167, 168, 169, 170, 171

### Batch 5 (15 versions)
172, 173, 174, 175, 177, 178, 179, 180, 183, 184, 185, 186, 188, 189, 190

### Batch 6 (15 versions)
191, 192, 193, 194, 195, 196, 197, 198, 201, 202, 203, 204, 205, 206, 207

### Batch 7 (15 versions)
208, 209, 210, 211, 212, 213, 214, 215, 218, 219, 220, 221, 223, 224, 225

### Batch 8 (15 versions)
227, 228, 229, 230, 231, 232, 233, 234, 235, 236, 237, 238, 239, 240, 241

### Batch 9 (4 versions)
242, 243, 245, 246

## Stop Conditions

Stop the entire process if:

1. Any expected object is missing or in an unexpected state during verification
2. Any `npx supabase migration repair` command returns an error
3. Post-repair verification shows a version appearing more than once or not at all
4. Schema_migrations count does not match expected total
5. Any unrelated migration row was modified
6. `npm run verify:migration-repair-plan` fails

## Final Reconciliation

After all approved batches complete:

- **Expected tracked count in range:** 8 (aligned) + number of successfully verified and repaired candidates
- **Intentionally unrepaired:** 14 versions (12 NOT_VERIFIABLE_SAFELY + 2 SUPERSEDED)
- The exact 14: 101, 105, 107, 122, 126, 130, 160, 163, 164, 187, 216, 217, 222, 226
- These versions must not be repaired unless new evidence is approved through a separate review
- Issue #53 closes only after: all approved repairs complete AND intentional exclusions are documented
- Update OPS-001 milestone to PRODUCTION_VERIFIED

## Intentionally Unrepaired

The 12 NOT_VERIFIABLE_SAFELY migrations (101, 105, 107, 126, 160, 163, 164, 187, 216, 217, 222, 226) and 2 SUPERSEDED migrations (122, 130) intentionally remain unrepaired. These 14 versions either lack durable schema objects that can be verified without reading customer data, or their effects have been fully replaced by later migrations. They must not be repaired unless new evidence is approved.
