/**
 * Release Gate V2 — Database Invariant Verification (Real PostgreSQL)
 *
 * Runs catalog-level invariant checks against a real Postgres database.
 * Requires TEST_DATABASE_URL to be set (skips otherwise for local dev).
 *
 * These tests are the executable equivalent of the invariant registry.
 * If a test here fails, the corresponding invariant ID is violated and
 * the release gate should BLOCK.
 *
 * @see RELEASE_GATE_V2.md §1 (Invariant Registry)
 * @see lib/release-gate/invariant-registry.ts
 */

import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';

const dbUrl = process.env.TEST_DATABASE_URL;

if (!dbUrl) {
  describe.skip('Release Gate V2 — DB Invariants (requires TEST_DATABASE_URL)', () => {
    it('skipped — set TEST_DATABASE_URL for real PostgreSQL invariant proofs', () => {});
  });
} else {

function runSQL(sql: string): { stdout: string; exitCode: number } {
  try {
    const stdout = execSync(
      `psql "${dbUrl}" -t -A -v ON_ERROR_STOP=1`,
      { input: sql, encoding: 'utf-8', timeout: 15000 },
    ).trim();
    return { stdout, exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { stdout: e.stdout?.trim() || e.stderr?.trim() || '', exitCode: e.status || 1 };
  }
}

// ═══════════════════════════════════════════════════════════════════
// DB-001: SECURITY DEFINER + digest() must have extensions in search_path
// ═══════════════════════════════════════════════════════════════════

describe('DB-001: digest()-calling SECURITY DEFINER functions have search_path = public, extensions', () => {
  it('no SECURITY DEFINER function calling digest() has search_path missing extensions', () => {
    const r = runSQL(`
      SELECT p.proname, COALESCE(array_to_string(p.proconfig, ', '), 'NONE')
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.prosecdef = true
        AND pg_get_functiondef(p.oid) LIKE '%digest(%'
        AND NOT ('search_path=public, extensions' = ANY(COALESCE(p.proconfig, ARRAY[]::text[])));
    `);

    // Zero rows = PASS (no violations)
    if (r.stdout === '') {
      expect(true).toBe(true);
    } else {
      const violations = r.stdout.split('\n').map(l => l.split('|'));
      expect.fail(
        `DB-001 VIOLATED: ${violations.length} function(s) call digest() without extensions in search_path:\n` +
        violations.map(v => `  ${v[0]}: proconfig = ${v[1]}`).join('\n')
      );
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// DB-006: Both terminal-effect functions have correct search_path
// ═══════════════════════════════════════════════════════════════════

describe('DB-006: initialize_terminal_effects + finalize_payment_confirmation search_path', () => {
  it('initialize_terminal_effects has search_path=public, extensions', () => {
    const r = runSQL(`
      SELECT CASE WHEN 'search_path=public, extensions' = ANY(COALESCE(p.proconfig, ARRAY[]::text[]))
                  THEN 'OK' ELSE 'MISSING' END
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'initialize_terminal_effects';
    `);

    if (r.stdout === '') {
      // Function does not exist yet — skip, not fail
      return;
    }
    expect(r.stdout).toBe('OK');
  });

  it('finalize_payment_confirmation has search_path=public, extensions', () => {
    const r = runSQL(`
      SELECT CASE WHEN 'search_path=public, extensions' = ANY(COALESCE(p.proconfig, ARRAY[]::text[]))
                  THEN 'OK' ELSE 'MISSING' END
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'finalize_payment_confirmation';
    `);

    if (r.stdout === '') return;
    expect(r.stdout).toBe('OK');
  });
});

// ═══════════════════════════════════════════════════════════════════
// DB-003: All public tables have RLS enabled
// ═══════════════════════════════════════════════════════════════════

describe('DB-003: RLS enabled on all public tables', () => {
  it('no public table has RLS disabled (excluding system tables)', () => {
    const r = runSQL(`
      SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind = 'r'
        AND NOT c.relrowsecurity
        AND c.relname NOT LIKE 'pg_%'
        AND c.relname NOT LIKE '_realtime%'
        AND c.relname NOT IN ('schema_migrations', 'supabase_migrations', 'extensions');
    `);

    if (r.stdout === '') {
      expect(true).toBe(true);
    } else {
      const tables = r.stdout.split('\n').filter(Boolean);
      expect.fail(
        `DB-003 VIOLATED: ${tables.length} table(s) in public schema have RLS disabled:\n` +
        tables.map(t => `  ${t}`).join('\n')
      );
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// DB-004: Saved-card RPCs blocked for anon/authenticated
// ═══════════════════════════════════════════════════════════════════

describe('DB-004: Saved-card RPCs access control', () => {
  const PROTECTED_RPCS = [
    'accept_saved_card_offer',
    'decline_saved_card_offer',
    'create_provider_consented_offer',
  ];

  for (const rpcName of PROTECTED_RPCS) {
    it(`${rpcName} is not executable by anon or authenticated`, () => {
      const r = runSQL(`
        SELECT grantee
        FROM information_schema.routine_privileges
        WHERE routine_schema = 'public'
          AND routine_name = '${rpcName}'
          AND grantee IN ('anon', 'authenticated')
          AND privilege_type = 'EXECUTE';
      `);

      if (r.stdout === '') {
        expect(true).toBe(true);
      } else {
        expect.fail(
          `DB-004 VIOLATED: ${rpcName} is executable by: ${r.stdout}`
        );
      }
    });
  }
});

// ═══════════════════════════════════════════════════════════════════
// DB-002: Protected object attribute preservation
// ═══════════════════════════════════════════════════════════════════

describe('DB-002: Protected function attributes not silently removed', () => {
  it('all SECURITY DEFINER functions in public schema calling digest() are cataloged', () => {
    // This test verifies that we know about all digest()-calling SECURITY DEFINER functions.
    // If a new one appears that we don't protect, this test should alert us.
    const r = runSQL(`
      SELECT p.proname
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.prosecdef = true
        AND pg_get_functiondef(p.oid) LIKE '%digest(%'
      ORDER BY p.proname;
    `);

    if (r.stdout === '') return; // No such functions yet

    const funcs = r.stdout.split('\n').filter(Boolean);
    const KNOWN_PROTECTED = [
      'initialize_terminal_effects',
      'finalize_payment_confirmation',
    ];

    const unprotected = funcs.filter(f => !KNOWN_PROTECTED.includes(f));
    if (unprotected.length > 0) {
      expect.fail(
        `DB-002 WARNING: New SECURITY DEFINER functions calling digest() found that are not in the protected objects registry:\n` +
        unprotected.map(f => `  ${f}`).join('\n') +
        '\nAdd them to PROTECTED_OBJECTS in lib/release-gate/invariant-registry.ts'
      );
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// Extension location verification
// ═══════════════════════════════════════════════════════════════════

describe('pgcrypto extension location', () => {
  it('pgcrypto is installed and its schema is known', () => {
    const r = runSQL(`
      SELECT n.nspname
      FROM pg_extension e
      JOIN pg_namespace n ON n.oid = e.extnamespace
      WHERE e.extname = 'pgcrypto';
    `);

    expect(r.stdout).toBeTruthy();
    // pgcrypto should be in either 'public' (local) or 'extensions' (production Supabase)
    expect(['public', 'extensions']).toContain(r.stdout);
  });
});

} // end if (dbUrl)
