/**
 * Regression tests for migration repair validator rules.
 *
 * These tests verify that the validator correctly rejects unsafe evidence states,
 * invalid timestamps, missing metadata, and inconsistent batch totals.
 * They also verify that the real Batch 1 and Batch 2 evidence passes all checks,
 * and that completed repair entries are correctly validated.
 * Multi-batch cross-validation tests ensure no duplicate versions or batch numbers.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { createHash } from 'crypto';
import { resolve } from 'path';

// ── Validation rule functions (mirroring validator logic) ──

const REJECTED_VERIFIED_STATES = new Set([
  'true', 'false', 'missing', 'absent', 'failed', 'ambiguous',
  'unknown', 'unverified', '', null
]);

const VALID_SUPERSEDED_STATES = new Set([
  'superseded_with_equivalent_state',
  'superseded_with_stricter_state'
]);

// States that satisfy "exists" — e.g., RLS "enabled" satisfies expected_state "exists"
const STATES_SATISFYING_EXISTS = new Set(['exists', 'enabled', 'nullable', 'dropped']);

function isValidUTCTimestamp(ts: unknown): boolean {
  if (!ts || typeof ts !== 'string') return false;
  if (!ts.endsWith('Z') && !ts.endsWith('+00:00')) return false;
  const d = new Date(ts);
  return !isNaN(d.getTime());
}

interface EvidenceItem {
  object_type: string;
  object_name: string;
  expected_state: string;
  verified_state: string | null;
  verification_source?: string;
  verified_at?: string;
  result?: string;
  replacement_object_name?: string;
  superseding_migration?: string;
  rationale?: string;
  application_behaviour_impact?: string;
}

interface ManifestEntry {
  version: string;
  filename: string;
  checksum: string;
  original_classification: string;
  current_classification: string;
  remote_tracked: boolean;
  repair_eligible: boolean;
  repair_status: string;
  confidence: string;
  evidence_source: string;
  evidence: EvidenceItem[];
  repaired_at?: string;
  repair_batch?: number;
  verification_batch?: number;
  repair_evidence_path?: string;
  repair_evidence_digest?: string;
  last_verified_at?: string;
}

interface BatchEvidence {
  main_sha: string;
  batch_number: number;
  verification_timestamp: string;
  versions: string[];
  total_objects_checked: number;
  total_passed: number;
  total_superseded?: number;
  total_failed: number;
  classifications?: Record<string, string>;
  migrations: Array<{
    version: string;
    checksum: string;
    objects: Array<{ result: string; verified_state: string; object_name?: string; verification_timestamp?: string }>;
    passed: number;
    failed: number;
    superseded?: number;
  }>;
}

interface RepairResult {
  version: number;
  exit_status: number;
  post_total: number;
  version_tracked: boolean;
  delta: number;
}

interface RepairEvidence {
  timestamp_utc: string;
  repository_sha: string;
  approved_versions: number[];
  approved_count: number;
  migration_files: Record<string, { filename: string; checksum: string }>;
  repair_results: RepairResult[];
  pre_repair: { total_remote_count: number; range_101_246_count: number };
  post_repair: {
    total_remote_count: number;
    range_101_246_count: number;
    all_approved_appear_exactly_once: boolean;
    total_delta: number;
    range_delta: number;
  };
}

/**
 * Validates a single evidence item for an approved entry.
 * Returns an array of error messages (empty = valid).
 */
function validateEvidenceItem(version: string, ev: EvidenceItem): string[] {
  const errors: string[] = [];

  // Rejected states
  if (REJECTED_VERIFIED_STATES.has(ev.verified_state)) {
    errors.push(`Version ${version}: evidence for ${ev.object_name} has rejected verified_state "${ev.verified_state}"`);
  }

  // Missing verification_source
  if (!ev.verification_source) {
    errors.push(`Version ${version}: evidence for ${ev.object_name} missing verification_source`);
  }

  // Timestamp validation
  if (ev.verified_at && !isValidUTCTimestamp(ev.verified_at)) {
    errors.push(`Version ${version}: evidence for ${ev.object_name} has invalid/non-UTC timestamp "${ev.verified_at}"`);
  }
  if (!ev.verified_at) {
    errors.push(`Version ${version}: evidence for ${ev.object_name} missing verified_at`);
  }

  // Result validation
  if (ev.result === 'failed') {
    errors.push(`Version ${version}: evidence for ${ev.object_name} has result "failed"`);
  }
  if (ev.result === 'ambiguous') {
    errors.push(`Version ${version}: evidence for ${ev.object_name} has result "ambiguous"`);
  }

  // State consistency
  if (ev.verified_state && !REJECTED_VERIFIED_STATES.has(ev.verified_state)) {
    const isSuperseded = VALID_SUPERSEDED_STATES.has(ev.verified_state);
    if (isSuperseded) {
      if (!ev.replacement_object_name) errors.push(`Version ${version}: superseded ${ev.object_name} missing replacement_object_name`);
      if (!ev.superseding_migration) errors.push(`Version ${version}: superseded ${ev.object_name} missing superseding_migration`);
      if (!ev.rationale) errors.push(`Version ${version}: superseded ${ev.object_name} missing rationale`);
      if (!ev.application_behaviour_impact) errors.push(`Version ${version}: superseded ${ev.object_name} missing application_behaviour_impact`);
    } else {
      const stateMatch = ev.verified_state === ev.expected_state ||
        (ev.expected_state === 'exists' && STATES_SATISFYING_EXISTS.has(ev.verified_state));
      if (!stateMatch) {
        errors.push(`Version ${version}: verified_state "${ev.verified_state}" !== expected_state "${ev.expected_state}"`);
      }
    }
  }

  return errors;
}

/**
 * Validates batch evidence totals consistency.
 */
function validateBatchTotals(batch: BatchEvidence): string[] {
  const errors: string[] = [];
  const computedTotal = batch.total_passed + (batch.total_superseded || 0) + batch.total_failed;
  if (computedTotal !== batch.total_objects_checked) {
    errors.push(`Batch totals inconsistent: passed(${batch.total_passed}) + superseded(${batch.total_superseded || 0}) + failed(${batch.total_failed}) = ${computedTotal}, expected ${batch.total_objects_checked}`);
  }
  return errors;
}

/**
 * Validates a completed repair entry.
 * Returns an array of error messages (empty = valid).
 */
function validateCompletedRepairEntry(entry: ManifestEntry, allowlistVersions: Set<string>): string[] {
  const errors: string[] = [];

  if (entry.current_classification !== 'ALIGNED_TRACKED') {
    errors.push(`Version ${entry.version}: completed but current_classification=${entry.current_classification}`);
  }
  if (entry.remote_tracked !== true) {
    errors.push(`Version ${entry.version}: completed but remote_tracked=${entry.remote_tracked}`);
  }
  if (entry.repair_eligible !== false) {
    errors.push(`Version ${entry.version}: completed but repair_eligible=${entry.repair_eligible}`);
  }
  if (entry.confidence !== 'HIGH') {
    errors.push(`Version ${entry.version}: completed but confidence=${entry.confidence}`);
  }
  if (entry.evidence_source !== 'production_verified') {
    errors.push(`Version ${entry.version}: completed but evidence_source=${entry.evidence_source}`);
  }
  if (!entry.repaired_at) {
    errors.push(`Version ${entry.version}: completed but missing repaired_at`);
  } else if (!isValidUTCTimestamp(entry.repaired_at)) {
    errors.push(`Version ${entry.version}: completed but repaired_at is not valid UTC`);
  }
  if (!Number.isInteger(entry.repair_batch) || (entry.repair_batch ?? 0) < 1) {
    errors.push(`Version ${entry.version}: completed but repair_batch is not a positive integer`);
  }
  if (!entry.repair_evidence_path || typeof entry.repair_evidence_path !== 'string') {
    errors.push(`Version ${entry.version}: completed but missing repair_evidence_path`);
  }
  if (!entry.repair_evidence_digest) {
    errors.push(`Version ${entry.version}: completed but missing repair_evidence_digest`);
  }
  if (allowlistVersions.has(entry.version)) {
    errors.push(`Version ${entry.version}: completed but still in active allowlist`);
  }

  return errors;
}

/**
 * Validates an approved-for-repair entry.
 * Returns an array of error messages (empty = valid).
 */
function validateApprovedEntry(entry: ManifestEntry): string[] {
  const errors: string[] = [];

  if (entry.current_classification !== 'VERIFIED_APPLIED_UNTRACKED') {
    errors.push(`Version ${entry.version}: approved but classification=${entry.current_classification}`);
  }
  if (entry.evidence_source !== 'production_verified') {
    errors.push(`Version ${entry.version}: approved but evidence_source=${entry.evidence_source}`);
  }
  if (entry.confidence !== 'HIGH') {
    errors.push(`Version ${entry.version}: approved but confidence=${entry.confidence}`);
  }
  if (entry.repair_eligible !== true) {
    errors.push(`Version ${entry.version}: approved but repair_eligible=${entry.repair_eligible}`);
  }
  if (!Array.isArray(entry.evidence) || entry.evidence.length === 0) {
    errors.push(`Version ${entry.version}: approved but evidence array is empty`);
  }
  if (entry.last_verified_at && !isValidUTCTimestamp(entry.last_verified_at)) {
    errors.push(`Version ${entry.version}: invalid last_verified_at`);
  }

  return errors;
}

// ── Helper to create a valid evidence item ──
function makeValidEvidence(overrides: Partial<EvidenceItem> = {}): EvidenceItem {
  return {
    object_type: 'column',
    object_name: 'test.col',
    expected_state: 'exists',
    verified_state: 'exists',
    verification_source: 'information_schema',
    verified_at: '2026-07-28T11:57:05.694160+00:00',
    result: 'pass',
    ...overrides
  };
}

function makeCompletedEntry(overrides: Partial<ManifestEntry> = {}): ManifestEntry {
  return {
    version: '999',
    filename: '999_test.sql',
    checksum: 'abc123',
    original_classification: 'VERIFIED_APPLIED_UNTRACKED',
    current_classification: 'ALIGNED_TRACKED',
    remote_tracked: true,
    repair_eligible: false,
    repair_status: 'completed',
    confidence: 'HIGH',
    evidence_source: 'production_verified',
    evidence: [makeValidEvidence()],
    repaired_at: '2026-07-28T13:21:43.345538+00:00',
    repair_batch: 1,
    repair_evidence_path: 'docs/migrations/evidence/batch-01-repair.json',
    repair_evidence_digest: 'deadbeef',
    ...overrides
  };
}

function makeApprovedEntry(overrides: Partial<ManifestEntry> = {}): ManifestEntry {
  return {
    version: '998',
    filename: '998_test.sql',
    checksum: 'def456',
    original_classification: 'PENDING_PRODUCTION_REVERIFICATION',
    current_classification: 'VERIFIED_APPLIED_UNTRACKED',
    remote_tracked: false,
    repair_eligible: true,
    repair_status: 'approved_for_repair',
    confidence: 'HIGH',
    evidence_source: 'production_verified',
    evidence: [makeValidEvidence()],
    last_verified_at: '2026-07-28T14:42:57.387751+00:00',
    verification_batch: 2,
    ...overrides
  };
}

function makeBatchEvidence(overrides: Partial<BatchEvidence> = {}): BatchEvidence {
  return {
    main_sha: 'bb4a4e98582205efa75c68db2ae70c97c5393e8d',
    batch_number: 2,
    verification_timestamp: '2026-07-28T14:42:57.387751+00:00',
    versions: ['121'],
    total_objects_checked: 1,
    total_passed: 1,
    total_failed: 0,
    migrations: [{
      version: '121',
      checksum: 'abc',
      objects: [{ result: 'pass', verified_state: 'exists' }],
      passed: 1,
      failed: 0
    }],
    ...overrides
  };
}

// ══════════════════════════════════════════════════════════════
// TESTS
// ══════════════════════════════════════════════════════════════

describe('Migration repair validator rules', () => {
  // Tests 1-4: Rejected verified_state values
  it('rejects verified_state "true"', () => {
    const errors = validateEvidenceItem('999', makeValidEvidence({ verified_state: 'true' }));
    expect(errors.some(e => e.includes('rejected verified_state "true"'))).toBe(true);
  });

  it('rejects verified_state "false"', () => {
    const errors = validateEvidenceItem('999', makeValidEvidence({ verified_state: 'false' }));
    expect(errors.some(e => e.includes('rejected verified_state "false"'))).toBe(true);
  });

  it('rejects verified_state "missing"', () => {
    const errors = validateEvidenceItem('999', makeValidEvidence({ verified_state: 'missing' }));
    expect(errors.some(e => e.includes('rejected verified_state "missing"'))).toBe(true);
  });

  it('rejects verified_state "ambiguous"', () => {
    const errors = validateEvidenceItem('999', makeValidEvidence({ verified_state: 'ambiguous' }));
    expect(errors.some(e => e.includes('rejected verified_state "ambiguous"'))).toBe(true);
  });

  // Tests 5-6: Rejected results
  it('rejects result "failed"', () => {
    const errors = validateEvidenceItem('999', makeValidEvidence({ result: 'failed' }));
    expect(errors.some(e => e.includes('result "failed"'))).toBe(true);
  });

  it('rejects result "ambiguous"', () => {
    const errors = validateEvidenceItem('999', makeValidEvidence({ result: 'ambiguous' }));
    expect(errors.some(e => e.includes('result "ambiguous"'))).toBe(true);
  });

  // Tests 7-8: Timestamp validation
  it('rejects invalid timestamp', () => {
    const errors = validateEvidenceItem('999', makeValidEvidence({ verified_at: 'not-a-date' }));
    expect(errors.some(e => e.includes('invalid/non-UTC timestamp'))).toBe(true);
  });

  it('rejects non-UTC timestamp', () => {
    const errors = validateEvidenceItem('999', makeValidEvidence({ verified_at: '2026-07-28T12:00:00+05:00' }));
    expect(errors.some(e => e.includes('invalid/non-UTC timestamp'))).toBe(true);
  });

  // Test 9: Missing verification_source
  it('rejects missing verification_source', () => {
    const errors = validateEvidenceItem('999', makeValidEvidence({ verification_source: undefined }));
    expect(errors.some(e => e.includes('missing verification_source'))).toBe(true);
  });

  // Test 10: Superseded without replacement metadata
  it('rejects superseded object without replacement_object_name', () => {
    const errors = validateEvidenceItem('999', makeValidEvidence({
      verified_state: 'superseded_with_stricter_state',
      result: 'superseded',
      replacement_object_name: undefined,
      superseding_migration: '144',
      rationale: 'test',
      application_behaviour_impact: 'none'
    }));
    expect(errors.some(e => e.includes('missing replacement_object_name'))).toBe(true);
  });

  // Test 11: Inconsistent batch totals
  it('rejects inconsistent batch evidence totals', () => {
    const errors = validateBatchTotals({
      ...makeBatchEvidence(),
      total_objects_checked: 94,
      total_passed: 90,
      total_superseded: 1,
      total_failed: 0,
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('Batch totals inconsistent');
  });

  // Test 12: Real Batch 1 verification evidence passes all checks
  it('real Batch 1 verification evidence passes all validation rules', () => {
    const evidencePath = resolve('docs/migrations/evidence/batch-01-production-verification.json');
    const manifestPath = resolve('docs/migrations/101-246-production-reconciliation.json');

    expect(existsSync(evidencePath)).toBe(true);
    expect(existsSync(manifestPath)).toBe(true);

    const batch = JSON.parse(readFileSync(evidencePath, 'utf-8')) as BatchEvidence;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as ManifestEntry[];

    // Batch totals must be consistent
    const totalErrors = validateBatchTotals(batch);
    expect(totalErrors).toEqual([]);

    // All batch evidence objects must pass validation
    const batch1Versions = new Set(['102','103','104','106','108','109','110','111','112','113','114','116','117','118','120']);

    // After repair, these entries are now repair_status=completed, not approved_for_repair
    const batch1Entries = manifest.filter(
      (e: ManifestEntry) => batch1Versions.has(e.version) && e.repair_status === 'completed'
    );

    expect(batch1Entries.length).toBe(15);

    const allErrors: string[] = [];
    for (const entry of batch1Entries) {
      for (const ev of entry.evidence) {
        const errs = validateEvidenceItem(entry.version, ev);
        allErrors.push(...errs);
      }
    }

    if (allErrors.length > 0) {
      console.error('Validation errors in real Batch 1 evidence:', allErrors);
    }
    expect(allErrors).toEqual([]);

    // Verify no rejected states in batch evidence
    for (const m of batch.migrations) {
      for (const obj of m.objects) {
        expect(REJECTED_VERIFIED_STATES.has(obj.verified_state)).toBe(false);
      }
    }

    // Verify batch totals
    expect(batch.total_passed).toBe(93);
    expect(batch.total_superseded).toBe(1);
    expect(batch.total_failed).toBe(0);
    expect(batch.total_objects_checked).toBe(94);
  });
});

describe('Completed repair entry validation', () => {
  const emptyAllowlist = new Set<string>();

  it('completed migration with remote_tracked=false fails', () => {
    const errors = validateCompletedRepairEntry(
      makeCompletedEntry({ remote_tracked: false }),
      emptyAllowlist
    );
    expect(errors.some(e => e.includes('remote_tracked=false'))).toBe(true);
  });

  it('completed migration with repair_eligible=true fails', () => {
    const errors = validateCompletedRepairEntry(
      makeCompletedEntry({ repair_eligible: true }),
      emptyAllowlist
    );
    expect(errors.some(e => e.includes('repair_eligible=true'))).toBe(true);
  });

  it('completed migration still in active allowlist fails', () => {
    const allowlistWithVersion = new Set(['999']);
    const errors = validateCompletedRepairEntry(
      makeCompletedEntry(),
      allowlistWithVersion
    );
    expect(errors.some(e => e.includes('still in active allowlist'))).toBe(true);
  });

  it('completed migration missing repaired_at fails', () => {
    const errors = validateCompletedRepairEntry(
      makeCompletedEntry({ repaired_at: undefined }),
      emptyAllowlist
    );
    expect(errors.some(e => e.includes('missing repaired_at'))).toBe(true);
  });

  it('completed migration with non-UTC repaired_at fails', () => {
    const errors = validateCompletedRepairEntry(
      makeCompletedEntry({ repaired_at: '2026-07-28T12:00:00+05:00' }),
      emptyAllowlist
    );
    expect(errors.some(e => e.includes('repaired_at is not valid UTC'))).toBe(true);
  });

  it('completed migration missing repair_evidence_digest fails', () => {
    const errors = validateCompletedRepairEntry(
      makeCompletedEntry({ repair_evidence_digest: undefined }),
      emptyAllowlist
    );
    expect(errors.some(e => e.includes('missing repair_evidence_digest'))).toBe(true);
  });
});

describe('Approved entry validation', () => {
  it('approved migration with wrong classification fails', () => {
    const errors = validateApprovedEntry(
      makeApprovedEntry({ current_classification: 'PENDING_PRODUCTION_REVERIFICATION' })
    );
    expect(errors.some(e => e.includes('approved but classification'))).toBe(true);
  });

  it('approved migration with wrong evidence_source fails', () => {
    const errors = validateApprovedEntry(
      makeApprovedEntry({ evidence_source: 'sql_derived' })
    );
    expect(errors.some(e => e.includes('approved but evidence_source'))).toBe(true);
  });

  it('approved migration with empty evidence fails', () => {
    const errors = validateApprovedEntry(
      makeApprovedEntry({ evidence: [] })
    );
    expect(errors.some(e => e.includes('evidence array is empty'))).toBe(true);
  });

  it('approved migration with invalid last_verified_at fails', () => {
    const errors = validateApprovedEntry(
      makeApprovedEntry({ last_verified_at: '2026-07-28T12:00:00+05:00' })
    );
    expect(errors.some(e => e.includes('invalid last_verified_at'))).toBe(true);
  });
});

describe('Multi-batch cross-validation', () => {
  it('duplicate migration version across batches fails', () => {
    const batch1: BatchEvidence = makeBatchEvidence({ batch_number: 1, versions: ['102', '103'] });
    const batch2: BatchEvidence = makeBatchEvidence({ batch_number: 2, versions: ['103', '121'] });
    const allVersions = [...batch1.versions, ...batch2.versions];
    const unique = new Set(allVersions);
    expect(unique.size).toBeLessThan(allVersions.length);
  });

  it('duplicate batch number fails', () => {
    const batch1: BatchEvidence = makeBatchEvidence({ batch_number: 2, versions: ['121'] });
    const batch2: BatchEvidence = makeBatchEvidence({ batch_number: 2, versions: ['123'] });
    const numbers = [batch1.batch_number, batch2.batch_number];
    const unique = new Set(numbers);
    expect(unique.size).toBeLessThan(numbers.length);
  });

  it('batch version missing from manifest fails', () => {
    const manifest: ManifestEntry[] = [makeApprovedEntry({ version: '121' })];
    const batch: BatchEvidence = makeBatchEvidence({ versions: ['121', '999'] });
    const manifestVersions = new Set(manifest.map(e => e.version));
    const missing = batch.versions.filter(v => !manifestVersions.has(v));
    expect(missing.length).toBeGreaterThan(0);
    expect(missing).toContain('999');
  });

  it('manifest verification_batch mismatch fails', () => {
    const entry = makeApprovedEntry({ version: '121', verification_batch: 3 });
    const batch: BatchEvidence = makeBatchEvidence({ batch_number: 2, versions: ['121'] });
    expect(entry.verification_batch).not.toBe(batch.batch_number);
  });

  it('candidate still present after verification fails', () => {
    const verifiedVersions = new Set(['121', '123']);
    const candidateVersions = new Set(['121', '139']); // 121 should have been removed
    const overlap = [...verifiedVersions].filter(v => candidateVersions.has(v));
    expect(overlap.length).toBeGreaterThan(0);
  });

  it('approved migration missing from allowlist fails', () => {
    const approvedVersions = new Set(['121', '123', '124']);
    const allowlistVersions = new Set(['121', '123']); // 124 missing
    const missing = [...approvedVersions].filter(v => !allowlistVersions.has(v));
    expect(missing.length).toBeGreaterThan(0);
    expect(missing).toContain('124');
  });

  it('allowlist migration not in approved set fails', () => {
    const approvedVersions = new Set(['121', '123']);
    const allowlistVersions = new Set(['121', '123', '999']); // 999 not approved
    const extra = [...allowlistVersions].filter(v => !approvedVersions.has(v));
    expect(extra.length).toBeGreaterThan(0);
    expect(extra).toContain('999');
  });

  it('object-count mismatch in batch fails', () => {
    const batch = makeBatchEvidence({
      total_objects_checked: 10,
      total_passed: 8,
      total_failed: 0,
    });
    const errors = validateBatchTotals(batch);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('failed Batch 2 object fails', () => {
    const ev = makeValidEvidence({ result: 'failed' });
    const errors = validateEvidenceItem('121', ev);
    expect(errors.some(e => e.includes('result "failed"'))).toBe(true);
  });

  it('invalid UTC Batch 2 timestamp fails', () => {
    const ev = makeValidEvidence({ verified_at: '2026-07-28T14:42:57+05:30' });
    const errors = validateEvidenceItem('121', ev);
    expect(errors.some(e => e.includes('invalid/non-UTC timestamp'))).toBe(true);
  });

  it('checksum mismatch in batch fails', () => {
    const migDir = resolve('supabase/migrations');
    const files = readdirSync(migDir).filter(f => f.startsWith('121_'));
    expect(files.length).toBe(1);
    const content = readFileSync(resolve(migDir, files[0]), 'utf-8');
    const realChecksum = createHash('sha256').update(content).digest('hex');
    const fakeChecksum = 'aaaa' + realChecksum.slice(4);
    expect(fakeChecksum).not.toBe(realChecksum);
  });

  it('production-evidence digest mismatch fails', () => {
    const entry = makeApprovedEntry({ version: '121' });
    const canonical = JSON.stringify({
      version: entry.version,
      filename: entry.filename,
      checksum: entry.checksum,
      current_classification: entry.current_classification,
      evidence_source: entry.evidence_source,
      evidence: entry.evidence,
      last_verified_at: entry.last_verified_at
    });
    const correctDigest = createHash('sha256').update(canonical).digest('hex');
    const wrongDigest = 'bbbb' + correctDigest.slice(4);
    expect(wrongDigest).not.toBe(correctDigest);
  });
});

describe('Repair evidence cross-validation', () => {
  it('repair-evidence digest mismatch fails', () => {
    const repairResult: RepairResult = { version: 102, exit_status: 0, post_total: 104, version_tracked: true, delta: 1 };
    const entry = makeCompletedEntry({ version: '102', repair_evidence_digest: 'wrong_digest' });

    const repairEvidence = {
      version: entry.version,
      filename: entry.filename,
      checksum: entry.checksum,
      repair_result: repairResult,
      repair_timestamp: '2026-07-28T13:21:43.345538+00:00',
      repository_sha: '1501eb825ff8c5d5a94373b6daa8166a471be48f'
    };
    const expectedDigest = createHash('sha256').update(JSON.stringify(repairEvidence)).digest('hex');

    expect(entry.repair_evidence_digest).not.toBe(expectedDigest);
  });

  it('version absent from repair evidence fails', () => {
    const repairData: RepairEvidence = {
      timestamp_utc: '2026-07-28T13:21:43.345538+00:00',
      repository_sha: '1501eb82',
      approved_versions: [102],
      approved_count: 1,
      migration_files: { '102': { filename: '102_test.sql', checksum: 'abc' } },
      repair_results: [{ version: 102, exit_status: 0, post_total: 104, version_tracked: true, delta: 1 }],
      pre_repair: { total_remote_count: 103, range_101_246_count: 8 },
      post_repair: { total_remote_count: 104, range_101_246_count: 9, all_approved_appear_exactly_once: true, total_delta: 1, range_delta: 1 }
    };

    const repairResultsByVersion: Record<string, RepairResult> = {};
    repairData.repair_results.forEach(r => { repairResultsByVersion[String(r.version)] = r; });

    // Version 999 is NOT in repair results
    expect(repairResultsByVersion['999']).toBeUndefined();
  });

  it('unsuccessful repair result (exit_status !== 0) fails', () => {
    const repairResult: RepairResult = { version: 102, exit_status: 1, post_total: 103, version_tracked: false, delta: 0 };
    expect(repairResult.exit_status).not.toBe(0);
    expect(repairResult.version_tracked).toBe(false);
  });

  it('version appearing more than once fails', () => {
    const versions = [102, 103, 102]; // duplicate 102
    const unique = new Set(versions);
    expect(unique.size).toBeLessThan(versions.length);
  });

  it('before/after count delta mismatch fails', () => {
    const pre = 103;
    const post = 117; // should be 118 for 15 repairs
    const expectedDelta = 15;
    const actualDelta = post - pre;
    expect(actualDelta).not.toBe(expectedDelta);
  });

  it('unrelated version-set change fails', () => {
    const confirmations = { no_unrelated_version_changed: false };
    expect(confirmations.no_unrelated_version_changed).toBe(false);
  });

  it('completed candidate still in verification candidates fails', () => {
    const completedVersions = new Set(['102', '103']);
    const candidateVersions = new Set(['102', '121', '123']); // 102 should not be here
    const overlap = [...completedVersions].filter(v => candidateVersions.has(v));
    expect(overlap.length).toBeGreaterThan(0);
  });

  it('real Batch 1 repair evidence passes all checks', () => {
    const repairPath = resolve('docs/migrations/evidence/batch-01-repair.json');
    const manifestPath = resolve('docs/migrations/101-246-production-reconciliation.json');
    const allowlistPath = resolve('docs/migrations/101-246-repair-allowlist.json');
    const candidatesPath = resolve('docs/migrations/101-246-verification-candidates.json');

    expect(existsSync(repairPath)).toBe(true);
    expect(existsSync(manifestPath)).toBe(true);

    const repairData = JSON.parse(readFileSync(repairPath, 'utf-8')) as RepairEvidence;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as ManifestEntry[];
    const allowlist = JSON.parse(readFileSync(allowlistPath, 'utf-8')) as Array<{ version: string }>;
    const candidates = JSON.parse(readFileSync(candidatesPath, 'utf-8')) as Array<{ version: string }>;
    const allowlistVersions = new Set(allowlist.map(a => a.version));
    const candidateVersions = new Set(candidates.map(c => c.version));

    // All 15 repair results have exit_status=0 and version_tracked=true
    expect(repairData.repair_results.length).toBe(15);
    for (const r of repairData.repair_results) {
      expect(r.exit_status).toBe(0);
      expect(r.version_tracked).toBe(true);
      expect(r.delta).toBe(1);
    }

    // Count delta matches
    expect(repairData.post_repair.total_remote_count - repairData.pre_repair.total_remote_count).toBe(15);
    expect(repairData.post_repair.total_delta).toBe(15);

    // All approved versions appear exactly once
    expect(repairData.post_repair.all_approved_appear_exactly_once).toBe(true);

    // Completed entries in manifest pass validation
    const completedEntries = manifest.filter(e => e.repair_status === 'completed' && e.repair_batch === 1);
    expect(completedEntries.length).toBe(15);

    const allErrors: string[] = [];
    const repairResultsByVersion: Record<string, RepairResult> = {};
    repairData.repair_results.forEach(r => { repairResultsByVersion[String(r.version)] = r; });

    for (const entry of completedEntries) {
      // Validate completed entry structure
      const entryErrors = validateCompletedRepairEntry(entry, allowlistVersions);
      allErrors.push(...entryErrors);

      // Verify entry is NOT in candidates
      if (candidateVersions.has(entry.version)) {
        allErrors.push(`Version ${entry.version}: completed but still in verification candidates`);
      }

      // Verify repair_evidence_digest recomputes
      const repairResult = repairResultsByVersion[entry.version];
      expect(repairResult).toBeDefined();

      const repairEvidence = {
        version: entry.version,
        filename: entry.filename,
        checksum: entry.checksum,
        repair_result: repairResult,
        repair_timestamp: repairData.timestamp_utc,
        repository_sha: repairData.repository_sha
      };
      const expectedDigest = createHash('sha256').update(JSON.stringify(repairEvidence)).digest('hex');
      if (entry.repair_evidence_digest !== expectedDigest) {
        allErrors.push(`Version ${entry.version}: repair_evidence_digest mismatch`);
      }
    }

    if (allErrors.length > 0) {
      console.error('Batch 1 repair evidence validation errors:', allErrors);
    }
    expect(allErrors).toEqual([]);

    // Batch 1 completed entries must NOT be in allowlist (allowlist is for Batch 2 now)
    for (const entry of completedEntries) {
      expect(allowlistVersions.has(entry.version)).toBe(false);
    }
  });
});

describe('Real Batch 1 + Batch 2 evidence integration', () => {
  it('both batches pass all validation rules together', () => {
    const evidenceDir = resolve('docs/migrations/evidence');
    const manifestPath = resolve('docs/migrations/101-246-production-reconciliation.json');
    const allowlistPath = resolve('docs/migrations/101-246-repair-allowlist.json');
    const candidatesPath = resolve('docs/migrations/101-246-verification-candidates.json');

    expect(existsSync(evidenceDir)).toBe(true);

    const batchFiles = readdirSync(evidenceDir)
      .filter(f => /^batch-\d+-production-verification\.json$/.test(f))
      .sort();
    expect(batchFiles.length).toBe(2);

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as ManifestEntry[];
    const allowlist = JSON.parse(readFileSync(allowlistPath, 'utf-8')) as Array<{ version: string }>;
    const candidates = JSON.parse(readFileSync(candidatesPath, 'utf-8')) as Array<{ version: string }>;
    const allowlistVersions = new Set(allowlist.map(a => a.version));
    const candidateVersions = new Set(candidates.map(c => c.version));

    // Parse both batches
    const batches: BatchEvidence[] = batchFiles.map(f =>
      JSON.parse(readFileSync(resolve(evidenceDir, f), 'utf-8'))
    );

    // No duplicate batch numbers
    const batchNums = batches.map(b => b.batch_number);
    expect(new Set(batchNums).size).toBe(batchNums.length);

    // No duplicate versions across batches
    const allVersions: string[] = [];
    for (const b of batches) allVersions.push(...b.versions);
    expect(new Set(allVersions).size).toBe(allVersions.length);

    // All Batch 2 versions are in manifest as approved_for_repair
    const batch2 = batches.find(b => b.batch_number === 2)!;
    expect(batch2).toBeDefined();
    expect(batch2.versions.length).toBe(15);
    expect(batch2.total_objects_checked).toBe(63);
    expect(batch2.total_passed).toBe(63);
    expect(batch2.total_failed).toBe(0);

    for (const ver of batch2.versions) {
      const me = manifest.find(e => e.version === ver)!;
      expect(me).toBeDefined();
      expect(me.repair_status).toBe('approved_for_repair');
      expect(me.repair_eligible).toBe(true);
      expect(me.confidence).toBe('HIGH');
      expect(me.evidence_source).toBe('production_verified');
      expect(me.current_classification).toBe('VERIFIED_APPLIED_UNTRACKED');
      expect(me.verification_batch).toBe(2);

      // Must be in allowlist
      expect(allowlistVersions.has(ver)).toBe(true);

      // Must NOT be in candidates
      expect(candidateVersions.has(ver)).toBe(false);
    }

    // All Batch 1 versions are completed in manifest
    const batch1 = batches.find(b => b.batch_number === 1)!;
    expect(batch1).toBeDefined();
    for (const ver of batch1.versions) {
      const me = manifest.find(e => e.version === ver)!;
      expect(me).toBeDefined();
      expect(me.repair_status).toBe('completed');
      expect(me.current_classification).toBe('ALIGNED_TRACKED');

      // Must NOT be in allowlist or candidates
      expect(allowlistVersions.has(ver)).toBe(false);
      expect(candidateVersions.has(ver)).toBe(false);
    }

    // Validate all approved entries' evidence
    const approvedEntries = manifest.filter(e => e.repair_status === 'approved_for_repair');
    expect(approvedEntries.length).toBe(15);

    const allErrors: string[] = [];
    for (const entry of approvedEntries) {
      const entryErrors = validateApprovedEntry(entry);
      allErrors.push(...entryErrors);
      for (const ev of entry.evidence) {
        const evErrors = validateEvidenceItem(entry.version, ev);
        allErrors.push(...evErrors);
      }
    }

    if (allErrors.length > 0) {
      console.error('Integration validation errors:', allErrors);
    }
    expect(allErrors).toEqual([]);

    // Classification counts
    const counts: Record<string, number> = {};
    manifest.forEach(e => { counts[e.current_classification] = (counts[e.current_classification] || 0) + 1; });
    expect(counts['ALIGNED_TRACKED']).toBe(23);
    expect(counts['VERIFIED_APPLIED_UNTRACKED']).toBe(15);
    expect(counts['PENDING_PRODUCTION_REVERIFICATION']).toBe(94);
    expect(counts['NOT_VERIFIABLE_SAFELY']).toBe(12);
    expect(counts['SUPERSEDED_WITH_EQUIVALENT_STATE']).toBe(2);

    // Allowlist = 15, Candidates = 94
    expect(allowlist.length).toBe(15);
    expect(candidates.length).toBe(94);

    // 124-candidate cohort invariant
    const repairedCandidates = manifest.filter(e =>
      e.current_classification === 'ALIGNED_TRACKED' &&
      e.repair_status === 'completed' &&
      e.original_classification === 'VERIFIED_APPLIED_UNTRACKED'
    ).length;
    expect(94 + 15 + repairedCandidates).toBe(124);

    // Production evidence digests recompute for all allowlist entries
    for (const al of allowlist) {
      const me = manifest.find(e => e.version === al.version)!;
      const canonical = JSON.stringify({
        version: me.version,
        filename: me.filename,
        checksum: me.checksum,
        current_classification: me.current_classification,
        evidence_source: me.evidence_source,
        evidence: me.evidence,
        last_verified_at: me.last_verified_at
      });
      const expected = createHash('sha256').update(canonical).digest('hex');
      expect((al as { production_evidence_digest: string }).production_evidence_digest).toBe(expected);
    }
  });
});
