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

- **68 ALIGNED_TRACKED:** 102, 103, 104, 106, 108, 109, 110, 111, 112, 113, 114, 115, 116, 117, 118, 119, 120, 121, 123, 124, 125, 127, 128, 129, 131, 132, 133, 134, 135, 136, 137, 138, 139, 140, 141, 142, 143, 144, 145, 146, 147, 148, 149, 150, 151, 152, 153, 154, 155, 156, 157, 158, 159, 161, 162, 165, 166, 167, 168, 169, 170, 171, 176, 181, 182, 199, 200, 244
- **15 VERIFIED_APPLIED_UNTRACKED:** 172, 173, 174, 175, 177, 178, 179, 180, 183, 184, 185, 186, 188, 189, 190
- **49 PENDING_PRODUCTION_REVERIFICATION:** require read-only verification
- **12 NOT_VERIFIABLE_SAFELY:** 101, 105, 107, 126, 160, 163, 164, 187, 216, 217, 222, 226
- **2 SUPERSEDED:** 122, 130
- **Active repair allowlist: 15** (Batch 5 versions)
- **Completed migration-history repairs: 60** (45 Batch 1-3 + 15 Batch 4)

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

### Batch 3 — Verification: COMPLETE | Repair: COMPLETE
- **Versions:** 139, 140, 141, 142, 143, 144, 145, 146, 147, 148, 149, 150, 151, 152, 153
- **Object checks:** 91 (88 passed, 3 superseded, 0 failed)
- **Superseded objects:**
  - Migration 147: `trg_bot_session_deactivate ON bot_sessions` (DROP+CREATE same migration)
  - Migration 149: `public_read_active_businesses ON businesses` (dropped by Migration 293, security hardening)
  - Migration 149: `trg_generate_event_slug ON events` (DROP+CREATE same migration)
- **Verification evidence:** `docs/migrations/evidence/batch-03-production-verification.json`
- **Repair evidence:** `docs/migrations/evidence/batch-03-repair.json`
- **Remote count:** 133 -> 148 (+15)
- **101-246 tracked count:** 38 -> 53 (+15)
- All 15 versions appear exactly once in remote schema_migrations
- No migration SQL executed. No schema or data change. No deployment.

### Batch 4 — Verification: COMPLETE | Repair: COMPLETE
- **Versions:** 154, 155, 156, 157, 158, 159, 161, 162, 165, 166, 167, 168, 169, 170, 171
- **Object checks:** 55 (53 passed, 2 superseded, 0 failed, 0 ambiguous)
- **Superseded objects:**
  - Migration 155: `book_slot_atomic` function (23-argument overload; replacement implementation in Migration 176, obsolete overload removed by Migration 245)
  - Migration 166: `book_slot_atomic` function (24-argument overload; replacement implementation in Migration 176, obsolete overload removed by Migration 245)
- **Verification evidence:** `docs/migrations/evidence/batch-04-production-verification.json`
- **Repair evidence:** `docs/migrations/evidence/batch-04-repair.json`
- **Remote count:** 148 -> 163 (+15)
- **101-246 tracked count:** 53 -> 68 (+15)
- All 15 versions appear exactly once in remote schema_migrations
- No migration SQL executed. No schema or data change. No deployment.

### Migration 298 — Applied to production (outside 101-246 range)
- **Migration 298 result verified:** exactly 11 historical payment rows linked, pending rows now zero, populated consistent count 39, mismatches 0.
- **Total remote migration count after Migration 298:** 164
- **101-246 tracked count:** unchanged at 68 (Migration 298 is outside this range)
- Migration 298 is recorded exactly once in schema_migrations.
- Migration 298 must not be rerun.
- **PROCEDURE DEVIATION:** `supabase migration up --linked --dry-run` showed 79 migrations. The approved procedure required stopping. Instead, Migration 298 SQL was executed through the Supabase Management API SQL method and recorded using `supabase migration repair --status applied 298`. The production result is verified correct, but the approved execution procedure was not followed.
- **Canonical evidence:** `docs/migrations/evidence/migration-298-production-application-corrected.json`
- **Superseded original evidence:** `docs/migrations/evidence/migration-298-production-application-original.json` (preserved as initial report; accurately recorded methods but did not explicitly classify the dry-run stop violation as a procedure deviation)

### Batch 5 — Verification: COMPLETE | Repair: PENDING
- **Versions:** 172, 173, 174, 175, 177, 178, 179, 180, 183, 184, 185, 186, 188, 189, 190
- **Object checks:** 55 (55 passed, 0 superseded, 0 failed, 0 ambiguous)
- **Verification evidence:** `docs/migrations/evidence/batch-05-production-verification.json`
- **Evidence digest (V2):** `bf528a884c0361b4d601232074b6d78194930b413726922d624f1fa932a4d2a8`
- **Detailed property checks:** 383 (55 objects, all verified)
- **Superseded V1 digest:** `92039f91091c0fa5f411f2ad1360b7a9d1d7634edbd81913d5f392182eef1f77`
- **Total remote count:** 164 (unchanged)
- **101-246 tracked count:** 68 (unchanged — Batch 5 versions remain untracked pending repair)
- All Batch 5 versions have 0 occurrences in remote schema_migrations
- Active repair allowlist contains 15 versions
- No migration SQL executed. No schema or data change. No deployment.
- No migration repair executed — repair blocked until evidence PR merges

### Batches 6-9 — Verification: NOT STARTED
- 49 candidates remain across 4 batches (Batches 6-9)
- Verification will proceed after Batch 5 repair is complete
- Batch 6 has not started

## Mandatory Execution Control Rule

When a dry run returns a migration scope different from the explicitly approved scope:

1. **Stop immediately.**
2. **Perform no write.**
3. **Do not switch** to Management API SQL, migration repair, `db push`, or another execution method.
4. **Report the mismatch.**
5. **Obtain new explicit user authorization** before any alternate write method.

The Migration 298 execution is documented as a **procedure deviation**, not the approved reference workflow. Future dry-run scope mismatches are mandatory hard stops.

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
