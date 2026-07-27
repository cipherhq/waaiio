/**
 * Migration 295 — Real PostgreSQL RPC Permission Tests
 *
 * Verifies that Migration 295 correctly restricts EXECUTE privileges on
 * process_recurring_charge(text,text,text,text,text,bigint,text,text,text,text)
 * to service_role only, without modifying the function body, owner, or
 * security settings.
 *
 * Works in two modes:
 *   CI:    TEST_DATABASE_URL points to the CI PostgreSQL where ALL migrations
 *          have been applied. The function exists with full schema.
 *   Local: TEST_DATABASE_URL points to an isolated container. The test creates
 *          the function minimally and applies Migration 295 itself.
 *
 * Requires TEST_DATABASE_URL environment variable (NOT staging or production).
 *
 * Local:
 *   docker run --rm -d --name m295-test -p 54321:5432 -e POSTGRES_PASSWORD=test postgres:16
 *   TEST_DATABASE_URL=postgresql://postgres:test@localhost:54321/postgres npx vitest run lib/__tests__/migration-295-rpc-permissions-db.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const MIGRATION_PATH = path.resolve('supabase/migrations/295_restrict_recurring_charge_rpc_execute.sql');
const FUNC_SIGNATURE = 'public.process_recurring_charge(text, text, text, text, text, bigint, text, text, text, text)';
const dbUrl = process.env.TEST_DATABASE_URL;

if (!dbUrl) {
  describe.skip('Migration 295: Real PostgreSQL RPC permission tests (TEST_DATABASE_URL not set)', () => {
    it('skipped — set TEST_DATABASE_URL to enable', () => {});
  });
} else {

function runSQL(sql: string): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execSync(
      `psql "${dbUrl}" -t -A -v ON_ERROR_STOP=1`,
      { input: sql, encoding: 'utf-8', timeout: 15000 },
    );
    return { stdout: stdout.trim(), stderr: '', exitCode: 0 };
  } catch (err: any) {
    return {
      stdout: err.stdout?.trim() || '',
      stderr: err.stderr?.trim() || '',
      exitCode: err.status || 1,
    };
  }
}

describe('Migration 295: Real PostgreSQL RPC permission tests', () => {
  let isFullSchema = false;
  let beforeFuncDef = '';
  let beforeOwner = '';
  let beforeSecDef = '';
  let beforeSearchPath = '';

  beforeAll(() => {
    // Detect CI (full schema) vs local (empty DB)
    const check = runSQL(
      `SELECT 1 FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
       WHERE n.nspname = 'public' AND p.proname = 'process_recurring_charge';`
    );
    isFullSchema = check.stdout.includes('1');

    if (!isFullSchema) {
      // Local mode: create roles and a minimal stub function with matching signature
      runSQL(`
        DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
        DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
        DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
        GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
      `);

      // Create a minimal stub function with the exact production signature
      runSQL(`
        CREATE OR REPLACE FUNCTION public.process_recurring_charge(
          p_event_id        TEXT,
          p_event_type      TEXT,
          p_gateway_ref     TEXT,
          p_auth_code       TEXT,
          p_cust_code       TEXT,
          p_amount_kobo     BIGINT,
          p_currency        TEXT DEFAULT 'NGN',
          p_channel         TEXT DEFAULT 'card',
          p_card_last_four  TEXT DEFAULT NULL,
          p_card_brand      TEXT DEFAULT NULL
        )
        RETURNS JSONB
        LANGUAGE plpgsql
        SECURITY DEFINER
        SET search_path = public
        AS $fn$
        BEGIN
          RETURN '{"stub": true}'::JSONB;
        END;
        $fn$;

        ALTER FUNCTION public.process_recurring_charge(text, text, text, text, text, bigint, text, text, text, text) OWNER TO postgres;
      `);
    }

    // Step B: Capture before-state
    const funcDefResult = runSQL(
      `SELECT pg_get_functiondef(p.oid) FROM pg_proc p
       JOIN pg_namespace n ON p.pronamespace = n.oid
       WHERE n.nspname = 'public' AND p.proname = 'process_recurring_charge'
       AND pg_get_function_identity_arguments(p.oid) = 'p_event_id text, p_event_type text, p_gateway_ref text, p_auth_code text, p_cust_code text, p_amount_kobo bigint, p_currency text, p_channel text, p_card_last_four text, p_card_brand text';`
    );
    beforeFuncDef = funcDefResult.stdout;

    const ownerResult = runSQL(
      `SELECT r.rolname FROM pg_proc p
       JOIN pg_namespace n ON p.pronamespace = n.oid
       JOIN pg_roles r ON p.proowner = r.oid
       WHERE n.nspname = 'public' AND p.proname = 'process_recurring_charge'
       AND pg_get_function_identity_arguments(p.oid) = 'p_event_id text, p_event_type text, p_gateway_ref text, p_auth_code text, p_cust_code text, p_amount_kobo bigint, p_currency text, p_channel text, p_card_last_four text, p_card_brand text';`
    );
    beforeOwner = ownerResult.stdout;

    const secDefResult = runSQL(
      `SELECT prosecdef FROM pg_proc p
       JOIN pg_namespace n ON p.pronamespace = n.oid
       WHERE n.nspname = 'public' AND p.proname = 'process_recurring_charge'
       AND pg_get_function_identity_arguments(p.oid) = 'p_event_id text, p_event_type text, p_gateway_ref text, p_auth_code text, p_cust_code text, p_amount_kobo bigint, p_currency text, p_channel text, p_card_last_four text, p_card_brand text';`
    );
    beforeSecDef = secDefResult.stdout;

    const searchPathResult = runSQL(
      `SELECT array_to_string(proconfig, ',') FROM pg_proc p
       JOIN pg_namespace n ON p.pronamespace = n.oid
       WHERE n.nspname = 'public' AND p.proname = 'process_recurring_charge'
       AND pg_get_function_identity_arguments(p.oid) = 'p_event_id text, p_event_type text, p_gateway_ref text, p_auth_code text, p_cust_code text, p_amount_kobo bigint, p_currency text, p_channel text, p_card_last_four text, p_card_brand text';`
    );
    beforeSearchPath = searchPathResult.stdout;

    // Step C: Deliberately grant direct EXECUTE to anon and authenticated
    // (simulates the pre-existing production state that Migration 295 fixes)
    runSQL(`
      GRANT EXECUTE ON FUNCTION ${FUNC_SIGNATURE} TO anon;
      GRANT EXECUTE ON FUNCTION ${FUNC_SIGNATURE} TO authenticated;
      GRANT EXECUTE ON FUNCTION ${FUNC_SIGNATURE} TO service_role;
    `);

  }, 30000);

  afterAll(() => {
    if (!isFullSchema) {
      // Local mode only: clean up stub function and roles
      runSQL(`DROP FUNCTION IF EXISTS ${FUNC_SIGNATURE};`);
    } else {
      // CI mode: restore original privilege state after Migration 295 has been
      // applied by the "Apply all migrations" step. The CI environment already
      // has the correct privileges from Migration 295, so we just need to undo
      // the deliberate grants we added in beforeAll.
      // Migration 295 already ran during "Apply all migrations", so privileges
      // are already correct. We just need to clean up our test grants.
      runSQL(`
        REVOKE EXECUTE ON FUNCTION ${FUNC_SIGNATURE} FROM anon;
        REVOKE EXECUTE ON FUNCTION ${FUNC_SIGNATURE} FROM authenticated;
      `);
    }
  }, 10000);

  // ── Step A: Function existence ──

  it('function exists with the exact overloaded signature', () => {
    const result = runSQL(
      `SELECT proname FROM pg_proc p
       JOIN pg_namespace n ON p.pronamespace = n.oid
       WHERE n.nspname = 'public' AND p.proname = 'process_recurring_charge'
       AND pg_get_function_identity_arguments(p.oid) = 'p_event_id text, p_event_type text, p_gateway_ref text, p_auth_code text, p_cust_code text, p_amount_kobo bigint, p_currency text, p_channel text, p_card_last_four text, p_card_brand text';`
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('process_recurring_charge');
  });

  // ── Step B: Before-state captured ──

  it('before-state captured: function definition is non-empty', () => {
    expect(beforeFuncDef).toBeTruthy();
    expect(beforeFuncDef).toContain('process_recurring_charge');
  });

  it('before-state captured: owner is non-empty', () => {
    expect(beforeOwner).toBeTruthy();
  });

  it('before-state captured: SECURITY DEFINER is true', () => {
    expect(beforeSecDef).toBe('t');
  });

  it('before-state captured: search_path includes public', () => {
    expect(beforeSearchPath).toContain('search_path=public');
  });

  // ── Step D: Precondition ──

  it('precondition: anon has EXECUTE before Migration 295', () => {
    const result = runSQL(
      `SELECT has_function_privilege('anon', '${FUNC_SIGNATURE}', 'EXECUTE');`
    );
    expect(result.stdout).toBe('t');
  });

  it('precondition: authenticated has EXECUTE before Migration 295', () => {
    const result = runSQL(
      `SELECT has_function_privilege('authenticated', '${FUNC_SIGNATURE}', 'EXECUTE');`
    );
    expect(result.stdout).toBe('t');
  });

  it('precondition: service_role has EXECUTE before Migration 295', () => {
    const result = runSQL(
      `SELECT has_function_privilege('service_role', '${FUNC_SIGNATURE}', 'EXECUTE');`
    );
    expect(result.stdout).toBe('t');
  });

  // ── Step E: Apply Migration 295 ──

  it('Migration 295 applies without error', () => {
    const migrationSql = fs.readFileSync(MIGRATION_PATH, 'utf-8');
    const result = runSQL(migrationSql);
    expect(result.exitCode).toBe(0);
  });

  // ── Step F: Post-migration privilege verification ──

  it('post-migration: anon has no EXECUTE privilege', () => {
    const result = runSQL(
      `SELECT has_function_privilege('anon', '${FUNC_SIGNATURE}', 'EXECUTE');`
    );
    expect(result.stdout).toBe('f');
  });

  it('post-migration: authenticated has no EXECUTE privilege', () => {
    const result = runSQL(
      `SELECT has_function_privilege('authenticated', '${FUNC_SIGNATURE}', 'EXECUTE');`
    );
    expect(result.stdout).toBe('f');
  });

  it('post-migration: service_role retains EXECUTE privilege', () => {
    const result = runSQL(
      `SELECT has_function_privilege('service_role', '${FUNC_SIGNATURE}', 'EXECUTE');`
    );
    expect(result.stdout).toBe('t');
  });

  it('post-migration: PUBLIC has no function EXECUTE ACL', () => {
    // Check aclitem array for PUBLIC (empty grantee = PUBLIC)
    const result = runSQL(
      `SELECT COALESCE(
        (SELECT bool_or(aclcontains(proacl, makeaclitem(0, p.proowner, 'EXECUTE', false)))
         FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
         WHERE n.nspname = 'public' AND p.proname = 'process_recurring_charge'
         AND pg_get_function_identity_arguments(p.oid) = 'p_event_id text, p_event_type text, p_gateway_ref text, p_auth_code text, p_cust_code text, p_amount_kobo bigint, p_currency text, p_channel text, p_card_last_four text, p_card_brand text'),
        false
      );`
    );
    expect(result.stdout).toBe('f');
  });

  // ── Step G: Function properties unchanged ──

  it('function definition unchanged after Migration 295', () => {
    const result = runSQL(
      `SELECT pg_get_functiondef(p.oid) FROM pg_proc p
       JOIN pg_namespace n ON p.pronamespace = n.oid
       WHERE n.nspname = 'public' AND p.proname = 'process_recurring_charge'
       AND pg_get_function_identity_arguments(p.oid) = 'p_event_id text, p_event_type text, p_gateway_ref text, p_auth_code text, p_cust_code text, p_amount_kobo bigint, p_currency text, p_channel text, p_card_last_four text, p_card_brand text';`
    );
    expect(result.stdout).toBe(beforeFuncDef);
  });

  it('owner unchanged after Migration 295', () => {
    const result = runSQL(
      `SELECT r.rolname FROM pg_proc p
       JOIN pg_namespace n ON p.pronamespace = n.oid
       JOIN pg_roles r ON p.proowner = r.oid
       WHERE n.nspname = 'public' AND p.proname = 'process_recurring_charge'
       AND pg_get_function_identity_arguments(p.oid) = 'p_event_id text, p_event_type text, p_gateway_ref text, p_auth_code text, p_cust_code text, p_amount_kobo bigint, p_currency text, p_channel text, p_card_last_four text, p_card_brand text';`
    );
    expect(result.stdout).toBe(beforeOwner);
  });

  it('SECURITY DEFINER remains true', () => {
    const result = runSQL(
      `SELECT prosecdef FROM pg_proc p
       JOIN pg_namespace n ON p.pronamespace = n.oid
       WHERE n.nspname = 'public' AND p.proname = 'process_recurring_charge'
       AND pg_get_function_identity_arguments(p.oid) = 'p_event_id text, p_event_type text, p_gateway_ref text, p_auth_code text, p_cust_code text, p_amount_kobo bigint, p_currency text, p_channel text, p_card_last_four text, p_card_brand text';`
    );
    expect(result.stdout).toBe('t');
  });

  it('search_path remains public', () => {
    const result = runSQL(
      `SELECT array_to_string(proconfig, ',') FROM pg_proc p
       JOIN pg_namespace n ON p.pronamespace = n.oid
       WHERE n.nspname = 'public' AND p.proname = 'process_recurring_charge'
       AND pg_get_function_identity_arguments(p.oid) = 'p_event_id text, p_event_type text, p_gateway_ref text, p_auth_code text, p_cust_code text, p_amount_kobo bigint, p_currency text, p_channel text, p_card_last_four text, p_card_brand text';`
    );
    expect(result.stdout).toContain('search_path=public');
  });

  // ── Step H: Idempotent second run ──

  it('Migration 295 applies a second time without error', () => {
    const migrationSql = fs.readFileSync(MIGRATION_PATH, 'utf-8');
    const result = runSQL(migrationSql);
    expect(result.exitCode).toBe(0);
  });

  it('privileges remain correct after second application', () => {
    const anon = runSQL(`SELECT has_function_privilege('anon', '${FUNC_SIGNATURE}', 'EXECUTE');`);
    expect(anon.stdout).toBe('f');

    const auth = runSQL(`SELECT has_function_privilege('authenticated', '${FUNC_SIGNATURE}', 'EXECUTE');`);
    expect(auth.stdout).toBe('f');

    const sr = runSQL(`SELECT has_function_privilege('service_role', '${FUNC_SIGNATURE}', 'EXECUTE');`);
    expect(sr.stdout).toBe('t');
  });

  it('function definition unchanged after second application', () => {
    const result = runSQL(
      `SELECT pg_get_functiondef(p.oid) FROM pg_proc p
       JOIN pg_namespace n ON p.pronamespace = n.oid
       WHERE n.nspname = 'public' AND p.proname = 'process_recurring_charge'
       AND pg_get_function_identity_arguments(p.oid) = 'p_event_id text, p_event_type text, p_gateway_ref text, p_auth_code text, p_cust_code text, p_amount_kobo bigint, p_currency text, p_channel text, p_card_last_four text, p_card_brand text';`
    );
    expect(result.stdout).toBe(beforeFuncDef);
  });

  // ── No table/data/policy changes ──

  it('no table, data, RLS policy or function-body change occurs', () => {
    // The migration SQL contains no CREATE TABLE, ALTER TABLE, INSERT, UPDATE,
    // DELETE, CREATE POLICY, ALTER POLICY, DROP POLICY, or CREATE OR REPLACE FUNCTION.
    // This is verified by the static tests. Here we confirm the function body is
    // identical to what it was before the migration.
    const result = runSQL(
      `SELECT pg_get_functiondef(p.oid) FROM pg_proc p
       JOIN pg_namespace n ON p.pronamespace = n.oid
       WHERE n.nspname = 'public' AND p.proname = 'process_recurring_charge'
       AND pg_get_function_identity_arguments(p.oid) = 'p_event_id text, p_event_type text, p_gateway_ref text, p_auth_code text, p_cust_code text, p_amount_kobo bigint, p_currency text, p_channel text, p_card_last_four text, p_card_brand text';`
    );
    expect(result.stdout).toBe(beforeFuncDef);
  });
});

} // end of if (dbUrl)
