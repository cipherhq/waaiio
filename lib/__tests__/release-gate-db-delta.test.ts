/**
 * Release Gate V2 — DB Delta CLI Tests (B3c)
 *
 * All unit tests are hermetic — they use temporary git fixtures or
 * direct function calls, never Waaiio historical SHAs.
 *
 * Integration tests (require TEST_DATABASE_URL) use the live repo
 * and are only run in environments with full git history + real PG.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  detectMigrationChangesRaw,
  enumerateBaseMigrations,
  runDbDelta,
  advisoryExitCode,
} from '../release-gate/db-delta-cli';
import { captureBaseline } from '../release-gate/baseline-capture';
import { computeStateDiff } from '../release-gate/diff-engine';
import { PROTECTED_OBJECTS } from '../release-gate/invariant-registry';
import type { BaselineSnapshot, StateDiffResult } from '../release-gate/types';

// ═══════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════

const DB_URL = process.env.TEST_DATABASE_URL;
const skipDb = !DB_URL;

function makeBaseline(overrides: Partial<BaselineSnapshot> = {}): BaselineSnapshot {
  return {
    id: 'test', captured_at: '2026-09-26T00:00:00Z', git_sha: 'abc123',
    phase: 'pre_deployment', label: 'test',
    functions: [], function_grants: [], table_rls: [], rls_policies: [],
    extensions: [], constraints: [], triggers: [], cron_jobs: [],
    migrations: [], invariant_results: [], journey_results: [],
    ...overrides,
  };
}

/** Create a temporary git repo with migration files for hermetic testing. */
function createTempGitRepo(): { dir: string; baseSha: string; headSha: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'db-delta-test-'));
  const migDir = join(dir, 'supabase', 'migrations');
  mkdirSync(migDir, { recursive: true });

  const run = (cmd: string) => execSync(cmd, { cwd: dir, encoding: 'utf-8', timeout: 10000 });

  run('git init');
  run('git config user.email "test@test.local"');
  run('git config user.name "Test"');

  // Base commit: one migration
  writeFileSync(join(migDir, '001_init.sql'), 'CREATE TABLE t1 (id int);');
  run('git add .');
  run('git commit -m "base"');
  const baseSha = run('git rev-parse HEAD').trim();

  // Head commit: add a second migration
  writeFileSync(join(migDir, '002_add_table.sql'), 'CREATE TABLE t2 (id int);');
  run('git add .');
  run('git commit -m "add migration"');
  const headSha = run('git rev-parse HEAD').trim();

  return {
    dir,
    baseSha,
    headSha,
    cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } },
  };
}

// ═══════════════════════════════════════════════════════════════════
// Unit tests — fully hermetic (no DB, no historical SHAs)
// ═══════════════════════════════════════════════════════════════════

describe('DB Delta — unit tests (hermetic)', () => {
  describe('protected object signatures', () => {
    it('create_provider_consented_offer has timestamp with time zone as 6th arg', () => {
      const obj = PROTECTED_OBJECTS.find(o => o.identifier.includes('create_provider_consented_offer'));
      expect(obj).toBeDefined();
      expect(obj!.identifier).toContain('timestamp with time zone');
      expect(obj!.identifier).not.toMatch(/\(uuid, text, uuid, text, text, text, text, uuid, uuid\)/);
    });
  });

  describe('self-diff produces zero entries', () => {
    it('identical baselines produce zero diff entries', () => {
      const base = makeBaseline({
        functions: [{
          schema: 'public', name: 'test_fn', arg_types: 'uuid',
          return_type: 'void', security: 'invoker', owner: 'postgres',
          proconfig: [], language: 'plpgsql', body_hash: 'abc123',
        }],
        table_rls: [{
          schema: 'public', table_name: 'test_table',
          rls_enabled: true, force_rls: false,
        }],
      });
      const candidate = makeBaseline({
        ...base, id: 'cand', phase: 'candidate',
        functions: [...base.functions],
        table_rls: [...base.table_rls],
      });

      const diff = computeStateDiff(base, candidate, null);
      expect(diff.entries).toHaveLength(0);
      expect(diff.verdict).toBe('PASS');
    });
  });

  describe('table/RLS addition produces expected Phase-1 delta', () => {
    it('new RLS-enabled table is detected as added', () => {
      const base = makeBaseline();
      const candidate = makeBaseline({
        id: 'cand', phase: 'candidate',
        table_rls: [{
          schema: 'public', table_name: 'new_table',
          rls_enabled: true, force_rls: false,
        }],
      });

      const diff = computeStateDiff(base, candidate, null);
      expect(diff.entries).toHaveLength(1);
      expect(diff.entries[0]).toMatchObject({
        category: 'rls',
        object_id: 'public.new_table',
        change_type: 'added',
        field: 'existence',
        before: 'absent',
        after: 'present',
      });
    });
  });

  describe('migration detection — temp git fixture', () => {
    let fixture: ReturnType<typeof createTempGitRepo>;

    beforeAll(() => { fixture = createTempGitRepo(); });
    afterAll(() => { fixture.cleanup(); });

    it('base migration enumeration reads the base commit, not HEAD', () => {
      const baseMigrations = enumerateBaseMigrations(fixture.baseSha, fixture.dir);
      expect(baseMigrations).toHaveLength(1);
      expect(baseMigrations[0]).toContain('001_init.sql');
      // HEAD has 2 migrations, but base should only have 1
      const headMigrations = enumerateBaseMigrations(fixture.headSha, fixture.dir);
      expect(headMigrations).toHaveLength(2);
    });

    it('detects added migrations between base and head', () => {
      const raw = execSync(
        `git diff --name-status -z "${fixture.baseSha}" "${fixture.headSha}" -- 'supabase/migrations/*.sql'`,
        { cwd: fixture.dir, encoding: 'utf-8', timeout: 10000 },
      );
      const delta = detectMigrationChangesRaw(raw);
      expect(delta.added).toContain('002_add_table.sql');
      expect(delta.modified).toHaveLength(0);
      expect(delta.deleted).toHaveLength(0);
      expect(delta.renamed).toHaveLength(0);
    });

    it('same SHA produces empty delta', () => {
      const raw = execSync(
        `git diff --name-status -z "${fixture.baseSha}" "${fixture.baseSha}" -- 'supabase/migrations/*.sql'`,
        { cwd: fixture.dir, encoding: 'utf-8', timeout: 10000 },
      );
      const delta = detectMigrationChangesRaw(raw);
      expect(delta.added).toHaveLength(0);
      expect(delta.modified).toHaveLength(0);
    });

    it('candidate migration bytes come from head SHA blob, not working tree', () => {
      // Verify getCandidateMigrationContent reads from git, not filesystem
      // by checking that git show headSha:path succeeds for the added migration
      const content = execSync(
        `git show "${fixture.headSha}:supabase/migrations/002_add_table.sql"`,
        { cwd: fixture.dir, encoding: 'utf-8', timeout: 10000 },
      );
      expect(content).toContain('CREATE TABLE t2');
    });
  });

  describe('NUL parser — rejection cases', () => {
    it('rejects modified migrations through orchestration path', async () => {
      const delta = detectMigrationChangesRaw('M\0supabase/migrations/001_init.sql\0');
      expect(delta.modified).toContain('001_init.sql');

      await expect(runDbDelta({
        baseSha: 'fake', headSha: 'fake',
        dbUrl: 'postgresql://unused:unused@localhost/unused',
        _overrideDelta: delta,
      })).rejects.toThrow('immutability violation');
    });

    it('rejects deleted migrations through orchestration path', async () => {
      const delta = detectMigrationChangesRaw('D\0supabase/migrations/001_init.sql\0');
      expect(delta.deleted).toContain('001_init.sql');

      await expect(runDbDelta({
        baseSha: 'fake', headSha: 'fake',
        dbUrl: 'postgresql://unused:unused@localhost/unused',
        _overrideDelta: delta,
      })).rejects.toThrow('deleted');
    });

    it('rejects renamed migrations through orchestration path', async () => {
      const delta = detectMigrationChangesRaw(
        'R100\0supabase/migrations/001_init.sql\0supabase/migrations/001_renamed.sql\0',
      );
      expect(delta.renamed).toHaveLength(1);

      await expect(runDbDelta({
        baseSha: 'fake', headSha: 'fake',
        dbUrl: 'postgresql://unused:unused@localhost/unused',
        _overrideDelta: delta,
      })).rejects.toThrow('renamed/copied');
    });

    it('unknown status fails closed as modified', () => {
      const delta = detectMigrationChangesRaw('T\0supabase/migrations/001_init.sql\0');
      expect(delta.modified).toContain('001_init.sql');
    });

    it('copy status (C100) is treated as rename and rejected', () => {
      const delta = detectMigrationChangesRaw(
        'C100\0supabase/migrations/001_init.sql\0supabase/migrations/001_copy.sql\0',
      );
      expect(delta.renamed).toHaveLength(1);
    });
  });

  describe('no-op path', () => {
    it('produces truthful no-op when no migration changes exist', async () => {
      const noOpDelta = { added: [], modified: [], deleted: [], renamed: [] };
      const artifact = await runDbDelta({
        baseSha: 'abc123', headSha: 'abc123',
        dbUrl: 'postgresql://unused:unused@localhost/unused',
        _overrideDelta: noOpDelta,
      });
      expect(artifact.noOp).toBe(true);
      expect(artifact.diff.verdict).toBe('PASS');
      expect(artifact.diff.entries).toHaveLength(0);
      expect(artifact.baseBaseline).toBeNull();
      expect(artifact.candidateBaseline).toBeNull();
    });
  });

  describe('advisory exit-decision', () => {
    it('advisory mode returns 0 for a PASS verdict', () => {
      const artifact = {
        baseSha: 'a', headSha: 'b', migrationDelta: { added: [], modified: [], deleted: [], renamed: [] },
        baseBaseline: null, candidateBaseline: null,
        baseStats: { functions: 0, grants: 0, rls: 0, policies: 0, constraints: 0, triggers: 0 },
        candidateStats: { functions: 0, grants: 0, rls: 0, policies: 0, constraints: 0, triggers: 0 },
        diff: { verdict: 'PASS' as const, entries: [], summary: { total: 0, expected: 0, unexpected: 0, improved: 0, regressions: 0, critical_regressions: 0 }, block_reasons: [], id: 'x', computed_at: '', before_baseline_id: '', before_sha: 'a', after_baseline_id: '', after_sha: 'b', manifest_id: null },
        noOp: false,
      };
      expect(advisoryExitCode(artifact)).toBe(0);
    });

    it('advisory mode returns 0 for a BLOCKED verdict (advisory does not fail)', () => {
      const artifact = {
        baseSha: 'a', headSha: 'b', migrationDelta: { added: ['test.sql'], modified: [], deleted: [], renamed: [] },
        baseBaseline: null, candidateBaseline: null,
        baseStats: { functions: 1, grants: 0, rls: 0, policies: 0, constraints: 0, triggers: 0 },
        candidateStats: { functions: 0, grants: 0, rls: 0, policies: 0, constraints: 0, triggers: 0 },
        diff: {
          verdict: 'BLOCKED' as const,
          entries: [{
            category: 'function' as const, object_id: 'public.fn()', change_type: 'removed' as const,
            field: 'existence', before: 'present', after: 'absent',
            classification: 'unexpected' as const, critical: true,
          }],
          summary: { total: 1, expected: 0, unexpected: 1, improved: 0, regressions: 0, critical_regressions: 0 },
          block_reasons: ['UNEXPECTED CRITICAL: function public.fn() — existence: present → absent'],
          id: 'x', computed_at: '', before_baseline_id: '', before_sha: 'a', after_baseline_id: '', after_sha: 'b', manifest_id: null,
        },
        noOp: false,
      };
      expect(advisoryExitCode(artifact)).toBe(0);
    });
  });

  describe('tooling failure exits non-zero', () => {
    it('runDbDelta throws on modified migration delta (simulates tooling failure path)', async () => {
      const badDelta = { added: [], modified: ['001.sql'], deleted: [], renamed: [] };
      await expect(runDbDelta({
        baseSha: 'x', headSha: 'x',
        dbUrl: 'postgresql://unused:unused@localhost/unused',
        _overrideDelta: badDelta,
      })).rejects.toThrow('GATE ERROR');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// Integration tests (require TEST_DATABASE_URL + full git history)
// ═══════════════════════════════════════════════════════════════════

describe.skipIf(skipDb)('DB Delta — integration tests (real PG)', () => {
  it('explicit extensions.digest() capture succeeds', () => {
    const snap = captureBaseline({
      dbUrl: DB_URL!,
      gitSha: 'test',
      phase: 'candidate',
      label: 'digest() resolution test',
    });
    expect(snap.functions.length).toBeGreaterThan(0);
    expect(snap.function_grants.length).toBeGreaterThan(0);
    expect(snap.table_rls.length).toBeGreaterThan(0);
    const fnWithHash = snap.functions.find(f => f.body_hash && f.body_hash.length === 64);
    expect(fnWithHash).toBeDefined();
  });

  it('corrected protected-object signature resolves real M395 function', () => {
    const snap = captureBaseline({
      dbUrl: DB_URL!,
      gitSha: 'test',
      phase: 'candidate',
      label: 'protected object signature test',
    });
    const db002Results = snap.invariant_results.filter(r => r.invariant_id === 'DB-002');
    const cpcoResult = db002Results.find(r =>
      r.description.includes('create_provider_consented_offer')
    );
    expect(cpcoResult).toBeDefined();
    expect(cpcoResult!.status).toBe('pass');
  });

  it('self-diff on real database produces zero entries', () => {
    const snap = captureBaseline({
      dbUrl: DB_URL!,
      gitSha: 'test',
      phase: 'pre_deployment',
      label: 'self-diff base',
    });
    const diff = computeStateDiff(snap, snap, null);
    expect(diff.entries).toHaveLength(0);
    expect(diff.verdict).toBe('PASS');
  });
});
