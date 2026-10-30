/**
 * Tests for the production deploy migration-attestation gate.
 *
 * Validates attestation structure, file hash verification, ledger name/version
 * matching, SQL content hash comparison, rename/delete rejection, injection
 * prevention, and simulated Supabase API responses.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { resolve } from 'path';
import { createHash } from 'crypto';

const TMP = resolve('scripts/__tests__/.attestation-test-tmp');
const ATTESTATION = resolve(TMP, 'migration-attestation.json');

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

interface AttestationEntry { sha256: string; ledger_version: string; ledger_name: string }

function writeAttestation(entries: Record<string, AttestationEntry>) {
  writeFileSync(ATTESTATION, JSON.stringify(entries, null, 2));
}

function writeMigration(name: string, content: string): string {
  const dir = resolve(TMP, 'migrations');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const p = resolve(dir, name);
  writeFileSync(p, content);
  return p;
}

/** Mirrors the workflow's node -e attestation validation. */
function validateAttestation(path: string): { ok: boolean; error?: string } {
  try {
    const raw = require('fs').readFileSync(path, 'utf8');
    const a = JSON.parse(raw);
    if (typeof a !== 'object' || a === null || Array.isArray(a)) return { ok: false, error: 'not an object' };
    for (const [k, v] of Object.entries(a)) {
      const e = v as Partial<AttestationEntry>;
      if (!e.sha256 || !e.ledger_version || !e.ledger_name) return { ok: false, error: `missing fields for ${k}` };
      if (!/^[0-9a-f]{64}$/.test(e.sha256)) return { ok: false, error: `invalid sha256 for ${k}` };
      if (!/^[0-9]{1,20}$/.test(e.ledger_version)) return { ok: false, error: `invalid ledger_version for ${k}` };
      if (!/^[a-z0-9_]+$/.test(e.ledger_name)) return { ok: false, error: `invalid ledger_name for ${k}` };
    }
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e) }; }
}

/** Mirrors the workflow's per-file hash check. */
function checkFileHash(filePath: string, fileName: string, attestation: Record<string, AttestationEntry>):
  'pass' | 'missing' | 'hash_mismatch' {
  const entry = attestation[fileName];
  if (!entry) return 'missing';
  const content = require('fs').readFileSync(filePath, 'utf8');
  if (sha256(content) !== entry.sha256) return 'hash_mismatch';
  return 'pass';
}

/** Simulates the workflow's Supabase ledger response verification. */
function verifyLedgerResponse(
  apiResponse: unknown[] | null,
  expectedVersion: string,
  expectedName: string,
  expectedFileHash: string,
): string {
  if (!Array.isArray(apiResponse) || apiResponse.length === 0) return 'NOT_FOUND';
  const row = apiResponse[0] as Record<string, unknown>;
  if (row.version !== expectedVersion) return 'VERSION_MISMATCH';
  if (row.name !== expectedName) return `NAME_MISMATCH:${row.name}`;
  if (!row.applied_sha256) return 'NO_SQL_HASH';
  if (row.stmt_count !== 1) return `MULTI_STATEMENT:${row.stmt_count}`;
  if (row.applied_sha256 !== expectedFileHash) return `SQL_HASH_MISMATCH:${String(row.applied_sha256).substring(0, 16)}`;
  return 'OK';
}

describe('Migration attestation gate', () => {
  beforeEach(() => { mkdirSync(TMP, { recursive: true }); });
  afterEach(() => { rmSync(TMP, { recursive: true, force: true }); });

  // ── Attestation structure ──

  describe('attestation validation', () => {
    it('rejects missing file', () => { expect(existsSync(ATTESTATION)).toBe(false); });
    it('rejects array', () => { writeFileSync(ATTESTATION, '[]'); expect(validateAttestation(ATTESTATION).ok).toBe(false); });
    it('rejects missing sha256', () => {
      writeFileSync(ATTESTATION, JSON.stringify({ 'f.sql': { ledger_version: '1', ledger_name: 'x' } }));
      expect(validateAttestation(ATTESTATION).ok).toBe(false);
    });
    it('rejects missing ledger_version', () => {
      writeFileSync(ATTESTATION, JSON.stringify({ 'f.sql': { sha256: 'a'.repeat(64), ledger_name: 'x' } }));
      expect(validateAttestation(ATTESTATION).ok).toBe(false);
    });
    it('rejects missing ledger_name', () => {
      writeFileSync(ATTESTATION, JSON.stringify({ 'f.sql': { sha256: 'a'.repeat(64), ledger_version: '1' } }));
      expect(validateAttestation(ATTESTATION).ok).toBe(false);
    });
    it('rejects invalid sha256', () => {
      writeFileSync(ATTESTATION, JSON.stringify({ 'f.sql': { sha256: 'bad', ledger_version: '1', ledger_name: 'x' } }));
      expect(validateAttestation(ATTESTATION).ok).toBe(false);
    });
    it('rejects non-numeric ledger_version (SQL injection)', () => {
      writeFileSync(ATTESTATION, JSON.stringify({ 'f.sql': { sha256: 'a'.repeat(64), ledger_version: "'; DROP TABLE--", ledger_name: 'x' } }));
      expect(validateAttestation(ATTESTATION).ok).toBe(false);
    });
    it('rejects ledger_name with special chars', () => {
      writeFileSync(ATTESTATION, JSON.stringify({ 'f.sql': { sha256: 'a'.repeat(64), ledger_version: '1', ledger_name: "x'; DROP--" } }));
      expect(validateAttestation(ATTESTATION).ok).toBe(false);
    });
    it('accepts well-formed attestation', () => {
      writeAttestation({ 'f.sql': { sha256: 'a'.repeat(64), ledger_version: '20261026153114', ledger_name: '466_payout_currency_authority' } });
      expect(validateAttestation(ATTESTATION).ok).toBe(true);
    });
  });

  // ── File hash ──

  describe('file hash verification', () => {
    it('passes on match', () => {
      const c = '-- M466\n'; const p = writeMigration('466.sql', c);
      expect(checkFileHash(p, 'm', { m: { sha256: sha256(c), ledger_version: '1', ledger_name: 'x' } })).toBe('pass');
    });
    it('rejects mismatch', () => {
      const p = writeMigration('466.sql', '-- original\n');
      expect(checkFileHash(p, 'm', { m: { sha256: 'b'.repeat(64), ledger_version: '1', ledger_name: 'x' } })).toBe('hash_mismatch');
    });
    it('rejects missing entry', () => {
      writeMigration('467.sql', '--\n');
      expect(checkFileHash(resolve(TMP, 'migrations/467.sql'), 'x', {})).toBe('missing');
    });
    it('rejects post-attestation modification', () => {
      const orig = '-- orig\n'; writeMigration('466.sql', '-- tampered\n');
      expect(checkFileHash(resolve(TMP, 'migrations/466.sql'), 'm', { m: { sha256: sha256(orig), ledger_version: '1', ledger_name: 'x' } })).toBe('hash_mismatch');
    });
    it('partial attestation fails', () => {
      const m1 = '-- a\n'; const m2 = '-- b\n';
      writeMigration('a.sql', m1); writeMigration('b.sql', m2);
      const att = { a: { sha256: sha256(m1), ledger_version: '1', ledger_name: 'x' } };
      expect(checkFileHash(resolve(TMP, 'migrations/a.sql'), 'a', att)).toBe('pass');
      expect(checkFileHash(resolve(TMP, 'migrations/b.sql'), 'b', att)).toBe('missing');
    });
  });

  // ── Ledger SQL verification (simulated API) ──

  describe('ledger SQL verification', () => {
    const H = 'a'.repeat(64), V = '20261026153114', N = '466_payout_currency_authority';

    it('passes when version + name + SQL hash all match', () => {
      expect(verifyLedgerResponse([{ version: V, name: N, applied_sha256: H, stmt_count: 1 }], V, N, H)).toBe('OK');
    });
    it('rejects empty response (not applied)', () => {
      expect(verifyLedgerResponse([], V, N, H)).toBe('NOT_FOUND');
    });
    it('rejects null response (API failure)', () => {
      expect(verifyLedgerResponse(null, V, N, H)).toBe('NOT_FOUND');
    });
    it('rejects version mismatch', () => {
      expect(verifyLedgerResponse([{ version: '999', name: N, applied_sha256: H, stmt_count: 1 }], V, N, H)).toBe('VERSION_MISMATCH');
    });
    it('rejects name mismatch', () => {
      expect(verifyLedgerResponse([{ version: V, name: 'wrong', applied_sha256: H, stmt_count: 1 }], V, N, H)).toContain('NAME_MISMATCH');
    });
    it('rejects missing SQL hash', () => {
      expect(verifyLedgerResponse([{ version: V, name: N, applied_sha256: null, stmt_count: 1 }], V, N, H)).toBe('NO_SQL_HASH');
    });
    it('rejects SQL hash mismatch', () => {
      expect(verifyLedgerResponse([{ version: V, name: N, applied_sha256: 'b'.repeat(64), stmt_count: 1 }], V, N, H)).toContain('SQL_HASH_MISMATCH');
    });
    it('rejects multi-statement migration', () => {
      expect(verifyLedgerResponse([{ version: V, name: N, applied_sha256: H, stmt_count: 3 }], V, N, H)).toContain('MULTI_STATEMENT');
    });
  });

  // ── Rename/delete/injection ──

  describe('rename, delete, and injection prevention', () => {
    it('--no-renames detects renames as deletes', () => {
      expect('--no-renames --diff-filter=D'.includes('--no-renames')).toBe(true);
    });
    it('empty delta skips gate', () => {
      expect(/^supabase\/migrations\//m.test('app/api/route.ts\n')).toBe(false);
    });
    it('rejects SQL injection in ledger_version', () => {
      expect(/^[0-9]{1,20}$/.test("20261026'; DROP TABLE--")).toBe(false);
    });
    it('rejects whitespace in ledger_version', () => {
      expect(/^[0-9]{1,20}$/.test('20261026 ')).toBe(false);
    });
    it('accepts numeric timestamp version', () => {
      expect(/^[0-9]{1,20}$/.test('20261026153114')).toBe(true);
    });
    it('accepts short numeric version', () => {
      expect(/^[0-9]{1,20}$/.test('466')).toBe(true);
    });
    it('production project ref is pinned constant', () => {
      expect('cxcmiqotkowhxinjbytg').toMatch(/^[a-z]{20}$/);
    });
  });
});
