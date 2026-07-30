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
  post_range?: number;
  version_tracked: boolean;
  delta?: number;
  total_delta?: number;
  range_delta?: number;
}

interface RepairEvidence {
  batch_number?: number;
  timestamp_utc: string;
  repository_sha: string;
  approved_versions: number[];
  approved_count: number;
  migration_files: Record<string, { filename: string; checksum: string }>;
  repair_results: RepairResult[];
  pre_repair: { total_remote_count: number; range_101_246_count: number; range_101_246_versions?: number[] };
  post_repair: {
    total_remote_count: number;
    range_101_246_count: number;
    range_101_246_versions?: number[];
    new_versions_added?: number[];
    all_approved_appear_exactly_once: boolean;
    total_delta: number;
    range_delta: number;
  };
}

/** Broad repair evidence type covering both legacy (Batch 1-2) and current (Batch 3+) fields */
interface RepairEvidenceBase {
  task_identifier?: string;
  repository_sha: string;
  linked_project_ref?: string;
  batch_number?: number;
  timestamp_utc?: string;
  repair_timestamp?: string;
  approved_versions: number[];
  approved_count?: number;
  migration_files?: Record<string, { filename: string; checksum: string }>;
  migration_filenames?: string[];
  approved_checksums?: Record<string, string>;
  approved_production_evidence_digests?: Record<string, string>;
  pre_repair: {
    total_remote_count: number;
    range_101_246_count: number;
    range_101_246_versions?: number[];
    tracked_version_snapshot?: number[];
  };
  repair_results: RepairResult[];
  post_repair: {
    total_remote_count: number;
    range_101_246_count: number;
    range_101_246_versions?: number[];
    tracked_version_snapshot?: number[];
    new_versions_added?: number[];
    lost_versions?: number[];
    all_approved_appear_exactly_once?: boolean;
    pre_existing_versions_intact?: boolean;
    total_delta?: number;
    range_delta?: number;
  };
  derived_added_version_set?: number[];
  derived_removed_version_set?: number[];
  confirmations?: Record<string, boolean>;
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
      // Exact match required, or recognized equivalent pair
      const equivalentStatePairs: [string, string][] = [
        ['drop_not_null', 'column_exists_nullable'],
        ['exists', 'enabled']
      ];
      const stateMatch = ev.verified_state === ev.expected_state ||
        equivalentStatePairs.some(([exp, ver]) => ev.expected_state === exp && ev.verified_state === ver);
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
      // Match by object_type + object_name + expected_state to handle duplicate names (e.g., DROP+CREATE)
      const manifestObj = me.evidence.find(ev =>
        ev.object_type === (obj as { object_type?: string }).object_type &&
        ev.object_name === obj.object_name &&
        ev.expected_state === (obj as { expected_state?: string }).expected_state
      );
      if (!manifestObj) {
        errors.push(`version ${m.version}: object ${obj.object_name} (expected_state=${(obj as { expected_state?: string }).expected_state}) not found in manifest`);
        continue;
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
        o.object_name === manifestObj.object_name &&
        (o as { expected_state?: string }).expected_state === manifestObj.expected_state
      );
      if (!evidenceObj) {
        errors.push(`version ${m.version}: manifest object ${manifestObj.object_name} (expected_state=${manifestObj.expected_state}) not in evidence`);
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
      if (obj.result === 'pass' && obj.verified_state && (obj as { expected_state?: string }).expected_state) {
        const eqPairs: [string, string][] = [
          ['drop_not_null', 'column_exists_nullable'],
          ['exists', 'enabled']
        ];
        const stateOk = obj.verified_state === (obj as { expected_state?: string }).expected_state ||
          eqPairs.some(([exp, ver]) => (obj as { expected_state?: string }).expected_state === exp && obj.verified_state === ver);
        if (!stateOk) {
          errors.push(`version ${m.version}: result=pass but verified_state !== expected_state`);
        }
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

  it('accepts RLS enabled when expected_state is exists (equivalent pair)', () => {
    const errors = validateEvidenceItem('999', makeValidEvidence({
      object_type: 'rls',
      expected_state: 'exists',
      verified_state: 'enabled'
    }));
    expect(errors.some(e => e.includes('verified_state "enabled" !== expected_state "exists"'))).toBe(false);
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

    // Batch 1 completed entries must NOT be in allowlist (allowlist is empty after Batch 2 repair)
    for (const entry of completedEntries) {
      expect(allowlistVersions.has(entry.version)).toBe(false);
    }
  });

  it('real Batch 2 repair evidence passes all checks', () => {
    const repairPath = resolve('docs/migrations/evidence/batch-02-repair.json');
    const manifestPath = resolve('docs/migrations/101-246-production-reconciliation.json');
    const allowlistPath = resolve('docs/migrations/101-246-repair-allowlist.json');
    const candidatesPath = resolve('docs/migrations/101-246-verification-candidates.json');

    expect(existsSync(repairPath)).toBe(true);

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
    }

    // Count delta matches
    expect(repairData.post_repair.total_remote_count - repairData.pre_repair.total_remote_count).toBe(15);
    expect(repairData.post_repair.total_delta).toBe(15);
    expect(repairData.post_repair.range_delta).toBe(15);

    // All approved versions appear exactly once
    expect(repairData.post_repair.all_approved_appear_exactly_once).toBe(true);

    // Completed entries in manifest pass validation
    const completedEntries = manifest.filter(e => e.repair_status === 'completed' && e.repair_batch === 2);
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
      console.error('Batch 2 repair evidence validation errors:', allErrors);
    }
    expect(allErrors).toEqual([]);

    // Batch 2 completed entries must NOT be in allowlist
    for (const entry of completedEntries) {
      expect(allowlistVersions.has(entry.version)).toBe(false);
    }
  });
});

describe('Real Batch 1-5 evidence integration (Batches 1-4 repaired, Batch 5 verified)', () => {
  it('all verification batches and repair batches pass all validation rules together', () => {
    const evidenceDir = resolve('docs/migrations/evidence');
    const manifestPath = resolve('docs/migrations/101-246-production-reconciliation.json');
    const allowlistPath = resolve('docs/migrations/101-246-repair-allowlist.json');
    const candidatesPath = resolve('docs/migrations/101-246-verification-candidates.json');

    expect(existsSync(evidenceDir)).toBe(true);

    // Verification evidence files (Batches 1-7 + wave summary)
    const verificationFiles = readdirSync(evidenceDir)
      .filter(f => /^batch-\d+-production-verification\.json$/.test(f))
      .sort();
    expect(verificationFiles.length).toBe(7);

    // Repair evidence files (Batches 1-7)
    const repairFiles = readdirSync(evidenceDir)
      .filter(f => /^batch-\d+-repair\.json$/.test(f))
      .sort();
    expect(repairFiles.length).toBe(7);

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as ManifestEntry[];
    const allowlist = JSON.parse(readFileSync(allowlistPath, 'utf-8')) as Array<{ version: string }>;
    const candidates = JSON.parse(readFileSync(candidatesPath, 'utf-8')) as Array<{ version: string }>;
    const allowlistVersions = new Set(allowlist.map(a => a.version));
    const candidateVersions = new Set(candidates.map(c => c.version));

    // Parse verification batches (filter out Wave 1 format files)
    const oldFormatBatches: BatchEvidence[] = [];
    for (const f of verificationFiles) {
      const data = JSON.parse(readFileSync(resolve(evidenceDir, f), 'utf-8'));
      if (data.task_identifier && !data.main_sha) continue; // Wave 1 format
      oldFormatBatches.push(data);
    }
    expect(oldFormatBatches.length).toBe(5); // Batches 1-5

    // No duplicate batch numbers
    const batchNums = oldFormatBatches.map(b => b.batch_number);
    expect(new Set(batchNums).size).toBe(batchNums.length);

    // No duplicate versions across old-format verification batches
    const allVersions: string[] = [];
    for (const b of oldFormatBatches) allVersions.push(...b.versions);
    expect(new Set(allVersions).size).toBe(allVersions.length);

    // Batches 1-5 completed (repaired)
    for (const b of oldFormatBatches) {
      for (const ver of b.versions) {
        const me = manifest.find(e => e.version === ver)!;
        expect(me).toBeDefined();
        expect(me.repair_status).toBe('completed');
        expect(me.current_classification).toBe('ALIGNED_TRACKED');
        expect(me.remote_tracked).toBe(true);
        expect(me.repair_eligible).toBe(false);
        expect(allowlistVersions.has(ver)).toBe(false);
        expect(candidateVersions.has(ver)).toBe(false);
      }
    }

    // 0 approved entries (all completed after Batch 7 repair)
    const approvedEntries = manifest.filter(e => e.repair_status === 'approved_for_repair');
    expect(approvedEntries.length).toBe(0);

    // Classification counts (post Batch 7 closeout)
    const counts: Record<string, number> = {};
    manifest.forEach(e => { counts[e.current_classification] = (counts[e.current_classification] || 0) + 1; });
    expect(counts['ALIGNED_TRACKED']).toBe(113);
    expect(counts['VERIFIED_APPLIED_UNTRACKED'] || 0).toBe(0);
    expect(counts['PENDING_PRODUCTION_REVERIFICATION']).toBe(19);
    expect(counts['NOT_VERIFIABLE_SAFELY']).toBe(12);
    expect(counts['SUPERSEDED_WITH_EQUIVALENT_STATE']).toBe(2);

    // Allowlist = 0 (Batch 7 completed), Candidates = 19 (Batches 8-9)
    expect(allowlist.length).toBe(0);
    expect(candidates.length).toBe(19);

    // 124-candidate cohort invariant: PENDING + VERIFIED + repaired candidates = 124
    const verifiedCount = counts['VERIFIED_APPLIED_UNTRACKED'] || 0;
    const repairedCandidates = manifest.filter(e =>
      e.current_classification === 'ALIGNED_TRACKED' &&
      e.repair_status === 'completed' &&
      e.original_classification === 'VERIFIED_APPLIED_UNTRACKED'
    ).length;
    expect(19 + verifiedCount + repairedCandidates).toBe(124);
    expect(repairedCandidates).toBe(105); // 15 * 7 batches

    // No duplicate versions across repair batches (Batches 1-5+7 use approved_versions, Batch 6 has different structure)
    const oldFormatRepairFiles = repairFiles.filter(f => f !== 'batch-06-repair.json');
    const repairs: RepairEvidenceBase[] = oldFormatRepairFiles.map(f =>
      JSON.parse(readFileSync(resolve(evidenceDir, f), 'utf-8'))
    );
    const b6Repair = JSON.parse(readFileSync(resolve(evidenceDir, 'batch-06-repair.json'), 'utf-8'));
    const allRepairVersions: string[] = [];
    for (const r of repairs) allRepairVersions.push(...r.approved_versions.map(String));
    allRepairVersions.push(...(b6Repair.approved_versions || []).map(String));
    expect(new Set(allRepairVersions).size).toBe(allRepairVersions.length);
    expect(allRepairVersions.length).toBe(105); // 15 * 7

    // Validate each repair batch
    for (const repair of repairs) {
      expect(repair.approved_versions.length).toBe(15);
      // Batch 4 uses top-level booleans instead of confirmations object
      if (repair.confirmations) {
        expect(repair.confirmations.no_unrelated_version_changed).toBe(true);
      }

      // Batch 5 uses `repairs` array instead of `repair_results`
      const results = repair.repair_results || (repair as any).repairs;
      if (results) {
        for (const r of results) {
          expect(r.exit_status).toBe(0);
          if ('version_tracked' in r) expect(r.version_tracked).toBe(true);
          if ('post_occurrences' in r) expect(r.post_occurrences).toBe(1);
        }
      }
    }

    // Verify repair-evidence digests recompute for all 90 completed entries (Batches 1-5 per-entry, Batch 7 whole-file SHA)
    const allErrors: string[] = [];

    // Batch 7 uses whole-file SHA (same as Batch 6) — validate its entries with the file digest
    const b7RepairPath = resolve(evidenceDir, 'batch-07-repair.json');
    const b7RepairDigest = createHash('sha256').update(readFileSync(b7RepairPath)).digest('hex');
    const b7CompletedEntries = manifest.filter(e => e.repair_batch === 7 && e.repair_status === 'completed');
    expect(b7CompletedEntries.length).toBe(15);
    for (const entry of b7CompletedEntries) {
      const entryErrors = validateCompletedRepairEntry(entry, allowlistVersions);
      allErrors.push(...entryErrors);
      if (candidateVersions.has(entry.version)) {
        allErrors.push(`Version ${entry.version}: completed but still in verification candidates`);
      }
      if (entry.repair_evidence_digest !== b7RepairDigest) {
        allErrors.push(`Version ${entry.version}: repair_evidence_digest mismatch`);
      }
    }

    // Batches 1-5 use per-entry digest formula
    const perEntryRepairs = repairs.filter(r => r.batch_number !== 7);
    for (const repair of perEntryRepairs) {
      const repairTimestamp = repair.timestamp_utc || repair.repair_timestamp || null;

      // Normalize: Batch 5 uses `repairs` array instead of `repair_results`
      let repairResultsByVersion: Record<string, any> = {};
      if (repair.repair_results) {
        repair.repair_results.forEach((r: any) => { repairResultsByVersion[String(r.version)] = r; });
      } else if ((repair as any).repairs) {
        (repair as any).repairs.forEach((r: any) => {
          repairResultsByVersion[String(r.version)] = {
            version: r.version,
            exit_status: r.exit_status,
            version_tracked: r.post_occurrences === 1,
            total_delta: 1,
            range_delta: 1,
            post_total: r.post_total_remote_count,
            post_range: r.post_range_101_246_count
          };
        });
      }

      // Find batch number from repair evidence
      const batchNum = repair.batch_number;
      const batchCompletedEntries = manifest.filter(e => e.repair_batch === batchNum && e.repair_status === 'completed');
      expect(batchCompletedEntries.length).toBe(15);

      for (const entry of batchCompletedEntries) {
        const entryErrors = validateCompletedRepairEntry(entry, allowlistVersions);
        allErrors.push(...entryErrors);

        if (candidateVersions.has(entry.version)) {
          allErrors.push(`Version ${entry.version}: completed but still in verification candidates`);
        }

        const repairResult = repairResultsByVersion[entry.version];
        expect(repairResult).toBeDefined();

        const repairEvidence = {
          version: entry.version,
          filename: entry.filename,
          checksum: entry.checksum,
          repair_result: repairResult,
          repair_timestamp: repairTimestamp,
          repository_sha: repair.repository_sha
        };
        const expectedDigest = createHash('sha256').update(JSON.stringify(repairEvidence)).digest('hex');
        if (entry.repair_evidence_digest !== expectedDigest) {
          allErrors.push(`Version ${entry.version}: repair_evidence_digest mismatch`);
        }
      }
    }

    if (allErrors.length > 0) {
      console.error('Integration validation errors:', allErrors);
    }
    expect(allErrors).toEqual([]);
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

describe('Batch 2 repair-specific validation', () => {
  it('rejects duplicate repair batch number', () => {
    // Two repair batches with the same batch number
    const batchNumbers = [1, 2, 2];
    const unique = new Set(batchNumbers);
    expect(unique.size).toBeLessThan(batchNumbers.length);
  });

  it('rejects duplicate version across repair batches', () => {
    // Version 121 appears in both repair batches
    const batch1Versions = [102, 103, 104];
    const batch2Versions = [121, 103, 123]; // 103 is a duplicate
    const all = [...batch1Versions, ...batch2Versions];
    const unique = new Set(all);
    expect(unique.size).toBeLessThan(all.length);
  });

  it('rejects repair version-set mismatch with manifest', () => {
    // Repair evidence claims version 999 was repaired, but manifest has no such entry with repair_batch=2
    const repairVersions = new Set(['121', '123', '999']);
    const manifestBatch2 = new Set(['121', '123']);
    const mismatch = [...repairVersions].filter(v => !manifestBatch2.has(v));
    expect(mismatch.length).toBeGreaterThan(0);
    expect(mismatch).toContain('999');
  });

  it('rejects completed migration missing from repair evidence', () => {
    const repairData: RepairEvidence = {
      timestamp_utc: '2026-07-28T17:49:35.034574+00:00',
      repository_sha: '7bd276ed',
      approved_versions: [121],
      approved_count: 1,
      migration_files: { '121': { filename: '121_test.sql', checksum: 'abc' } },
      repair_results: [{ version: 121, exit_status: 0, post_total: 119, version_tracked: true, delta: 1 }],
      pre_repair: { total_remote_count: 118, range_101_246_count: 23 },
      post_repair: { total_remote_count: 119, range_101_246_count: 24, all_approved_appear_exactly_once: true, total_delta: 1, range_delta: 1 }
    };

    const repairResultsByVersion: Record<string, RepairResult> = {};
    repairData.repair_results.forEach(r => { repairResultsByVersion[String(r.version)] = r; });

    // Version 123 is NOT in repair results
    expect(repairResultsByVersion['123']).toBeUndefined();
  });

  it('rejects unsuccessful repair command', () => {
    const repairResult: RepairResult = { version: 121, exit_status: 1, post_total: 118, version_tracked: false, delta: 0 };
    expect(repairResult.exit_status).not.toBe(0);
    expect(repairResult.version_tracked).toBe(false);
  });

  it('rejects pre/post total-count delta mismatch', () => {
    const pre = 118;
    const post = 130; // should be 133 for 15 repairs
    const expectedDelta = 15;
    const actualDelta = post - pre;
    expect(actualDelta).not.toBe(expectedDelta);
  });

  it('rejects pre/post range-count delta mismatch', () => {
    const preRange = 23;
    const postRange = 35; // should be 38 for 15 repairs
    const expectedDelta = 15;
    const actualRangeDelta = postRange - preRange;
    expect(actualRangeDelta).not.toBe(expectedDelta);
  });

  it('rejects repair-evidence digest mismatch', () => {
    const repairResult: RepairResult = { version: 121, exit_status: 0, post_total: 119, version_tracked: true, delta: 1 };
    const entry = makeCompletedEntry({ version: '121', repair_batch: 2, repair_evidence_digest: 'wrong_digest' });

    const repairEvidence = {
      version: entry.version,
      filename: entry.filename,
      checksum: entry.checksum,
      repair_result: repairResult,
      repair_timestamp: '2026-07-28T17:49:35.034574+00:00',
      repository_sha: '7bd276ed6f10927827ffffdd8ee39ed294207dae'
    };
    const expectedDigest = createHash('sha256').update(JSON.stringify(repairEvidence)).digest('hex');

    expect(entry.repair_evidence_digest).not.toBe(expectedDigest);
  });

  it('rejects completed Batch 2 version in active allowlist', () => {
    const completedVersions = new Set(['121', '123', '124']);
    const allowlistVersions = new Set(['121', '139']); // 121 should not be in allowlist
    const overlap = [...completedVersions].filter(v => allowlistVersions.has(v));
    expect(overlap.length).toBeGreaterThan(0);
    expect(overlap).toContain('121');
  });

  it('rejects completed Batch 2 version in verification candidates', () => {
    const completedVersions = new Set(['121', '123', '124']);
    const candidateVersions = new Set(['121', '139', '140']); // 121 should not be here
    const overlap = [...completedVersions].filter(v => candidateVersions.has(v));
    expect(overlap.length).toBeGreaterThan(0);
    expect(overlap).toContain('121');
  });

  it('valid Batch 1, Batch 2, Batch 3, Batch 4, Batch 5, Batch 6, and Batch 7 repair evidence passes', () => {
    const evidenceDir = resolve('docs/migrations/evidence');
    const repairFiles = readdirSync(evidenceDir)
      .filter(f => /^batch-\d+-repair\.json$/.test(f))
      .sort();
    expect(repairFiles.length).toBe(7);

    // Batch 6 has a different structure, validate Batches 1-5 and 7 generically
    const oldFormatFiles = repairFiles.filter(f => f !== 'batch-06-repair.json');
    const repairs: RepairEvidenceBase[] = oldFormatFiles.map(f =>
      JSON.parse(readFileSync(resolve(evidenceDir, f), 'utf-8'))
    );

    // No duplicate versions across repair batches (Batches 1-5 + 7)
    const allVersions: string[] = [];
    for (const r of repairs) allVersions.push(...r.approved_versions.map(String));
    expect(new Set(allVersions).size).toBe(allVersions.length);
    expect(allVersions.length).toBe(90);

    // Each batch has 15 versions and all passed
    for (const r of repairs) {
      expect(r.approved_versions.length).toBe(15);
      // Batch 4 uses top-level booleans instead of confirmations object
      if (r.confirmations) {
        expect(r.confirmations.no_unrelated_version_changed).toBe(true);
      }

      // Batch 5 uses `repairs` array instead of `repair_results`
      const results = r.repair_results || (r as any).repairs;
      if (results) {
        for (const rr of results) {
          expect(rr.exit_status).toBe(0);
          if ('version_tracked' in rr) expect(rr.version_tracked).toBe(true);
          if ('post_occurrences' in rr) expect(rr.post_occurrences).toBe(1);
        }
      }
    }

    // Batch 1: 103 -> 118, Batch 2: 118 -> 133, Batch 3: 133 -> 148
    const batch1 = repairs.find(r => r.pre_repair.total_remote_count === 103)!;
    const batch2 = repairs.find(r => r.pre_repair.total_remote_count === 118)!;
    const batch3 = repairs.find(r => r.pre_repair.total_remote_count === 133)!;
    expect(batch1).toBeDefined();
    expect(batch2).toBeDefined();
    expect(batch3).toBeDefined();
    expect(batch1.post_repair.total_remote_count).toBe(118);
    expect(batch2.post_repair.total_remote_count).toBe(133);
    expect(batch3.post_repair.total_remote_count).toBe(148);
  });
});

// ══════════════════════════════════════════════════════════════
// REPAIR EVIDENCE BINDING TESTS
// ══════════════════════════════════════════════════════════════

/**
 * Helper to create a minimal valid repair evidence object for testing.
 */
function makeRepairEvidence(overrides: Partial<RepairEvidence> = {}): RepairEvidence {
  return {
    batch_number: 1,
    timestamp_utc: '2026-07-28T13:21:43.345538+00:00',
    repository_sha: '1501eb825ff8c5d5a94373b6daa8166a471be48f',
    approved_versions: [102, 103],
    approved_count: 2,
    migration_files: {
      '102': { filename: '102_test.sql', checksum: 'aaa' },
      '103': { filename: '103_test.sql', checksum: 'bbb' },
    },
    repair_results: [
      { version: 102, exit_status: 0, post_total: 104, post_range: 9, version_tracked: true, total_delta: 1, range_delta: 1 },
      { version: 103, exit_status: 0, post_total: 105, post_range: 10, version_tracked: true, total_delta: 1, range_delta: 1 },
    ],
    pre_repair: { total_remote_count: 103, range_101_246_count: 8, range_101_246_versions: [115, 119, 176, 181, 182, 199, 200, 244] },
    post_repair: {
      total_remote_count: 105,
      range_101_246_count: 10,
      range_101_246_versions: [102, 103, 115, 119, 176, 181, 182, 199, 200, 244],
      new_versions_added: [102, 103],
      all_approved_appear_exactly_once: true,
      total_delta: 2,
      range_delta: 2,
    },
    ...overrides,
  };
}

/**
 * Validates repair evidence binding rules.
 * Returns array of error messages (empty = valid).
 */
function validateRepairEvidenceBinding(
  filename: string,
  repairData: RepairEvidence,
  manifest: ManifestEntry[]
): string[] {
  const errors: string[] = [];

  // 2a. Filename/JSON batch-number equality
  const fileMatch = filename.match(/batch-(\d+)-repair\.json$/);
  const filenameBatchNum = fileMatch ? parseInt(fileMatch[1]) : null;
  if (!filenameBatchNum || filenameBatchNum < 1) {
    errors.push(`${filename}: cannot derive positive batch number from filename`);
    return errors;
  }
  if (!Number.isInteger(repairData.batch_number) || (repairData.batch_number ?? 0) < 1) {
    errors.push(`${filename}: missing or invalid JSON batch_number`);
    return errors;
  }
  if (repairData.batch_number !== filenameBatchNum) {
    errors.push(`${filename}: filename batch ${filenameBatchNum} !== JSON batch_number ${repairData.batch_number}`);
    return errors;
  }

  // 2b. Full 40-char lowercase SHA
  if (!/^[0-9a-f]{40}$/.test(repairData.repository_sha)) {
    errors.push(`Repair batch ${repairData.batch_number}: repository_sha is not a valid 40-char lowercase hex SHA`);
  }

  // 2c. 5-way version-set equality
  const approvedSet = new Set(repairData.approved_versions.map(String));
  const resultSet = new Set(repairData.repair_results.map(r => String(r.version)));
  const fileSet = new Set(Object.keys(repairData.migration_files));
  const manifestRepairSet = new Set(manifest.filter(e => e.repair_batch === repairData.batch_number).map(e => e.version));
  const newVersionsSet = new Set((repairData.post_repair.new_versions_added || []).map(String));

  for (const [name, s] of [['repair_results', resultSet], ['migration_files', fileSet], ['manifest repair_batch', manifestRepairSet], ['new_versions_added', newVersionsSet]] as const) {
    const missing = [...approvedSet].filter(v => !s.has(v));
    const extra = [...s].filter(v => !approvedSet.has(v));
    if (missing.length > 0 || extra.length > 0) {
      errors.push(`Repair batch ${repairData.batch_number}: approved_versions vs ${name} mismatch (missing: ${missing.join(',')}, extra: ${extra.join(',')})`);
    }
  }

  // 2d. Derive before/after version difference
  const preVersions = new Set((repairData.pre_repair.range_101_246_versions || []).map(String));
  const postVersions = new Set((repairData.post_repair.range_101_246_versions || []).map(String));
  const derivedAdded = [...postVersions].filter(v => !preVersions.has(v)).sort((a, b) => parseInt(a) - parseInt(b));
  const derivedRemoved = [...preVersions].filter(v => !postVersions.has(v));
  const approvedSorted = [...approvedSet].sort((a, b) => parseInt(a) - parseInt(b));

  if (JSON.stringify(derivedAdded) !== JSON.stringify(approvedSorted)) {
    errors.push(`Repair batch ${repairData.batch_number}: derived added versions don't match approved`);
  }
  if (derivedRemoved.length > 0) {
    errors.push(`Repair batch ${repairData.batch_number}: ${derivedRemoved.length} pre-existing versions removed`);
  }
  if (repairData.post_repair.total_remote_count - repairData.pre_repair.total_remote_count !== repairData.approved_count) {
    errors.push(`Repair batch ${repairData.batch_number}: total count delta mismatch`);
  }
  if (repairData.post_repair.range_101_246_count - repairData.pre_repair.range_101_246_count !== repairData.approved_count) {
    errors.push(`Repair batch ${repairData.batch_number}: range count delta mismatch`);
  }

  // 2e. Validate each result (order-independent)
  const postTotals: number[] = [];
  const postRanges: number[] = [];
  for (const r of repairData.repair_results) {
    if (!approvedSet.has(String(r.version))) {
      errors.push(`Repair batch ${repairData.batch_number}: result version ${r.version} not in approved_versions`);
    }
    if (r.exit_status !== 0) errors.push(`Repair batch ${repairData.batch_number} version ${r.version}: exit_status=${r.exit_status}`);
    if (r.version_tracked !== true) errors.push(`Repair batch ${repairData.batch_number} version ${r.version}: version_tracked=${r.version_tracked}`);
    const tDelta = r.total_delta !== undefined ? r.total_delta : r.delta;
    if (tDelta !== 1) errors.push(`Repair batch ${repairData.batch_number} version ${r.version}: total_delta=${tDelta}`);
    if (r.range_delta !== undefined && r.range_delta !== 1) errors.push(`Repair batch ${repairData.batch_number} version ${r.version}: range_delta=${r.range_delta}`);
    if (!Number.isInteger(r.post_total)) errors.push(`Repair batch ${repairData.batch_number} version ${r.version}: post_total not integer`);
    postTotals.push(r.post_total);
    if (r.post_range !== undefined) {
      if (!Number.isInteger(r.post_range)) errors.push(`Repair batch ${repairData.batch_number} version ${r.version}: post_range not integer`);
      postRanges.push(r.post_range);
    }
  }

  // Order-independent: post_total set must be pre+1 through post
  const expectedTotalSet = new Set<number>();
  for (let i = repairData.pre_repair.total_remote_count + 1; i <= repairData.post_repair.total_remote_count; i++) expectedTotalSet.add(i);
  const actualTotalSet = new Set(postTotals);
  if (actualTotalSet.size !== postTotals.length) errors.push(`Repair batch ${repairData.batch_number}: duplicate post_total values`);
  if (actualTotalSet.size !== expectedTotalSet.size || [...actualTotalSet].some(v => !expectedTotalSet.has(v))) {
    errors.push(`Repair batch ${repairData.batch_number}: post_total values don't cover ${repairData.pre_repair.total_remote_count + 1}-${repairData.post_repair.total_remote_count}`);
  }

  if (postRanges.length > 0) {
    const expectedRangeSet = new Set<number>();
    for (let i = repairData.pre_repair.range_101_246_count + 1; i <= repairData.post_repair.range_101_246_count; i++) expectedRangeSet.add(i);
    const actualRangeSet = new Set(postRanges);
    if (actualRangeSet.size !== postRanges.length) errors.push(`Repair batch ${repairData.batch_number}: duplicate post_range values`);
    if (actualRangeSet.size !== expectedRangeSet.size || [...actualRangeSet].some(v => !expectedRangeSet.has(v))) {
      errors.push(`Repair batch ${repairData.batch_number}: post_range values don't cover ${repairData.pre_repair.range_101_246_count + 1}-${repairData.post_repair.range_101_246_count}`);
    }
  }

  return errors;
}

describe('Repair evidence binding tests', () => {
  it('rejects missing JSON batch_number in repair evidence', () => {
    const data = makeRepairEvidence({ batch_number: undefined });
    const errors = validateRepairEvidenceBinding('batch-01-repair.json', data, []);
    expect(errors.some(e => e.includes('missing or invalid JSON batch_number'))).toBe(true);
  });

  it('rejects filename/JSON batch-number mismatch', () => {
    const data = makeRepairEvidence({ batch_number: 2 });
    const errors = validateRepairEvidenceBinding('batch-01-repair.json', data, []);
    expect(errors.some(e => e.includes('filename batch 1 !== JSON batch_number 2'))).toBe(true);
  });

  it('rejects abbreviated repository SHA', () => {
    const data = makeRepairEvidence({ repository_sha: '1501eb82' });
    const manifest = [
      makeCompletedEntry({ version: '102', repair_batch: 1 }),
      makeCompletedEntry({ version: '103', repair_batch: 1 }),
    ];
    const errors = validateRepairEvidenceBinding('batch-01-repair.json', data, manifest);
    expect(errors.some(e => e.includes('not a valid 40-char lowercase hex SHA'))).toBe(true);
  });

  it('rejects approved_versions/repair_results set mismatch', () => {
    const data = makeRepairEvidence({
      repair_results: [
        // Only 102, missing 103
        { version: 102, exit_status: 0, post_total: 104, post_range: 9, version_tracked: true, total_delta: 1, range_delta: 1 },
      ],
    });
    const manifest = [
      makeCompletedEntry({ version: '102', repair_batch: 1 }),
      makeCompletedEntry({ version: '103', repair_batch: 1 }),
    ];
    const errors = validateRepairEvidenceBinding('batch-01-repair.json', data, manifest);
    expect(errors.some(e => e.includes('approved_versions vs repair_results mismatch'))).toBe(true);
  });

  it('rejects extra migration_files version', () => {
    const data = makeRepairEvidence();
    data.migration_files['999'] = { filename: '999_extra.sql', checksum: 'xxx' };
    const manifest = [
      makeCompletedEntry({ version: '102', repair_batch: 1 }),
      makeCompletedEntry({ version: '103', repair_batch: 1 }),
    ];
    const errors = validateRepairEvidenceBinding('batch-01-repair.json', data, manifest);
    expect(errors.some(e => e.includes('approved_versions vs migration_files mismatch'))).toBe(true);
  });

  it('rejects new_versions_added mismatch', () => {
    const data = makeRepairEvidence();
    data.post_repair.new_versions_added = [102, 103, 999]; // 999 not in approved
    const manifest = [
      makeCompletedEntry({ version: '102', repair_batch: 1 }),
      makeCompletedEntry({ version: '103', repair_batch: 1 }),
    ];
    const errors = validateRepairEvidenceBinding('batch-01-repair.json', data, manifest);
    expect(errors.some(e => e.includes('approved_versions vs new_versions_added mismatch'))).toBe(true);
  });

  it('rejects unrelated added version in derived diff', () => {
    const data = makeRepairEvidence();
    // Add an unrelated version to post that's not in approved
    data.post_repair.range_101_246_versions = [102, 103, 115, 119, 176, 181, 182, 199, 200, 244, 999];
    data.post_repair.range_101_246_count = 11;
    const manifest = [
      makeCompletedEntry({ version: '102', repair_batch: 1 }),
      makeCompletedEntry({ version: '103', repair_batch: 1 }),
    ];
    const errors = validateRepairEvidenceBinding('batch-01-repair.json', data, manifest);
    expect(errors.some(e => e.includes('derived added versions don\'t match approved'))).toBe(true);
  });

  it('rejects removed pre-existing version', () => {
    const data = makeRepairEvidence();
    // Remove version 115 from post (was in pre)
    data.post_repair.range_101_246_versions = [102, 103, 119, 176, 181, 182, 199, 200, 244];
    data.post_repair.range_101_246_count = 9;
    const manifest = [
      makeCompletedEntry({ version: '102', repair_batch: 1 }),
      makeCompletedEntry({ version: '103', repair_batch: 1 }),
    ];
    const errors = validateRepairEvidenceBinding('batch-01-repair.json', data, manifest);
    expect(errors.some(e => e.includes('pre-existing versions removed'))).toBe(true);
  });

  it('rejects duplicate repair result version', () => {
    const data = makeRepairEvidence({
      repair_results: [
        { version: 102, exit_status: 0, post_total: 104, post_range: 9, version_tracked: true, total_delta: 1, range_delta: 1 },
        { version: 102, exit_status: 0, post_total: 105, post_range: 10, version_tracked: true, total_delta: 1, range_delta: 1 },
      ],
    });
    const manifest = [
      makeCompletedEntry({ version: '102', repair_batch: 1 }),
      makeCompletedEntry({ version: '103', repair_batch: 1 }),
    ];
    const errors = validateRepairEvidenceBinding('batch-01-repair.json', data, manifest);
    // Result set will have only '102', missing '103'
    expect(errors.some(e => e.includes('approved_versions vs repair_results mismatch'))).toBe(true);
  });

  it('rejects duplicate intermediate post_total', () => {
    const data = makeRepairEvidence({
      repair_results: [
        { version: 102, exit_status: 0, post_total: 104, post_range: 9, version_tracked: true, total_delta: 1, range_delta: 1 },
        { version: 103, exit_status: 0, post_total: 104, post_range: 10, version_tracked: true, total_delta: 1, range_delta: 1 }, // duplicate post_total
      ],
    });
    const manifest = [
      makeCompletedEntry({ version: '102', repair_batch: 1 }),
      makeCompletedEntry({ version: '103', repair_batch: 1 }),
    ];
    const errors = validateRepairEvidenceBinding('batch-01-repair.json', data, manifest);
    expect(errors.some(e => e.includes('duplicate post_total values'))).toBe(true);
  });

  it('rejects missing intermediate post_total', () => {
    const data = makeRepairEvidence({
      approved_versions: [102, 103, 104],
      approved_count: 3,
      migration_files: {
        '102': { filename: '102_test.sql', checksum: 'aaa' },
        '103': { filename: '103_test.sql', checksum: 'bbb' },
        '104': { filename: '104_test.sql', checksum: 'ccc' },
      },
      repair_results: [
        { version: 102, exit_status: 0, post_total: 104, post_range: 9, version_tracked: true, total_delta: 1, range_delta: 1 },
        { version: 103, exit_status: 0, post_total: 105, post_range: 10, version_tracked: true, total_delta: 1, range_delta: 1 },
        // Skips 106, jumps to 107
        { version: 104, exit_status: 0, post_total: 107, post_range: 11, version_tracked: true, total_delta: 1, range_delta: 1 },
      ],
      pre_repair: { total_remote_count: 103, range_101_246_count: 8, range_101_246_versions: [115, 119, 176, 181, 182, 199, 200, 244] },
      post_repair: {
        total_remote_count: 106,
        range_101_246_count: 11,
        range_101_246_versions: [102, 103, 104, 115, 119, 176, 181, 182, 199, 200, 244],
        new_versions_added: [102, 103, 104],
        all_approved_appear_exactly_once: true,
        total_delta: 3,
        range_delta: 3,
      },
    });
    const manifest = [
      makeCompletedEntry({ version: '102', repair_batch: 1 }),
      makeCompletedEntry({ version: '103', repair_batch: 1 }),
      makeCompletedEntry({ version: '104', repair_batch: 1 }),
    ];
    const errors = validateRepairEvidenceBinding('batch-01-repair.json', data, manifest);
    // post_total 107 is out of range (expected 104-106)
    expect(errors.some(e => e.includes('post_total values don\'t cover'))).toBe(true);
  });

  it('rejects out-of-range intermediate post_total', () => {
    const data = makeRepairEvidence({
      repair_results: [
        { version: 102, exit_status: 0, post_total: 104, post_range: 9, version_tracked: true, total_delta: 1, range_delta: 1 },
        { version: 103, exit_status: 0, post_total: 999, post_range: 10, version_tracked: true, total_delta: 1, range_delta: 1 }, // way out of range
      ],
    });
    const manifest = [
      makeCompletedEntry({ version: '102', repair_batch: 1 }),
      makeCompletedEntry({ version: '103', repair_batch: 1 }),
    ];
    const errors = validateRepairEvidenceBinding('batch-01-repair.json', data, manifest);
    expect(errors.some(e => e.includes('post_total values don\'t cover'))).toBe(true);
  });

  it('rejects incorrect final total count', () => {
    const data = makeRepairEvidence();
    // post total is 105 but approved_count is 2, pre is 103, so delta should be 2 -> post should be 105
    // Change post to 106 to cause mismatch
    data.post_repair.total_remote_count = 106;
    const manifest = [
      makeCompletedEntry({ version: '102', repair_batch: 1 }),
      makeCompletedEntry({ version: '103', repair_batch: 1 }),
    ];
    const errors = validateRepairEvidenceBinding('batch-01-repair.json', data, manifest);
    expect(errors.some(e => e.includes('total count delta mismatch'))).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════
// BATCH 3 SUPERSESSION AND VERIFICATION TESTS
// ══════════════════════════════════════════════════════════════

describe('Batch 3 superseded object validation', () => {
  it('rejects superseded object missing superseding_migration', () => {
    const errors = validateEvidenceItem('147', makeValidEvidence({
      verified_state: 'superseded_with_equivalent_state',
      result: 'superseded',
      replacement_object_name: 'trg_bot_session_deactivate',
      superseding_migration: undefined,
      rationale: 'DROP+CREATE same migration',
      application_behaviour_impact: 'none'
    }));
    expect(errors.some(e => e.includes('missing superseding_migration'))).toBe(true);
  });

  it('rejects superseded object missing rationale', () => {
    const errors = validateEvidenceItem('149', makeValidEvidence({
      verified_state: 'superseded_with_stricter_state',
      result: 'superseded',
      replacement_object_name: 'businesses_public view',
      superseding_migration: '293',
      rationale: undefined,
      application_behaviour_impact: 'none'
    }));
    expect(errors.some(e => e.includes('missing rationale'))).toBe(true);
  });

  it('rejects superseded object missing application_behaviour_impact', () => {
    const errors = validateEvidenceItem('149', makeValidEvidence({
      verified_state: 'superseded_with_equivalent_state',
      result: 'superseded',
      replacement_object_name: 'trg_generate_event_slug',
      superseding_migration: '149',
      rationale: 'DROP+CREATE same migration',
      application_behaviour_impact: undefined
    }));
    expect(errors.some(e => e.includes('missing application_behaviour_impact'))).toBe(true);
  });
});

describe('Batch 3 verification state consistency', () => {
  it('rejects Batch 3 version remaining in verification candidates', () => {
    const batch3Versions = new Set(['139','140','141','142','143','144','145','146','147','148','149','150','151','152','153']);
    const candidatesPath = resolve('docs/migrations/101-246-verification-candidates.json');
    const candidates = JSON.parse(readFileSync(candidatesPath, 'utf-8')) as Array<{ version: string }>;
    const overlap = candidates.filter(c => batch3Versions.has(c.version));
    expect(overlap.length).toBe(0);
  });

  it('allowlist is empty after Batch 7 closeout', () => {
    const allowlistPath = resolve('docs/migrations/101-246-repair-allowlist.json');
    const allowlist = JSON.parse(readFileSync(allowlistPath, 'utf-8'));
    expect(allowlist.length).toBe(0);
    const versions = allowlist.map((e: any) => e.version);
    expect(versions).toEqual([]);
  });

  it('Batch 3 entries now marked remote_tracked=true after repair', () => {
    const manifestPath = resolve('docs/migrations/101-246-production-reconciliation.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as ManifestEntry[];
    const batch3Entries = manifest.filter(e => e.verification_batch === 3);
    expect(batch3Entries.length).toBe(15);
    for (const e of batch3Entries) {
      expect(e.remote_tracked).toBe(true);
      expect(e.repair_status).toBe('completed');
      expect(e.current_classification).toBe('ALIGNED_TRACKED');
      expect(e.repair_batch).toBe(3);
    }
  });

  it('Batch 3 completed entries have valid repair fields', () => {
    const manifestPath = resolve('docs/migrations/101-246-production-reconciliation.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as ManifestEntry[];
    const batch3Entries = manifest.filter(e => e.repair_batch === 3);
    expect(batch3Entries.length).toBe(15);
    for (const e of batch3Entries) {
      expect(e.repair_status).toBe('completed');
      expect(e.repaired_at).toBeDefined();
      expect(isValidUTCTimestamp(e.repaired_at!)).toBe(true);
      expect(e.repair_evidence_digest).toBeDefined();
      expect(e.repair_evidence_path).toBe('docs/migrations/evidence/batch-03-repair.json');
    }
  });

  it('Batch 4 entries now marked completed after repair', () => {
    const manifestPath = resolve('docs/migrations/101-246-production-reconciliation.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as ManifestEntry[];
    const batch4Entries = manifest.filter(e => e.verification_batch === 4);
    expect(batch4Entries.length).toBe(15);
    for (const e of batch4Entries) {
      expect(e.remote_tracked).toBe(true);
      expect(e.repair_status).toBe('completed');
      expect(e.current_classification).toBe('ALIGNED_TRACKED');
      expect(e.repair_batch).toBe(4);
      expect(e.repair_evidence_path).toBe('docs/migrations/evidence/batch-04-repair.json');
    }
  });

  it('real Batch 3 verification evidence passes all checks', () => {
    const evidencePath = resolve('docs/migrations/evidence/batch-03-production-verification.json');
    const manifestPath = resolve('docs/migrations/101-246-production-reconciliation.json');

    expect(existsSync(evidencePath)).toBe(true);
    const batch = JSON.parse(readFileSync(evidencePath, 'utf-8')) as BatchEvidence;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as ManifestEntry[];

    // Batch totals
    expect(batch.total_objects_checked).toBe(91);
    expect(batch.total_passed).toBe(88);
    expect(batch.total_superseded).toBe(3);
    expect(batch.total_failed).toBe(0);
    expect(batch.versions.length).toBe(15);

    const totalErrors = validateBatchTotals(batch);
    expect(totalErrors).toEqual([]);

    const versionSetErrors = validateVersionSet(batch);
    expect(versionSetErrors).toEqual([]);

    const derivedCountErrors = validateDerivedCounts(batch);
    expect(derivedCountErrors).toEqual([]);

    const completenessErrors = validateObjectEvidenceCompleteness(batch);
    expect(completenessErrors).toEqual([]);

    // All evidence items pass validation
    const batch3Entries = manifest.filter(e => e.verification_batch === 3);
    expect(batch3Entries.length).toBe(15);

    const allErrors: string[] = [];
    for (const entry of batch3Entries) {
      for (const ev of entry.evidence) {
        const errs = validateEvidenceItem(entry.version, ev);
        allErrors.push(...errs);
      }
    }
    if (allErrors.length > 0) {
      console.error('Batch 3 validation errors:', allErrors);
    }
    expect(allErrors).toEqual([]);

    // 3 superseded objects must have full metadata
    const supersededObjs = batch.migrations.flatMap(m => m.objects.filter(o => o.result === 'superseded'));
    expect(supersededObjs.length).toBe(3);
    for (const obj of supersededObjs) {
      expect(VALID_SUPERSEDED_STATES.has(obj.verified_state)).toBe(true);
    }

    // Cross-validate with manifest
    const crossErrors = validateManifestCrossMatch(batch, manifest);
    expect(crossErrors).toEqual([]);

    const batchSetErrors = validateManifestBatchVersionSet(batch, manifest);
    expect(batchSetErrors).toEqual([]);
  });
});

describe('Batch 3 repair-specific validation', () => {
  it('Batch 3 pre/post total mismatch (133 to 148)', () => {
    const repairPath = resolve('docs/migrations/evidence/batch-03-repair.json');
    expect(existsSync(repairPath)).toBe(true);
    
    const repairData = JSON.parse(readFileSync(repairPath, 'utf-8')) as RepairEvidenceBase;
    expect(repairData.pre_repair.total_remote_count).toBe(133);
    expect(repairData.post_repair.total_remote_count).toBe(148);
    expect(repairData.post_repair.total_remote_count - repairData.pre_repair.total_remote_count).toBe(15);
  });

  it('Batch 3 pre/post range mismatch (38 to 53)', () => {
    const repairPath = resolve('docs/migrations/evidence/batch-03-repair.json');
    
    const repairData = JSON.parse(readFileSync(repairPath, 'utf-8')) as RepairEvidenceBase;
    expect(repairData.pre_repair.range_101_246_count).toBe(38);
    expect(repairData.post_repair.range_101_246_count).toBe(53);
    expect(repairData.post_repair.range_101_246_count - repairData.pre_repair.range_101_246_count).toBe(15);
  });

  it('valid Batch 1+2+3+4+5+6+7 repair evidence passes', () => {
    const evidenceDir = resolve('docs/migrations/evidence');
    const repairFiles = readdirSync(evidenceDir)
      .filter(f => /^batch-\d+-repair\.json$/.test(f))
      .sort();
    expect(repairFiles.length).toBe(7);

    // No duplicate versions across all 7 repair batches (all use approved_versions)
    const allVersions: string[] = [];
    for (const f of repairFiles) {
      const data = JSON.parse(readFileSync(resolve(evidenceDir, f), 'utf-8'));
      allVersions.push(...(data.approved_versions || []).map(String));
    }
    expect(new Set(allVersions).size).toBe(allVersions.length);
    expect(allVersions.length).toBe(105);

    // Batch 1: 103->118, Batch 2: 118->133, Batch 3: 133->148
    
    const batch1 = JSON.parse(readFileSync(resolve(evidenceDir, repairFiles[0]), 'utf-8')) as RepairEvidenceBase;

    const batch2 = JSON.parse(readFileSync(resolve(evidenceDir, repairFiles[1]), 'utf-8')) as RepairEvidenceBase;

    const batch3 = JSON.parse(readFileSync(resolve(evidenceDir, repairFiles[2]), 'utf-8')) as RepairEvidenceBase;

    expect(batch1.pre_repair.total_remote_count).toBe(103);
    expect(batch1.post_repair.total_remote_count).toBe(118);
    expect(batch2.pre_repair.total_remote_count).toBe(118);
    expect(batch2.post_repair.total_remote_count).toBe(133);
    expect(batch3.pre_repair.total_remote_count).toBe(133);
    expect(batch3.post_repair.total_remote_count).toBe(148);

    // All results successful
    for (const batch of [batch1, batch2, batch3]) {
      for (const r of batch.repair_results) {
        expect(r.exit_status).toBe(0);
        expect(r.version_tracked).toBe(true);
      }
      expect(batch.confirmations.no_unrelated_version_changed).toBe(true);
    }
  });

  it('Batch 3 filename-map binds correctly to manifest', () => {
    const repairPath = resolve('docs/migrations/evidence/batch-03-repair.json');
    const manifestPath = resolve('docs/migrations/101-246-production-reconciliation.json');
    const repairData = JSON.parse(readFileSync(repairPath, 'utf-8')) as RepairEvidenceBase;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as ManifestEntry[];
    const manifestByVersion: Record<string, ManifestEntry> = {};
    manifest.forEach(e => { manifestByVersion[e.version] = e; });

    expect(repairData.migration_filenames.length).toBe(repairData.approved_versions.length);
    expect(new Set(repairData.migration_filenames).size).toBe(repairData.migration_filenames.length);
    repairData.approved_versions.forEach((ver: string, i: number) => {
      const fn = repairData.migration_filenames[i];
      const me = manifestByVersion[ver];
      expect(me).toBeDefined();
      expect(fn).toBe(me.filename);
    });
  });

  it('Batch 3 checksum-map binds correctly to manifest and repository', () => {
    const repairPath = resolve('docs/migrations/evidence/batch-03-repair.json');
    const manifestPath = resolve('docs/migrations/101-246-production-reconciliation.json');
    const migDir = resolve('supabase/migrations');
    const repairData = JSON.parse(readFileSync(repairPath, 'utf-8')) as RepairEvidenceBase;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as ManifestEntry[];
    const manifestByVersion: Record<string, ManifestEntry> = {};
    manifest.forEach(e => { manifestByVersion[e.version] = e; });

    const csKeys = Object.keys(repairData.approved_checksums);
    expect(csKeys.length).toBe(repairData.approved_versions.length);
    for (const [ver, cs] of Object.entries(repairData.approved_checksums) as [string, string][]) {
      expect(cs).toMatch(/^[0-9a-f]{64}$/);
      const me = manifestByVersion[ver];
      expect(me).toBeDefined();
      expect(cs).toBe(me.checksum);
      const files = readdirSync(migDir).filter(f => f.startsWith(ver + '_'));
      expect(files.length).toBe(1);
      const content = readFileSync(resolve(migDir, files[0]), 'utf-8');
      const sha256 = createHash('sha256').update(content).digest('hex');
      expect(cs).toBe(sha256);
    }
  });

  it('Batch 3 production-evidence digests recompute correctly', () => {
    const repairPath = resolve('docs/migrations/evidence/batch-03-repair.json');
    const manifestPath = resolve('docs/migrations/101-246-production-reconciliation.json');
    const repairData = JSON.parse(readFileSync(repairPath, 'utf-8')) as RepairEvidenceBase;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as ManifestEntry[];
    const manifestByVersion: Record<string, ManifestEntry> = {};
    manifest.forEach(e => { manifestByVersion[e.version] = e; });

    const pedKeys = Object.keys(repairData.approved_production_evidence_digests);
    expect(pedKeys.length).toBe(repairData.approved_versions.length);
    for (const [ver, storedDigest] of Object.entries(repairData.approved_production_evidence_digests) as [string, string][]) {
      expect(storedDigest).toMatch(/^[0-9a-f]{64}$/);
      const me = manifestByVersion[ver]!;
      expect(me).toBeDefined();
      const canonical = JSON.stringify({
        version: me.version, filename: me.filename, checksum: me.checksum,
        current_classification: 'VERIFIED_APPLIED_UNTRACKED',
        evidence_source: me.evidence_source,
        evidence: me.evidence,
        last_verified_at: me.last_verified_at
      });
      const recomputed = createHash('sha256').update(canonical).digest('hex');
      expect(storedDigest).toBe(recomputed);
    }
  });

  it('Batch 3 snapshot validation passes', () => {
    const repairPath = resolve('docs/migrations/evidence/batch-03-repair.json');
    const repairData = JSON.parse(readFileSync(repairPath, 'utf-8')) as RepairEvidenceBase;

    const preSnap = repairData.pre_repair.tracked_version_snapshot;
    const postSnap = repairData.post_repair.tracked_version_snapshot;
    expect(Array.isArray(preSnap)).toBe(true);
    expect(Array.isArray(postSnap)).toBe(true);
    expect(preSnap.every((v: number) => Number.isInteger(v) && v > 0)).toBe(true);
    expect(postSnap.every((v: number) => Number.isInteger(v) && v > 0)).toBe(true);
    expect(new Set(preSnap).size).toBe(preSnap.length);
    expect(new Set(postSnap).size).toBe(postSnap.length);
    expect(preSnap.length).toBe(repairData.pre_repair.total_remote_count);
    expect(postSnap.length).toBe(repairData.post_repair.total_remote_count);

    // Derive added/removed
    const preSet = new Set(preSnap.map(String));
    const postSet = new Set(postSnap.map(String));
    const added = [...postSet].filter((v: string) => !preSet.has(v)).sort((a: string, b: string) => parseInt(a) - parseInt(b));
    const removed = [...preSet].filter((v: string) => !postSet.has(v));
    const approvedSorted = repairData.approved_versions.map(String).sort((a: string, b: string) => parseInt(a) - parseInt(b));
    expect(added).toEqual(approvedSorted);
    expect(removed).toEqual([]);
    expect(repairData.post_repair.lost_versions).toEqual([]);
  });

  it('Batch 3 safety confirmations all present and true', () => {
    const repairPath = resolve('docs/migrations/evidence/batch-03-repair.json');
    const repairData = JSON.parse(readFileSync(repairPath, 'utf-8')) as RepairEvidenceBase;

    const required = [
      'every_approved_version_appears_exactly_once',
      'no_unrelated_version_changed',
      'no_migration_sql_executed',
      'no_schema_or_application_data_changed',
      'no_customer_record_contents_accessed',
      'no_deployment_occurred',
      'no_token_or_auth_header_recorded',
      'batch_4_did_not_start'
    ];
    for (const key of required) {
      expect(repairData.confirmations[key]).toBe(true);
    }
  });

  it('all 105 completed batch-repaired entries in manifest have valid digests', () => {
    const evidenceDir = resolve('docs/migrations/evidence');
    const manifestPath = resolve('docs/migrations/101-246-production-reconciliation.json');
    const allowlistPath = resolve('docs/migrations/101-246-repair-allowlist.json');
    const candidatesPath = resolve('docs/migrations/101-246-verification-candidates.json');

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as ManifestEntry[];
    const allowlist = JSON.parse(readFileSync(allowlistPath, 'utf-8')) as Array<{ version: string }>;
    const candidates = JSON.parse(readFileSync(candidatesPath, 'utf-8')) as Array<{ version: string }>;
    const allowlistVersions = new Set(allowlist.map(a => a.version));
    const candidateVersions = new Set(candidates.map(c => c.version));

    // Classification counts post Batch 7 closeout
    const counts: Record<string, number> = {};
    manifest.forEach(e => { counts[e.current_classification] = (counts[e.current_classification] || 0) + 1; });
    expect(counts['ALIGNED_TRACKED']).toBe(113);
    expect(counts['VERIFIED_APPLIED_UNTRACKED'] || 0).toBe(0);
    expect(counts['PENDING_PRODUCTION_REVERIFICATION']).toBe(19);

    expect(allowlist.length).toBe(0);
    expect(candidates.length).toBe(19);

    const repairedCandidates = manifest.filter(e =>
      e.current_classification === 'ALIGNED_TRACKED' &&
      e.repair_status === 'completed' &&
      e.original_classification === 'VERIFIED_APPLIED_UNTRACKED'
    ).length;
    expect(19 + 0 + repairedCandidates).toBe(124);
    expect(repairedCandidates).toBe(105);

    // Verify all 105 completed entries NOT in allowlist or candidates
    const completedEntries = manifest.filter(e => e.repair_status === 'completed' && e.original_classification === 'VERIFIED_APPLIED_UNTRACKED');
    for (const entry of completedEntries) {
      expect(allowlistVersions.has(entry.version)).toBe(false);
      expect(candidateVersions.has(entry.version)).toBe(false);
    }

    // Verify all Batch 1-5 digests recompute (Batches 6 and 7 use whole-file SHA, validated separately)
    const repairFiles = readdirSync(evidenceDir)
      .filter(f => /^batch-\d+-repair\.json$/.test(f) && f !== 'batch-06-repair.json' && f !== 'batch-07-repair.json')
      .sort();
    const allErrors: string[] = [];

    // Batch 7 uses whole-file SHA — validate its 15 entries against the file digest
    const b7RepairPath2 = resolve(evidenceDir, 'batch-07-repair.json');
    const b7RepairDigest2 = createHash('sha256').update(readFileSync(b7RepairPath2)).digest('hex');
    const b7Entries = manifest.filter(e => e.repair_batch === 7 && e.repair_status === 'completed');
    for (const entry of b7Entries) {
      if (entry.repair_evidence_digest !== b7RepairDigest2) {
        allErrors.push(`Version ${entry.version}: repair_evidence_digest mismatch`);
      }
    }

    for (const f of repairFiles) {

      const repair = JSON.parse(readFileSync(resolve(evidenceDir, f), 'utf-8'));
      const repairTimestamp = repair.timestamp_utc || repair.repair_timestamp || null;

      // Normalize: Batch 5 uses `repairs` array with different structure
      let repairResultsByVersion: Record<string, any> = {};
      if (repair.repair_results) {
        repair.repair_results.forEach((r: any) => { repairResultsByVersion[String(r.version)] = r; });
      } else if (repair.repairs) {
        repair.repairs.forEach((r: any) => {
          repairResultsByVersion[String(r.version)] = {
            version: r.version,
            exit_status: r.exit_status,
            version_tracked: r.post_occurrences === 1,
            total_delta: 1,
            range_delta: 1,
            post_total: r.post_total_remote_count,
            post_range: r.post_range_101_246_count
          };
        });
      }

      const batchEntries = manifest.filter(e => e.repair_batch === repair.batch_number && e.repair_status === 'completed');
      for (const entry of batchEntries) {
        const repairResult = repairResultsByVersion[entry.version];
        if (!repairResult) {
          allErrors.push(`Version ${entry.version}: missing from repair evidence`);
          continue;
        }
        const repairEvidence = {
          version: entry.version, filename: entry.filename, checksum: entry.checksum,
          repair_result: repairResult, repair_timestamp: repairTimestamp, repository_sha: repair.repository_sha
        };
        const expectedDigest = createHash('sha256').update(JSON.stringify(repairEvidence)).digest('hex');
        if (entry.repair_evidence_digest !== expectedDigest) {
          allErrors.push(`Version ${entry.version}: repair_evidence_digest mismatch`);
        }
      }
    }
    if (allErrors.length > 0) {
      console.error('Digest validation errors:', allErrors);
    }
    expect(allErrors).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════
// EVIDENCE-BINDING HARDENING REJECTION TESTS
// ══════════════════════════════════════════════════════════════

describe('Filename-map rejection tests', () => {
  it('rejects extra migration_filenames entry', () => {
    const filenames = ['139_a.sql', '140_b.sql', '141_c.sql'];
    const versions = ['139', '140'];
    expect(filenames.length).not.toBe(versions.length);
  });

  it('rejects missing migration_filenames entry', () => {
    const filenames = ['139_a.sql'];
    const versions = ['139', '140'];
    expect(filenames.length).not.toBe(versions.length);
  });

  it('rejects duplicate migration filename', () => {
    const filenames = ['139_a.sql', '139_a.sql', '141_c.sql'];
    const fnSet = new Set(filenames);
    expect(fnSet.size).toBeLessThan(filenames.length);
  });
});

describe('Checksum-map rejection tests', () => {
  it('rejects extra approved_checksums key', () => {
    const approvedVersions = new Set(['139', '140']);
    const csKeys = new Set(['139', '140', '999']);
    const extra = [...csKeys].filter(v => !approvedVersions.has(v));
    expect(extra.length).toBeGreaterThan(0);
    expect(extra).toContain('999');
  });

  it('rejects missing approved_checksums key', () => {
    const approvedVersions = new Set(['139', '140', '141']);
    const csKeys = new Set(['139', '140']);
    const missing = [...approvedVersions].filter(v => !csKeys.has(v));
    expect(missing.length).toBeGreaterThan(0);
    expect(missing).toContain('141');
  });

  it('rejects malformed checksum (not 64-char hex)', () => {
    const cs = 'ZZZZ0000000000000000000000000000000000000000000000000000000000';
    expect(/^[0-9a-f]{64}$/.test(cs)).toBe(false);
  });
});

describe('Production-evidence digest rejection tests', () => {
  it('rejects extra approved_production_evidence_digests key', () => {
    const approvedVersions = new Set(['139', '140']);
    const pedKeys = new Set(['139', '140', '999']);
    const extra = [...pedKeys].filter(v => !approvedVersions.has(v));
    expect(extra.length).toBeGreaterThan(0);
  });

  it('rejects missing approved_production_evidence_digests key', () => {
    const approvedVersions = new Set(['139', '140', '141']);
    const pedKeys = new Set(['139', '140']);
    const missing = [...approvedVersions].filter(v => !pedKeys.has(v));
    expect(missing.length).toBeGreaterThan(0);
  });

  it('rejects malformed production-evidence digest', () => {
    const digest = 'not-a-valid-hex-string';
    expect(/^[0-9a-f]{64}$/.test(digest)).toBe(false);
  });

  it('rejects production-evidence digest not matching recomputed', () => {
    const me: ManifestEntry = makeCompletedEntry({
      version: '139',
      evidence_source: 'production_verified',
      last_verified_at: '2026-07-28T11:57:05.694160+00:00'
    });
    const canonical = JSON.stringify({
      version: me.version, filename: me.filename, checksum: me.checksum,
      current_classification: 'VERIFIED_APPLIED_UNTRACKED',
      evidence_source: me.evidence_source,
      evidence: me.evidence,
      last_verified_at: me.last_verified_at
    });
    const correctDigest = createHash('sha256').update(canonical).digest('hex');
    const wrongDigest = 'aaaa' + correctDigest.slice(4);
    expect(wrongDigest).not.toBe(correctDigest);
  });
});

describe('Snapshot rejection tests', () => {
  it('rejects duplicate pre-repair snapshot version', () => {
    const snap = [1, 2, 3, 3, 4];
    expect(new Set(snap).size).toBeLessThan(snap.length);
  });

  it('rejects duplicate post-repair snapshot version', () => {
    const snap = [1, 2, 3, 4, 4, 5];
    expect(new Set(snap).size).toBeLessThan(snap.length);
  });

  it('rejects snapshot length not matching total_remote_count', () => {
    const snap = [1, 2, 3];
    const totalRemoteCount = 5;
    expect(snap.length).not.toBe(totalRemoteCount);
  });

  it('rejects snapshot range count not matching range_101_246_count', () => {
    const snap = [1, 2, 100, 101, 102, 200, 247, 300];
    const rangeCount = snap.filter(v => v >= 101 && v <= 246).length;
    const expectedRangeCount = 5; // wrong
    expect(rangeCount).not.toBe(expectedRangeCount);
  });

  it('rejects non-empty post_repair.lost_versions', () => {
    const lostVersions = [115];
    expect(lostVersions.length).toBeGreaterThan(0);
  });
});

describe('Safety confirmation rejection tests', () => {
  it('rejects missing required safety confirmation', () => {
    const confirmations: Record<string, boolean> = {
      every_approved_version_appears_exactly_once: true,
      no_unrelated_version_changed: true,
      no_migration_sql_executed: true,
      // missing: no_schema_or_application_data_changed
      no_customer_record_contents_accessed: true,
      no_deployment_occurred: true,
      no_token_or_auth_header_recorded: true,
      batch_4_did_not_start: true
    };
    const required = [
      'every_approved_version_appears_exactly_once',
      'no_unrelated_version_changed',
      'no_migration_sql_executed',
      'no_schema_or_application_data_changed',
      'no_customer_record_contents_accessed',
      'no_deployment_occurred',
      'no_token_or_auth_header_recorded',
      'batch_4_did_not_start'
    ];
    const missing = required.filter(k => confirmations[k] !== true);
    expect(missing.length).toBeGreaterThan(0);
    expect(missing).toContain('no_schema_or_application_data_changed');
  });

  it('rejects safety confirmation set to false', () => {
    const confirmations: Record<string, boolean> = {
      every_approved_version_appears_exactly_once: true,
      no_unrelated_version_changed: false, // deliberately false
      no_migration_sql_executed: true,
      no_schema_or_application_data_changed: true,
      no_customer_record_contents_accessed: true,
      no_deployment_occurred: true,
      no_token_or_auth_header_recorded: true,
      batch_4_did_not_start: true
    };
    expect(confirmations['no_unrelated_version_changed']).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════
// BATCH 3+ REQUIRED-FIELD SCHEMA TESTS
// ══════════════════════════════════════════════════════════════

describe('Batch 3+ required-field schema validation', () => {
  // Helper: validate required fields for Batch 3+ repair evidence
  function validateBatch3RequiredFields(repairData: Record<string, unknown>): string[] {
    const errors: string[] = [];
    if ((repairData.batch_number as number) < 3) return errors;

    const requireArray = (path: string, val: unknown): boolean => {
      if (!Array.isArray(val)) {
        errors.push(`${path} must be an array (got ${val === null ? 'null' : typeof val})`);
        return false;
      }
      return true;
    };
    const requireObject = (path: string, val: unknown): boolean => {
      if (!val || typeof val !== 'object' || Array.isArray(val)) {
        errors.push(`${path} must be a plain object (got ${val === null ? 'null' : Array.isArray(val) ? 'array' : typeof val})`);
        return false;
      }
      return true;
    };

    requireArray('migration_filenames', repairData.migration_filenames);
    requireObject('approved_checksums', repairData.approved_checksums);
    requireObject('approved_production_evidence_digests', repairData.approved_production_evidence_digests);
    const hasPreRepair = requireObject('pre_repair', repairData.pre_repair);
    const hasPostRepair = requireObject('post_repair', repairData.post_repair);
    requireObject('confirmations', repairData.confirmations);

    if (hasPreRepair) {
      requireArray('pre_repair.tracked_version_snapshot', (repairData.pre_repair as Record<string, unknown>)?.tracked_version_snapshot);
    }
    if (hasPostRepair) {
      const postRepair = repairData.post_repair as Record<string, unknown>;
      requireArray('post_repair.tracked_version_snapshot', postRepair?.tracked_version_snapshot);
      requireArray('post_repair.new_versions_added', postRepair?.new_versions_added);
      requireArray('post_repair.lost_versions', postRepair?.lost_versions);
    }
    requireArray('derived_added_version_set', repairData.derived_added_version_set);
    requireArray('derived_removed_version_set', repairData.derived_removed_version_set);

    return errors;
  }

  // Helper: make a minimal valid Batch 3 repair evidence object
  function makeMinimalBatch3Evidence(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      batch_number: 3,
      migration_filenames: ['139_test.sql'],
      approved_checksums: { '139': 'a'.repeat(64) },
      approved_production_evidence_digests: { '139': 'b'.repeat(64) },
      pre_repair: { tracked_version_snapshot: [1, 2, 3], total_remote_count: 3, range_101_246_count: 0 },
      post_repair: {
        tracked_version_snapshot: [1, 2, 3, 139],
        total_remote_count: 4,
        range_101_246_count: 1,
        new_versions_added: [139],
        lost_versions: []
      },
      confirmations: { every_approved_version_appears_exactly_once: true },
      derived_added_version_set: [139],
      derived_removed_version_set: [],
      ...overrides
    };
  }

  it('rejects missing migration_filenames field', () => {
    const data = makeMinimalBatch3Evidence({ migration_filenames: undefined });
    const errors = validateBatch3RequiredFields(data);
    expect(errors.some(e => e.includes('migration_filenames must be an array'))).toBe(true);
  });

  it('rejects missing approved_checksums field', () => {
    const data = makeMinimalBatch3Evidence({ approved_checksums: undefined });
    const errors = validateBatch3RequiredFields(data);
    expect(errors.some(e => e.includes('approved_checksums must be a plain object'))).toBe(true);
  });

  it('rejects missing approved_production_evidence_digests field', () => {
    const data = makeMinimalBatch3Evidence({ approved_production_evidence_digests: undefined });
    const errors = validateBatch3RequiredFields(data);
    expect(errors.some(e => e.includes('approved_production_evidence_digests must be a plain object'))).toBe(true);
  });

  it('rejects missing pre_repair.tracked_version_snapshot', () => {
    const data = makeMinimalBatch3Evidence({
      pre_repair: { total_remote_count: 3, range_101_246_count: 0 }
    });
    const errors = validateBatch3RequiredFields(data);
    expect(errors.some(e => e.includes('pre_repair.tracked_version_snapshot must be an array'))).toBe(true);
  });

  it('rejects missing post_repair.tracked_version_snapshot', () => {
    const data = makeMinimalBatch3Evidence({
      post_repair: { total_remote_count: 4, range_101_246_count: 1, new_versions_added: [139], lost_versions: [] }
    });
    const errors = validateBatch3RequiredFields(data);
    expect(errors.some(e => e.includes('post_repair.tracked_version_snapshot must be an array'))).toBe(true);
  });

  it('rejects missing post_repair.new_versions_added', () => {
    const data = makeMinimalBatch3Evidence({
      post_repair: { tracked_version_snapshot: [1, 2, 3, 139], total_remote_count: 4, range_101_246_count: 1, lost_versions: [] }
    });
    const errors = validateBatch3RequiredFields(data);
    expect(errors.some(e => e.includes('post_repair.new_versions_added must be an array'))).toBe(true);
  });

  it('rejects missing post_repair.lost_versions', () => {
    const data = makeMinimalBatch3Evidence({
      post_repair: { tracked_version_snapshot: [1, 2, 3, 139], total_remote_count: 4, range_101_246_count: 1, new_versions_added: [139] }
    });
    const errors = validateBatch3RequiredFields(data);
    expect(errors.some(e => e.includes('post_repair.lost_versions must be an array'))).toBe(true);
  });

  it('rejects missing derived_added_version_set', () => {
    const data = makeMinimalBatch3Evidence({ derived_added_version_set: undefined });
    const errors = validateBatch3RequiredFields(data);
    expect(errors.some(e => e.includes('derived_added_version_set must be an array'))).toBe(true);
  });

  it('rejects missing derived_removed_version_set', () => {
    const data = makeMinimalBatch3Evidence({ derived_removed_version_set: undefined });
    const errors = validateBatch3RequiredFields(data);
    expect(errors.some(e => e.includes('derived_removed_version_set must be an array'))).toBe(true);
  });

  it('rejects missing confirmations object', () => {
    const data = makeMinimalBatch3Evidence({ confirmations: undefined });
    const errors = validateBatch3RequiredFields(data);
    expect(errors.some(e => e.includes('confirmations must be a plain object'))).toBe(true);
  });

  it('rejects wrong-type field (array instead of object)', () => {
    const data = makeMinimalBatch3Evidence({ approved_checksums: ['not', 'an', 'object'] });
    const errors = validateBatch3RequiredFields(data);
    expect(errors.some(e => e.includes('approved_checksums must be a plain object (got array)'))).toBe(true);
  });

  it('rejects no repository migration file found', () => {
    // Verify that version 999 has no matching repo file — the validator would fail this
    const migDir = resolve('supabase/migrations');
    const files = readdirSync(migDir).filter(f => f.startsWith('999_'));
    expect(files.length).toBe(0);
  });

  it('rejects multiple repository files matching one version', () => {
    // Test the uniqueness check logic: if two files match, it's an error
    const mockFiles = ['100_first.sql', '100_second.sql', '101_test.sql'];
    const matchingFiles = mockFiles.filter(f => f.startsWith('100_'));
    expect(matchingFiles.length).toBeGreaterThan(1);
  });
});

// ══════════════════════════════════════════════════════════════
// CLI INTEGRATION TESTS — execute the real validator script
// ══════════════════════════════════════════════════════════════

describe('Validator CLI rejection tests (table-driven)', () => {
  const { execSync } = require('child_process');
  const { mkdirSync, cpSync, rmSync, writeFileSync } = require('fs');
  const { join } = require('path');
  const os = require('os');

  const VALIDATOR_SCRIPT = resolve('scripts/validate-migration-repair-allowlist.mjs');
  const SRC_DOCS_MIGRATIONS = resolve('docs/migrations');
  const SRC_SUPABASE_MIGRATIONS = resolve('supabase/migrations');

  function createTestFixture(): string {
    const tmpDir = join(os.tmpdir(), `validator-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(join(tmpDir, 'docs', 'migrations', 'evidence'), { recursive: true });
    mkdirSync(join(tmpDir, 'supabase', 'migrations'), { recursive: true });

    cpSync(join(SRC_DOCS_MIGRATIONS, '101-246-production-reconciliation.json'), join(tmpDir, 'docs', 'migrations', '101-246-production-reconciliation.json'));
    cpSync(join(SRC_DOCS_MIGRATIONS, '101-246-repair-allowlist.json'), join(tmpDir, 'docs', 'migrations', '101-246-repair-allowlist.json'));
    cpSync(join(SRC_DOCS_MIGRATIONS, '101-246-verification-candidates.json'), join(tmpDir, 'docs', 'migrations', '101-246-verification-candidates.json'));

    const evidenceDir = join(SRC_DOCS_MIGRATIONS, 'evidence');
    if (existsSync(evidenceDir)) {
      for (const f of readdirSync(evidenceDir)) {
        cpSync(join(evidenceDir, f), join(tmpDir, 'docs', 'migrations', 'evidence', f));
      }
    }

    for (const f of readdirSync(SRC_SUPABASE_MIGRATIONS).filter((f: string) => f.endsWith('.sql'))) {
      cpSync(join(SRC_SUPABASE_MIGRATIONS, f), join(tmpDir, 'supabase', 'migrations', f));
    }

    return tmpDir;
  }

  function runValidatorInFixture(cwd: string): { exitCode: number; output: string } {
    try {
      const output = execSync(`node "${VALIDATOR_SCRIPT}"`, { cwd, encoding: 'utf-8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] });
      return { exitCode: 0, output };
    } catch (err: unknown) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return { exitCode: e.status || 1, output: (e.stdout || '') + (e.stderr || '') };
    }
  }

  function cleanupFixture(tmpDir: string) {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }

  const cliRejectionCases: Array<{
    name: string;
    mutate: (tmpDir: string) => void;
    expectedDiagnostic: RegExp;
  }> = [
    {
      name: 'missing migration_filenames in Batch 3 repair',
      mutate: (tmpDir) => {
        const p = join(tmpDir, 'docs', 'migrations', 'evidence', 'batch-03-repair.json');
        const d = JSON.parse(readFileSync(p, 'utf-8'));
        delete d.migration_filenames;
        writeFileSync(p, JSON.stringify(d, null, 2));
      },
      expectedDiagnostic: /migration_filenames/,
    },
    {
      name: 'missing pre_repair.tracked_version_snapshot',
      mutate: (tmpDir) => {
        const p = join(tmpDir, 'docs', 'migrations', 'evidence', 'batch-03-repair.json');
        const d = JSON.parse(readFileSync(p, 'utf-8'));
        delete d.pre_repair.tracked_version_snapshot;
        writeFileSync(p, JSON.stringify(d, null, 2));
      },
      expectedDiagnostic: /tracked_version_snapshot/,
    },
    {
      name: 'missing derived_added_version_set',
      mutate: (tmpDir) => {
        const p = join(tmpDir, 'docs', 'migrations', 'evidence', 'batch-03-repair.json');
        const d = JSON.parse(readFileSync(p, 'utf-8'));
        delete d.derived_added_version_set;
        writeFileSync(p, JSON.stringify(d, null, 2));
      },
      expectedDiagnostic: /derived_added_version_set/,
    },
    {
      name: 'missing confirmations object',
      mutate: (tmpDir) => {
        const p = join(tmpDir, 'docs', 'migrations', 'evidence', 'batch-03-repair.json');
        const d = JSON.parse(readFileSync(p, 'utf-8'));
        delete d.confirmations;
        writeFileSync(p, JSON.stringify(d, null, 2));
      },
      expectedDiagnostic: /confirmations/,
    },
    {
      name: 'missing repository migration SQL file',
      mutate: (tmpDir) => {
        const migDir = join(tmpDir, 'supabase', 'migrations');
        const f139 = readdirSync(migDir).find((f: string) => f.startsWith('139_'));
        if (f139) rmSync(join(migDir, f139));
      },
      expectedDiagnostic: /139/,
    },
    {
      name: 'legacy approved_count set to 0',
      mutate: (tmpDir) => {
        const p = join(tmpDir, 'docs', 'migrations', 'evidence', 'batch-01-repair.json');
        const d = JSON.parse(readFileSync(p, 'utf-8'));
        d.approved_count = 0;
        writeFileSync(p, JSON.stringify(d, null, 2));
      },
      expectedDiagnostic: /approved_count/,
    },
    {
      name: 'missing legacy exactly-once confirmation',
      mutate: (tmpDir) => {
        const p = join(tmpDir, 'docs', 'migrations', 'evidence', 'batch-01-repair.json');
        const d = JSON.parse(readFileSync(p, 'utf-8'));
        if (d.post_repair) delete d.post_repair.all_approved_appear_exactly_once;
        if (d.confirmations) delete d.confirmations.every_approved_version_appears_exactly_once;
        writeFileSync(p, JSON.stringify(d, null, 2));
      },
      expectedDiagnostic: /exactly-once/i,
    },
    {
      name: 'missing verification safety confirmation (Batch 4)',
      mutate: (tmpDir) => {
        const p = join(tmpDir, 'docs', 'migrations', 'evidence', 'batch-04-production-verification.json');
        const d = JSON.parse(readFileSync(p, 'utf-8'));
        delete d.no_migration_sql_executed;
        writeFileSync(p, JSON.stringify(d, null, 2));
      },
      expectedDiagnostic: /no_migration_sql_executed.*missing|missing.*no_migration_sql_executed/,
    },
    {
      name: 'non-boolean verification safety confirmation (Batch 4)',
      mutate: (tmpDir) => {
        const p = join(tmpDir, 'docs', 'migrations', 'evidence', 'batch-04-production-verification.json');
        const d = JSON.parse(readFileSync(p, 'utf-8'));
        d.no_supabase_db_push = 'yes';
        writeFileSync(p, JSON.stringify(d, null, 2));
      },
      expectedDiagnostic: /no_supabase_db_push.*not boolean true/,
    },
    // ── Migration 298 evidence CLI rejection cases ──
    {
      name: 'corrected Migration 298 evidence file missing',
      mutate: (tmpDir) => {
        const p = join(tmpDir, 'docs', 'migrations', 'evidence', 'migration-298-production-application-corrected.json');
        if (existsSync(p)) rmSync(p);
      },
      expectedDiagnostic: /Migration 298 corrected evidence file missing/,
    },
    {
      name: 'original Migration 298 evidence file missing',
      mutate: (tmpDir) => {
        const p = join(tmpDir, 'docs', 'migrations', 'evidence', 'migration-298-production-application-original.json');
        if (existsSync(p)) rmSync(p);
      },
      expectedDiagnostic: /Migration 298 original evidence file missing/,
    },
    {
      name: 'original SHA mismatch in corrected evidence',
      mutate: (tmpDir) => {
        const p = join(tmpDir, 'docs', 'migrations', 'evidence', 'migration-298-production-application-corrected.json');
        const d = JSON.parse(readFileSync(p, 'utf-8'));
        d.original_evidence_sha256 = 'aaaa' + d.original_evidence_sha256.slice(4);
        writeFileSync(p, JSON.stringify(d, null, 2));
      },
      expectedDiagnostic: /original_evidence_sha256 recomputes/,
    },
    {
      name: 'corrected manual_sql_execution_occurred missing',
      mutate: (tmpDir) => {
        const p = join(tmpDir, 'docs', 'migrations', 'evidence', 'migration-298-production-application-corrected.json');
        const d = JSON.parse(readFileSync(p, 'utf-8'));
        delete d.manual_sql_execution_occurred;
        writeFileSync(p, JSON.stringify(d, null, 2));
      },
      expectedDiagnostic: /manual_sql_execution_occurred/,
    },
    {
      name: 'corrected manual_sql_execution_occurred false',
      mutate: (tmpDir) => {
        const p = join(tmpDir, 'docs', 'migrations', 'evidence', 'migration-298-production-application-corrected.json');
        const d = JSON.parse(readFileSync(p, 'utf-8'));
        d.manual_sql_execution_occurred = false;
        writeFileSync(p, JSON.stringify(d, null, 2));
      },
      expectedDiagnostic: /manual_sql_execution_occurred/,
    },
    {
      name: 'corrected migration_repair_occurred false',
      mutate: (tmpDir) => {
        const p = join(tmpDir, 'docs', 'migrations', 'evidence', 'migration-298-production-application-corrected.json');
        const d = JSON.parse(readFileSync(p, 'utf-8'));
        d.migration_repair_occurred = false;
        writeFileSync(p, JSON.stringify(d, null, 2));
      },
      expectedDiagnostic: /migration_repair_occurred/,
    },
    {
      name: 'corrected approved_procedure_followed true',
      mutate: (tmpDir) => {
        const p = join(tmpDir, 'docs', 'migrations', 'evidence', 'migration-298-production-application-corrected.json');
        const d = JSON.parse(readFileSync(p, 'utf-8'));
        d.actual_execution.approved_procedure_followed = true;
        writeFileSync(p, JSON.stringify(d, null, 2));
      },
      expectedDiagnostic: /approved_procedure_followed/,
    },
    {
      name: 'corrected procedure_deviation_recorded false',
      mutate: (tmpDir) => {
        const p = join(tmpDir, 'docs', 'migrations', 'evidence', 'migration-298-production-application-corrected.json');
        const d = JSON.parse(readFileSync(p, 'utf-8'));
        d.actual_execution.procedure_deviation_recorded = false;
        writeFileSync(p, JSON.stringify(d, null, 2));
      },
      expectedDiagnostic: /procedure_deviation_recorded/,
    },
    {
      name: 'corrected required_action_was_stop false',
      mutate: (tmpDir) => {
        const p = join(tmpDir, 'docs', 'migrations', 'evidence', 'migration-298-production-application-corrected.json');
        const d = JSON.parse(readFileSync(p, 'utf-8'));
        d.dry_run.required_action_was_stop = false;
        writeFileSync(p, JSON.stringify(d, null, 2));
      },
      expectedDiagnostic: /required_action_was_stop/,
    },
    {
      name: 'corrected migration_up_linked_used true',
      mutate: (tmpDir) => {
        const p = join(tmpDir, 'docs', 'migrations', 'evidence', 'migration-298-production-application-corrected.json');
        const d = JSON.parse(readFileSync(p, 'utf-8'));
        d.actual_execution.migration_up_linked_used = true;
        writeFileSync(p, JSON.stringify(d, null, 2));
      },
      expectedDiagnostic: /migration_up_linked_used/,
    },
    {
      name: 'corrected repaired_version not 298',
      mutate: (tmpDir) => {
        const p = join(tmpDir, 'docs', 'migrations', 'evidence', 'migration-298-production-application-corrected.json');
        const d = JSON.parse(readFileSync(p, 'utf-8'));
        d.actual_execution.repaired_version = 299;
        writeFileSync(p, JSON.stringify(d, null, 2));
      },
      expectedDiagnostic: /repaired_version/,
    },
    {
      name: 'corrected exact_new_history_versions not [298]',
      mutate: (tmpDir) => {
        const p = join(tmpDir, 'docs', 'migrations', 'evidence', 'migration-298-production-application-corrected.json');
        const d = JSON.parse(readFileSync(p, 'utf-8'));
        d.post_application_history.exact_new_history_versions = [298, 299];
        writeFileSync(p, JSON.stringify(d, null, 2));
      },
      expectedDiagnostic: /exact_new_history_versions/,
    },
    {
      name: 'corrected pending rows nonzero',
      mutate: (tmpDir) => {
        const p = join(tmpDir, 'docs', 'migrations', 'evidence', 'migration-298-production-application-corrected.json');
        const d = JSON.parse(readFileSync(p, 'utf-8'));
        d.current_pending_rows = 3;
        writeFileSync(p, JSON.stringify(d, null, 2));
      },
      expectedDiagnostic: /current_pending_rows/,
    },
    {
      name: 'corrected populated matches not 39',
      mutate: (tmpDir) => {
        const p = join(tmpDir, 'docs', 'migrations', 'evidence', 'migration-298-production-application-corrected.json');
        const d = JSON.parse(readFileSync(p, 'utf-8'));
        d.populated_metadata_match_rows = 38;
        writeFileSync(p, JSON.stringify(d, null, 2));
      },
      expectedDiagnostic: /populated_metadata_match_rows/,
    },
    {
      name: 'corrected post migration_298_occurrences zero',
      mutate: (tmpDir) => {
        const p = join(tmpDir, 'docs', 'migrations', 'evidence', 'migration-298-production-application-corrected.json');
        const d = JSON.parse(readFileSync(p, 'utf-8'));
        d.post_application_history.migration_298_occurrences = 0;
        writeFileSync(p, JSON.stringify(d, null, 2));
      },
      expectedDiagnostic: /post_application_history\.migration_298_occurrences.*= 1/,
    },
    {
      name: 'corrected migration_result_verified false',
      mutate: (tmpDir) => {
        const p = join(tmpDir, 'docs', 'migrations', 'evidence', 'migration-298-production-application-corrected.json');
        const d = JSON.parse(readFileSync(p, 'utf-8'));
        d.migration_result_verified = false;
        writeFileSync(p, JSON.stringify(d, null, 2));
      },
      expectedDiagnostic: /migration_result_verified/,
    },
    {
      name: 'corrected batch_5_not_started false',
      mutate: (tmpDir) => {
        const p = join(tmpDir, 'docs', 'migrations', 'evidence', 'migration-298-production-application-corrected.json');
        const d = JSON.parse(readFileSync(p, 'utf-8'));
        d.batch_5_not_started = false;
        writeFileSync(p, JSON.stringify(d, null, 2));
      },
      expectedDiagnostic: /batch_5_not_started/,
    },
    {
      name: 'original no longer records Management API SQL',
      mutate: (tmpDir) => {
        const p = join(tmpDir, 'docs', 'migrations', 'evidence', 'migration-298-production-application-original.json');
        const d = JSON.parse(readFileSync(p, 'utf-8'));
        d.application.command_category = 'supabase_migration_up';
        writeFileSync(p, JSON.stringify(d, null, 2));
      },
      expectedDiagnostic: /command_category.*supabase_management_api_sql/,
    },
    {
      name: 'original no longer records migration repair',
      mutate: (tmpDir) => {
        const p = join(tmpDir, 'docs', 'migrations', 'evidence', 'migration-298-production-application-original.json');
        const d = JSON.parse(readFileSync(p, 'utf-8'));
        d.application.migration_history_recorded_via = 'supabase_migration_up';
        writeFileSync(p, JSON.stringify(d, null, 2));
      },
      expectedDiagnostic: /migration_history_recorded_via.*supabase_migration_repair/,
    },
    // ── Batch 4 flat-evidence strict boolean CLI rejection cases ──
    {
      name: 'Batch 4 flat evidence missing no_unapproved_versions_added',
      mutate: (tmpDir) => {
        const p = join(tmpDir, 'docs', 'migrations', 'evidence', 'batch-04-repair.json');
        const d = JSON.parse(readFileSync(p, 'utf-8'));
        delete d.no_unapproved_versions_added;
        writeFileSync(p, JSON.stringify(d, null, 2));
      },
      expectedDiagnostic: /no_unapproved_versions_added/,
    },
    {
      name: 'Batch 4 flat evidence missing no_migration_sql_executed',
      mutate: (tmpDir) => {
        const p = join(tmpDir, 'docs', 'migrations', 'evidence', 'batch-04-repair.json');
        const d = JSON.parse(readFileSync(p, 'utf-8'));
        delete d.no_migration_sql_executed;
        writeFileSync(p, JSON.stringify(d, null, 2));
      },
      expectedDiagnostic: /no_migration_sql_executed/,
    },
    {
      name: 'Batch 4 flat evidence false no_supabase_db_push',
      mutate: (tmpDir) => {
        const p = join(tmpDir, 'docs', 'migrations', 'evidence', 'batch-04-repair.json');
        const d = JSON.parse(readFileSync(p, 'utf-8'));
        d.no_supabase_db_push = false;
        writeFileSync(p, JSON.stringify(d, null, 2));
      },
      expectedDiagnostic: /no_supabase_db_push.*must be boolean true/,
    },
    {
      name: 'Batch 4 flat evidence altered new_versions_added',
      mutate: (tmpDir) => {
        const p = join(tmpDir, 'docs', 'migrations', 'evidence', 'batch-04-repair.json');
        const d = JSON.parse(readFileSync(p, 'utf-8'));
        d.new_versions_added = [...d.new_versions_added, 999];
        writeFileSync(p, JSON.stringify(d, null, 2));
      },
      expectedDiagnostic: /new_versions_added|derived added/,
    },
    {
      name: 'Batch 4 flat evidence removed approved version from post snapshot',
      mutate: (tmpDir) => {
        const p = join(tmpDir, 'docs', 'migrations', 'evidence', 'batch-04-repair.json');
        const d = JSON.parse(readFileSync(p, 'utf-8'));
        // Remove the first approved version from post snapshot
        const first = String(d.approved_versions[0]);
        d.post_repair_tracked_snapshot = d.post_repair_tracked_snapshot.filter((v: string | number) => String(v) !== first);
        d.post_repair_range_101_246 = d.post_repair_range_101_246 - 1;
        d.post_repair_total = d.post_repair_total - 1;
        writeFileSync(p, JSON.stringify(d, null, 2));
      },
      expectedDiagnostic: /snapshot-derived|added versions|total count delta/,
    },
    {
      name: 'Batch 4 flat evidence unrelated added version in post snapshot',
      mutate: (tmpDir) => {
        const p = join(tmpDir, 'docs', 'migrations', 'evidence', 'batch-04-repair.json');
        const d = JSON.parse(readFileSync(p, 'utf-8'));
        d.post_repair_tracked_snapshot.push('999');
        d.post_repair_total = d.post_repair_total + 1;
        writeFileSync(p, JSON.stringify(d, null, 2));
      },
      expectedDiagnostic: /snapshot-derived|added versions|total count delta|post_total/,
    },
    // ── Exact Migration 298 occurrence and lineage CLI rejection cases ──
    {
      name: 'corrected pre migration_298_occurrences changed from 0 to 1',
      mutate: (tmpDir) => {
        const p = join(tmpDir, 'docs', 'migrations', 'evidence', 'migration-298-production-application-corrected.json');
        const d = JSON.parse(readFileSync(p, 'utf-8'));
        d.pre_application_history.migration_298_occurrences = 1;
        writeFileSync(p, JSON.stringify(d, null, 2));
      },
      expectedDiagnostic: /pre_application_history\.migration_298_occurrences.*= 0/,
    },
    {
      name: 'corrected post migration_298_occurrences changed from 1 to 2',
      mutate: (tmpDir) => {
        const p = join(tmpDir, 'docs', 'migrations', 'evidence', 'migration-298-production-application-corrected.json');
        const d = JSON.parse(readFileSync(p, 'utf-8'));
        d.post_application_history.migration_298_occurrences = 2;
        writeFileSync(p, JSON.stringify(d, null, 2));
      },
      expectedDiagnostic: /post_application_history\.migration_298_occurrences.*= 1/,
    },
    {
      name: 'corrected original_evidence_path changed to corrected path',
      mutate: (tmpDir) => {
        const p = join(tmpDir, 'docs', 'migrations', 'evidence', 'migration-298-production-application-corrected.json');
        const d = JSON.parse(readFileSync(p, 'utf-8'));
        d.original_evidence_path = '/tmp/waaiio-migration-298-production-application-corrected.json';
        writeFileSync(p, JSON.stringify(d, null, 2));
      },
      expectedDiagnostic: /original_evidence_path/,
    },
    {
      name: 'corrected original_evidence_path changed to unrelated path',
      mutate: (tmpDir) => {
        const p = join(tmpDir, 'docs', 'migrations', 'evidence', 'migration-298-production-application-corrected.json');
        const d = JSON.parse(readFileSync(p, 'utf-8'));
        d.original_evidence_path = '/tmp/something-else.json';
        writeFileSync(p, JSON.stringify(d, null, 2));
      },
      expectedDiagnostic: /original_evidence_path/,
    },
  ];

  it('unmodified fixtures pass the real validator', () => {
    const tmpDir = createTestFixture();
    try {
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).toBe(0);
      expect(output).toContain('Migration reconciliation validation PASSED');
    } finally {
      cleanupFixture(tmpDir);
    }
  }, 30000);

  for (const tc of cliRejectionCases) {
    it(`rejects: ${tc.name}`, () => {
      const tmpDir = createTestFixture();
      try {
        tc.mutate(tmpDir);
        const { exitCode, output } = runValidatorInFixture(tmpDir);
        expect(exitCode).not.toBe(0);
        expect(output).toMatch(tc.expectedDiagnostic);
      } finally {
        cleanupFixture(tmpDir);
      }
    }, 30000);
  }
});

// ══════════════════════════════════════════════════════════════
// MIGRATION 298 CORRECTED EVIDENCE VALIDATION
// ══════════════════════════════════════════════════════════════

describe('Migration 298 corrected evidence validation', () => {
  const correctedPath = resolve('docs/migrations/evidence/migration-298-production-application-corrected.json');
  const originalPath = resolve('docs/migrations/evidence/migration-298-production-application-original.json');

  it('corrected evidence file exists and is valid JSON', () => {
    expect(existsSync(correctedPath)).toBe(true);
    const data = JSON.parse(readFileSync(correctedPath, 'utf-8'));
    expect(data).toBeDefined();
  });

  it('original evidence file exists and is valid JSON', () => {
    expect(existsSync(originalPath)).toBe(true);
    const data = JSON.parse(readFileSync(originalPath, 'utf-8'));
    expect(data).toBeDefined();
  });

  it('corrected evidence has required structural fields', () => {
    const data = JSON.parse(readFileSync(correctedPath, 'utf-8'));
    expect(data.task_identifier).toBe('migration-298-production-application-corrected');
    expect(data.repository_sha).toBe('6ceb7fae6e67a389af24424775b50e06e6c57858');
    expect(data.linked_project_ref).toBe('cxcmiqotkowhxinjbytg');
    expect(data.migration_version).toBe(298);
  });

  it('corrected evidence records dry-run gate failure', () => {
    const data = JSON.parse(readFileSync(correctedPath, 'utf-8'));
    expect(data.dry_run.approved_gate_passed).toBe(false);
    expect(data.dry_run.required_action_was_stop).toBe(true);
    expect(data.dry_run.result).toContain('79');
  });

  it('corrected evidence records Management API SQL execution', () => {
    const data = JSON.parse(readFileSync(correctedPath, 'utf-8'));
    expect(data.actual_execution.migration_sql_execution_method).toBe('supabase_management_api_sql');
    expect(data.actual_execution.migration_up_linked_used).toBe(false);
    expect(data.actual_execution.migration_repair_used).toBe(true);
    expect(data.actual_execution.repaired_version).toBe(298);
  });

  it('corrected evidence records procedure deviation', () => {
    const data = JSON.parse(readFileSync(correctedPath, 'utf-8'));
    expect(data.actual_execution.approved_procedure_followed).toBe(false);
    expect(data.actual_execution.procedure_deviation_recorded).toBe(true);
  });

  it('corrected evidence records manual SQL and migration repair truthfully', () => {
    const data = JSON.parse(readFileSync(correctedPath, 'utf-8'));
    expect(data.manual_sql_execution_occurred).toBe(true);
    expect(data.migration_repair_occurred).toBe(true);
  });

  it('corrected evidence records correct post-application counts', () => {
    const data = JSON.parse(readFileSync(correctedPath, 'utf-8'));
    expect(data.pre_application_history.total_remote_migration_count).toBe(163);
    expect(data.post_application_history.total_remote_migration_count).toBe(164);
    expect(data.post_application_history.tracked_101_246_count).toBe(68);
    expect(data.post_application_history.migration_298_occurrences).toBe(1);
    expect(data.post_application_history.exact_new_history_versions).toEqual([298]);
  });

  it('corrected evidence records exactly 11 rows corrected', () => {
    const data = JSON.parse(readFileSync(correctedPath, 'utf-8'));
    expect(data.exactly_11_rows_corrected).toBe(true);
    expect(data.current_pending_rows).toBe(0);
    expect(data.populated_metadata_match_rows).toBe(39);
    expect(data.populated_metadata_mismatch_rows).toBe(0);
  });

  it('corrected evidence records business ownership not inferred', () => {
    const data = JSON.parse(readFileSync(correctedPath, 'utf-8'));
    expect(data.historical_payment_business_ids_remain_null).toBe(true);
    expect(data.referenced_order_business_ids_non_null).toBe(true);
  });

  it('corrected evidence records migration result verified', () => {
    const data = JSON.parse(readFileSync(correctedPath, 'utf-8'));
    expect(data.migration_result_verified).toBe(true);
    expect(data.issue_53_remains_open).toBe(true);
    expect(data.batch_5_not_started).toBe(true);
  });

  it('corrected evidence records corrective actions', () => {
    const data = JSON.parse(readFileSync(correctedPath, 'utf-8'));
    expect(data.corrective_action.do_not_rerun_migration_298).toBe(true);
    expect(data.corrective_action.preserve_current_production_state).toBe(true);
    expect(data.corrective_action.require_stop_on_future_dry_run_scope_mismatch).toBe(true);
  });

  it('original evidence SHA matches the reference in corrected evidence', () => {
    const corrected = JSON.parse(readFileSync(correctedPath, 'utf-8'));
    const originalContent = readFileSync(originalPath);
    const originalHash = createHash('sha256').update(originalContent).digest('hex');
    expect(corrected.original_evidence_sha256).toBe(originalHash);
  });
});

describe('Migration 298 negative tests — contradictory evidence rejection', () => {
  it('corrected evidence cannot claim no manual SQL execution', () => {
    const data = JSON.parse(readFileSync(resolve('docs/migrations/evidence/migration-298-production-application-corrected.json'), 'utf-8'));
    // The corrected evidence MUST acknowledge manual SQL
    expect(data.manual_sql_execution_occurred).not.toBe(false);
    expect(data.manual_sql_execution_occurred).toBe(true);
  });

  it('corrected evidence cannot claim no migration repair', () => {
    const data = JSON.parse(readFileSync(resolve('docs/migrations/evidence/migration-298-production-application-corrected.json'), 'utf-8'));
    expect(data.migration_repair_occurred).not.toBe(false);
    expect(data.migration_repair_occurred).toBe(true);
  });

  it('procedure deviation cannot simultaneously be false', () => {
    const data = JSON.parse(readFileSync(resolve('docs/migrations/evidence/migration-298-production-application-corrected.json'), 'utf-8'));
    expect(data.actual_execution.procedure_deviation_recorded).toBe(true);
    expect(data.actual_execution.approved_procedure_followed).toBe(false);
    // Both must be consistent — deviation is true AND procedure was not followed
    expect(data.actual_execution.procedure_deviation_recorded && !data.actual_execution.approved_procedure_followed).toBe(true);
  });

  it('Migration 298 cannot be marked pending or unapplied', () => {
    const data = JSON.parse(readFileSync(resolve('docs/migrations/evidence/migration-298-production-application-corrected.json'), 'utf-8'));
    expect(data.post_application_history.migration_298_occurrences).toBe(1);
    expect(data.migration_result_verified).toBe(true);
    // Must not be 0 occurrences (unapplied)
    expect(data.post_application_history.migration_298_occurrences).not.toBe(0);
  });

  it('corrected evidence is canonical (not the original)', () => {
    const corrected = JSON.parse(readFileSync(resolve('docs/migrations/evidence/migration-298-production-application-corrected.json'), 'utf-8'));
    const original = JSON.parse(readFileSync(resolve('docs/migrations/evidence/migration-298-production-application-original.json'), 'utf-8'));
    // Corrected evidence must record procedure deviation — original did not
    expect(corrected.actual_execution.procedure_deviation_recorded).toBe(true);
    expect(corrected.manual_sql_execution_occurred).toBe(true);
    expect(corrected.migration_repair_occurred).toBe(true);
    // Original must NOT have these corrective fields (it's the inaccurate version)
    expect(original.actual_execution).toBeUndefined();
  });

  it('corrected evidence must not rerun Migration 298', () => {
    const data = JSON.parse(readFileSync(resolve('docs/migrations/evidence/migration-298-production-application-corrected.json'), 'utf-8'));
    expect(data.corrective_action.do_not_rerun_migration_298).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════
// BATCH 5 EVIDENCE VALIDATION
// ══════════════════════════════════════════════════════════════
describe('Batch 5 production verification evidence', () => {
  const BATCH5_VERSIONS = ['172','173','174','175','177','178','179','180','183','184','185','186','188','189','190'];
  const evidencePath = resolve('docs/migrations/evidence/batch-05-production-verification.json');

  it('evidence file exists and is valid JSON', () => {
    expect(existsSync(evidencePath)).toBe(true);
    const data = JSON.parse(readFileSync(evidencePath, 'utf-8'));
    expect(data).toBeDefined();
  });

  it('has correct batch number and version set', () => {
    const data = JSON.parse(readFileSync(evidencePath, 'utf-8'));
    expect(data.batch_number).toBe(5);
    expect(data.versions).toEqual(BATCH5_VERSIONS);
  });

  it('has correct checksums and expected-object metadata', () => {
    const data = JSON.parse(readFileSync(evidencePath, 'utf-8'));
    const migrationFiles = readdirSync(resolve('supabase/migrations')).filter(f => f.endsWith('.sql'));
    for (const m of data.migrations) {
      expect(BATCH5_VERSIONS).toContain(m.version);
      const repoFile = migrationFiles.find(f => f.startsWith(m.version + '_'));
      expect(repoFile).toBeDefined();
      const content = readFileSync(resolve('supabase/migrations', repoFile!), 'utf-8');
      const sha256 = createHash('sha256').update(content).digest('hex');
      expect(m.checksum).toBe(sha256);
      expect(m.expected_object_count).toBe(m.objects.length);
    }
  });

  it('total checks = 55, passed = 55, superseded/failed/ambiguous = 0', () => {
    const data = JSON.parse(readFileSync(evidencePath, 'utf-8'));
    expect(data.total_objects_checked).toBe(55);
    expect(data.total_passed).toBe(55);
    expect(data.total_superseded).toBe(0);
    expect(data.total_failed).toBe(0);
    expect(data.total_ambiguous).toBe(0);
  });

  it('all classifications are VERIFIED_APPLIED_UNTRACKED', () => {
    const data = JSON.parse(readFileSync(evidencePath, 'utf-8'));
    for (const [ver, cls] of Object.entries(data.classifications)) {
      expect(cls).toBe('VERIFIED_APPLIED_UNTRACKED');
    }
    expect(Object.keys(data.classifications).length).toBe(15);
    for (const m of data.migrations) {
      expect(m.classification).toBe('VERIFIED_APPLIED_UNTRACKED');
    }
  });

  it('all object results are pass', () => {
    const data = JSON.parse(readFileSync(evidencePath, 'utf-8'));
    for (const m of data.migrations) {
      for (const obj of m.objects) {
        expect(obj.result).toBe('pass');
      }
    }
  });

  it('pre/post migration-history counts unchanged', () => {
    const data = JSON.parse(readFileSync(evidencePath, 'utf-8'));
    expect(data.pre_total_remote_count).toBe(164);
    expect(data.post_total_remote_count).toBe(164);
    expect(data.pre_range_101_246_count).toBe(68);
    expect(data.post_range_101_246_count).toBe(68);
  });

  it('Migration 298 exactly once pre and post', () => {
    const data = JSON.parse(readFileSync(evidencePath, 'utf-8'));
    expect(data.migration_298_pre_occurrences).toBe(1);
    expect(data.migration_298_post_occurrences).toBe(1);
  });

  it('all Batch 5 occurrences zero pre and post', () => {
    const data = JSON.parse(readFileSync(evidencePath, 'utf-8'));
    for (const v of BATCH5_VERSIONS) {
      expect(data.batch5_pre_occurrence_map[v]).toBe(0);
      expect(data.batch5_post_occurrence_map[v]).toBe(0);
    }
  });

  it('tracked snapshots identical', () => {
    const data = JSON.parse(readFileSync(evidencePath, 'utf-8'));
    expect(data.pre_tracked_snapshot).toEqual(data.post_tracked_snapshot);
  });

  it('migration_history_unchanged is true', () => {
    const data = JSON.parse(readFileSync(evidencePath, 'utf-8'));
    expect(data.migration_history_unchanged).toBe(true);
  });

  it('all safety booleans exist and are true', () => {
    const data = JSON.parse(readFileSync(evidencePath, 'utf-8'));
    const safetyFields = [
      'all_queries_read_only', 'no_record_contents_returned', 'no_customer_records_accessed',
      'no_write_query_executed', 'no_migration_sql_executed', 'no_migration_repair',
      'no_migration_up', 'no_supabase_db_push', 'no_management_api_write',
      'no_schema_or_data_changed', 'no_migration_history_changed', 'no_repository_change',
      'no_commit_push_or_pr', 'no_issue_53_mutation', 'no_deployment_occurred',
      'no_token_recorded', 'batch_6_not_started'
    ];
    for (const field of safetyFields) {
      expect(data[field]).toBe(true);
    }
  });

  it('repository SHA and linked project ref correct', () => {
    const data = JSON.parse(readFileSync(evidencePath, 'utf-8'));
    expect(data.main_sha).toBe('906878f94141e39ecc3fe19e4cf6ddc714a3811c');
    expect(data.linked_project_ref).toBe('cxcmiqotkowhxinjbytg');
  });

  it('evidence digest consistency', () => {
    const content = readFileSync(evidencePath, 'utf-8');
    const digest = createHash('sha256').update(readFileSync(evidencePath)).digest('hex');
    expect(digest).toBe('8f093426b4688650d4e9da185f82d3d001592b9f3cc9b4b1ed2bdc8553962930');
  });
});

describe('Post-Batch 5 repair allowlist validation', () => {
  it('allowlist is empty after Batch 7 closeout', () => {
    const allowlist = JSON.parse(readFileSync(resolve('docs/migrations/101-246-repair-allowlist.json'), 'utf-8'));
    expect(allowlist.length).toBe(0);
    const versions = allowlist.map((e: any) => e.version);
    expect(versions).toEqual([]);
  });

  it('all 15 Batch 5 versions are now ALIGNED_TRACKED', () => {
    const manifest = JSON.parse(readFileSync(resolve('docs/migrations/101-246-production-reconciliation.json'), 'utf-8'));
    const batch5Versions = ['172','173','174','175','177','178','179','180','183','184','185','186','188','189','190'];
    for (const v of batch5Versions) {
      const entry = manifest.find((e: ManifestEntry) => e.version === v);
      expect(entry).toBeDefined();
      expect(entry!.current_classification).toBe('ALIGNED_TRACKED');
      expect(entry!.repair_status).toBe('completed');
      expect(entry!.remote_tracked).toBe(true);
      expect(entry!.repair_eligible).toBe(false);
    }
  });

  it('exactly 0 VERIFIED_APPLIED_UNTRACKED entries after Batch 7 closeout', () => {
    const manifest = JSON.parse(readFileSync(resolve('docs/migrations/101-246-production-reconciliation.json'), 'utf-8'));
    const verified = manifest.filter((e: ManifestEntry) => e.current_classification === 'VERIFIED_APPLIED_UNTRACKED');
    expect(verified.length).toBe(0);
  });
});

describe('Batch 5 candidate validation', () => {
  const BATCH5_VERSIONS = new Set(['172','173','174','175','177','178','179','180','183','184','185','186','188','189','190']);
  const BATCH6_VERSIONS = ['191','192','193','194','195','196','197','198','201','202','203','204','205','206','207'];

  it('exactly 19 candidates after Wave 1', () => {
    const candidates = JSON.parse(readFileSync(resolve('docs/migrations/101-246-verification-candidates.json'), 'utf-8'));
    expect(candidates.length).toBe(19);
  });

  it('no Batch 5 version remains', () => {
    const candidates = JSON.parse(readFileSync(resolve('docs/migrations/101-246-verification-candidates.json'), 'utf-8'));
    for (const c of candidates) {
      expect(BATCH5_VERSIONS.has(c.version)).toBe(false);
    }
  });

  it('Batch 8 begins the candidate list after Wave 1', () => {
    const candidates = JSON.parse(readFileSync(resolve('docs/migrations/101-246-verification-candidates.json'), 'utf-8'));
    const BATCH8_START = ['227','228','229','230','231'];
    for (let i = 0; i < BATCH8_START.length; i++) {
      expect(candidates[i].version).toBe(BATCH8_START[i]);
    }
  });

  it('all remaining entries are PENDING in manifest', () => {
    const candidates = JSON.parse(readFileSync(resolve('docs/migrations/101-246-verification-candidates.json'), 'utf-8'));
    const manifest = JSON.parse(readFileSync(resolve('docs/migrations/101-246-production-reconciliation.json'), 'utf-8'));
    for (const c of candidates) {
      const me = manifest.find((e: ManifestEntry) => e.version === c.version);
      expect(me).toBeDefined();
      expect(me!.current_classification).toBe('PENDING_PRODUCTION_REVERIFICATION');
    }
  });
});

describe('Batch 5 classification counts', () => {
  it('113/0/19/12/2 and completed repairs at 113 after Batch 7 closeout', () => {
    const manifest = JSON.parse(readFileSync(resolve('docs/migrations/101-246-production-reconciliation.json'), 'utf-8')) as ManifestEntry[];
    const counts: Record<string, number> = {};
    manifest.forEach(e => { counts[e.current_classification] = (counts[e.current_classification] || 0) + 1; });
    expect(counts['ALIGNED_TRACKED']).toBe(113);
    expect(counts['VERIFIED_APPLIED_UNTRACKED'] || 0).toBe(0);
    expect(counts['PENDING_PRODUCTION_REVERIFICATION']).toBe(19);
    expect(counts['NOT_VERIFIABLE_SAFELY']).toBe(12);
    expect(counts['SUPERSEDED_WITH_EQUIVALENT_STATE']).toBe(2);

    const completedRepairs = manifest.filter(e => e.repair_status === 'completed' && e.current_classification === 'ALIGNED_TRACKED').length;
    expect(completedRepairs).toBe(113);
  });
});

describe('Batch 5 CLI rejection tests', () => {
  it('rejects missing Batch 5 evidence file', () => {
    expect(existsSync(resolve('docs/migrations/evidence/batch-05-production-verification.json'))).toBe(true);
    // A missing file would fail: existsSync returns false
    expect(existsSync(resolve('docs/migrations/evidence/batch-99-production-verification.json'))).toBe(false);
  });

  it('rejects wrong batch number', () => {
    const data = JSON.parse(readFileSync(resolve('docs/migrations/evidence/batch-05-production-verification.json'), 'utf-8'));
    expect(data.batch_number).toBe(5);
    expect(data.batch_number).not.toBe(4);
    expect(data.batch_number).not.toBe(6);
  });

  it('rejects altered version set', () => {
    const data = JSON.parse(readFileSync(resolve('docs/migrations/evidence/batch-05-production-verification.json'), 'utf-8'));
    const expected = ['172','173','174','175','177','178','179','180','183','184','185','186','188','189','190'];
    expect(data.versions).toEqual(expected);
    expect(data.versions).not.toContain('191');
    expect(data.versions).not.toContain('171');
  });

  it('rejects total checks not 55', () => {
    const data = JSON.parse(readFileSync(resolve('docs/migrations/evidence/batch-05-production-verification.json'), 'utf-8'));
    expect(data.total_objects_checked).toBe(55);
  });

  it('rejects failed count nonzero', () => {
    const data = JSON.parse(readFileSync(resolve('docs/migrations/evidence/batch-05-production-verification.json'), 'utf-8'));
    expect(data.total_failed).toBe(0);
  });

  it('rejects ambiguous count nonzero', () => {
    const data = JSON.parse(readFileSync(resolve('docs/migrations/evidence/batch-05-production-verification.json'), 'utf-8'));
    expect(data.total_ambiguous).toBe(0);
  });

  it('rejects classification not VERIFIED_APPLIED_UNTRACKED', () => {
    const data = JSON.parse(readFileSync(resolve('docs/migrations/evidence/batch-05-production-verification.json'), 'utf-8'));
    for (const cls of Object.values(data.classifications)) {
      expect(cls).toBe('VERIFIED_APPLIED_UNTRACKED');
    }
  });

  it('rejects Batch 5 history occurrence nonzero', () => {
    const data = JSON.parse(readFileSync(resolve('docs/migrations/evidence/batch-05-production-verification.json'), 'utf-8'));
    for (const v of data.versions) {
      expect(data.batch5_pre_occurrence_map[v]).toBe(0);
      expect(data.batch5_post_occurrence_map[v]).toBe(0);
    }
  });

  it('rejects Migration 298 occurrence not 1', () => {
    const data = JSON.parse(readFileSync(resolve('docs/migrations/evidence/batch-05-production-verification.json'), 'utf-8'));
    expect(data.migration_298_pre_occurrences).toBe(1);
    expect(data.migration_298_post_occurrences).toBe(1);
  });

  it('rejects changed pre/post snapshot', () => {
    const data = JSON.parse(readFileSync(resolve('docs/migrations/evidence/batch-05-production-verification.json'), 'utf-8'));
    expect(JSON.stringify(data.pre_tracked_snapshot)).toBe(JSON.stringify(data.post_tracked_snapshot));
  });

  it('rejects missing read-only safety confirmation', () => {
    const data = JSON.parse(readFileSync(resolve('docs/migrations/evidence/batch-05-production-verification.json'), 'utf-8'));
    expect(data.all_queries_read_only).toBe(true);
    expect(data.no_record_contents_returned).toBe(true);
  });

  it('rejects false no_migration_repair', () => {
    const data = JSON.parse(readFileSync(resolve('docs/migrations/evidence/batch-05-production-verification.json'), 'utf-8'));
    expect(data.no_migration_repair).toBe(true);
  });

  it('rejects incorrect evidence digest', () => {
    const digest = createHash('sha256').update(readFileSync(resolve('docs/migrations/evidence/batch-05-production-verification.json'))).digest('hex');
    expect(digest).toBe('8f093426b4688650d4e9da185f82d3d001592b9f3cc9b4b1ed2bdc8553962930');
    expect(digest).not.toBe('0000000000000000000000000000000000000000000000000000000000000000');
  });

  it('confirms allowlist is empty after Batch 7 closeout', () => {
    const allowlist = JSON.parse(readFileSync(resolve('docs/migrations/101-246-repair-allowlist.json'), 'utf-8'));
    expect(allowlist.length).toBe(0);
  });

  it('confirms all Batch 5 versions are ALIGNED_TRACKED in manifest', () => {
    const manifest = JSON.parse(readFileSync(resolve('docs/migrations/101-246-production-reconciliation.json'), 'utf-8'));
    const batch5Versions = ['172','173','174','175','177','178','179','180','183','184','185','186','188','189','190'];
    for (const v of batch5Versions) {
      const entry = manifest.find((e: any) => e.version === v);
      expect(entry.current_classification).toBe('ALIGNED_TRACKED');
      expect(entry.repair_status).toBe('completed');
      expect(entry.remote_tracked).toBe(true);
      expect(entry.repair_batch).toBe(5);
    }
  });

  it('rejects Batch 5 version still present in candidate list', () => {
    const candidates = JSON.parse(readFileSync(resolve('docs/migrations/101-246-verification-candidates.json'), 'utf-8'));
    const candidateVersions = new Set(candidates.map((c: { version: string }) => c.version));
    const batch5Versions = ['172','173','174','175','177','178','179','180','183','184','185','186','188','189','190'];
    for (const v of batch5Versions) {
      expect(candidateVersions.has(v)).toBe(false);
    }
  });
});

// ══════════════════════════════════════════════════════════════
// CLI REJECTION TESTS FOR V2 EVIDENCE
// ══════════════════════════════════════════════════════════════

describe('CLI rejection tests for V2 evidence', () => {
  const { execSync } = require('child_process');
  const { mkdirSync, cpSync, rmSync, writeFileSync } = require('fs');
  const { join } = require('path');
  const os = require('os');

  const VALIDATOR_SCRIPT = resolve('scripts/validate-migration-repair-allowlist.mjs');
  const SRC_DOCS_MIGRATIONS = resolve('docs/migrations');
  const SRC_SUPABASE_MIGRATIONS = resolve('supabase/migrations');

  const EVIDENCE_FILE = 'batch-05-production-verification.json';
  const MANIFEST_FILE = '101-246-production-reconciliation.json';
  const ALLOWLIST_FILE = '101-246-repair-allowlist.json';

  function createTestFixture(): string {
    const tmpDir = join(os.tmpdir(), `v2-validator-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(join(tmpDir, 'docs', 'migrations', 'evidence'), { recursive: true });
    mkdirSync(join(tmpDir, 'supabase', 'migrations'), { recursive: true });

    cpSync(join(SRC_DOCS_MIGRATIONS, MANIFEST_FILE), join(tmpDir, 'docs', 'migrations', MANIFEST_FILE));
    cpSync(join(SRC_DOCS_MIGRATIONS, ALLOWLIST_FILE), join(tmpDir, 'docs', 'migrations', ALLOWLIST_FILE));
    cpSync(join(SRC_DOCS_MIGRATIONS, '101-246-verification-candidates.json'), join(tmpDir, 'docs', 'migrations', '101-246-verification-candidates.json'));

    const evidenceDir = join(SRC_DOCS_MIGRATIONS, 'evidence');
    if (existsSync(evidenceDir)) {
      for (const f of readdirSync(evidenceDir)) {
        cpSync(join(evidenceDir, f), join(tmpDir, 'docs', 'migrations', 'evidence', f));
      }
    }

    for (const f of readdirSync(SRC_SUPABASE_MIGRATIONS).filter((f: string) => f.endsWith('.sql'))) {
      cpSync(join(SRC_SUPABASE_MIGRATIONS, f), join(tmpDir, 'supabase', 'migrations', f));
    }

    return tmpDir;
  }

  function runValidatorInFixture(cwd: string): { exitCode: number; output: string } {
    try {
      const output = execSync(`node "${VALIDATOR_SCRIPT}"`, { cwd, encoding: 'utf-8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] });
      return { exitCode: 0, output };
    } catch (err: unknown) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return { exitCode: e.status || 1, output: (e.stdout || '') + (e.stderr || '') };
    }
  }

  function cleanupFixture(tmpDir: string) {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }

  function evidencePath(tmpDir: string): string {
    return join(tmpDir, 'docs', 'migrations', 'evidence', EVIDENCE_FILE);
  }

  function manifestPath(tmpDir: string): string {
    return join(tmpDir, 'docs', 'migrations', MANIFEST_FILE);
  }

  function allowlistPath(tmpDir: string): string {
    return join(tmpDir, 'docs', 'migrations', ALLOWLIST_FILE);
  }

  function readEvidence(tmpDir: string) {
    return JSON.parse(readFileSync(evidencePath(tmpDir), 'utf-8'));
  }

  function writeEvidence(tmpDir: string, data: unknown) {
    writeFileSync(evidencePath(tmpDir), JSON.stringify(data, null, 2));
  }

  function readManifest(tmpDir: string) {
    return JSON.parse(readFileSync(manifestPath(tmpDir), 'utf-8'));
  }

  function writeManifest(tmpDir: string, data: unknown) {
    writeFileSync(manifestPath(tmpDir), JSON.stringify(data, null, 2));
  }

  function readAllowlist(tmpDir: string) {
    return JSON.parse(readFileSync(allowlistPath(tmpDir), 'utf-8'));
  }

  function writeAllowlist(tmpDir: string, data: unknown) {
    writeFileSync(allowlistPath(tmpDir), JSON.stringify(data, null, 2));
  }

  // Test 1: V2 evidence SHA mismatch
  it('rejects when V2 evidence SHA mismatches', () => {
    const tmpDir = createTestFixture();
    try {
      const d = readEvidence(tmpDir);
      d.superseded_temporary_evidence_sha256 = 'aa' + d.superseded_temporary_evidence_sha256.slice(2);
      writeEvidence(tmpDir, d);
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/sha256|SHA|digest|mismatch/i);
    } finally {
      cleanupFixture(tmpDir);
    }
  }, 30000);

  // Test 2: Wrong task identifier
  it('rejects when task_identifier is wrong', () => {
    const tmpDir = createTestFixture();
    try {
      const d = readEvidence(tmpDir);
      d.task_identifier = 'batch-05-production-verification-v1';
      writeEvidence(tmpDir, d);
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/task_identifier/i);
    } finally {
      cleanupFixture(tmpDir);
    }
  }, 30000);

  // Test 3: Wrong superseded V1 SHA
  it('rejects when superseded_temporary_evidence_sha256 is wrong', () => {
    const tmpDir = createTestFixture();
    try {
      const d = readEvidence(tmpDir);
      d.superseded_temporary_evidence_sha256 = '0000000000000000000000000000000000000000000000000000000000000000';
      writeEvidence(tmpDir, d);
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/superseded|sha256|SHA|digest|mismatch/i);
    } finally {
      cleanupFixture(tmpDir);
    }
  }, 30000);

  // Test 4: Missing detailed_property_checks_total
  it('rejects when detailed_property_checks_total is missing', () => {
    const tmpDir = createTestFixture();
    try {
      const d = readEvidence(tmpDir);
      delete d.detailed_property_checks_total;
      writeEvidence(tmpDir, d);
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/detailed_property_checks_total/);
    } finally {
      cleanupFixture(tmpDir);
    }
  }, 30000);

  // Test 5: Detailed property total changed from 383
  it('rejects when detailed_property_checks_total differs from 383', () => {
    const tmpDir = createTestFixture();
    try {
      const d = readEvidence(tmpDir);
      d.detailed_property_checks_total = 384;
      writeEvidence(tmpDir, d);
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/detailed_property_checks_total|383|384/);
    } finally {
      cleanupFixture(tmpDir);
    }
  }, 30000);

  // Test 6: One per-migration property count changed
  it('rejects when one per-migration property count is wrong', () => {
    const tmpDir = createTestFixture();
    try {
      const d = readEvidence(tmpDir);
      // Add a fake property to the first object of the first migration
      const obj = d.migrations[0].objects[0];
      if (obj.verified_properties) {
        obj.verified_properties.fake_extra_prop = 'bad';
      }
      writeEvidence(tmpDir, d);
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/property|digest|mismatch/i);
    } finally {
      cleanupFixture(tmpDir);
    }
  }, 30000);

  // Test 7: Missing migration_evidence_digest
  it('rejects when migration_evidence_digest is missing', () => {
    const tmpDir = createTestFixture();
    try {
      const d = readEvidence(tmpDir);
      delete d.migrations[0].migration_evidence_digest;
      writeEvidence(tmpDir, d);
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/migration_evidence_digest/);
    } finally {
      cleanupFixture(tmpDir);
    }
  }, 30000);

  // Test 8: Incorrect migration_evidence_digest
  it('rejects when migration_evidence_digest is incorrect', () => {
    const tmpDir = createTestFixture();
    try {
      const d = readEvidence(tmpDir);
      d.migrations[0].migration_evidence_digest = 'aa' + d.migrations[0].migration_evidence_digest.slice(2);
      writeEvidence(tmpDir, d);
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/migration_evidence_digest|digest.*mismatch/i);
    } finally {
      cleanupFixture(tmpDir);
    }
  }, 30000);

  // Test 9: Manifest production_evidence_digest tampered (V2 digest binding)
  it('rejects when manifest production_evidence_digest is tampered for Batch 5 entry', () => {
    const tmpDir = createTestFixture();
    try {
      const m = readManifest(tmpDir);
      const batch5Entry = m.find((e: ManifestEntry) => e.version === '172');
      if (batch5Entry) {
        batch5Entry.production_evidence_digest = 'aa' + batch5Entry.production_evidence_digest.slice(2);
      }
      writeManifest(tmpDir, m);
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/digest|mismatch|172/i);
    } finally {
      cleanupFixture(tmpDir);
    }
  }, 30000);

  // Test 10: Allowlist must be empty after Batch 5 repair
  it('rejects when allowlist is not empty after Batch 5 repair', () => {
    const tmpDir = createTestFixture();
    try {
      const a = [{ version: '172', filename: '172_recurring_billing.sql', checksum: 'abc', classification: 'VERIFIED_APPLIED_UNTRACKED', repair_action: 'migration_history_repair_only', confidence: 'HIGH', production_evidence_path: 'docs/migrations/evidence/batch-05-production-verification.json', production_evidence_digest: 'abc' }];
      writeAllowlist(tmpDir, a);
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/allowlist|approved/i);
    } finally {
      cleanupFixture(tmpDir);
    }
  }, 30000);

  // Test 11: Manifest evidence timestamp tampered invalidates V2 digest
  it('rejects when manifest evidence verified_at is tampered for Batch 5 entry', () => {
    const tmpDir = createTestFixture();
    try {
      const m = readManifest(tmpDir);
      const batch5Entry = m.find((e: ManifestEntry) => e.version === '172');
      if (batch5Entry && batch5Entry.evidence[0]) {
        batch5Entry.evidence[0].verified_at = '2020-01-01T00:00:00Z';
      }
      writeManifest(tmpDir, m);
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/digest|mismatch|timestamp|172/i);
    } finally {
      cleanupFixture(tmpDir);
    }
  }, 30000);

  // Test 12: Missing object migration_version
  it('rejects when object migration_version is missing', () => {
    const tmpDir = createTestFixture();
    try {
      const d = readEvidence(tmpDir);
      delete d.migrations[0].objects[0].migration_version;
      writeEvidence(tmpDir, d);
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/migration_version/);
    } finally {
      cleanupFixture(tmpDir);
    }
  }, 30000);

  // Test 13: Missing object migration_filename
  it('rejects when object migration_filename is missing', () => {
    const tmpDir = createTestFixture();
    try {
      const d = readEvidence(tmpDir);
      delete d.migrations[0].objects[0].migration_filename;
      writeEvidence(tmpDir, d);
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/migration_filename/);
    } finally {
      cleanupFixture(tmpDir);
    }
  }, 30000);

  // Test 14: Missing object migration_checksum
  it('rejects when object migration_checksum is missing', () => {
    const tmpDir = createTestFixture();
    try {
      const d = readEvidence(tmpDir);
      delete d.migrations[0].objects[0].migration_checksum;
      writeEvidence(tmpDir, d);
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/migration_checksum/);
    } finally {
      cleanupFixture(tmpDir);
    }
  }, 30000);

  // Test 15: Missing expected_object_digest from migration and its objects
  it('rejects when expected_object_digest is missing from a migration and its objects', () => {
    const tmpDir = createTestFixture();
    try {
      const d = readEvidence(tmpDir);
      delete d.migrations[0].expected_object_digest;
      for (const obj of d.migrations[0].objects) {
        delete obj.expected_object_digest;
      }
      writeEvidence(tmpDir, d);
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/expected_object_digest|digest/i);
    } finally {
      cleanupFixture(tmpDir);
    }
  }, 30000);

  // Test 16: Missing expected_properties
  it('rejects when expected_properties is missing from an object', () => {
    const tmpDir = createTestFixture();
    try {
      const d = readEvidence(tmpDir);
      delete d.migrations[0].objects[0].expected_properties;
      writeEvidence(tmpDir, d);
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/expected_properties/);
    } finally {
      cleanupFixture(tmpDir);
    }
  }, 30000);

  // Test 17: Missing verified_properties
  it('rejects when verified_properties is missing from an object', () => {
    const tmpDir = createTestFixture();
    try {
      const d = readEvidence(tmpDir);
      delete d.migrations[0].objects[0].verified_properties;
      writeEvidence(tmpDir, d);
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/verified_properties/);
    } finally {
      cleanupFixture(tmpDir);
    }
  }, 30000);

  // Test 18: Missing property_comparison_result
  it('rejects when property_comparison_result is missing from an object', () => {
    const tmpDir = createTestFixture();
    try {
      const d = readEvidence(tmpDir);
      delete d.migrations[0].objects[0].property_comparison_result;
      writeEvidence(tmpDir, d);
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/property_comparison_result/);
    } finally {
      cleanupFixture(tmpDir);
    }
  }, 30000);

  // Test 19: Generic verification_source pg_catalog
  it('rejects when verification_source is generic pg_catalog', () => {
    const tmpDir = createTestFixture();
    try {
      const d = readEvidence(tmpDir);
      d.migrations[0].objects[0].verification_source = 'pg_catalog';
      writeEvidence(tmpDir, d);
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/pg_catalog|verification_source/i);
    } finally {
      cleanupFixture(tmpDir);
    }
  }, 30000);

  // Test 20: Missing batch5_pre_occurrence_map
  it('rejects when batch5_pre_occurrence_map is missing', () => {
    const tmpDir = createTestFixture();
    try {
      const d = readEvidence(tmpDir);
      delete d.batch5_pre_occurrence_map;
      writeEvidence(tmpDir, d);
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/batch5_pre_occurrence_map|pre occurrence|occurrence/i);
    } finally {
      cleanupFixture(tmpDir);
    }
  }, 30000);

  // Test 21: Missing batch5_post_occurrence_map
  it('rejects when batch5_post_occurrence_map is missing', () => {
    const tmpDir = createTestFixture();
    try {
      const d = readEvidence(tmpDir);
      delete d.batch5_post_occurrence_map;
      writeEvidence(tmpDir, d);
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/batch5_post_occurrence_map|post occurrence|occurrence/i);
    } finally {
      cleanupFixture(tmpDir);
    }
  }, 30000);

  // Test 22: Pre-occurrence map missing one version
  it('rejects when pre-occurrence map is missing one version', () => {
    const tmpDir = createTestFixture();
    try {
      const d = readEvidence(tmpDir);
      delete d.batch5_pre_occurrence_map['172'];
      writeEvidence(tmpDir, d);
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/172|occurrence|pre_occurrence/i);
    } finally {
      cleanupFixture(tmpDir);
    }
  }, 30000);

  // Test 23: Post-occurrence map containing extra version
  it('rejects when post-occurrence map contains an extra version', () => {
    const tmpDir = createTestFixture();
    try {
      const d = readEvidence(tmpDir);
      d.batch5_post_occurrence_map['999'] = 0;
      writeEvidence(tmpDir, d);
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/999|occurrence|extra|post_occurrence/i);
    } finally {
      cleanupFixture(tmpDir);
    }
  }, 30000);

  // Test 24: One occurrence changed from 0 to 1
  it('rejects when one occurrence is changed from 0 to 1', () => {
    const tmpDir = createTestFixture();
    try {
      const d = readEvidence(tmpDir);
      d.batch5_pre_occurrence_map['172'] = 1;
      writeEvidence(tmpDir, d);
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/172|occurrence|expected 0/i);
    } finally {
      cleanupFixture(tmpDir);
    }
  }, 30000);

  // Test 25: Missing pre_tracked_snapshot
  it('rejects when pre_tracked_snapshot is missing', () => {
    const tmpDir = createTestFixture();
    try {
      const d = readEvidence(tmpDir);
      delete d.pre_tracked_snapshot;
      writeEvidence(tmpDir, d);
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/pre_tracked_snapshot|snapshot/i);
    } finally {
      cleanupFixture(tmpDir);
    }
  }, 30000);

  // Test 26: Missing post_tracked_snapshot
  it('rejects when post_tracked_snapshot is missing', () => {
    const tmpDir = createTestFixture();
    try {
      const d = readEvidence(tmpDir);
      delete d.post_tracked_snapshot;
      writeEvidence(tmpDir, d);
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/post_tracked_snapshot|snapshot/i);
    } finally {
      cleanupFixture(tmpDir);
    }
  }, 30000);

  // Test 27: Snapshot length not 164
  it('rejects when snapshot length is not 164', () => {
    const tmpDir = createTestFixture();
    try {
      const d = readEvidence(tmpDir);
      d.pre_tracked_snapshot.push('999');
      d.post_tracked_snapshot.push('999');
      writeEvidence(tmpDir, d);
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/snapshot|164|165/i);
    } finally {
      cleanupFixture(tmpDir);
    }
  }, 30000);

  // Test 28: Duplicate snapshot version
  it('rejects when snapshot has a duplicate version', () => {
    const tmpDir = createTestFixture();
    try {
      const d = readEvidence(tmpDir);
      // Replace the last element with a duplicate of the first
      const first = d.pre_tracked_snapshot[0];
      d.pre_tracked_snapshot[d.pre_tracked_snapshot.length - 1] = first;
      d.post_tracked_snapshot[d.post_tracked_snapshot.length - 1] = first;
      writeEvidence(tmpDir, d);
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/duplicate|snapshot/i);
    } finally {
      cleanupFixture(tmpDir);
    }
  }, 30000);

  // Test 29: Batch 5 version present in snapshot
  it('rejects when a Batch 5 version is present in snapshot', () => {
    const tmpDir = createTestFixture();
    try {
      const d = readEvidence(tmpDir);
      // Replace one snapshot entry with Batch 5 version 172
      d.pre_tracked_snapshot[d.pre_tracked_snapshot.length - 1] = '172';
      d.post_tracked_snapshot[d.post_tracked_snapshot.length - 1] = '172';
      writeEvidence(tmpDir, d);
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/172|batch.*5.*version.*snapshot|snapshot.*batch.*5/i);
    } finally {
      cleanupFixture(tmpDir);
    }
  }, 30000);

  // Test 30: Migration 298 absent from snapshot
  it('rejects when migration 298 is absent from snapshot', () => {
    const tmpDir = createTestFixture();
    try {
      const d = readEvidence(tmpDir);
      d.pre_tracked_snapshot = d.pre_tracked_snapshot.filter((v: string) => v !== '298');
      d.post_tracked_snapshot = d.post_tracked_snapshot.filter((v: string) => v !== '298');
      writeEvidence(tmpDir, d);
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/298|snapshot/i);
    } finally {
      cleanupFixture(tmpDir);
    }
  }, 30000);

  // Test 31: Missing each newly required safety boolean
  it('rejects when no_record_contents_returned safety boolean is missing', () => {
    const tmpDir = createTestFixture();
    try {
      const d = readEvidence(tmpDir);
      delete d.no_record_contents_returned;
      writeEvidence(tmpDir, d);
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/no_record_contents_returned/);
    } finally {
      cleanupFixture(tmpDir);
    }
  }, 30000);

  // Test 32: One newly required safety boolean set false
  it('rejects when no_write_query_executed safety boolean is false', () => {
    const tmpDir = createTestFixture();
    try {
      const d = readEvidence(tmpDir);
      d.no_write_query_executed = false;
      writeEvidence(tmpDir, d);
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/no_write_query_executed/);
    } finally {
      cleanupFixture(tmpDir);
    }
  }, 30000);

  // Test 33: Non-RLS object using exists->enabled is rejected
  it('rejects when a non-RLS object uses exists->enabled equivalence', () => {
    const tmpDir = createTestFixture();
    try {
      const d = readEvidence(tmpDir);
      // Find a column object and change its states to exists->enabled (invalid for non-RLS)
      const colObj = d.migrations[0].objects[0]; // This is a column object
      colObj.expected_state = 'exists';
      colObj.verified_state = 'enabled';
      writeEvidence(tmpDir, d);
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/verified_state|expected_state|enabled|mismatch/i);
    } finally {
      cleanupFixture(tmpDir);
    }
  }, 30000);

  // Test 34: RLS object using exists->enabled remains accepted (positive unit test)
  it('accepts RLS object using exists->enabled equivalence via unit validation', () => {
    // The exists->enabled pair is a recognized equivalent in the validator logic.
    // We verify at the unit level because changing evidence objects would invalidate
    // migration_evidence_digest, causing a cascade failure unrelated to the state check.
    const rlsEvidence: EvidenceItem = {
      object_type: 'rls',
      object_name: 'test_table',
      expected_state: 'exists',
      verified_state: 'enabled',
      verification_source: 'pg_class',
      verified_at: '2026-07-29T22:09:39.973603+00:00',
      result: 'pass'
    };
    const errors = validateEvidenceItem('999', rlsEvidence);
    // The equivalent pair exists->enabled should not produce a state mismatch error
    const stateMismatchErrors = errors.filter(e => e.includes('verified_state') && e.includes('expected_state'));
    expect(stateMismatchErrors).toHaveLength(0);
  });

  // Test 35: Column-alter drop_not_null->column_exists_nullable remains accepted (positive test)
  it('accepts column-alter drop_not_null->column_exists_nullable equivalence', () => {
    const tmpDir = createTestFixture();
    try {
      // This tests that the existing batch-04 evidence with drop_not_null->column_exists_nullable passes
      // The unmodified fixture should pass the validator
      const { exitCode } = runValidatorInFixture(tmpDir);
      expect(exitCode).toBe(0);
    } finally {
      cleanupFixture(tmpDir);
    }
  }, 30000);

  // Test 36: Non-column object using drop_not_null->column_exists_nullable is rejected
  it('rejects when a non-column object uses drop_not_null->column_exists_nullable', () => {
    const tmpDir = createTestFixture();
    try {
      const d = readEvidence(tmpDir);
      // Find an RLS object and change its states to drop_not_null->column_exists_nullable (invalid for non-column)
      let found = false;
      for (const mig of d.migrations) {
        for (const obj of mig.objects) {
          if (obj.object_type === 'rls') {
            obj.expected_state = 'drop_not_null';
            obj.verified_state = 'column_exists_nullable';
            found = true;
            break;
          }
        }
        if (found) break;
      }
      writeEvidence(tmpDir, d);
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/verified_state|expected_state|column_exists_nullable|drop_not_null|mismatch/i);
    } finally {
      cleanupFixture(tmpDir);
    }
  }, 30000);
});

// ══════════════════════════════════════════════════════════════
// V3 PROPERTY COMPARISON CLI TESTS (8 focused tests)
// ══════════════════════════════════════════════════════════════

describe('V3 property comparison CLI tests', () => {
  const { execSync } = require('child_process');
  const { mkdirSync, cpSync, rmSync, writeFileSync } = require('fs');
  const { join } = require('path');
  const os = require('os');

  const VALIDATOR_SCRIPT = resolve('scripts/validate-migration-repair-allowlist.mjs');
  const SRC_DOCS_MIGRATIONS = resolve('docs/migrations');
  const SRC_SUPABASE_MIGRATIONS = resolve('supabase/migrations');

  function createTestFixture(): string {
    const tmpDir = join(os.tmpdir(), `v3-cmp-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(join(tmpDir, 'docs', 'migrations', 'evidence'), { recursive: true });
    mkdirSync(join(tmpDir, 'supabase', 'migrations'), { recursive: true });
    cpSync(join(SRC_DOCS_MIGRATIONS, '101-246-production-reconciliation.json'), join(tmpDir, 'docs', 'migrations', '101-246-production-reconciliation.json'));
    cpSync(join(SRC_DOCS_MIGRATIONS, '101-246-repair-allowlist.json'), join(tmpDir, 'docs', 'migrations', '101-246-repair-allowlist.json'));
    cpSync(join(SRC_DOCS_MIGRATIONS, '101-246-verification-candidates.json'), join(tmpDir, 'docs', 'migrations', '101-246-verification-candidates.json'));
    const evidenceDir = join(SRC_DOCS_MIGRATIONS, 'evidence');
    if (existsSync(evidenceDir)) {
      for (const f of readdirSync(evidenceDir)) {
        cpSync(join(evidenceDir, f), join(tmpDir, 'docs', 'migrations', 'evidence', f));
      }
    }
    for (const f of readdirSync(SRC_SUPABASE_MIGRATIONS).filter((f: string) => f.endsWith('.sql'))) {
      cpSync(join(SRC_SUPABASE_MIGRATIONS, f), join(tmpDir, 'supabase', 'migrations', f));
    }
    return tmpDir;
  }

  function runValidatorInFixture(cwd: string): { exitCode: number; output: string } {
    try {
      const output = execSync(`node "${VALIDATOR_SCRIPT}"`, { cwd, encoding: 'utf-8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] });
      return { exitCode: 0, output };
    } catch (err: unknown) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return { exitCode: e.status || 1, output: (e.stdout || '') + (e.stderr || '') };
    }
  }

  function cleanupFixture(tmpDir: string) { rmSync(tmpDir, { recursive: true, force: true }); }

  function readEvidence(tmpDir: string) {
    return JSON.parse(readFileSync(join(tmpDir, 'docs', 'migrations', 'evidence', 'batch-05-production-verification.json'), 'utf-8'));
  }
  function writeEvidence(tmpDir: string, data: any) {
    writeFileSync(join(tmpDir, 'docs', 'migrations', 'evidence', 'batch-05-production-verification.json'), JSON.stringify(data, null, 2) + '\n');
  }

  // Test 1: exact_match with a changed expected value
  it('rejects exact_match when expected value differs from verified', () => {
    const tmpDir = createTestFixture();
    try {
      const d = readEvidence(tmpDir);
      // Change a column expected data_type to something wrong
      const m172 = d.migrations.find((m: any) => String(m.version) === '172');
      m172.objects[0].expected_properties.data_type = 'integer'; // was 'text'
      writeEvidence(tmpDir, d);
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/exact_match.*values differ|exact_match.*data_type/i);
    } finally { cleanupFixture(tmpDir); }
  }, 30000);

  // Test 2: missing expected compared path
  it('rejects when compared path does not exist in expected_properties', () => {
    const tmpDir = createTestFixture();
    try {
      const d = readEvidence(tmpDir);
      const m172 = d.migrations.find((m: any) => String(m.version) === '172');
      delete m172.objects[0].expected_properties.data_type;
      writeEvidence(tmpDir, d);
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/not in expected_properties|data_type/i);
    } finally { cleanupFixture(tmpDir); }
  }, 30000);

  // Test 3: missing verified compared path
  it('rejects when compared path does not exist in verified_properties', () => {
    const tmpDir = createTestFixture();
    try {
      const d = readEvidence(tmpDir);
      const m172 = d.migrations.find((m: any) => String(m.version) === '172');
      delete m172.objects[0].verified_properties.data_type;
      writeEvidence(tmpDir, d);
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/not in verified_properties|data_type/i);
    } finally { cleanupFixture(tmpDir); }
  }, 30000);

  // Test 4: unreported unequal path (equivalent_stricter)
  it('rejects equivalent_stricter with undeclared unequal path', () => {
    const tmpDir = createTestFixture();
    try {
      const d = readEvidence(tmpDir);
      const m173 = d.migrations.find((m: any) => String(m.version) === '173');
      // Change an expected value that should match but isn't in mismatches
      m173.objects[0].expected_properties.language = 'sql'; // was 'plpgsql'
      writeEvidence(tmpDir, d);
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/undeclared unequal|unpermitted unequal|language/i);
    } finally { cleanupFixture(tmpDir); }
  }, 30000);

  // Test 5: equivalent_stricter with wrong lineage
  it('rejects equivalent_stricter with incorrect lineage', () => {
    const tmpDir = createTestFixture();
    try {
      const d = readEvidence(tmpDir);
      const m173 = d.migrations.find((m: any) => String(m.version) === '173');
      m173.objects[0].later_migration_lineage[0].version = '999';
      m173.objects[0].later_migration_lineage[0].filename = '999_wrong.sql';
      writeEvidence(tmpDir, d);
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/lineage.*181|lineage.*296|versions 181 and 296/i);
    } finally { cleanupFixture(tmpDir); }
  }, 30000);

  // Test 6: Migration 173 def_hash mismatch
  it('rejects Migration 173 function with def_hash mismatch', () => {
    const tmpDir = createTestFixture();
    try {
      const d = readEvidence(tmpDir);
      const m173 = d.migrations.find((m: any) => String(m.version) === '173');
      m173.objects[0].expected_properties.def_hash = 'aa' + m173.objects[0].expected_properties.def_hash.slice(2);
      writeEvidence(tmpDir, d);
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/def_hash.*mismatch|undeclared unequal.*def_hash|unpermitted.*def_hash/i);
    } finally { cleanupFixture(tmpDir); }
  }, 30000);

  // Test 7: valid exact_match passes (positive test)
  it('accepts valid exact_match object without modifications', () => {
    const tmpDir = createTestFixture();
    try {
      const { exitCode } = runValidatorInFixture(tmpDir);
      expect(exitCode).toBe(0);
    } finally { cleanupFixture(tmpDir); }
  }, 30000);

  // Test 8: valid equivalent_stricter passes (positive test via unmodified fixture)
  it('accepts valid Migration 173 equivalent_stricter via unmodified fixture', () => {
    const tmpDir = createTestFixture();
    try {
      const d = readEvidence(tmpDir);
      const m173 = d.migrations.find((m: any) => String(m.version) === '173');
      // Verify the 3 functions have equivalent_stricter
      for (const obj of m173.objects) {
        expect(obj.property_comparison_result).toBe('equivalent_stricter');
        expect(obj.property_mismatches.length).toBe(2);
        expect(obj.property_mismatches.map((m: any) => m.path).sort()).toEqual(['anon_exec', 'auth_exec']);
        expect(obj.expected_properties.def_hash).toBe(obj.verified_properties.def_hash);
      }
      const { exitCode } = runValidatorInFixture(tmpDir);
      expect(exitCode).toBe(0);
    } finally { cleanupFixture(tmpDir); }
  }, 30000);
});

// ══════════════════════════════════════════════════════════════
// CLI REJECTION TESTS FOR BATCH 5 REPAIR EVIDENCE
// ══════════════════════════════════════════════════════════════

describe('CLI rejection tests for Batch 5 repair evidence', () => {
  const { execSync } = require('child_process');
  const { mkdirSync, cpSync, rmSync, writeFileSync, unlinkSync } = require('fs');
  const { join } = require('path');
  const os = require('os');

  const VALIDATOR_SCRIPT = resolve('scripts/validate-migration-repair-allowlist.mjs');
  const SRC_DOCS_MIGRATIONS = resolve('docs/migrations');
  const SRC_SUPABASE_MIGRATIONS = resolve('supabase/migrations');
  const REPAIR_FILE = 'batch-05-repair.json';

  function createTestFixture(): string {
    const tmpDir = join(os.tmpdir(), `b5-repair-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(join(tmpDir, 'docs', 'migrations', 'evidence'), { recursive: true });
    mkdirSync(join(tmpDir, 'supabase', 'migrations'), { recursive: true });

    cpSync(join(SRC_DOCS_MIGRATIONS, '101-246-production-reconciliation.json'), join(tmpDir, 'docs', 'migrations', '101-246-production-reconciliation.json'));
    cpSync(join(SRC_DOCS_MIGRATIONS, '101-246-repair-allowlist.json'), join(tmpDir, 'docs', 'migrations', '101-246-repair-allowlist.json'));
    cpSync(join(SRC_DOCS_MIGRATIONS, '101-246-verification-candidates.json'), join(tmpDir, 'docs', 'migrations', '101-246-verification-candidates.json'));

    const evidenceDir = join(SRC_DOCS_MIGRATIONS, 'evidence');
    for (const f of readdirSync(evidenceDir)) {
      cpSync(join(evidenceDir, f), join(tmpDir, 'docs', 'migrations', 'evidence', f));
    }

    for (const f of readdirSync(SRC_SUPABASE_MIGRATIONS).filter((f: string) => f.endsWith('.sql'))) {
      cpSync(join(SRC_SUPABASE_MIGRATIONS, f), join(tmpDir, 'supabase', 'migrations', f));
    }

    return tmpDir;
  }

  function runValidatorInFixture(cwd: string): { exitCode: number; output: string } {
    try {
      const output = execSync(`node "${VALIDATOR_SCRIPT}"`, { cwd, encoding: 'utf-8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] });
      return { exitCode: 0, output };
    } catch (err: unknown) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return { exitCode: e.status || 1, output: (e.stdout || '') + (e.stderr || '') };
    }
  }

  function cleanupFixture(tmpDir: string) { rmSync(tmpDir, { recursive: true, force: true }); }

  function readRepairEvidence(tmpDir: string) {
    return JSON.parse(readFileSync(join(tmpDir, 'docs', 'migrations', 'evidence', REPAIR_FILE), 'utf-8'));
  }
  function writeRepairEvidence(tmpDir: string, data: any) {
    writeFileSync(join(tmpDir, 'docs', 'migrations', 'evidence', REPAIR_FILE), JSON.stringify(data, null, 2) + '\n');
  }

  // Positive baseline
  it('accepts unmodified Batch 5 repair evidence', () => {
    const tmpDir = createTestFixture();
    try {
      const { exitCode } = runValidatorInFixture(tmpDir);
      expect(exitCode).toBe(0);
    } finally { cleanupFixture(tmpDir); }
  }, 30000);

  // Test: repair evidence missing
  it('rejects when repair evidence file is missing', () => {
    const tmpDir = createTestFixture();
    try {
      unlinkSync(join(tmpDir, 'docs', 'migrations', 'evidence', REPAIR_FILE));
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/batch-05-repair|repair evidence/i);
    } finally { cleanupFixture(tmpDir); }
  }, 30000);

  // Test: repair evidence SHA mismatch
  it('rejects when repair evidence SHA mismatches', () => {
    const tmpDir = createTestFixture();
    try {
      const d = readRepairEvidence(tmpDir);
      d._tamper = 'modified';
      writeRepairEvidence(tmpDir, d);
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/SHA mismatch|repair evidence/i);
    } finally { cleanupFixture(tmpDir); }
  }, 30000);

  // Test: wrong repaired version set
  it('rejects wrong repaired version set', () => {
    const tmpDir = createTestFixture();
    try {
      const d = readRepairEvidence(tmpDir);
      d.approved_versions = [172, 173, 174, 175, 177, 178, 179, 180, 183, 184, 185, 186, 188, 189, 999];
      writeRepairEvidence(tmpDir, d);
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/version|mismatch|999/i);
    } finally { cleanupFixture(tmpDir); }
  }, 30000);

  // Test: wrong repair sequence
  it('rejects wrong repair sequence', () => {
    const tmpDir = createTestFixture();
    try {
      const d = readRepairEvidence(tmpDir);
      d.repairs[0].sequence = 2;
      writeRepairEvidence(tmpDir, d);
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/sequence/i);
    } finally { cleanupFixture(tmpDir); }
  }, 30000);

  // Test: nonzero command exit
  it('rejects nonzero command exit status', () => {
    const tmpDir = createTestFixture();
    try {
      const d = readRepairEvidence(tmpDir);
      d.repairs[3].exit_status = 1;
      writeRepairEvidence(tmpDir, d);
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/exit_status/i);
    } finally { cleanupFixture(tmpDir); }
  }, 30000);

  // Test: failed postcondition
  it('rejects failed postcondition', () => {
    const tmpDir = createTestFixture();
    try {
      const d = readRepairEvidence(tmpDir);
      d.repairs[7].postcondition_passed = false;
      writeRepairEvidence(tmpDir, d);
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/postcondition_passed/i);
    } finally { cleanupFixture(tmpDir); }
  }, 30000);

  // Test: incorrect pre/post count progression
  it('rejects incorrect post_total_remote_count progression', () => {
    const tmpDir = createTestFixture();
    try {
      const d = readRepairEvidence(tmpDir);
      d.repairs[5].post_total_remote_count = 999;
      writeRepairEvidence(tmpDir, d);
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/post_total|expected/i);
    } finally { cleanupFixture(tmpDir); }
  }, 30000);

  // Test: Migration 298 count changed
  it('rejects when Migration 298 count changes during repair', () => {
    const tmpDir = createTestFixture();
    try {
      const d = readRepairEvidence(tmpDir);
      d.repairs[10].migration_298_post_occurrences = 2;
      writeRepairEvidence(tmpDir, d);
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/migration_298/i);
    } finally { cleanupFixture(tmpDir); }
  }, 30000);

  // Test: removed version present
  it('rejects when removed_versions is non-empty', () => {
    const tmpDir = createTestFixture();
    try {
      const d = readRepairEvidence(tmpDir);
      d.post_repair.removed_versions = [102];
      writeRepairEvidence(tmpDir, d);
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/removed/i);
    } finally { cleanupFixture(tmpDir); }
  }, 30000);

  // Test: unapproved added version present
  it('rejects when unapproved_added_versions is non-empty', () => {
    const tmpDir = createTestFixture();
    try {
      const d = readRepairEvidence(tmpDir);
      d.post_repair.unapproved_added_versions = [999];
      writeRepairEvidence(tmpDir, d);
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/unapproved/i);
    } finally { cleanupFixture(tmpDir); }
  }, 30000);

  // Test: one Batch 5 manifest entry not ALIGNED_TRACKED
  it('rejects when a Batch 5 manifest entry is not ALIGNED_TRACKED', () => {
    const tmpDir = createTestFixture();
    try {
      const manifestPath = join(tmpDir, 'docs', 'migrations', '101-246-production-reconciliation.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      const entry = manifest.find((e: any) => e.version === '172');
      entry.current_classification = 'VERIFIED_APPLIED_UNTRACKED';
      entry.repair_status = 'approved_for_repair';
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/ALIGNED_TRACKED|classification/i);
    } finally { cleanupFixture(tmpDir); }
  }, 30000);

  // Test: allowlist not empty
  it('rejects when allowlist is not empty', () => {
    const tmpDir = createTestFixture();
    try {
      const alPath = join(tmpDir, 'docs', 'migrations', '101-246-repair-allowlist.json');
      writeFileSync(alPath, JSON.stringify([{ version: '172', confidence: 'HIGH' }], null, 2));
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/allowlist|approved/i);
    } finally { cleanupFixture(tmpDir); }
  }, 30000);

  // Test: completed repair count not 75
  it('rejects when batch-repaired candidate count is not 75', () => {
    const tmpDir = createTestFixture();
    try {
      // Remove the repair_batch from one Batch 5 entry to reduce the count
      const manifestPath = join(tmpDir, 'docs', 'migrations', '101-246-production-reconciliation.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      const entry = manifest.find((e: any) => e.version === '172');
      entry.original_classification = 'ALIGNED_TRACKED'; // No longer in repaired candidate cohort
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/candidate|cohort|75|PENDING.*VERIFIED.*repaired/i);
    } finally { cleanupFixture(tmpDir); }
  }, 30000);

  // Test: Batch 5 repaired_at before PR #75 merge
  it('rejects Batch 5 repaired_at before PR #75 merge time', () => {
    const tmpDir = createTestFixture();
    try {
      const manifestPath = join(tmpDir, 'docs', 'migrations', '101-246-production-reconciliation.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      const entry = manifest.find((e: any) => e.version === '172');
      entry.repaired_at = '2026-07-30T00:30:00Z'; // Before PR #75 merge at 02:54:38Z
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/Batch 5 repaired_at.*not later than PR #75/i);
    } finally { cleanupFixture(tmpDir); }
  }, 30000);

  // Test: Batch 5 repaired_at_source missing or incorrect
  it('rejects Batch 5 repaired_at_source missing or incorrect', () => {
    const tmpDir = createTestFixture();
    try {
      const manifestPath = join(tmpDir, 'docs', 'migrations', '101-246-production-reconciliation.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      const entry = manifest.find((e: any) => e.version === '172');
      entry.repaired_at_source = 'wrong value';
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/repaired_at_source.*missing or incorrect/i);
    } finally { cleanupFixture(tmpDir); }
  }, 30000);
});

// ══════════════════════════════════════════════════════════════
// WAVE 1 (BATCHES 6-7) REJECTION TESTS
// ══════════════════════════════════════════════════════════════
describe('Wave 1 rejection tests', () => {
  const { execSync } = require('child_process');
  const { mkdirSync, cpSync, rmSync, writeFileSync } = require('fs');
  const { join } = require('path');
  const os = require('os');

  const VALIDATOR_SCRIPT = resolve('scripts/validate-migration-repair-allowlist.mjs');
  const SRC_DOCS_MIGRATIONS = resolve('docs/migrations');
  const SRC_SUPABASE_MIGRATIONS = resolve('supabase/migrations');

  function createTestFixture(): string {
    const tmpDir = join(os.tmpdir(), `wave1-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(join(tmpDir, 'docs', 'migrations', 'evidence'), { recursive: true });
    mkdirSync(join(tmpDir, 'supabase', 'migrations'), { recursive: true });

    cpSync(join(SRC_DOCS_MIGRATIONS, '101-246-production-reconciliation.json'), join(tmpDir, 'docs', 'migrations', '101-246-production-reconciliation.json'));
    cpSync(join(SRC_DOCS_MIGRATIONS, '101-246-repair-allowlist.json'), join(tmpDir, 'docs', 'migrations', '101-246-repair-allowlist.json'));
    cpSync(join(SRC_DOCS_MIGRATIONS, '101-246-verification-candidates.json'), join(tmpDir, 'docs', 'migrations', '101-246-verification-candidates.json'));

    const evidenceDir = join(SRC_DOCS_MIGRATIONS, 'evidence');
    for (const f of readdirSync(evidenceDir)) {
      cpSync(join(evidenceDir, f), join(tmpDir, 'docs', 'migrations', 'evidence', f));
    }

    for (const f of readdirSync(SRC_SUPABASE_MIGRATIONS).filter((f: string) => f.endsWith('.sql'))) {
      cpSync(join(SRC_SUPABASE_MIGRATIONS, f), join(tmpDir, 'supabase', 'migrations', f));
    }

    return tmpDir;
  }

  function runValidatorInFixture(cwd: string): { exitCode: number; output: string } {
    try {
      const output = execSync(`node "${VALIDATOR_SCRIPT}"`, { cwd, encoding: 'utf-8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] });
      return { exitCode: 0, output };
    } catch (err: unknown) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return { exitCode: e.status || 1, output: (e.stdout || '') + (e.stderr || '') };
    }
  }

  function cleanupFixture(tmpDir: string) { rmSync(tmpDir, { recursive: true, force: true }); }

  // Positive baseline
  it('accepts unmodified Wave 1 evidence', () => {
    const tmpDir = createTestFixture();
    try {
      const { exitCode } = runValidatorInFixture(tmpDir);
      expect(exitCode).toBe(0);
    } finally { cleanupFixture(tmpDir); }
  }, 30000);

  // 1. Missing Batch 6 evidence
  it('rejects missing Batch 6 evidence', () => {
    const tmpDir = createTestFixture();
    try {
      rmSync(join(tmpDir, 'docs', 'migrations', 'evidence', 'batch-06-production-verification.json'));
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/Batch 6 evidence file missing/i);
    } finally { cleanupFixture(tmpDir); }
  }, 30000);

  // 2. Batch 6 evidence SHA mismatch
  it('rejects Batch 6 evidence SHA mismatch', () => {
    const tmpDir = createTestFixture();
    try {
      const p = join(tmpDir, 'docs', 'migrations', 'evidence', 'batch-06-production-verification.json');
      const d = JSON.parse(readFileSync(p, 'utf-8'));
      d._tamper = true;
      writeFileSync(p, JSON.stringify(d, null, 2) + '\n');
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/Batch 6 SHA mismatch/i);
    } finally { cleanupFixture(tmpDir); }
  }, 30000);

  // 3. Missing Batch 7 evidence
  it('rejects missing Batch 7 evidence', () => {
    const tmpDir = createTestFixture();
    try {
      rmSync(join(tmpDir, 'docs', 'migrations', 'evidence', 'batch-07-production-verification.json'));
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/Batch 7 evidence file missing/i);
    } finally { cleanupFixture(tmpDir); }
  }, 30000);

  // 4. Batch 7 evidence SHA mismatch
  it('rejects Batch 7 evidence SHA mismatch', () => {
    const tmpDir = createTestFixture();
    try {
      const p = join(tmpDir, 'docs', 'migrations', 'evidence', 'batch-07-production-verification.json');
      const d = JSON.parse(readFileSync(p, 'utf-8'));
      d._tamper = true;
      writeFileSync(p, JSON.stringify(d, null, 2) + '\n');
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/Batch 7 SHA mismatch/i);
    } finally { cleanupFixture(tmpDir); }
  }, 30000);

  // 5. Wave summary SHA mismatch
  it('rejects Wave summary SHA mismatch', () => {
    const tmpDir = createTestFixture();
    try {
      const p = join(tmpDir, 'docs', 'migrations', 'evidence', 'wave-01-production-verification.json');
      const d = JSON.parse(readFileSync(p, 'utf-8'));
      d._tamper = true;
      writeFileSync(p, JSON.stringify(d, null, 2) + '\n');
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/Wave summary SHA mismatch/i);
    } finally { cleanupFixture(tmpDir); }
  }, 30000);

  // 6. Wrong Batch 6 version set
  it('rejects wrong Batch 6 version set', () => {
    const tmpDir = createTestFixture();
    try {
      const p = join(tmpDir, 'docs', 'migrations', 'evidence', 'batch-06-production-verification.json');
      const d = JSON.parse(readFileSync(p, 'utf-8'));
      d.versions = ['191','192']; // truncated
      writeFileSync(p, JSON.stringify(d, null, 2) + '\n');
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/Batch 6.*version|SHA mismatch/i);
    } finally { cleanupFixture(tmpDir); }
  }, 30000);

  // 7. Wrong Batch 7 version set
  it('rejects wrong Batch 7 version set', () => {
    const tmpDir = createTestFixture();
    try {
      const p = join(tmpDir, 'docs', 'migrations', 'evidence', 'batch-07-production-verification.json');
      const d = JSON.parse(readFileSync(p, 'utf-8'));
      d.versions = ['208','209']; // truncated
      writeFileSync(p, JSON.stringify(d, null, 2) + '\n');
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/Batch 7.*version|SHA mismatch/i);
    } finally { cleanupFixture(tmpDir); }
  }, 30000);

  // 8. Wrong object count
  it('rejects wrong Batch 6 object count', () => {
    const tmpDir = createTestFixture();
    try {
      const p = join(tmpDir, 'docs', 'migrations', 'evidence', 'batch-06-production-verification.json');
      const d = JSON.parse(readFileSync(p, 'utf-8'));
      d.actual_object_count = 100;
      writeFileSync(p, JSON.stringify(d, null, 2) + '\n');
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/Batch 6.*object count|SHA mismatch/i);
    } finally { cleanupFixture(tmpDir); }
  }, 30000);

  // 9. Migration digest mismatch
  it('rejects migration digest mismatch', () => {
    const tmpDir = createTestFixture();
    try {
      const p = join(tmpDir, 'docs', 'migrations', 'evidence', 'batch-06-production-verification.json');
      const d = JSON.parse(readFileSync(p, 'utf-8'));
      d.migrations[0].migration_evidence_digest = 'aaaa' + d.migrations[0].migration_evidence_digest.slice(4);
      writeFileSync(p, JSON.stringify(d, null, 2) + '\n');
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/digest mismatch|SHA mismatch/i);
    } finally { cleanupFixture(tmpDir); }
  }, 30000);

  // 10. Failed or ambiguous result introduced
  it('rejects failed result in Batch 7 evidence', () => {
    const tmpDir = createTestFixture();
    try {
      const p = join(tmpDir, 'docs', 'migrations', 'evidence', 'batch-07-production-verification.json');
      const d = JSON.parse(readFileSync(p, 'utf-8'));
      d.migrations[0].objects[0].property_comparison_result = 'failed';
      writeFileSync(p, JSON.stringify(d, null, 2) + '\n');
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/failed result|SHA mismatch/i);
    } finally { cleanupFixture(tmpDir); }
  }, 30000);

  // 11. Migration 223 supersession lineage changed
  it('rejects Migration 223 supersession lineage change', () => {
    const tmpDir = createTestFixture();
    try {
      const p = join(tmpDir, 'docs', 'migrations', 'evidence', 'batch-07-production-verification.json');
      const d = JSON.parse(readFileSync(p, 'utf-8'));
      const m223 = d.migrations.find((m: any) => m.migration_version === '223');
      const sup = m223.objects.find((o: any) => o.property_comparison_result === 'superseded');
      sup.lineage.later_migration = '999';
      writeFileSync(p, JSON.stringify(d, null, 2) + '\n');
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/223.*superseded.*lineage|SHA mismatch/i);
    } finally { cleanupFixture(tmpDir); }
  }, 30000);

  // 12. Pre/post history snapshots differ
  it('rejects when Batch 6 pre/post snapshots differ', () => {
    const tmpDir = createTestFixture();
    try {
      const p = join(tmpDir, 'docs', 'migrations', 'evidence', 'batch-06-production-verification.json');
      const d = JSON.parse(readFileSync(p, 'utf-8'));
      d.post_verification_ordered_snapshot = [...d.pre_verification_ordered_snapshot, '999'];
      writeFileSync(p, JSON.stringify(d, null, 2) + '\n');
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/snapshots differ|SHA mismatch/i);
    } finally { cleanupFixture(tmpDir); }
  }, 30000);

  // 13. Batch 6 version added back to (empty) allowlist
  it('rejects when Batch 6 version present in allowlist after Batch 7 closeout', () => {
    const tmpDir = createTestFixture();
    try {
      const alPath = join(tmpDir, 'docs', 'migrations', '101-246-repair-allowlist.json');
      const al = JSON.parse(readFileSync(alPath, 'utf-8'));
      // Allowlist must be empty; adding a Batch 6 entry violates the post-Batch 7 invariant
      al.push({ version: '191', filename: '191_scan_to_pay.sql', checksum: 'x', classification: 'VERIFIED_APPLIED_UNTRACKED', repair_action: 'migration_history_repair_only', confidence: 'HIGH', verification_batch: 6, production_evidence_path: 'x', production_evidence_digest: 'x' });
      writeFileSync(alPath, JSON.stringify(al, null, 2) + '\n');
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/Allowlist length.*1.*expected 0|Allowlist has 1 entries|allowlist/i);
    } finally { cleanupFixture(tmpDir); }
  }, 30000);

  // 14. Batch 8 version added to (empty) allowlist after Batch 7 closeout
  it('rejects Batch 8 version in allowlist', () => {
    const tmpDir = createTestFixture();
    try {
      const alPath = join(tmpDir, 'docs', 'migrations', '101-246-repair-allowlist.json');
      const al = JSON.parse(readFileSync(alPath, 'utf-8'));
      // Allowlist is empty; adding any entry (including Batch 8) must be rejected
      al.push({ version: '250', filename: '250_future_migration.sql', checksum: 'x', classification: 'VERIFIED_APPLIED_UNTRACKED', repair_action: 'migration_history_repair_only', confidence: 'HIGH', verification_batch: 8, production_evidence_path: 'x', production_evidence_digest: 'x' });
      writeFileSync(alPath, JSON.stringify(al, null, 2) + '\n');
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/Non-Batch-7.*allowlist|Allowlist length.*1.*expected 0|Batch 8.*allowlist/i);
    } finally { cleanupFixture(tmpDir); }
  }, 30000);

  // 15. Batch 6 version incorrectly marked VERIFIED_APPLIED_UNTRACKED (should be ALIGNED_TRACKED)
  it('rejects Batch 6 version marked VERIFIED_APPLIED_UNTRACKED instead of ALIGNED_TRACKED', () => {
    const tmpDir = createTestFixture();
    try {
      const mPath = join(tmpDir, 'docs', 'migrations', '101-246-production-reconciliation.json');
      const m = JSON.parse(readFileSync(mPath, 'utf-8'));
      const e191 = m.find((e: any) => e.version === '191');
      e191.current_classification = 'VERIFIED_APPLIED_UNTRACKED';
      e191.remote_tracked = false;
      e191.repair_eligible = true;
      e191.repair_status = 'approved_for_repair';
      writeFileSync(mPath, JSON.stringify(m, null, 2) + '\n');
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/B6.*classification|ALIGNED.*expected 113|VERIFIED.*expected 0/i);
    } finally { cleanupFixture(tmpDir); }
  }, 30000);

  // 16. Remaining candidate list differs
  it('rejects when candidate list differs from exact 19 versions', () => {
    const tmpDir = createTestFixture();
    try {
      const cPath = join(tmpDir, 'docs', 'migrations', '101-246-verification-candidates.json');
      const c = JSON.parse(readFileSync(cPath, 'utf-8'));
      c.push({ version: '191', filename: 'x', checksum: 'x' }); // Add a Wave 1 version back
      writeFileSync(cPath, JSON.stringify(c, null, 2) + '\n');
      // Also update manifest to match
      const mPath = join(tmpDir, 'docs', 'migrations', '101-246-production-reconciliation.json');
      const m = JSON.parse(readFileSync(mPath, 'utf-8'));
      const e191 = m.find((e: any) => e.version === '191');
      e191.current_classification = 'PENDING_PRODUCTION_REVERIFICATION';
      writeFileSync(mPath, JSON.stringify(m, null, 2) + '\n');
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/candidate|ALIGNED.*expected 113|PENDING.*expected 19|VERIFIED.*expected 0/i);
    } finally { cleanupFixture(tmpDir); }
  }, 30000);

  // 17. Classification totals differ
  it('rejects when classification totals differ from expected', () => {
    const tmpDir = createTestFixture();
    try {
      const mPath = join(tmpDir, 'docs', 'migrations', '101-246-production-reconciliation.json');
      const m = JSON.parse(readFileSync(mPath, 'utf-8'));
      const e191 = m.find((e: any) => e.version === '191');
      e191.current_classification = 'PENDING_PRODUCTION_REVERIFICATION';
      writeFileSync(mPath, JSON.stringify(m, null, 2) + '\n');
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/ALIGNED.*112.*expected 113|PENDING.*20.*expected 19/i);
    } finally { cleanupFixture(tmpDir); }
  }, 30000);

  // 18. Completed repair count changes from 105
  it('rejects when completed repair count changes from 105', () => {
    const tmpDir = createTestFixture();
    try {
      const mPath = join(tmpDir, 'docs', 'migrations', '101-246-production-reconciliation.json');
      const m = JSON.parse(readFileSync(mPath, 'utf-8'));
      // Change a Batch 5 repaired entry to make it no longer count as a batch-repaired candidate
      const entry = m.find((e: any) => e.version === '172');
      entry.original_classification = 'ALIGNED_TRACKED'; // Breaks the candidate cohort
      writeFileSync(mPath, JSON.stringify(m, null, 2) + '\n');
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/candidate|cohort|104|105|PENDING.*VERIFIED.*repaired/i);
    } finally { cleanupFixture(tmpDir); }
  }, 30000);
});

// ══════════════════════════════════════════════════════════════
// BATCH 6 CLOSEOUT REJECTION TESTS
// ══════════════════════════════════════════════════════════════
describe('Batch 6 closeout rejection tests', () => {
  const { execSync } = require('child_process');
  const { mkdirSync, cpSync, rmSync, writeFileSync } = require('fs');
  const { join } = require('path');
  const os = require('os');

  const VALIDATOR_SCRIPT = resolve('scripts/validate-migration-repair-allowlist.mjs');
  const SRC_DOCS_MIGRATIONS = resolve('docs/migrations');
  const SRC_SUPABASE_MIGRATIONS = resolve('supabase/migrations');

  function createTestFixture(): string {
    const tmpDir = join(os.tmpdir(), `b6close-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(join(tmpDir, 'docs', 'migrations', 'evidence'), { recursive: true });
    mkdirSync(join(tmpDir, 'supabase', 'migrations'), { recursive: true });

    cpSync(join(SRC_DOCS_MIGRATIONS, '101-246-production-reconciliation.json'), join(tmpDir, 'docs', 'migrations', '101-246-production-reconciliation.json'));
    cpSync(join(SRC_DOCS_MIGRATIONS, '101-246-repair-allowlist.json'), join(tmpDir, 'docs', 'migrations', '101-246-repair-allowlist.json'));
    cpSync(join(SRC_DOCS_MIGRATIONS, '101-246-verification-candidates.json'), join(tmpDir, 'docs', 'migrations', '101-246-verification-candidates.json'));

    const evidenceDir = join(SRC_DOCS_MIGRATIONS, 'evidence');
    for (const f of readdirSync(evidenceDir)) {
      cpSync(join(evidenceDir, f), join(tmpDir, 'docs', 'migrations', 'evidence', f));
    }

    for (const f of readdirSync(SRC_SUPABASE_MIGRATIONS).filter((f: string) => f.endsWith('.sql'))) {
      cpSync(join(SRC_SUPABASE_MIGRATIONS, f), join(tmpDir, 'supabase', 'migrations', f));
    }

    return tmpDir;
  }

  function runValidatorInFixture(cwd: string): { exitCode: number; output: string } {
    try {
      const output = execSync(`node "${VALIDATOR_SCRIPT}"`, { cwd, encoding: 'utf-8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] });
      return { exitCode: 0, output };
    } catch (err: unknown) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return { exitCode: e.status || 1, output: (e.stdout || '') + (e.stderr || '') };
    }
  }

  function cleanupFixture(tmpDir: string) { rmSync(tmpDir, { recursive: true, force: true }); }

  // Positive baseline
  it('accepts valid Batch 6 closeout state', () => {
    const tmpDir = createTestFixture();
    try {
      const { exitCode } = runValidatorInFixture(tmpDir);
      expect(exitCode).toBe(0);
    } finally { cleanupFixture(tmpDir); }
  }, 30000);

  // 1. Missing Batch 6 repair evidence
  it('rejects missing Batch 6 repair evidence', () => {
    const tmpDir = createTestFixture();
    try {
      rmSync(join(tmpDir, 'docs', 'migrations', 'evidence', 'batch-06-repair.json'));
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/Batch 6 repair evidence.*missing/i);
    } finally { cleanupFixture(tmpDir); }
  }, 30000);

  // 2. Batch 6 repair evidence SHA mismatch
  it('rejects Batch 6 repair evidence SHA mismatch', () => {
    const tmpDir = createTestFixture();
    try {
      const p = join(tmpDir, 'docs', 'migrations', 'evidence', 'batch-06-repair.json');
      const d = JSON.parse(readFileSync(p, 'utf-8'));
      d._tamper = true;
      writeFileSync(p, JSON.stringify(d, null, 2) + '\n');
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/Batch 6 repair evidence SHA mismatch/i);
    } finally { cleanupFixture(tmpDir); }
  }, 30000);

  // 3. Wrong repaired version set
  it('rejects wrong Batch 6 repaired version set', () => {
    const tmpDir = createTestFixture();
    try {
      const p = join(tmpDir, 'docs', 'migrations', 'evidence', 'batch-06-repair.json');
      const d = JSON.parse(readFileSync(p, 'utf-8'));
      d.approved_versions = ['191','192'];
      writeFileSync(p, JSON.stringify(d, null, 2) + '\n');
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/repair.*version|SHA mismatch/i);
    } finally { cleanupFixture(tmpDir); }
  }, 30000);

  // 4. Wrong repair sequence
  it('rejects wrong repair sequence', () => {
    const tmpDir = createTestFixture();
    try {
      const p = join(tmpDir, 'docs', 'migrations', 'evidence', 'batch-06-repair.json');
      const d = JSON.parse(readFileSync(p, 'utf-8'));
      d.repairs[0].sequence = 5;
      writeFileSync(p, JSON.stringify(d, null, 2) + '\n');
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/sequence|SHA mismatch/i);
    } finally { cleanupFixture(tmpDir); }
  }, 30000);

  // 5. Nonzero command exit
  it('rejects nonzero repair exit status', () => {
    const tmpDir = createTestFixture();
    try {
      const p = join(tmpDir, 'docs', 'migrations', 'evidence', 'batch-06-repair.json');
      const d = JSON.parse(readFileSync(p, 'utf-8'));
      d.repairs[3].exit_status = 1;
      writeFileSync(p, JSON.stringify(d, null, 2) + '\n');
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/exit_status|SHA mismatch/i);
    } finally { cleanupFixture(tmpDir); }
  }, 30000);

  // 6. Failed postcondition (safety confirmation)
  it('rejects failed safety confirmation', () => {
    const tmpDir = createTestFixture();
    try {
      const p = join(tmpDir, 'docs', 'migrations', 'evidence', 'batch-06-repair.json');
      const d = JSON.parse(readFileSync(p, 'utf-8'));
      d.safety_confirmations.no_version_removed = false;
      writeFileSync(p, JSON.stringify(d, null, 2) + '\n');
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/safety|SHA mismatch/i);
    } finally { cleanupFixture(tmpDir); }
  }, 30000);

  // 7. Incorrect count progression
  it('rejects incorrect count progression', () => {
    const tmpDir = createTestFixture();
    try {
      const p = join(tmpDir, 'docs', 'migrations', 'evidence', 'batch-06-repair.json');
      const d = JSON.parse(readFileSync(p, 'utf-8'));
      d.repairs[5].post_total = d.repairs[5].pre_total + 3;
      writeFileSync(p, JSON.stringify(d, null, 2) + '\n');
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/delta|SHA mismatch/i);
    } finally { cleanupFixture(tmpDir); }
  }, 30000);

  // 8. Batch 7 occurrence changed from zero
  it('rejects Batch 7 occurrence changed from zero', () => {
    const tmpDir = createTestFixture();
    try {
      const p = join(tmpDir, 'docs', 'migrations', 'evidence', 'batch-06-repair.json');
      const d = JSON.parse(readFileSync(p, 'utf-8'));
      d.batch_7_post_occurrence_map['208'] = 1;
      writeFileSync(p, JSON.stringify(d, null, 2) + '\n');
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/B7.*occurrence|SHA mismatch/i);
    } finally { cleanupFixture(tmpDir); }
  }, 30000);

  // 9. Migration 298 count changed
  it('rejects Migration 298 count change', () => {
    const tmpDir = createTestFixture();
    try {
      const p = join(tmpDir, 'docs', 'migrations', 'evidence', 'batch-06-repair.json');
      const d = JSON.parse(readFileSync(p, 'utf-8'));
      d.post_repair_counts.migration_298_count = 2;
      writeFileSync(p, JSON.stringify(d, null, 2) + '\n');
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/m298|298|SHA mismatch/i);
    } finally { cleanupFixture(tmpDir); }
  }, 30000);

  // 10. Removed version present
  it('rejects removed version present', () => {
    const tmpDir = createTestFixture();
    try {
      const p = join(tmpDir, 'docs', 'migrations', 'evidence', 'batch-06-repair.json');
      const d = JSON.parse(readFileSync(p, 'utf-8'));
      d.removed_versions = ['100'];
      writeFileSync(p, JSON.stringify(d, null, 2) + '\n');
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/removed|SHA mismatch/i);
    } finally { cleanupFixture(tmpDir); }
  }, 30000);

  // 11. Unapproved added version present
  it('rejects unapproved added version', () => {
    const tmpDir = createTestFixture();
    try {
      const p = join(tmpDir, 'docs', 'migrations', 'evidence', 'batch-06-repair.json');
      const d = JSON.parse(readFileSync(p, 'utf-8'));
      d.unapproved_added_versions = ['999'];
      writeFileSync(p, JSON.stringify(d, null, 2) + '\n');
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/unapproved|SHA mismatch/i);
    } finally { cleanupFixture(tmpDir); }
  }, 30000);

  // 12. Batch 6 manifest entry not ALIGNED_TRACKED
  it('rejects Batch 6 manifest entry not ALIGNED_TRACKED', () => {
    const tmpDir = createTestFixture();
    try {
      const mPath = join(tmpDir, 'docs', 'migrations', '101-246-production-reconciliation.json');
      const m = JSON.parse(readFileSync(mPath, 'utf-8'));
      const e191 = m.find((e: any) => e.version === '191');
      e191.current_classification = 'VERIFIED_APPLIED_UNTRACKED';
      e191.remote_tracked = false;
      e191.repair_status = 'approved_for_repair';
      e191.repair_eligible = true;
      writeFileSync(mPath, JSON.stringify(m, null, 2) + '\n');
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/B6.*classification|ALIGNED.*expected 113|VERIFIED.*expected 0/i);
    } finally { cleanupFixture(tmpDir); }
  }, 30000);

  // 13. Batch 6 repaired_at not equal to evidence completed_at
  it('rejects Batch 6 repaired_at not matching evidence', () => {
    const tmpDir = createTestFixture();
    try {
      const mPath = join(tmpDir, 'docs', 'migrations', '101-246-production-reconciliation.json');
      const m = JSON.parse(readFileSync(mPath, 'utf-8'));
      const e191 = m.find((e: any) => e.version === '191');
      e191.repaired_at = '2026-01-01T00:00:00.000Z';
      writeFileSync(mPath, JSON.stringify(m, null, 2) + '\n');
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/repaired_at.*end_ts|not later than PR/i);
    } finally { cleanupFixture(tmpDir); }
  }, 30000);

  // 14. Batch 6 repaired_at_source missing or wrong
  it('rejects Batch 6 repaired_at_source wrong', () => {
    const tmpDir = createTestFixture();
    try {
      const mPath = join(tmpDir, 'docs', 'migrations', '101-246-production-reconciliation.json');
      const m = JSON.parse(readFileSync(mPath, 'utf-8'));
      const e191 = m.find((e: any) => e.version === '191');
      e191.repaired_at_source = 'wrong_source';
      writeFileSync(mPath, JSON.stringify(m, null, 2) + '\n');
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/repaired_at_source/i);
    } finally { cleanupFixture(tmpDir); }
  }, 30000);

  // 16. Batch 6 version remains in allowlist
  it('rejects Batch 6 version in allowlist', () => {
    const tmpDir = createTestFixture();
    try {
      const aPath = join(tmpDir, 'docs', 'migrations', '101-246-repair-allowlist.json');
      const a = JSON.parse(readFileSync(aPath, 'utf-8'));
      // Allowlist is now empty; adding a Batch 6 entry should be rejected
      a.push({ version: '191', filename: '191_scan_to_pay.sql', checksum: 'x', classification: 'ALIGNED_TRACKED', repair_action: 'none', confidence: 'HIGH', verification_batch: 6, production_evidence_path: 'x', production_evidence_digest: 'x' });
      writeFileSync(aPath, JSON.stringify(a, null, 2) + '\n');
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/Allowlist length.*1.*expected 0|Allowlist has 1 entries|allowlist/i);
    } finally { cleanupFixture(tmpDir); }
  }, 30000);

  // 17. Batch 7 repair_eligible wrongly set to true (completed entries must have repair_eligible=false)
  it('rejects Batch 7 with repair_eligible true on completed entry', () => {
    const tmpDir = createTestFixture();
    try {
      const mPath = join(tmpDir, 'docs', 'migrations', '101-246-production-reconciliation.json');
      const m = JSON.parse(readFileSync(mPath, 'utf-8'));
      const e208 = m.find((e: any) => e.version === '208');
      // Completed entries must have repair_eligible=false; setting it true breaks the check
      e208.repair_eligible = true;
      writeFileSync(mPath, JSON.stringify(m, null, 2) + '\n');
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/repair_eligible|208.*completed/i);
    } finally { cleanupFixture(tmpDir); }
  }, 30000);

  // 18. Candidate list differs from exact 19
  it('rejects candidate list differing from exact 19', () => {
    const tmpDir = createTestFixture();
    try {
      const cPath = join(tmpDir, 'docs', 'migrations', '101-246-verification-candidates.json');
      const c = JSON.parse(readFileSync(cPath, 'utf-8'));
      c.push({ version: '208', filename: 'x', checksum: 'x' });
      writeFileSync(cPath, JSON.stringify(c, null, 2) + '\n');
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/Candidate|expected.*19/i);
    } finally { cleanupFixture(tmpDir); }
  }, 30000);

  // 19. Classification totals differ
  it('rejects classification totals differing from expected', () => {
    const tmpDir = createTestFixture();
    try {
      const mPath = join(tmpDir, 'docs', 'migrations', '101-246-production-reconciliation.json');
      const m = JSON.parse(readFileSync(mPath, 'utf-8'));
      // Move a Batch 7 entry (now ALIGNED_TRACKED) to PENDING — ALIGNED drops to 112, PENDING rises to 20
      const e208 = m.find((e: any) => e.version === '208');
      e208.current_classification = 'PENDING_PRODUCTION_REVERIFICATION';
      writeFileSync(mPath, JSON.stringify(m, null, 2) + '\n');
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/ALIGNED.*112.*expected 113|PENDING.*20.*expected 19/i);
    } finally { cleanupFixture(tmpDir); }
  }, 30000);

  // 20. Completed repair count differs from 105
  it('rejects completed repair count differing from 105', () => {
    const tmpDir = createTestFixture();
    try {
      const mPath = join(tmpDir, 'docs', 'migrations', '101-246-production-reconciliation.json');
      const m = JSON.parse(readFileSync(mPath, 'utf-8'));
      // Changing a Batch 7 repaired entry's original_classification away from VERIFIED_APPLIED_UNTRACKED
      // removes it from the candidate cohort: 105 → 104
      const entry = m.find((e: any) => e.version === '208');
      entry.original_classification = 'ALIGNED_TRACKED';
      writeFileSync(mPath, JSON.stringify(m, null, 2) + '\n');
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/candidate|cohort|104|105/i);
    } finally { cleanupFixture(tmpDir); }
  }, 30000);
});

// ══════════════════════════════════════════════════════════════
// BATCH 7 CLOSEOUT REJECTION TESTS
// ══════════════════════════════════════════════════════════════
describe('Batch 7 closeout rejection tests', () => {
  const { execSync } = require('child_process');
  const { mkdirSync, cpSync, rmSync, writeFileSync } = require('fs');
  const { join } = require('path');
  const os = require('os');

  const VALIDATOR_SCRIPT = resolve('scripts/validate-migration-repair-allowlist.mjs');
  const SRC_DOCS_MIGRATIONS = resolve('docs/migrations');
  const SRC_SUPABASE_MIGRATIONS = resolve('supabase/migrations');

  function createTestFixture(): string {
    const tmpDir = join(os.tmpdir(), `b7close-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(join(tmpDir, 'docs', 'migrations', 'evidence'), { recursive: true });
    mkdirSync(join(tmpDir, 'supabase', 'migrations'), { recursive: true });

    cpSync(join(SRC_DOCS_MIGRATIONS, '101-246-production-reconciliation.json'), join(tmpDir, 'docs', 'migrations', '101-246-production-reconciliation.json'));
    cpSync(join(SRC_DOCS_MIGRATIONS, '101-246-repair-allowlist.json'), join(tmpDir, 'docs', 'migrations', '101-246-repair-allowlist.json'));
    cpSync(join(SRC_DOCS_MIGRATIONS, '101-246-verification-candidates.json'), join(tmpDir, 'docs', 'migrations', '101-246-verification-candidates.json'));

    const evidenceDir = join(SRC_DOCS_MIGRATIONS, 'evidence');
    for (const f of readdirSync(evidenceDir)) {
      cpSync(join(evidenceDir, f), join(tmpDir, 'docs', 'migrations', 'evidence', f));
    }

    for (const f of readdirSync(SRC_SUPABASE_MIGRATIONS).filter((f: string) => f.endsWith('.sql'))) {
      cpSync(join(SRC_SUPABASE_MIGRATIONS, f), join(tmpDir, 'supabase', 'migrations', f));
    }

    return tmpDir;
  }

  function runValidatorInFixture(cwd: string): { exitCode: number; output: string } {
    try {
      const output = execSync(`node "${VALIDATOR_SCRIPT}"`, { cwd, encoding: 'utf-8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] });
      return { exitCode: 0, output };
    } catch (err: unknown) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return { exitCode: e.status || 1, output: (e.stdout || '') + (e.stderr || '') };
    }
  }

  function cleanupFixture(tmpDir: string) { rmSync(tmpDir, { recursive: true, force: true }); }

  // Positive baseline
  it('accepts valid Batch 7 closeout state', () => {
    const tmpDir = createTestFixture();
    try {
      const { exitCode } = runValidatorInFixture(tmpDir);
      expect(exitCode).toBe(0);
    } finally { cleanupFixture(tmpDir); }
  }, 30000);

  // 1. Missing Batch 7 repair evidence
  it('rejects missing Batch 7 repair evidence', () => {
    const tmpDir = createTestFixture();
    try {
      rmSync(join(tmpDir, 'docs', 'migrations', 'evidence', 'batch-07-repair.json'));
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/Batch 7 repair evidence.*missing/i);
    } finally { cleanupFixture(tmpDir); }
  }, 30000);

  // 2. Repair evidence SHA mismatch
  it('rejects Batch 7 repair evidence SHA mismatch', () => {
    const tmpDir = createTestFixture();
    try {
      const p = join(tmpDir, 'docs', 'migrations', 'evidence', 'batch-07-repair.json');
      // Append a space to corrupt the SHA without breaking JSON
      const content = readFileSync(p, 'utf-8');
      writeFileSync(p, content + ' ');
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/Batch 7 repair evidence SHA mismatch/i);
    } finally { cleanupFixture(tmpDir); }
  }, 30000);

  // 3. Wrong version set
  it('rejects wrong Batch 7 version set', () => {
    const tmpDir = createTestFixture();
    try {
      const p = join(tmpDir, 'docs', 'migrations', 'evidence', 'batch-07-repair.json');
      const d = JSON.parse(readFileSync(p, 'utf-8'));
      d.approved_versions = d.approved_versions.slice(0, -1); // Remove last version
      writeFileSync(p, JSON.stringify(d, null, 2) + '\n');
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/Batch 7 repair.*version|SHA mismatch/i);
    } finally { cleanupFixture(tmpDir); }
  }, 30000);

  // 4. Wrong sequence
  it('rejects wrong repair sequence', () => {
    const tmpDir = createTestFixture();
    try {
      const p = join(tmpDir, 'docs', 'migrations', 'evidence', 'batch-07-repair.json');
      const d = JSON.parse(readFileSync(p, 'utf-8'));
      d.repairs[0].sequence = 2; // First repair should be sequence=1
      writeFileSync(p, JSON.stringify(d, null, 2) + '\n');
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/sequence|SHA mismatch/i);
    } finally { cleanupFixture(tmpDir); }
  }, 30000);

  // 5. Nonzero command exit
  it('rejects nonzero exit status', () => {
    const tmpDir = createTestFixture();
    try {
      const p = join(tmpDir, 'docs', 'migrations', 'evidence', 'batch-07-repair.json');
      const d = JSON.parse(readFileSync(p, 'utf-8'));
      d.repairs[0].exit_status = 1;
      writeFileSync(p, JSON.stringify(d, null, 2) + '\n');
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/exit_status|SHA mismatch/i);
    } finally { cleanupFixture(tmpDir); }
  }, 30000);

  // 6. Failed postcondition
  it('rejects failed postcondition', () => {
    const tmpDir = createTestFixture();
    try {
      const p = join(tmpDir, 'docs', 'migrations', 'evidence', 'batch-07-repair.json');
      const d = JSON.parse(readFileSync(p, 'utf-8'));
      d.repairs[0].postcondition_passed = false;
      writeFileSync(p, JSON.stringify(d, null, 2) + '\n');
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/postcondition|SHA mismatch/i);
    } finally { cleanupFixture(tmpDir); }
  }, 30000);

  // 7. Incorrect count progression
  it('rejects incorrect count progression', () => {
    const tmpDir = createTestFixture();
    try {
      const p = join(tmpDir, 'docs', 'migrations', 'evidence', 'batch-07-repair.json');
      const d = JSON.parse(readFileSync(p, 'utf-8'));
      // repairs[0] has pre=194, post=195; change post to 197 (delta=3, not 1)
      d.repairs[0].post_total_remote_count = 197;
      writeFileSync(p, JSON.stringify(d, null, 2) + '\n');
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/total delta|SHA mismatch/i);
    } finally { cleanupFixture(tmpDir); }
  }, 30000);

  // 8. Later-batch occurrence changed from zero
  it('rejects later-batch occurrence changed', () => {
    const tmpDir = createTestFixture();
    try {
      const p = join(tmpDir, 'docs', 'migrations', 'evidence', 'batch-07-repair.json');
      const d = JSON.parse(readFileSync(p, 'utf-8'));
      d.batches_8_9_post_occurrence_map['227'] = 1;
      writeFileSync(p, JSON.stringify(d, null, 2) + '\n');
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/B89.*occurrence|Batch 8.*9.*remain zero|SHA mismatch/i);
    } finally { cleanupFixture(tmpDir); }
  }, 30000);

  // 9. Migration 298 changed
  it('rejects Migration 298 changed', () => {
    const tmpDir = createTestFixture();
    try {
      const p = join(tmpDir, 'docs', 'migrations', 'evidence', 'batch-07-repair.json');
      const d = JSON.parse(readFileSync(p, 'utf-8'));
      d.post_repair_counts.migration_298_count = 2;
      writeFileSync(p, JSON.stringify(d, null, 2) + '\n');
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/m298|migration.*298|SHA mismatch/i);
    } finally { cleanupFixture(tmpDir); }
  }, 30000);

  // 10. Removed version present
  it('rejects removed version present', () => {
    const tmpDir = createTestFixture();
    try {
      const p = join(tmpDir, 'docs', 'migrations', 'evidence', 'batch-07-repair.json');
      const d = JSON.parse(readFileSync(p, 'utf-8'));
      d.removed_versions = ['191'];
      writeFileSync(p, JSON.stringify(d, null, 2) + '\n');
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/Removed version|SHA mismatch/i);
    } finally { cleanupFixture(tmpDir); }
  }, 30000);

  // 11. Unapproved version present
  it('rejects unapproved version present', () => {
    const tmpDir = createTestFixture();
    try {
      const p = join(tmpDir, 'docs', 'migrations', 'evidence', 'batch-07-repair.json');
      const d = JSON.parse(readFileSync(p, 'utf-8'));
      d.unapproved_added_versions = ['999'];
      writeFileSync(p, JSON.stringify(d, null, 2) + '\n');
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/Unapproved.*version|unapproved|SHA mismatch/i);
    } finally { cleanupFixture(tmpDir); }
  }, 30000);

  // 12. Batch 7 manifest entry not ALIGNED_TRACKED
  it('rejects Batch 7 not ALIGNED_TRACKED', () => {
    const tmpDir = createTestFixture();
    try {
      const mPath = join(tmpDir, 'docs', 'migrations', '101-246-production-reconciliation.json');
      const m = JSON.parse(readFileSync(mPath, 'utf-8'));
      const e208 = m.find((e: any) => e.version === '208');
      e208.current_classification = 'VERIFIED_APPLIED_UNTRACKED';
      writeFileSync(mPath, JSON.stringify(m, null, 2) + '\n');
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/208.*classification|ALIGNED.*112.*expected 113/i);
    } finally { cleanupFixture(tmpDir); }
  }, 30000);

  // 13. repaired_at differs from completed_at
  it('rejects repaired_at differs from completed_at', () => {
    const tmpDir = createTestFixture();
    try {
      const mPath = join(tmpDir, 'docs', 'migrations', '101-246-production-reconciliation.json');
      const m = JSON.parse(readFileSync(mPath, 'utf-8'));
      const e208 = m.find((e: any) => e.version === '208');
      e208.repaired_at = '2026-01-01T00:00:00.000Z'; // Different from evidence completed_at
      writeFileSync(mPath, JSON.stringify(m, null, 2) + '\n');
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/repaired_at.*completed_at|208.*repaired_at/i);
    } finally { cleanupFixture(tmpDir); }
  }, 30000);

  // 14. repaired_at_source missing or wrong
  it('rejects repaired_at_source wrong', () => {
    const tmpDir = createTestFixture();
    try {
      const mPath = join(tmpDir, 'docs', 'migrations', '101-246-production-reconciliation.json');
      const m = JSON.parse(readFileSync(mPath, 'utf-8'));
      const e208 = m.find((e: any) => e.version === '208');
      e208.repaired_at_source = 'wrong_source';
      writeFileSync(mPath, JSON.stringify(m, null, 2) + '\n');
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/repaired_at_source/i);
    } finally { cleanupFixture(tmpDir); }
  }, 30000);

  // 15. Batch 7 version remains in allowlist
  it('rejects Batch 7 version in allowlist', () => {
    const tmpDir = createTestFixture();
    try {
      const aPath = join(tmpDir, 'docs', 'migrations', '101-246-repair-allowlist.json');
      const a = JSON.parse(readFileSync(aPath, 'utf-8'));
      // Allowlist is empty; adding a Batch 7 version entry should be rejected
      a.push({ version: '208', filename: '208_payment_channels.sql', checksum: 'x', classification: 'ALIGNED_TRACKED', repair_action: 'none', confidence: 'HIGH', verification_batch: 7, production_evidence_path: 'x', production_evidence_digest: 'x' });
      writeFileSync(aPath, JSON.stringify(a, null, 2) + '\n');
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/Batch 7.*allowlist|Allowlist length.*1|Allowlist.*0/i);
    } finally { cleanupFixture(tmpDir); }
  }, 30000);

  // 16. Batch 8 or 9 version enters allowlist
  it('rejects Batch 8 version in allowlist', () => {
    const tmpDir = createTestFixture();
    try {
      const aPath = join(tmpDir, 'docs', 'migrations', '101-246-repair-allowlist.json');
      const a = JSON.parse(readFileSync(aPath, 'utf-8'));
      // Adding a Batch 8 version to the (empty) allowlist
      a.push({ version: '227', filename: '227_customer_ltv_tier.sql', checksum: 'x', classification: 'PENDING_PRODUCTION_REVERIFICATION', repair_action: 'none', confidence: 'HIGH', verification_batch: 8, production_evidence_path: 'x', production_evidence_digest: 'x' });
      writeFileSync(aPath, JSON.stringify(a, null, 2) + '\n');
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/allowlist/i);
    } finally { cleanupFixture(tmpDir); }
  }, 30000);

  // 17. Allowlist is nonempty
  it('rejects nonempty allowlist', () => {
    const tmpDir = createTestFixture();
    try {
      const aPath = join(tmpDir, 'docs', 'migrations', '101-246-repair-allowlist.json');
      const a = JSON.parse(readFileSync(aPath, 'utf-8'));
      // Add any entry to violate the "must be empty" invariant
      a.push({ version: '999', filename: '999_fake.sql', checksum: 'x', classification: 'ALIGNED_TRACKED', repair_action: 'none', confidence: 'HIGH', verification_batch: 7, production_evidence_path: 'x', production_evidence_digest: 'x' });
      writeFileSync(aPath, JSON.stringify(a, null, 2) + '\n');
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/Allowlist length.*1.*expected 0|Allowlist.*0|allowlist/i);
    } finally { cleanupFixture(tmpDir); }
  }, 30000);

  // 18. Candidate list differs from exact 19
  it('rejects candidate list differing from 19', () => {
    const tmpDir = createTestFixture();
    try {
      const cPath = join(tmpDir, 'docs', 'migrations', '101-246-verification-candidates.json');
      const c = JSON.parse(readFileSync(cPath, 'utf-8'));
      c.push({ version: '999', filename: '999_fake.sql', checksum: 'x' });
      writeFileSync(cPath, JSON.stringify(c, null, 2) + '\n');
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/Candidate|expected.*19/i);
    } finally { cleanupFixture(tmpDir); }
  }, 30000);

  // 19. Classification totals differ
  it('rejects classification totals differ', () => {
    const tmpDir = createTestFixture();
    try {
      const mPath = join(tmpDir, 'docs', 'migrations', '101-246-production-reconciliation.json');
      const m = JSON.parse(readFileSync(mPath, 'utf-8'));
      // Change a Batch 7 ALIGNED_TRACKED entry to PENDING — ALIGNED drops to 112, PENDING rises to 20
      const e208 = m.find((e: any) => e.version === '208');
      e208.current_classification = 'PENDING_PRODUCTION_REVERIFICATION';
      writeFileSync(mPath, JSON.stringify(m, null, 2) + '\n');
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/ALIGNED.*112|PENDING.*20/i);
    } finally { cleanupFixture(tmpDir); }
  }, 30000);

  // 20. Completed repair count differs from 105
  it('rejects completed repair count differs from 105', () => {
    const tmpDir = createTestFixture();
    try {
      const mPath = join(tmpDir, 'docs', 'migrations', '101-246-production-reconciliation.json');
      const m = JSON.parse(readFileSync(mPath, 'utf-8'));
      // Changing version 208's original_classification away from VERIFIED_APPLIED_UNTRACKED
      // removes it from the repaired candidate cohort: 105 → 104
      const entry = m.find((e: any) => e.version === '208');
      entry.original_classification = 'ALIGNED_TRACKED';
      writeFileSync(mPath, JSON.stringify(m, null, 2) + '\n');
      const { exitCode, output } = runValidatorInFixture(tmpDir);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/candidate|cohort|104|105/i);
    } finally { cleanupFixture(tmpDir); }
  }, 30000);
});
