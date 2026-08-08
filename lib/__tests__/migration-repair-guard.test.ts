/**
 * Migration repair guard tests
 *
 * Verifies:
 * 1. NOT_VERIFIABLE_SAFELY versions blocked
 * 2. SUPERSEDED versions blocked
 * 3. APPLIED_WITHOUT_EXECUTION deviation versions blocked
 * 4. Versions not in allowlist blocked
 * 5. Versions not in manifest blocked
 * 6. Empty/valid allowlist succeeds (CI integration)
 * 7. Protected version in allowlist fails (CI integration)
 * 8. Deviation versions match documentation
 */
import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import { checkRepairEligibility } from '@/scripts/migration-repair-guard';
import { readFileSync, writeFileSync } from 'fs';

describe('Migration repair guard — TypeScript module', () => {
  const DEVIATION_VERSIONS = ['101', '105', '107', '122', '126', '130', '160', '163', '164', '187', '216', '217', '222', '226'];

  it('blocks all 14 deviation versions', () => {
    for (const v of DEVIATION_VERSIONS) {
      const result = checkRepairEligibility(v);
      expect(result.allowed, `Version ${v} should be blocked`).toBe(false);
      expect(result.reason).toContain('APPLIED_WITHOUT_EXECUTION');
    }
  });

  it('blocks NOT_VERIFIABLE_SAFELY versions', () => {
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
    const result = checkRepairEligibility('102');
    expect(result.allowed).toBe(false);
  });

  it('exactly 14 deviation versions are tracked', () => {
    expect(DEVIATION_VERSIONS).toHaveLength(14);
  });

  it('deviation versions match the documented incident', () => {
    const log = readFileSync('docs/migrations/PRODUCTION_DEVIATION_LOG.md', 'utf-8');
    for (const v of DEVIATION_VERSIONS) {
      expect(log).toContain(`| ${v} |`);
    }
  });
});

describe('Migration repair guard — CI script integration', () => {
  const ALLOWLIST_PATH = 'docs/migrations/101-246-repair-allowlist.json';

  it('empty allowlist → exit 0', () => {
    // Allowlist is already empty in the repo
    const original = readFileSync(ALLOWLIST_PATH, 'utf-8');
    expect(JSON.parse(original)).toEqual([]);
    const result = execSync('node scripts/validate-migration-repair-guard.mjs', { encoding: 'utf-8' });
    expect(result).toContain('Allowlist is empty');
  });

  it('APPLIED_WITHOUT_EXECUTION version in allowlist → exit non-zero', () => {
    const original = readFileSync(ALLOWLIST_PATH, 'utf-8');
    try {
      writeFileSync(ALLOWLIST_PATH, JSON.stringify(['101']));
      expect(() => execSync('node scripts/validate-migration-repair-guard.mjs', { encoding: 'utf-8' })).toThrow();
    } finally {
      writeFileSync(ALLOWLIST_PATH, original);
    }
  });

  it('NOT_VERIFIABLE_SAFELY version in allowlist → exit non-zero', () => {
    const original = readFileSync(ALLOWLIST_PATH, 'utf-8');
    try {
      writeFileSync(ALLOWLIST_PATH, JSON.stringify(['226']));
      expect(() => execSync('node scripts/validate-migration-repair-guard.mjs', { encoding: 'utf-8' })).toThrow();
    } finally {
      writeFileSync(ALLOWLIST_PATH, original);
    }
  });

  it('SUPERSEDED version in allowlist → exit non-zero', () => {
    const original = readFileSync(ALLOWLIST_PATH, 'utf-8');
    try {
      writeFileSync(ALLOWLIST_PATH, JSON.stringify(['122']));
      expect(() => execSync('node scripts/validate-migration-repair-guard.mjs', { encoding: 'utf-8' })).toThrow();
    } finally {
      writeFileSync(ALLOWLIST_PATH, original);
    }
  });

  it('unknown version in allowlist → exit non-zero', () => {
    const original = readFileSync(ALLOWLIST_PATH, 'utf-8');
    try {
      writeFileSync(ALLOWLIST_PATH, JSON.stringify(['999']));
      expect(() => execSync('node scripts/validate-migration-repair-guard.mjs', { encoding: 'utf-8' })).toThrow();
    } finally {
      writeFileSync(ALLOWLIST_PATH, original);
    }
  });
});
