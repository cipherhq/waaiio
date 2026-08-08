/**
 * Migration repair guard tests
 *
 * Verifies that the repair guard correctly blocks:
 * 1. NOT_VERIFIABLE_SAFELY versions
 * 2. SUPERSEDED versions
 * 3. APPLIED_WITHOUT_EXECUTION deviation versions
 * 4. Versions not in the allowlist
 * 5. Versions not in the manifest
 */
import { describe, it, expect } from 'vitest';
import { checkRepairEligibility } from '@/scripts/migration-repair-guard';

describe('Migration repair guard', () => {
  const DEVIATION_VERSIONS = ['101', '105', '107', '122', '126', '130', '160', '163', '164', '187', '216', '217', '222', '226'];

  it('blocks all 14 deviation versions', () => {
    for (const v of DEVIATION_VERSIONS) {
      const result = checkRepairEligibility(v);
      expect(result.allowed, `Version ${v} should be blocked`).toBe(false);
      expect(result.reason).toContain('APPLIED_WITHOUT_EXECUTION');
    }
  });

  it('blocks NOT_VERIFIABLE_SAFELY versions', () => {
    // These are in the deviation set too, but the classification check would also block them
    const result = checkRepairEligibility('101');
    expect(result.allowed).toBe(false);
    expect(result.classification).toBe('NOT_VERIFIABLE_SAFELY');
  });

  it('blocks SUPERSEDED versions', () => {
    const result = checkRepairEligibility('122');
    expect(result.allowed).toBe(false);
    expect(result.classification).toBe('SUPERSEDED_WITH_EQUIVALENT_STATE');
  });

  it('blocks versions not in manifest', () => {
    const result = checkRepairEligibility('999');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('not found in manifest');
  });

  it('blocks already-repaired versions not in allowlist', () => {
    // Version 102 is ALIGNED_TRACKED and repair_eligible=false
    const result = checkRepairEligibility('102');
    expect(result.allowed).toBe(false);
  });

  it('exactly 14 deviation versions are tracked', () => {
    expect(DEVIATION_VERSIONS).toHaveLength(14);
  });

  it('deviation versions match the documented incident', () => {
    // Cross-reference with PRODUCTION_DEVIATION_LOG.md
    const fs = require('fs');
    const log = fs.readFileSync('docs/migrations/PRODUCTION_DEVIATION_LOG.md', 'utf-8');
    for (const v of DEVIATION_VERSIONS) {
      expect(log).toContain(`| ${v} |`);
    }
  });
});
