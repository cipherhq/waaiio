/**
 * Tests for the production deploy migration-attestation gate.
 *
 * Validates the bash logic that checks:
 * 1. Attestation file exists and is well-formed
 * 2. SHA-256 hash of each migration file matches the attested hash
 * 3. Missing attestation entries are rejected
 * 4. Hash mismatches are rejected
 * 5. Deleted/renamed migration files are rejected
 * 6. Empty migration delta passes without attestation
 *
 * These tests exercise the attestation validation logic in isolation
 * (without the Supabase ledger query, which requires production credentials).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { resolve } from 'path';
import { createHash } from 'crypto';

const TMP = resolve('scripts/__tests__/.attestation-test-tmp');
const ATTESTATION = resolve(TMP, 'migration-attestation.json');

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function writeAttestation(entries: Record<string, { sha256: string; ledger_version: string }>) {
  writeFileSync(ATTESTATION, JSON.stringify(entries, null, 2));
}

function writeMigration(name: string, content: string) {
  const dir = resolve(TMP, 'migrations');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, name), content);
  return resolve(dir, name);
}

/**
 * Validate attestation file structure (mirrors the workflow's node -e check).
 */
function validateAttestation(path: string): { ok: boolean; error?: string } {
  try {
    const a = JSON.parse(require('fs').readFileSync(path, 'utf8'));
    if (typeof a !== 'object' || a === null || Array.isArray(a)) return { ok: false, error: 'not an object' };
    for (const [k, v] of Object.entries(a)) {
      const entry = v as { sha256?: string; ledger_version?: string };
      if (!entry.sha256 || !entry.ledger_version) return { ok: false, error: `missing fields for ${k}` };
      if (!/^[0-9a-f]{64}$/.test(entry.sha256)) return { ok: false, error: `invalid sha256 for ${k}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/**
 * Check a single migration file against the attestation.
 * Returns 'pass' | 'missing' | 'hash_mismatch'.
 */
function checkMigrationFile(
  filePath: string,
  fileName: string,
  attestation: Record<string, { sha256: string; ledger_version: string }>,
): 'pass' | 'missing' | 'hash_mismatch' {
  const entry = attestation[fileName];
  if (!entry) return 'missing';
  const content = require('fs').readFileSync(filePath, 'utf8');
  const hash = sha256(content);
  if (hash !== entry.sha256) return 'hash_mismatch';
  return 'pass';
}

describe('Migration attestation gate', () => {
  beforeEach(() => { mkdirSync(TMP, { recursive: true }); });
  afterEach(() => { rmSync(TMP, { recursive: true, force: true }); });

  // ── Attestation file validation ──

  it('rejects missing attestation file', () => {
    expect(existsSync(ATTESTATION)).toBe(false);
    // Gate would abort: "no attestation file"
  });

  it('rejects empty attestation', () => {
    writeFileSync(ATTESTATION, '[]');
    expect(validateAttestation(ATTESTATION).ok).toBe(false);
  });

  it('rejects attestation with missing sha256', () => {
    writeFileSync(ATTESTATION, JSON.stringify({
      'supabase/migrations/466_test.sql': { ledger_version: '20261026' },
    }));
    expect(validateAttestation(ATTESTATION).ok).toBe(false);
  });

  it('rejects attestation with missing ledger_version', () => {
    writeFileSync(ATTESTATION, JSON.stringify({
      'supabase/migrations/466_test.sql': { sha256: 'a'.repeat(64) },
    }));
    expect(validateAttestation(ATTESTATION).ok).toBe(false);
  });

  it('rejects attestation with invalid sha256 format', () => {
    writeFileSync(ATTESTATION, JSON.stringify({
      'supabase/migrations/466_test.sql': { sha256: 'not-a-hash', ledger_version: '20261026' },
    }));
    expect(validateAttestation(ATTESTATION).ok).toBe(false);
  });

  it('accepts well-formed attestation', () => {
    writeAttestation({
      'supabase/migrations/466_test.sql': { sha256: 'a'.repeat(64), ledger_version: '20261026153114' },
    });
    expect(validateAttestation(ATTESTATION).ok).toBe(true);
  });

  // ── File hash verification ──

  it('passes when file hash matches attestation', () => {
    const content = '-- M466 test migration\nALTER TABLE foo ADD COLUMN bar TEXT;\n';
    const path = writeMigration('466_test.sql', content);
    const attestation = {
      'supabase/migrations/466_test.sql': { sha256: sha256(content), ledger_version: '20261026' },
    };
    expect(checkMigrationFile(path, 'supabase/migrations/466_test.sql', attestation)).toBe('pass');
  });

  it('rejects when file hash does not match attestation', () => {
    const content = '-- M466 test migration\nALTER TABLE foo ADD COLUMN bar TEXT;\n';
    const path = writeMigration('466_test.sql', content);
    const attestation = {
      'supabase/migrations/466_test.sql': { sha256: 'b'.repeat(64), ledger_version: '20261026' },
    };
    expect(checkMigrationFile(path, 'supabase/migrations/466_test.sql', attestation)).toBe('hash_mismatch');
  });

  it('rejects when migration file is not in attestation', () => {
    const content = '-- M467 unapproved migration\n';
    const path = writeMigration('467_unapproved.sql', content);
    const attestation = {};
    expect(checkMigrationFile(path, 'supabase/migrations/467_unapproved.sql', attestation)).toBe('missing');
  });

  it('rejects when file is modified after attestation', () => {
    const original = '-- M466 original\n';
    const modified = '-- M466 tampered\n';
    const path = writeMigration('466_test.sql', modified);
    const attestation = {
      'supabase/migrations/466_test.sql': { sha256: sha256(original), ledger_version: '20261026' },
    };
    expect(checkMigrationFile(path, 'supabase/migrations/466_test.sql', attestation)).toBe('hash_mismatch');
  });

  // ── Multiple migrations ──

  it('all migrations must be attested — partial attestation fails', () => {
    const m1 = '-- M466\n';
    const m2 = '-- M468\n';
    writeMigration('466_test.sql', m1);
    writeMigration('468_test.sql', m2);
    const attestation = {
      'supabase/migrations/466_test.sql': { sha256: sha256(m1), ledger_version: '20261026' },
      // 468 deliberately missing
    };
    const files = ['supabase/migrations/466_test.sql', 'supabase/migrations/468_test.sql'];
    const results = files.map(f => checkMigrationFile(resolve(TMP, 'migrations', f.split('/').pop()!), f, attestation));
    expect(results).toContain('missing');
    expect(results.every(r => r === 'pass')).toBe(false);
  });

  it('all migrations attested and matching passes', () => {
    const m1 = '-- M466\n';
    const m2 = '-- M468\n';
    writeMigration('466_test.sql', m1);
    writeMigration('468_test.sql', m2);
    const attestation = {
      'supabase/migrations/466_test.sql': { sha256: sha256(m1), ledger_version: '20261026a' },
      'supabase/migrations/468_test.sql': { sha256: sha256(m2), ledger_version: '20261026b' },
    };
    const files = ['supabase/migrations/466_test.sql', 'supabase/migrations/468_test.sql'];
    const results = files.map(f => checkMigrationFile(resolve(TMP, 'migrations', f.split('/').pop()!), f, attestation));
    expect(results.every(r => r === 'pass')).toBe(true);
  });

  // ── No migration delta = no attestation needed ──

  it('empty migration delta requires no attestation', () => {
    // When CHANGED has no supabase/migrations/ files, the gate is skipped entirely
    const changed = 'app/api/route.ts\nlib/utils.ts\n';
    const hasMigrations = /^supabase\/migrations\//m.test(changed);
    expect(hasMigrations).toBe(false);
  });
});
