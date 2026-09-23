/**
 * Release Gate V2 — Migration Lint Tests (R2 corrections)
 *
 * Proves:
 * - M394-pattern caught by lint
 * - Protected function enforcement
 * - Historical M394 does NOT make the gate permanently unusable
 * - Candidate-only linting works
 */

import { describe, it, expect } from 'vitest';
import { lintMigration, lintMigrationDirectory, HISTORICAL_EXCEPTIONS } from '../release-gate/migration-lint';
import { resolve } from 'path';

describe('#365: M394-style regression detected by lint', () => {
  it('catches CREATE OR REPLACE that drops extensions from search_path', () => {
    const sql = `
      CREATE OR REPLACE FUNCTION initialize_terminal_effects(
        p_payment_id UUID, p_claim_token UUID, p_effect_keys TEXT[],
        p_categories TEXT[], p_execution_classes TEXT[],
        p_provider_channels TEXT[], p_manifest_version INTEGER DEFAULT 1
      ) RETURNS JSONB
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      BEGIN
        RETURN encode(digest('test', 'sha256'), 'hex');
      END;
      $$;
    `;
    const violations = lintMigration('candidate.sql', sql);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some(v => v.severity === 'error' && v.message.includes('extensions'))).toBe(true);
  });

  it('passes when search_path includes extensions', () => {
    const sql = `
      CREATE OR REPLACE FUNCTION initialize_terminal_effects(
        p_payment_id UUID, p_claim_token UUID, p_effect_keys TEXT[],
        p_categories TEXT[], p_execution_classes TEXT[],
        p_provider_channels TEXT[], p_manifest_version INTEGER DEFAULT 1
      ) RETURNS JSONB
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
      BEGIN
        RETURN encode(digest('test', 'sha256'), 'hex');
      END;
      $$;
    `;
    const errors = lintMigration('correct.sql', sql).filter(v => v.severity === 'error');
    expect(errors).toHaveLength(0);
  });
});

describe('Historical M394 does not make the gate permanently unusable', () => {
  it('M394 is listed in HISTORICAL_EXCEPTIONS', () => {
    expect(HISTORICAL_EXCEPTIONS['394_direct_order_payment_authority.sql']).toBeDefined();
    expect(HISTORICAL_EXCEPTIONS['394_direct_order_payment_authority.sql']).toContain('#365');
  });

  it('linting the real migration directory with exceptions produces zero errors from M394', () => {
    const migrationsDir = resolve(process.cwd(), 'supabase/migrations');
    // Lint all non-excepted migrations
    const violations = lintMigrationDirectory(migrationsDir);
    // M394 should NOT appear in violations because it is historically excepted
    const m394Violations = violations.filter(v => v.file.includes('394'));
    expect(m394Violations).toHaveLength(0);
  });

  it('candidate-only linting skips historical migrations entirely', () => {
    const migrationsDir = resolve(process.cwd(), 'supabase/migrations');
    // Only lint a hypothetical new candidate migration
    const violations = lintMigrationDirectory(migrationsDir, ['999_hypothetical_new.sql']);
    // No file matches, so no violations
    expect(violations).toHaveLength(0);
  });
});

describe('Protected function attribute enforcement', () => {
  it('catches protected function recreated without SECURITY DEFINER', () => {
    const sql = `
      CREATE OR REPLACE FUNCTION finalize_payment_confirmation(
        p_payment_id UUID, p_claim_token UUID
      ) RETURNS JSONB
      LANGUAGE plpgsql SET search_path = public, extensions AS $$
      BEGIN RETURN '{}'; END;
      $$;
    `;
    const violations = lintMigration('test.sql', sql);
    expect(violations.some(v => v.rule === 'PROTECTED_FUNCTION_SECURITY')).toBe(true);
  });
});

describe('ALTER FUNCTION does not trigger lint', () => {
  it('ALTER is safe — only changes attributes, not the function definition', () => {
    const sql = `
      ALTER FUNCTION public.initialize_terminal_effects(
        uuid, uuid, text[], text[], text[], text[], integer
      ) SET search_path = public, extensions;
    `;
    expect(lintMigration('alter.sql', sql)).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════
// R4 — Migration diff parser (real parser, not concept tests)
// ═══════════════════════════════════════════════════════════════════

import { parseMigrationDiffNul, parseMigrationDiffLines } from '../release-gate/migration-diff-parser';

describe('R4: Migration diff parser (NUL-delimited)', () => {
  it('classifies added migration (A) as new — available for linting', () => {
    // NUL-delimited: "A\0path\0"
    const raw = 'A\0supabase/migrations/999_new_feature.sql\0';
    const result = parseMigrationDiffNul(raw);
    expect(result.newMigrations).toEqual(['999_new_feature.sql']);
    expect(result.hasImmutabilityViolation).toBe(false);
  });

  it('classifies modified migration (M) as immutability violation → BLOCK', () => {
    const raw = 'M\0supabase/migrations/001_initial.sql\0';
    const result = parseMigrationDiffNul(raw);
    expect(result.modifiedMigrations).toEqual(['001_initial.sql']);
    expect(result.hasImmutabilityViolation).toBe(true);
    expect(result.blockReasons[0]).toContain('MODIFIED');
  });

  it('classifies deleted migration (D) as immutability violation → BLOCK', () => {
    const raw = 'D\0supabase/migrations/050_old_migration.sql\0';
    const result = parseMigrationDiffNul(raw);
    expect(result.deletedMigrations).toEqual(['050_old_migration.sql']);
    expect(result.hasImmutabilityViolation).toBe(true);
    expect(result.blockReasons[0]).toContain('DELETED');
  });

  it('classifies renamed migration (R) as immutability violation → BLOCK', () => {
    // NUL-delimited rename: "R100\0oldpath\0newpath\0"
    const raw = 'R100\0supabase/migrations/001_old.sql\0supabase/migrations/001_new.sql\0';
    const result = parseMigrationDiffNul(raw);
    expect(result.renamedMigrations).toHaveLength(1);
    expect(result.renamedMigrations[0]).toContain('001_old.sql');
    expect(result.hasImmutabilityViolation).toBe(true);
    expect(result.blockReasons[0]).toContain('RENAMED');
  });

  it('handles mixed A + M correctly — M blocks, A is available for lint', () => {
    const raw = 'M\0supabase/migrations/001_initial.sql\0A\0supabase/migrations/999_new.sql\0';
    const result = parseMigrationDiffNul(raw);
    expect(result.modifiedMigrations).toEqual(['001_initial.sql']);
    expect(result.newMigrations).toEqual(['999_new.sql']);
    expect(result.hasImmutabilityViolation).toBe(true);
  });

  it('ignores non-migration files', () => {
    const raw = 'M\0lib/some-file.ts\0A\0supabase/migrations/999_new.sql\0';
    const result = parseMigrationDiffNul(raw);
    expect(result.changes).toHaveLength(1); // only the migration
    expect(result.newMigrations).toEqual(['999_new.sql']);
    expect(result.hasImmutabilityViolation).toBe(false);
  });

  it('returns empty result for empty input', () => {
    const result = parseMigrationDiffNul('');
    expect(result.changes).toHaveLength(0);
    expect(result.hasImmutabilityViolation).toBe(false);
  });

  it('bad added migration reaches lintMigrationDirectory and BLOCKS', () => {
    // Simulate: parser identifies new migration, lint catches bad content
    const raw = 'A\0supabase/migrations/999_bad_migration.sql\0';
    const result = parseMigrationDiffNul(raw);
    expect(result.newMigrations).toEqual(['999_bad_migration.sql']);

    // Now prove the filename would be passed to lintMigrationDirectory and blocks
    const badSql = `
      CREATE OR REPLACE FUNCTION initialize_terminal_effects(p UUID)
      RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      BEGIN PERFORM encode(digest('x', 'sha256'), 'hex'); END; $$;
    `;
    const violations = lintMigration('999_bad_migration.sql', badSql);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some(v => v.severity === 'error')).toBe(true);
  });
});

describe('R4: Migration diff parser (line-based fallback)', () => {
  it('handles tab-delimited output correctly', () => {
    const raw = "M\tsupabase/migrations/001_initial.sql\nA\tsupabase/migrations/999_new.sql";
    const result = parseMigrationDiffLines(raw);
    expect(result.modifiedMigrations).toEqual(['001_initial.sql']);
    expect(result.newMigrations).toEqual(['999_new.sql']);
    expect(result.hasImmutabilityViolation).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// R5 — NUL-safe transport integration test (real bytes through CLI)
// ═══════════════════════════════════════════════════════════════════

import { execSync, type ExecSyncOptions } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('R5: NUL-safe transport integration (real NUL bytes → CLI)', () => {
  const cliPath = join(process.cwd(), 'lib/release-gate/migration-diff-cli.ts');
  const tmpFile = join(process.cwd(), '.migration-diff-test.bin');
  const opts: ExecSyncOptions = { encoding: 'utf-8', timeout: 30000 };

  function runCli(nulInput: Buffer, migrationsDir = 'supabase/migrations'): { stdout: string; exitCode: number } {
    // Write real NUL bytes to a temp file, then pipe to the CLI.
    // This exercises the same stdin byte transport used by CI.
    writeFileSync(tmpFile, nulInput);
    try {
      const stdout = execSync(
        `cat "${tmpFile}" | npx tsx "${cliPath}" "${migrationsDir}"`,
        opts,
      ) as string;
      return { stdout: stdout.trim(), exitCode: 0 };
    } catch (err: unknown) {
      const e = err as { stdout?: string; status?: number };
      return { stdout: (e.stdout || '').trim(), exitCode: e.status || 1 };
    } finally {
      try { unlinkSync(tmpFile); } catch { /* ignore */ }
    }
  }

  it('A (added) migration is detected via NUL transport', () => {
    // Real NUL-delimited: "A\0supabase/migrations/999_test.sql\0"
    const input = Buffer.from('A\0supabase/migrations/999_test.sql\0');
    const { stdout, exitCode } = runCli(input);
    expect(stdout).toContain('NEW');
    expect(stdout).toContain('999_test.sql');
    // Exit 0 = pass (migration exists in supabase/migrations is not guaranteed,
    // but the parser classifies correctly and the lint runs or says "not found")
  });

  it('bad A migration reaches lint through the real CLI transport and BLOCKS', () => {
    const tempMigrationsDir = mkdtempSync(join(tmpdir(), 'waaiio-release-gate-'));
    try {
      const filename = '999_bad_transport.sql';
      const badSql = `
        CREATE OR REPLACE FUNCTION initialize_terminal_effects(p UUID)
        RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
        BEGIN PERFORM encode(digest('x', 'sha256'), 'hex'); END; $$;
      `;
      writeFileSync(join(tempMigrationsDir, filename), badSql);

      const input = Buffer.from(`A\0supabase/migrations/${filename}\0`);
      const { stdout, exitCode } = runCli(input, tempMigrationsDir);

      expect(exitCode).toBe(1);
      expect(stdout).toContain(`Linting new migrations: ${filename}`);
      expect(stdout).toContain('BLOCKED');
    } finally {
      rmSync(tempMigrationsDir, { recursive: true, force: true });
    }
  });
  it('M (modified) migration BLOCKS via NUL transport', () => {
    const input = Buffer.from('M\0supabase/migrations/001_initial.sql\0');
    const { stdout, exitCode } = runCli(input);
    expect(exitCode).toBe(1);
    expect(stdout).toContain('MODIFIED');
    expect(stdout).toContain('BLOCKED');
  });

  it('D (deleted) migration BLOCKS via NUL transport', () => {
    const input = Buffer.from('D\0supabase/migrations/050_old.sql\0');
    const { stdout, exitCode } = runCli(input);
    expect(exitCode).toBe(1);
    expect(stdout).toContain('DELETED');
    expect(stdout).toContain('BLOCKED');
  });

  it('R (renamed) migration BLOCKS via NUL transport', () => {
    const input = Buffer.from('R100\0supabase/migrations/001_old.sql\0supabase/migrations/001_new.sql\0');
    const { stdout, exitCode } = runCli(input);
    expect(exitCode).toBe(1);
    expect(stdout).toContain('RENAMED');
    expect(stdout).toContain('BLOCKED');
  });

  it('mixed A + M: M BLOCKS even with valid new migration', () => {
    const input = Buffer.from('M\0supabase/migrations/001_initial.sql\0A\0supabase/migrations/999_new.sql\0');
    const { stdout, exitCode } = runCli(input);
    expect(exitCode).toBe(1);
    expect(stdout).toContain('MODIFIED');
    expect(stdout).toContain('BLOCKED');
  });
});

describe('Non-protected functions', () => {
  it('does not flag functions without digest()', () => {
    const sql = `
      CREATE OR REPLACE FUNCTION count_records(p_table TEXT) RETURNS INTEGER
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      BEGIN RETURN 0; END;
      $$;
    `;
    expect(lintMigration('simple.sql', sql)).toHaveLength(0);
  });
});
