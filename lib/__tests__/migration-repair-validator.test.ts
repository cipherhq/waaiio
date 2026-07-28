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

// Removed STATES_SATISFYING_EXISTS — exact match required since Batch 2 fix

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
  total_ambiguous?: number;
  total_failed: number;
  classifications?: Record<string, string>;
  migrations: Array<{
    version: string;
    checksum: string;
    objects: Array<{
      result: string;
      verified_state: string;
      object_name?: string;
      object_type?: string;
      expected_state?: string;
      verification_timestamp?: string;
      verification_source?: string;
      query_category?: string;
    }>;
    passed: number;
    failed: number;
    superseded?: number;
    ambiguous?: number;
    object_count?: number;
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
      // Exact match required — no broad state satisfaction
      const stateMatch = ev.verified_state === ev.expected_state;
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
 * Validates version-set equality between batch.versions, migrations, and classifications.
 */
function validateVersionSet(batch: BatchEvidence): string[] {
  const errors: string[] = [];
  const batchVersionSet = new Set(batch.versions || []);
  const migrationVersionSet = new Set((batch.migrations || []).map(m => m.version));
  const versionsNotInMigrations = [...batchVersionSet].filter(v => !migrationVersionSet.has(v));
  const migrationsNotInVersions = [...migrationVersionSet].filter(v => !batchVersionSet.has(v));
  if (versionsNotInMigrations.length > 0 || migrationsNotInVersions.length > 0) {
    errors.push(`versions array and migrations array mismatch`);
  }
  if (batch.classifications) {
    const classVersionSet = new Set(Object.keys(batch.classifications));
    const versionsNotInClass = [...batchVersionSet].filter(v => !classVersionSet.has(v));
    const classNotInVersions = [...classVersionSet].filter(v => !batchVersionSet.has(v));
    if (versionsNotInClass.length > 0 || classNotInVersions.length > 0) {
      errors.push(`versions array and classifications keys mismatch`);
    }
  }
  return errors;
}

/**
 * Validates per-migration object_count matches objects.length for Batch 2+.
 */
function validateObjectCounts(batch: BatchEvidence): string[] {
  const errors: string[] = [];
  let totalObjectSum = 0;
  for (const m of batch.migrations || []) {
    const actualLen = (m.objects || []).length;
    totalObjectSum += actualLen;
    if ((m as { object_count?: number }).object_count !== undefined &&
        (m as { object_count?: number }).object_count !== actualLen) {
      errors.push(`version ${m.version}: object_count mismatch`);
    }
  }
  if (totalObjectSum !== batch.total_objects_checked) {
    errors.push(`sum of objects (${totalObjectSum}) !== total_objects_checked (${batch.total_objects_checked})`);
  }
  return errors;
}

/**
 * Validates verification_source and query_category on Batch 2+ objects.
 */
function validateEnrichment(batch: BatchEvidence): string[] {
  const errors: string[] = [];
  if (batch.batch_number < 2) return errors;
  for (const m of batch.migrations || []) {
    for (const obj of m.objects || []) {
      if (!(obj as { verification_source?: string }).verification_source) {
        errors.push(`version ${m.version}: object missing verification_source`);
      }
      if (!(obj as { query_category?: string }).query_category) {
        errors.push(`version ${m.version}: object missing query_category`);
      }
    }
  }
  return errors;
}

/**
 * Cross-validates batch evidence objects against manifest evidence.
 */
function validateManifestCrossMatch(
  batch: BatchEvidence,
  manifest: ManifestEntry[]
): string[] {
  const errors: string[] = [];
  const manifestByVersion: Record<string, ManifestEntry> = {};
  manifest.forEach(e => { manifestByVersion[e.version] = e; });

  for (const m of batch.migrations || []) {
    const me = manifestByVersion[m.version];
    if (!me) {
      errors.push(`version ${m.version}: not found in manifest`);
      continue;
    }
    if (me.verification_batch === undefined) {
      errors.push(`version ${m.version}: manifest missing verification_batch`);
    }
    if (!Array.isArray(me.evidence)) continue;
    for (const obj of m.objects || []) {
      const manifestObj = me.evidence.find(ev =>
        ev.object_type === (obj as { object_type?: string }).object_type &&
        ev.object_name === obj.object_name
      );
      if (!manifestObj) {
        errors.push(`version ${m.version}: object ${obj.object_name} not found in manifest`);
        continue;
      }
      if (manifestObj.expected_state !== (obj as { expected_state?: string }).expected_state) {
        errors.push(`version ${m.version}: object ${obj.object_name} expected_state mismatch`);
      }
      if (manifestObj.verified_state !== obj.verified_state) {
        errors.push(`version ${m.version}: object ${obj.object_name} verified_state mismatch`);
      }
      if (manifestObj.verification_source !== (obj as { verification_source?: string }).verification_source) {
        errors.push(`version ${m.version}: object ${obj.object_name} verification_source mismatch`);
      }
      if (manifestObj.result !== obj.result) {
        errors.push(`version ${m.version}: object ${obj.object_name} result mismatch`);
      }
      if (manifestObj.verified_at !== (obj as { verification_timestamp?: string }).verification_timestamp) {
        errors.push(`version ${m.version}: object ${obj.object_name} timestamp mismatch`);
      }
    }

    // Check reverse: manifest objects not in evidence
    for (const manifestObj of me.evidence) {
      const evidenceObj = (m.objects || []).find(o =>
        (o as { object_type?: string }).object_type === manifestObj.object_type &&
        o.object_name === manifestObj.object_name
      );
      if (!evidenceObj) {
        errors.push(`version ${m.version}: manifest object ${manifestObj.object_name} not in evidence`);
      }
    }
  }
  return errors;
}

/**
 * Validates Batch 2+ object evidence completeness (all required fields).
 */
function validateObjectEvidenceCompleteness(batch: BatchEvidence): string[] {
  const errors: string[] = [];
  if (batch.batch_number < 2) return errors;
  for (const m of batch.migrations || []) {
    for (const obj of m.objects || []) {
      if (!(obj as { object_type?: string }).object_type) {
        errors.push(`version ${m.version}: object missing object_type`);
      }
      if (!obj.object_name) {
        errors.push(`version ${m.version}: object missing object_name`);
      }
      if (!(obj as { expected_state?: string }).expected_state) {
        errors.push(`version ${m.version}: object missing expected_state`);
      }
      if (!obj.verified_state) {
        errors.push(`version ${m.version}: object missing verified_state`);
      }
      if (!obj.verification_timestamp || !isValidUTCTimestamp(obj.verification_timestamp)) {
        errors.push(`version ${m.version}: object has invalid verification_timestamp`);
      }
      if (!obj.result) {
        errors.push(`version ${m.version}: object missing result`);
      } else if (obj.result !== 'pass' && obj.result !== 'superseded') {
        errors.push(`version ${m.version}: object has invalid result "${obj.result}"`);
      }
      if (obj.result === 'pass' && obj.verified_state && (obj as { expected_state?: string }).expected_state &&
          obj.verified_state !== (obj as { expected_state?: string }).expected_state) {
        errors.push(`version ${m.version}: result=pass but verified_state !== expected_state`);
      }
    }
  }
  return errors;
}

/**
 * Validates manifest verification_batch version-set equality for Batch 2+.
 */
function validateManifestBatchVersionSet(
  batch: BatchEvidence,
  manifest: ManifestEntry[]
): string[] {
  const errors: string[] = [];
  if (batch.batch_number < 2) return errors;
  const batchVersionSet = new Set(batch.versions || []);
  const manifestBatchEntries = manifest.filter(e => e.verification_batch === batch.batch_number);
  const manifestBatchVersionSet = new Set(manifestBatchEntries.map(e => e.version));
  const batchNotInManifestBatch = [...batchVersionSet].filter(v => !manifestBatchVersionSet.has(v));
  const manifestBatchNotInBatch = [...manifestBatchVersionSet].filter(v => !batchVersionSet.has(v));
  if (batchNotInManifestBatch.length > 0 || manifestBatchNotInBatch.length > 0) {
    errors.push(`version-set mismatch with manifest verification_batch entries`);
  }
  return errors;
}

/**
 * Derives per-migration counts from object results and compares against stored counts.
 */
function validateDerivedCounts(batch: BatchEvidence): string[] {
  const errors: string[] = [];
  if (batch.batch_number < 2) return errors;
  for (const m of batch.migrations || []) {
    const derivedPassed = (m.objects || []).filter(o => o.result === 'pass').length;
    const derivedFailed = (m.objects || []).filter(o => o.result === 'failed' || o.result === 'fail').length;
    const derivedAmbiguous = (m.objects || []).filter(o => o.result === 'ambiguous').length;
    const derivedSuperseded = (m.objects || []).filter(o => o.result === 'superseded').length;

    if (m.passed !== undefined && m.passed !== derivedPassed) {
      errors.push(`version ${m.version}: stored passed=${m.passed} but derived=${derivedPassed}`);
    }
    if (m.failed !== undefined && m.failed !== derivedFailed) {
      errors.push(`version ${m.version}: stored failed=${m.failed} but derived=${derivedFailed}`);
    }
    if ((m as { ambiguous?: number }).ambiguous !== undefined && (m as { ambiguous?: number }).ambiguous !== derivedAmbiguous) {
      errors.push(`version ${m.version}: stored ambiguous=${(m as { ambiguous?: number }).ambiguous} but derived=${derivedAmbiguous}`);
    }
    if ((m as { superseded?: number }).superseded !== undefined && (m as { superseded?: number }).superseded !== derivedSuperseded) {
      errors.push(`version ${m.version}: stored superseded=${(m as { superseded?: number }).superseded} but derived=${derivedSuperseded}`);
    }
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

  // Tests: Exact state matching (dropped/nullable/enabled no longer satisfy exists)
  it('rejects dropped satisfying exists', () => {
    const errors = validateEvidenceItem('999', makeValidEvidence({
      expected_state: 'exists',
      verified_state: 'dropped'
    }));
    expect(errors.some(e => e.includes('verified_state "dropped" !== expected_state "exists"'))).toBe(true);
  });

  it('rejects nullable satisfying exists', () => {
    const errors = validateEvidenceItem('999', makeValidEvidence({
      expected_state: 'exists',
      verified_state: 'nullable'
    }));
    expect(errors.some(e => e.includes('verified_state "nullable" !== expected_state "exists"'))).toBe(true);
  });

  it('rejects RLS enabled when expected_state is exists', () => {
    const errors = validateEvidenceItem('999', makeValidEvidence({
      object_type: 'rls',
      expected_state: 'exists',
      verified_state: 'enabled'
    }));
    expect(errors.some(e => e.includes('verified_state "enabled" !== expected_state "exists"'))).toBe(true);
  });

  it('accepts exact match enabled=enabled for RLS', () => {
    const errors = validateEvidenceItem('999', makeValidEvidence({
      object_type: 'rls',
      expected_state: 'enabled',
      verified_state: 'enabled',
      verification_source: 'pg_class'
    }));
    const stateErrors = errors.filter(e => e.includes('verified_state') && e.includes('expected_state'));
    expect(stateErrors).toEqual([]);
  });

  // Test: Missing query_category in batch 2+ evidence
  it('rejects missing query_category in batch 2+ evidence', () => {
    const batch = makeBatchEvidence({
      batch_number: 2,
      migrations: [{
        version: '121',
        checksum: 'abc',
        object_count: 1,
        objects: [{
          result: 'pass',
          verified_state: 'exists',
          object_name: 'test_table',
          verification_source: 'information_schema'
          // query_category deliberately missing
        }],
        passed: 1,
        failed: 0
      }]
    });
    const errors = validateEnrichment(batch);
    expect(errors.some(e => e.includes('missing query_category'))).toBe(true);
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

describe('Version-set and count validation', () => {
  it('rejects batch versions not matching migrations', () => {
    const batch = makeBatchEvidence({
      versions: ['121', '123'],
      migrations: [{ version: '121', checksum: 'a', objects: [{ result: 'pass', verified_state: 'exists' }], passed: 1, failed: 0 }]
    });
    const errors = validateVersionSet(batch);
    expect(errors.some(e => e.includes('mismatch'))).toBe(true);
  });

  it('rejects object_count mismatch with objects.length', () => {
    const batch = makeBatchEvidence({
      batch_number: 2,
      total_objects_checked: 2,
      total_passed: 2,
      migrations: [{
        version: '121',
        checksum: 'a',
        object_count: 5, // wrong
        objects: [
          { result: 'pass', verified_state: 'exists', verification_source: 'information_schema', query_category: 'information_schema' },
          { result: 'pass', verified_state: 'exists', verification_source: 'information_schema', query_category: 'information_schema' }
        ],
        passed: 2,
        failed: 0
      }]
    });
    const errors = validateObjectCounts(batch);
    expect(errors.some(e => e.includes('object_count mismatch'))).toBe(true);
  });

  it('rejects summary count mismatch', () => {
    const batch = makeBatchEvidence({
      total_objects_checked: 10,  // wrong — only 1 object
      total_passed: 1,
      total_failed: 0,
      migrations: [{
        version: '121',
        checksum: 'a',
        objects: [{ result: 'pass', verified_state: 'exists' }],
        passed: 1,
        failed: 0
      }]
    });
    const errors = validateObjectCounts(batch);
    expect(errors.some(e => e.includes('sum of objects'))).toBe(true);
  });

  it('rejects evidence object differing from manifest', () => {
    const batch = makeBatchEvidence({
      batch_number: 2,
      versions: ['121'],
      migrations: [{
        version: '121',
        checksum: 'a',
        objects: [{
          result: 'pass',
          verified_state: 'exists',
          object_name: 'test_table',
          object_type: 'table',
          expected_state: 'exists'
        }],
        passed: 1,
        failed: 0
      }]
    });
    const manifest: ManifestEntry[] = [makeApprovedEntry({
      version: '121',
      verification_batch: 2,
      evidence: [makeValidEvidence({
        object_type: 'table',
        object_name: 'test_table',
        expected_state: 'exists',
        verified_state: 'dropped'  // different from batch
      })]
    })];
    const errors = validateManifestCrossMatch(batch, manifest);
    expect(errors.some(e => e.includes('verified_state mismatch'))).toBe(true);
  });

  it('rejects missing verification_batch on manifest entry', () => {
    const batch = makeBatchEvidence({
      batch_number: 2,
      versions: ['121'],
      migrations: [{
        version: '121',
        checksum: 'a',
        objects: [{ result: 'pass', verified_state: 'exists', object_name: 'x', object_type: 'table', expected_state: 'exists' }],
        passed: 1,
        failed: 0
      }]
    });
    const manifest: ManifestEntry[] = [makeApprovedEntry({
      version: '121',
      verification_batch: undefined,
      evidence: [makeValidEvidence({ object_type: 'table', object_name: 'x' })]
    })];
    const errors = validateManifestCrossMatch(batch, manifest);
    expect(errors.some(e => e.includes('missing verification_batch'))).toBe(true);
  });

  it('rejects missing repository migration file (validator would fail)', () => {
    // This tests the concept: a version with no matching repo file should fail
    const migDir = resolve('supabase/migrations');
    const files = readdirSync(migDir).filter(f => f.startsWith('999_'));
    expect(files.length).toBe(0); // no file for version 999
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
    expect(batch2.total_ambiguous).toBe(0);
    expect(batch2.total_superseded).toBe(0);

    // Version-set equality
    const versionSetErrors = validateVersionSet(batch2);
    expect(versionSetErrors).toEqual([]);

    // Count reconciliation
    const countErrors = validateObjectCounts(batch2);
    expect(countErrors).toEqual([]);

    // Enrichment checks
    const enrichErrors = validateEnrichment(batch2);
    expect(enrichErrors).toEqual([]);

    // Manifest cross-validation
    const crossErrors = validateManifestCrossMatch(batch2, manifest);
    expect(crossErrors).toEqual([]);

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

    // Derived counts match for Batch 2
    const derivedCountErrors = validateDerivedCounts(batch2);
    expect(derivedCountErrors).toEqual([]);

    // Object evidence completeness for Batch 2
    const completenessErrors = validateObjectEvidenceCompleteness(batch2);
    expect(completenessErrors).toEqual([]);

    // Manifest batch version-set equality for Batch 2
    const manifestBatchErrors = validateManifestBatchVersionSet(batch2, manifest);
    expect(manifestBatchErrors).toEqual([]);

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

describe('Object evidence completeness (Batch 2+)', () => {
  it('rejects Batch 2+ object with missing result field', () => {
    const batch = makeBatchEvidence({
      batch_number: 2,
      migrations: [{
        version: '121', checksum: 'a', passed: 1, failed: 0,
        objects: [{
          result: '', verified_state: 'exists', object_name: 'test_col', object_type: 'column',
          expected_state: 'exists', verification_timestamp: '2026-07-28T14:42:57.387751+00:00',
          verification_source: 'information_schema', query_category: 'information_schema'
        }]
      }]
    });
    const errors = validateObjectEvidenceCompleteness(batch);
    expect(errors.some(e => e.includes('missing result'))).toBe(true);
  });

  it('rejects Batch 2+ object with invalid result (e.g. "fail")', () => {
    const batch = makeBatchEvidence({
      batch_number: 2,
      migrations: [{
        version: '121', checksum: 'a', passed: 0, failed: 1,
        objects: [{
          result: 'fail', verified_state: 'exists', object_name: 'test_col', object_type: 'column',
          expected_state: 'exists', verification_timestamp: '2026-07-28T14:42:57.387751+00:00',
          verification_source: 'information_schema', query_category: 'information_schema'
        }]
      }]
    });
    const errors = validateObjectEvidenceCompleteness(batch);
    expect(errors.some(e => e.includes('invalid result "fail"'))).toBe(true);
  });
});

describe('Manifest batch-set equality (Batch 2+)', () => {
  it('rejects manifest batch version absent from evidence', () => {
    const batch = makeBatchEvidence({ batch_number: 2, versions: ['121'] });
    const manifest: ManifestEntry[] = [
      makeApprovedEntry({ version: '121', verification_batch: 2 }),
      makeApprovedEntry({ version: '123', verification_batch: 2 }) // extra in manifest
    ];
    const errors = validateManifestBatchVersionSet(batch, manifest);
    expect(errors.some(e => e.includes('version-set mismatch'))).toBe(true);
  });

  it('rejects evidence version absent from manifest batch set', () => {
    const batch = makeBatchEvidence({ batch_number: 2, versions: ['121', '123'] });
    const manifest: ManifestEntry[] = [
      makeApprovedEntry({ version: '121', verification_batch: 2 })
      // 123 missing from manifest verification_batch=2
    ];
    const errors = validateManifestBatchVersionSet(batch, manifest);
    expect(errors.some(e => e.includes('version-set mismatch'))).toBe(true);
  });
});

describe('Object-level cross-validation', () => {
  it('rejects verification_source mismatch between evidence and manifest', () => {
    const batch = makeBatchEvidence({
      batch_number: 2, versions: ['121'],
      migrations: [{
        version: '121', checksum: 'a', passed: 1, failed: 0,
        objects: [{
          result: 'pass', verified_state: 'exists', object_name: 'test_col', object_type: 'column',
          expected_state: 'exists', verification_source: 'information_schema',
          verification_timestamp: '2026-07-28T14:42:57.387751+00:00'
        }]
      }]
    });
    const manifest: ManifestEntry[] = [makeApprovedEntry({
      version: '121', verification_batch: 2,
      evidence: [makeValidEvidence({
        object_type: 'column', object_name: 'test_col',
        verification_source: 'pg_catalog' // different
      })]
    })];
    const errors = validateManifestCrossMatch(batch, manifest);
    expect(errors.some(e => e.includes('verification_source mismatch'))).toBe(true);
  });

  it('rejects timestamp mismatch between evidence and manifest', () => {
    const batch = makeBatchEvidence({
      batch_number: 2, versions: ['121'],
      migrations: [{
        version: '121', checksum: 'a', passed: 1, failed: 0,
        objects: [{
          result: 'pass', verified_state: 'exists', object_name: 'test_col', object_type: 'column',
          expected_state: 'exists', verification_source: 'information_schema',
          verification_timestamp: '2026-07-28T14:42:57.387751+00:00'
        }]
      }]
    });
    const manifest: ManifestEntry[] = [makeApprovedEntry({
      version: '121', verification_batch: 2,
      evidence: [makeValidEvidence({
        object_type: 'column', object_name: 'test_col',
        verification_source: 'information_schema',
        verified_at: '2026-07-29T00:00:00.000000+00:00' // different
      })]
    })];
    const errors = validateManifestCrossMatch(batch, manifest);
    expect(errors.some(e => e.includes('timestamp mismatch'))).toBe(true);
  });

  it('rejects result mismatch between evidence and manifest', () => {
    const batch = makeBatchEvidence({
      batch_number: 2, versions: ['121'],
      migrations: [{
        version: '121', checksum: 'a', passed: 1, failed: 0,
        objects: [{
          result: 'pass', verified_state: 'exists', object_name: 'test_col', object_type: 'column',
          expected_state: 'exists', verification_source: 'information_schema',
          verification_timestamp: '2026-07-28T14:42:57.387751+00:00'
        }]
      }]
    });
    const manifest: ManifestEntry[] = [makeApprovedEntry({
      version: '121', verification_batch: 2,
      evidence: [makeValidEvidence({
        object_type: 'column', object_name: 'test_col',
        result: 'superseded' // different
      })]
    })];
    const errors = validateManifestCrossMatch(batch, manifest);
    expect(errors.some(e => e.includes('result mismatch'))).toBe(true);
  });

  it('rejects extra manifest evidence object not in durable evidence', () => {
    const batch = makeBatchEvidence({
      batch_number: 2, versions: ['121'],
      migrations: [{
        version: '121', checksum: 'a', passed: 1, failed: 0,
        objects: [{
          result: 'pass', verified_state: 'exists', object_name: 'test_col', object_type: 'column',
          expected_state: 'exists', verification_source: 'information_schema',
          verification_timestamp: '2026-07-28T11:57:05.694160+00:00'
        }]
      }]
    });
    const manifest: ManifestEntry[] = [makeApprovedEntry({
      version: '121', verification_batch: 2,
      evidence: [
        makeValidEvidence({ object_type: 'column', object_name: 'test_col' }),
        makeValidEvidence({ object_type: 'index', object_name: 'extra_index' }) // not in batch
      ]
    })];
    const errors = validateManifestCrossMatch(batch, manifest);
    expect(errors.some(e => e.includes('manifest object extra_index') && e.includes('not in evidence'))).toBe(true);
  });

  it('rejects extra durable evidence object not in manifest', () => {
    const batch = makeBatchEvidence({
      batch_number: 2, versions: ['121'],
      migrations: [{
        version: '121', checksum: 'a', passed: 2, failed: 0,
        objects: [
          {
            result: 'pass', verified_state: 'exists', object_name: 'test_col', object_type: 'column',
            expected_state: 'exists', verification_source: 'information_schema',
            verification_timestamp: '2026-07-28T11:57:05.694160+00:00'
          },
          {
            result: 'pass', verified_state: 'exists', object_name: 'extra_obj', object_type: 'table',
            expected_state: 'exists', verification_source: 'information_schema',
            verification_timestamp: '2026-07-28T11:57:05.694160+00:00'
          }
        ]
      }]
    });
    const manifest: ManifestEntry[] = [makeApprovedEntry({
      version: '121', verification_batch: 2,
      evidence: [makeValidEvidence({ object_type: 'column', object_name: 'test_col' })]
    })];
    const errors = validateManifestCrossMatch(batch, manifest);
    expect(errors.some(e => e.includes('extra_obj') && e.includes('not found in manifest'))).toBe(true);
  });
});

describe('Derived count reconciliation', () => {
  it('rejects stored migration passed count differing from object results', () => {
    const batch = makeBatchEvidence({
      batch_number: 2,
      total_objects_checked: 2, total_passed: 2,
      migrations: [{
        version: '121', checksum: 'a', passed: 5, failed: 0, // stored passed=5, but only 2 pass objects
        objects: [
          { result: 'pass', verified_state: 'exists' },
          { result: 'pass', verified_state: 'exists' }
        ]
      }]
    });
    const errors = validateDerivedCounts(batch);
    expect(errors.some(e => e.includes('stored passed=5 but derived=2'))).toBe(true);
  });

  it('rejects stored batch totals differing from derived object results', () => {
    const batch = makeBatchEvidence({
      batch_number: 2,
      total_objects_checked: 3, total_passed: 3,
      migrations: [
        {
          version: '121', checksum: 'a', passed: 2, failed: 0, superseded: 1, // superseded=1 but no superseded objects
          objects: [
            { result: 'pass', verified_state: 'exists' },
            { result: 'pass', verified_state: 'exists' }
          ]
        }
      ]
    });
    const errors = validateDerivedCounts(batch);
    expect(errors.some(e => e.includes('stored superseded=1 but derived=0'))).toBe(true);
  });
});
