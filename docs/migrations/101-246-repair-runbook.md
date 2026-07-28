# Migration 101-246 Controlled Repair Runbook

## Purpose

This runbook governs the controlled repair of 124 verified-but-untracked migrations (101-246) in the Supabase remote schema_migrations table. Each migration has been individually verified as applied to production via structured durable schema evidence (tables, columns, indexes, policies, functions, triggers, constraints) extracted from the migration SQL files.

## Constraints

1. **No blind bulk repair.** Every version must be individually present in the immutable allowlist (`docs/migrations/101-246-repair-allowlist.json`).
2. **Maximum 15 versions per batch.** Each batch is a single PR and a single production operation.
3. **Allowlist is immutable.** If a version needs to be added or removed, the allowlist must be regenerated and re-validated through CI before any batch uses it.
4. **Checksum verification required.** Before repairing any version, verify the local file checksum matches the allowlist checksum.
5. **No SQL execution.** `supabase migration repair` only inserts a row into `schema_migrations` — it does not execute the migration SQL.
6. **Post-repair verification required.** After each batch, verify the repaired versions appear exactly once in `schema_migrations`.
7. **Stop on any failure.** If any version in a batch fails verification, stop the entire batch and investigate.
8. **Issue #53 stays open** until all batches complete, intentional exclusions are documented, and final reconciliation is confirmed.

## Excluded Versions

The following versions are **not** in the allowlist and must **never** be repaired through this process:

### Already Completed (ALIGNED_TRACKED) — 8 versions
- 115, 119, 176, 181, 182, 199, 200, 244

### Not Verifiable Safely — 12 versions
- 101, 105, 107, 126, 160, 163, 164, 187, 216, 217, 222, 226

### Superseded — 2 versions
- 122, 130

## Batch Process

For each batch:

### 1. Pre-flight
```bash
# Verify allowlist passes CI
npm run verify:migration-repair-plan

# Verify current schema_migrations count
# (use read-only query via Management API)
```

### 2. Execute Repair
For each version N in the batch:
```bash
# Verify checksum first (macOS-compatible)
shasum -a 256 supabase/migrations/N_*.sql
# Or use the validator script: npm run verify:migration-repair-plan

# Execute repair (marks as applied, does NOT run SQL)
npx supabase migration repair --status applied N --linked
```

### 3. Post-repair Verification
```bash
# Verify each repaired version appears exactly once
# Query schema_migrations via Management API (read-only)

# Verify total schema_migrations count increased by batch size

# Verify no unrelated migrations were affected
```

### 4. Record Results
- Update `docs/migrations/101-246-production-reconciliation.json` repair_status for each version
- Add verification evidence to OPS-001 in `docs/engineering-status.json`
- Update Issue #53 with batch completion details
- Add CHANGELOG.md entry

## Proposed Batches

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

Stop the entire repair process if:

1. Any `supabase migration repair` command returns an error
2. Post-repair verification shows a version appearing more than once
3. Post-repair verification shows a version not appearing at all
4. Schema_migrations count does not match expected total
5. Any unrelated migration row was modified
6. The allowlist validator (`npm run verify:migration-repair-plan`) fails

## Final Reconciliation

After all 9 batches complete:

1. Verify total schema_migrations count matches expected: currently aligned (8) + repaired (124) + pre-existing tracked (versions 001-100 and 247+) = all tracked
2. Run `supabase migration list` and confirm no "not applied" entries for versions in the allowlist
3. Update `docs/migrations/101-246-production-reconciliation.json` — all 124 repair candidates should show `repair_status: "completed"`
4. Document the 14 intentionally unrepaired versions (12 NOT_VERIFIABLE_SAFELY + 2 SUPERSEDED) with rationale in Issue #53
5. Issue #53 closes only after: all 124 approved repairs complete AND the 14 intentional exclusions are fully documented
6. Update OPS-001 milestone to PRODUCTION_VERIFIED

## Intentionally Unrepaired

The 12 NOT_VERIFIABLE_SAFELY migrations (101, 105, 107, 126, 160, 163, 164, 187, 216, 217, 222, 226) and 2 SUPERSEDED migrations (122, 130) intentionally remain unrepaired. These 14 versions either lack durable schema objects that can be verified from SQL parsing (data-only migrations, COMMENT statements, INSERT/UPDATE-only operations) or their effects have been fully replaced by later migrations. They must not be repaired unless new evidence is approved through a separate review process.
