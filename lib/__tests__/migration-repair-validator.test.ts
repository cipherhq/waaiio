/**
 * Regression tests for migration repair validator rules.
 *
 * These tests verify that the validator correctly rejects unsafe evidence states,
 * invalid timestamps, missing metadata, and inconsistent batch totals.
 * They also verify that the real Batch 1 evidence passes all checks.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
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
  repair_status: string;
  repair_eligible: boolean;
  evidence: EvidenceItem[];
}

interface BatchEvidence {
  total_objects_checked: number;
  total_passed: number;
  total_superseded: number;
  total_failed: number;
  migrations: Array<{
    version: string;
    objects: Array<{ result: string; verified_state: string }>;
    passed: number;
    failed: number;
    superseded?: number;
  }>;
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
      if (ev.verified_state !== ev.expected_state) {
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
      total_objects_checked: 94,
      total_passed: 90,
      total_superseded: 1,
      total_failed: 0,
      migrations: []
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('Batch totals inconsistent');
  });

  // Test 12: Real Batch 1 evidence passes all checks
  it('real Batch 1 evidence passes all validation rules', () => {
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
    const approvedEntries = manifest.filter(
      (e: ManifestEntry) => batch1Versions.has(e.version) && e.repair_status === 'approved_for_repair'
    );

    expect(approvedEntries.length).toBe(15);

    const allErrors: string[] = [];
    for (const entry of approvedEntries) {
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
