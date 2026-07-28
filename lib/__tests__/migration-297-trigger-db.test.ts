/**
 * Migration 297 — Real PostgreSQL Trigger Tests
 *
 * Verifies that Migration 297 correctly creates the properties_updated_at
 * trigger on public.properties, and that it correctly calls update_updated_at()
 * to advance the updated_at timestamp on row updates.
 *
 * Works in two modes:
 *   CI:    TEST_DATABASE_URL points to the CI PostgreSQL where ALL migrations
 *          have been applied. The table, function, and trigger already exist.
 *   Local: TEST_DATABASE_URL points to an isolated container. The test creates
 *          the function and table minimally, then applies Migration 297.
 *
 * Requires TEST_DATABASE_URL environment variable (NOT staging or production).
 *
 * Local:
 *   docker run --rm -d --name m297-test -p 54323:5432 -e POSTGRES_PASSWORD=test postgres:16
 *   TEST_DATABASE_URL=postgresql://postgres:test@localhost:54323/postgres npx vitest run lib/__tests__/migration-297-trigger-db.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const MIGRATION_PATH = path.resolve('supabase/migrations/297_complete_migration_115_trigger.sql');
const dbUrl = process.env.TEST_DATABASE_URL;

if (!dbUrl) {
  describe.skip('Migration 297: Real PostgreSQL trigger tests (TEST_DATABASE_URL not set)', () => {
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

describe('Migration 297: Real PostgreSQL trigger tests', () => {
  let isFullSchema = false;
  let beforeFuncHash = '';
  let beforeRowCount = '';
  let beforeTriggerNames: string[] = [];
  let triggerAlreadyExisted = false;
  let testBizId = '';
  const TEST_BIZ_ID = 'm297bbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const TEST_USER_ID = 'm297aaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

  beforeAll(() => {
    // Detect CI (full schema) vs local (empty DB)
    const check = runSQL(
      `SELECT 1 FROM pg_class c JOIN pg_namespace n ON c.relnamespace = n.oid
       WHERE n.nspname = 'public' AND c.relname = 'properties' AND c.relkind = 'r';`
    );
    isFullSchema = check.stdout.includes('1');

    if (!isFullSchema) {
      // Local mode: create function and table
      runSQL(`
        CREATE OR REPLACE FUNCTION public.update_updated_at()
        RETURNS TRIGGER AS $$
        BEGIN
          NEW.updated_at = NOW();
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
      `);

      runSQL(`
        CREATE TABLE IF NOT EXISTS public.properties (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id UUID,
          name TEXT NOT NULL,
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );
      `);
    }

    if (isFullSchema) {
      // CI mode: create a test business for FK constraints
      runSQL(`
        ALTER TABLE auth.users DISABLE TRIGGER ALL;
        INSERT INTO auth.users (id, email) VALUES ('${TEST_USER_ID}', 'm297test@test.local') ON CONFLICT DO NOTHING;
        ALTER TABLE auth.users ENABLE TRIGGER ALL;
        INSERT INTO profiles (id, first_name, last_name, email) VALUES ('${TEST_USER_ID}', 'M297', 'Test', 'm297test@test.local') ON CONFLICT DO NOTHING;
        INSERT INTO businesses (id, name, slug, owner_id, address, city, neighborhood, phone, status, country_code)
        VALUES ('${TEST_BIZ_ID}', 'M297 Test Biz', 'm297-test-biz', '${TEST_USER_ID}', '1 Test', 'Test', 'Test', '+0', 'active', 'NG')
        ON CONFLICT (slug) DO NOTHING;
      `);
      testBizId = TEST_BIZ_ID;
    }

    // Check if trigger already exists (CI mode where Migration 297 was applied in "Apply all migrations")
    const triggerCheck = runSQL(
      `SELECT 1 FROM pg_trigger t
       JOIN pg_class c ON t.tgrelid = c.oid
       JOIN pg_namespace n ON c.relnamespace = n.oid
       WHERE n.nspname = 'public' AND c.relname = 'properties' AND t.tgname = 'properties_updated_at';`
    );
    triggerAlreadyExisted = triggerCheck.stdout.includes('1');

    // Capture before-state
    const funcHashResult = runSQL(
      `SELECT md5(pg_get_functiondef(p.oid)) FROM pg_proc p
       JOIN pg_namespace n ON p.pronamespace = n.oid
       WHERE n.nspname = 'public' AND p.proname = 'update_updated_at';`
    );
    beforeFuncHash = funcHashResult.stdout;

    const rowCountResult = runSQL(
      `SELECT COUNT(*) FROM public.properties;`
    );
    beforeRowCount = rowCountResult.stdout;

    const triggerListResult = runSQL(
      `SELECT tgname FROM pg_trigger t
       JOIN pg_class c ON t.tgrelid = c.oid
       JOIN pg_namespace n ON c.relnamespace = n.oid
       WHERE n.nspname = 'public' AND c.relname = 'properties'
       AND NOT t.tgisinternal
       ORDER BY tgname;`
    );
    beforeTriggerNames = triggerListResult.stdout ? triggerListResult.stdout.split('\n') : [];
  }, 30000);

  afterAll(() => {
    // Clean up test data
    runSQL(`DELETE FROM public.properties WHERE name LIKE '__m297_%';`);

    if (isFullSchema) {
      // Clean up test business
      runSQL(`DELETE FROM businesses WHERE slug = 'm297-test-biz';`);
      runSQL(`DELETE FROM profiles WHERE id = '${TEST_USER_ID}';`);
      runSQL(`
        ALTER TABLE auth.users DISABLE TRIGGER ALL;
        DELETE FROM auth.users WHERE id = '${TEST_USER_ID}';
        ALTER TABLE auth.users ENABLE TRIGGER ALL;
      `);
    } else {
      // Local mode: drop table and function
      runSQL(`DROP TABLE IF EXISTS public.properties;`);
      runSQL(`DROP FUNCTION IF EXISTS public.update_updated_at();`);
    }
  }, 10000);

  // ── Prerequisites ──

  it('properties table exists', () => {
    const result = runSQL(
      `SELECT 1 FROM pg_class c JOIN pg_namespace n ON c.relnamespace = n.oid
       WHERE n.nspname = 'public' AND c.relname = 'properties' AND c.relkind = 'r';`
    );
    expect(result.stdout).toBe('1');
  });

  it('update_updated_at function exists', () => {
    const result = runSQL(
      `SELECT 1 FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
       WHERE n.nspname = 'public' AND p.proname = 'update_updated_at';`
    );
    expect(result.stdout).toBe('1');
  });

  it('before-state: function hash captured', () => {
    expect(beforeFuncHash).toBeTruthy();
  });

  // ── Apply Migration 297 ──

  it('Migration 297 applies without error', () => {
    const migrationSql = fs.readFileSync(MIGRATION_PATH, 'utf-8');
    const result = runSQL(migrationSql);
    expect(result.exitCode).toBe(0);
  });

  // ── After-state: trigger existence and properties ──

  it('properties_updated_at trigger exists exactly once', () => {
    const result = runSQL(
      `SELECT COUNT(*) FROM pg_trigger t
       JOIN pg_class c ON t.tgrelid = c.oid
       JOIN pg_namespace n ON c.relnamespace = n.oid
       WHERE n.nspname = 'public' AND c.relname = 'properties' AND t.tgname = 'properties_updated_at';`
    );
    expect(result.stdout).toBe('1');
  });

  it('trigger is enabled (tgenabled = O)', () => {
    const result = runSQL(
      `SELECT tgenabled FROM pg_trigger t
       JOIN pg_class c ON t.tgrelid = c.oid
       JOIN pg_namespace n ON c.relnamespace = n.oid
       WHERE n.nspname = 'public' AND c.relname = 'properties' AND t.tgname = 'properties_updated_at';`
    );
    expect(result.stdout).toBe('O');
  });

  it('trigger timing is BEFORE', () => {
    const result = runSQL(
      `SELECT (tgtype & 2) > 0 FROM pg_trigger t
       JOIN pg_class c ON t.tgrelid = c.oid
       JOIN pg_namespace n ON c.relnamespace = n.oid
       WHERE n.nspname = 'public' AND c.relname = 'properties' AND t.tgname = 'properties_updated_at';`
    );
    expect(result.stdout).toBe('t');
  });

  it('trigger event is UPDATE', () => {
    const result = runSQL(
      `SELECT (tgtype & 16) > 0 FROM pg_trigger t
       JOIN pg_class c ON t.tgrelid = c.oid
       JOIN pg_namespace n ON c.relnamespace = n.oid
       WHERE n.nspname = 'public' AND c.relname = 'properties' AND t.tgname = 'properties_updated_at';`
    );
    expect(result.stdout).toBe('t');
  });

  it('trigger is row-level', () => {
    const result = runSQL(
      `SELECT (tgtype & 1) > 0 FROM pg_trigger t
       JOIN pg_class c ON t.tgrelid = c.oid
       JOIN pg_namespace n ON c.relnamespace = n.oid
       WHERE n.nspname = 'public' AND c.relname = 'properties' AND t.tgname = 'properties_updated_at';`
    );
    expect(result.stdout).toBe('t');
  });

  it('trigger target table is public.properties', () => {
    const result = runSQL(
      `SELECT c.relname FROM pg_trigger t
       JOIN pg_class c ON t.tgrelid = c.oid
       JOIN pg_namespace n ON c.relnamespace = n.oid
       WHERE t.tgname = 'properties_updated_at' AND n.nspname = 'public';`
    );
    expect(result.stdout).toBe('properties');
  });

  it('trigger function is update_updated_at', () => {
    const result = runSQL(
      `SELECT p.proname FROM pg_trigger t
       JOIN pg_proc p ON t.tgfoid = p.oid
       JOIN pg_class c ON t.tgrelid = c.oid
       JOIN pg_namespace n ON c.relnamespace = n.oid
       WHERE n.nspname = 'public' AND c.relname = 'properties' AND t.tgname = 'properties_updated_at';`
    );
    expect(result.stdout).toBe('update_updated_at');
  });

  // ── Behaviour test ──

  it('trigger advances updated_at on UPDATE', () => {
    // Insert a test row with required columns
    const insertSql = isFullSchema
      ? `INSERT INTO public.properties (business_id, name, property_type, updated_at)
         VALUES ('${testBizId}', '__m297_test_row__', 'apartment', '2020-01-01T00:00:00Z')
         RETURNING id;`
      : `INSERT INTO public.properties (name, updated_at)
         VALUES ('__m297_test_row__', '2020-01-01T00:00:00Z')
         RETURNING id;`;

    const insertResult = runSQL(insertSql);
    expect(insertResult.exitCode).toBe(0);
    const testId = insertResult.stdout;
    expect(testId).toBeTruthy();

    // Record the initial updated_at
    const beforeUpdate = runSQL(
      `SELECT updated_at FROM public.properties WHERE id = '${testId}';`
    );
    expect(beforeUpdate.stdout).toContain('2020');

    // Update a field
    const updateResult = runSQL(
      `UPDATE public.properties SET name = '__m297_test_row_updated__' WHERE id = '${testId}';`
    );
    expect(updateResult.exitCode).toBe(0);

    // Verify updated_at changed
    const afterUpdate = runSQL(
      `SELECT updated_at > '2020-01-02T00:00:00Z'::timestamptz FROM public.properties WHERE id = '${testId}';`
    );
    expect(afterUpdate.stdout).toBe('t');

    // Clean up
    runSQL(`DELETE FROM public.properties WHERE id = '${testId}';`);
  });

  // ── Unchanged state ──

  it('update_updated_at function hash unchanged', () => {
    const result = runSQL(
      `SELECT md5(pg_get_functiondef(p.oid)) FROM pg_proc p
       JOIN pg_namespace n ON p.pronamespace = n.oid
       WHERE n.nspname = 'public' AND p.proname = 'update_updated_at';`
    );
    expect(result.stdout).toBe(beforeFuncHash);
  });

  it('no unrelated trigger created on properties', () => {
    const result = runSQL(
      `SELECT tgname FROM pg_trigger t
       JOIN pg_class c ON t.tgrelid = c.oid
       JOIN pg_namespace n ON c.relnamespace = n.oid
       WHERE n.nspname = 'public' AND c.relname = 'properties'
       AND NOT t.tgisinternal
       AND t.tgname != 'properties_updated_at'
       ORDER BY tgname;`
    );
    const afterTriggerNames = result.stdout ? result.stdout.split('\n') : [];
    // Filter out properties_updated_at from before list for comparison
    const beforeOther = beforeTriggerNames.filter(n => n !== 'properties_updated_at');
    expect(afterTriggerNames).toEqual(beforeOther);
  });

  it('no pre-existing row changed (count matches before)', () => {
    const result = runSQL(`SELECT COUNT(*) FROM public.properties;`);
    expect(result.stdout).toBe(beforeRowCount);
  });

  // ── Idempotency: second application ──

  it('Migration 297 applies a second time without error', () => {
    const migrationSql = fs.readFileSync(MIGRATION_PATH, 'utf-8');
    const result = runSQL(migrationSql);
    expect(result.exitCode).toBe(0);
  });

  it('still exactly one properties_updated_at trigger after second application', () => {
    const result = runSQL(
      `SELECT COUNT(*) FROM pg_trigger t
       JOIN pg_class c ON t.tgrelid = c.oid
       JOIN pg_namespace n ON c.relnamespace = n.oid
       WHERE n.nspname = 'public' AND c.relname = 'properties' AND t.tgname = 'properties_updated_at';`
    );
    expect(result.stdout).toBe('1');
  });

  it('trigger behaviour still works after second application', () => {
    const insertSql = isFullSchema
      ? `INSERT INTO public.properties (business_id, name, property_type, updated_at)
         VALUES ('${testBizId}', '__m297_test_row__', 'apartment', '2020-01-01T00:00:00Z')
         RETURNING id;`
      : `INSERT INTO public.properties (name, updated_at)
         VALUES ('__m297_test_row__', '2020-01-01T00:00:00Z')
         RETURNING id;`;

    const insertResult = runSQL(insertSql);
    expect(insertResult.exitCode).toBe(0);
    const testId = insertResult.stdout;

    // Update
    runSQL(`UPDATE public.properties SET name = '__m297_test_idempotent__' WHERE id = '${testId}';`);

    // Verify updated_at advanced
    const afterUpdate = runSQL(
      `SELECT updated_at > '2020-01-02T00:00:00Z'::timestamptz FROM public.properties WHERE id = '${testId}';`
    );
    expect(afterUpdate.stdout).toBe('t');

    // Clean up
    runSQL(`DELETE FROM public.properties WHERE id = '${testId}';`);
  });
});

} // end of if (dbUrl)
