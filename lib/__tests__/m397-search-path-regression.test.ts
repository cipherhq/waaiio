/**
 * M397 — Regression tests for #365 (initialize_terminal_effects search_path)
 *
 * Tests:
 * 1. Real PostgreSQL: both terminal functions have search_path = public, extensions
 * 2. Real PostgreSQL: digest() resolves through the function's search_path
 * 3. Release Gate V2: M394-style replacement is detected and BLOCKS
 * 4. Migration lint: M394 pattern is caught by static analysis
 *
 * Tests 1-2 require TEST_DATABASE_URL (skip otherwise).
 * Tests 3-4 are synthetic (no DB required).
 */

import { describe, it, expect } from 'vitest';

// ═══════════════════════════════════════════════════════════════════
// Real PostgreSQL tests (require TEST_DATABASE_URL)
// ═══════════════════════════════════════════════════════════════════

import { execSync } from 'child_process';

const dbUrl = process.env.TEST_DATABASE_URL;

if (!dbUrl) {
  describe.skip('M397 — real PostgreSQL regression (requires TEST_DATABASE_URL)', () => {
    it('skipped', () => {});
  });
} else {

function runSQL(sql: string): string {
  try {
    return execSync(
      `psql "${dbUrl}" -t -A -v ON_ERROR_STOP=1`,
      { input: sql, encoding: 'utf-8', timeout: 15000 },
    ).trim();
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string };
    return `ERROR: ${e.stderr || e.stdout || 'unknown'}`;
  }
}

describe('M397 — real PostgreSQL: terminal function search_path', () => {
  it('initialize_terminal_effects has search_path = public, extensions', () => {
    const result = runSQL(`
      SELECT CASE WHEN 'search_path=public, extensions' = ANY(COALESCE(p.proconfig, ARRAY[]::text[]))
                  THEN 'OK' ELSE 'MISSING' END
      FROM pg_proc p
      WHERE p.oid = 'public.initialize_terminal_effects(uuid,uuid,text[],text[],text[],text[],integer)'::regprocedure;
    `);
    expect(result).toBe('OK');
  });

  it('finalize_payment_confirmation has search_path = public, extensions', () => {
    const result = runSQL(`
      SELECT CASE WHEN 'search_path=public, extensions' = ANY(COALESCE(p.proconfig, ARRAY[]::text[]))
                  THEN 'OK' ELSE 'MISSING' END
      FROM pg_proc p
      WHERE p.oid = 'public.finalize_payment_confirmation(uuid,uuid)'::regprocedure;
    `);
    expect(result).toBe('OK');
  });

  it('digest() resolves through search_path = public, extensions', () => {
    const result = runSQL(`
      SET search_path = public, extensions;
      SELECT encode(digest('m397-test-probe'::text, 'sha256'::text), 'hex');
    `);
    // SHA-256 of 'm397-test-probe' should be a 64-char hex string
    expect(result).toMatch(/^[a-f0-9]{64}$/);
  });
});

} // end if (dbUrl)

// ═══════════════════════════════════════════════════════════════════
// Release Gate V2 synthetic tests (no DB required)
// ═══════════════════════════════════════════════════════════════════

import { computeStateDiff } from '../release-gate/diff-engine';
import { lintMigration } from '../release-gate/migration-lint';
import type { BaselineSnapshot, FunctionCatalog } from '../release-gate/types';

function makeBaseline(overrides: Partial<BaselineSnapshot> = {}): BaselineSnapshot {
  return {
    id: 'test', captured_at: '2026-09-23T00:00:00Z', git_sha: 'abc123',
    phase: 'pre_deployment', label: 'Test',
    functions: [], function_grants: [], table_rls: [], rls_policies: [],
    extensions: [], constraints: [], triggers: [], cron_jobs: [],
    migrations: [], invariant_results: [], journey_results: [],
    ...overrides,
  };
}

function makeFunction(overrides: Partial<FunctionCatalog> = {}): FunctionCatalog {
  return {
    schema: 'public', name: 'test_function', arg_types: 'uuid, uuid',
    return_type: 'jsonb', security: 'definer', owner: 'postgres',
    proconfig: ['search_path=public, extensions'], language: 'plpgsql',
    body_hash: 'hash', ...overrides,
  };
}

describe('M397 — Release Gate V2: M394-style replacement detected and BLOCKED', () => {
  it('search_path regression from public,extensions to public-only → BLOCKED', () => {
    const before = makeBaseline({
      functions: [makeFunction({
        name: 'initialize_terminal_effects',
        arg_types: 'uuid, uuid, text[], text[], text[], text[], integer',
        proconfig: ['search_path=public, extensions'],
      })],
    });

    const after = makeBaseline({
      git_sha: 'def456',
      functions: [makeFunction({
        name: 'initialize_terminal_effects',
        arg_types: 'uuid, uuid, text[], text[], text[], text[], integer',
        proconfig: ['search_path=public'], // M394-style regression
      })],
    });

    const diff = computeStateDiff(before, after);
    expect(diff.verdict).toBe('BLOCKED');
    const entry = diff.entries.find(e =>
      e.object_id.includes('initialize_terminal_effects') && e.field === 'proconfig'
    );
    expect(entry).toBeDefined();
    expect(entry!.critical).toBe(true);
    expect(entry!.before).toContain('extensions');
    expect(entry!.after).not.toContain('extensions');
  });
});

describe('M397 — Migration lint: M394 pattern caught by static analysis', () => {
  it('CREATE OR REPLACE with search_path=public (missing extensions) → lint error', () => {
    const sql = `
      CREATE OR REPLACE FUNCTION initialize_terminal_effects(
        p_payment_id UUID, p_claim_token UUID,
        p_effect_keys TEXT[], p_categories TEXT[],
        p_execution_classes TEXT[], p_provider_channels TEXT[],
        p_manifest_version INTEGER DEFAULT 1
      ) RETURNS JSONB
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
      DECLARE v_hash text;
      BEGIN
        v_hash := encode(digest('test', 'sha256'), 'hex');
        RETURN '{}';
      END;
      $$;
    `;

    const violations = lintMigration('hypothetical_regression.sql', sql);
    const errors = violations.filter(v => v.severity === 'error');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some(v => v.message.includes('extensions'))).toBe(true);
  });

  it('M397 ALTER FUNCTION (the actual fix) passes lint cleanly', () => {
    const sql = `
      ALTER FUNCTION public.initialize_terminal_effects(
        uuid, uuid, text[], text[], text[], text[], integer
      ) SET search_path = public, extensions;
    `;

    const violations = lintMigration('397_restore_terminal_effects_search_path.sql', sql);
    expect(violations).toHaveLength(0);
  });
});
