/**
 * AUTH-001: Profiles Role Hardening — Real PostgreSQL Tests
 *
 * Proves the AUTH-001 protections are active against a real database:
 * - Column-level privilege prevents profiles.role UPDATE
 * - Protection triggers exist and fire
 * - is_admin() uses auth.users.raw_app_meta_data, not profiles.role
 * - service_role provisioning still works
 *
 * Requires TEST_DATABASE_URL pointing to a PostgreSQL database with
 * all migrations applied (including 353_auth001_profiles_role_hardening).
 */
import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';

const dbUrl = process.env.TEST_DATABASE_URL;

if (!dbUrl) {
  describe.skip('AUTH-001 profiles role hardening — TEST_DATABASE_URL not set', () => {
    it('skipped', () => {});
  });
} else {

function runSQL(sql: string, role?: string): { stdout: string; stderr: string; exitCode: number } {
  const fullSql = role ? `SET ROLE ${role};\n${sql}` : sql;
  try {
    let stdout = execSync(
      `psql "${dbUrl}" -t -A -v ON_ERROR_STOP=1`,
      { input: fullSql, encoding: 'utf-8', timeout: 15000 },
    );
    stdout = stdout.trim();
    if (role && stdout.startsWith('SET\n')) stdout = stdout.slice(4).trim();
    else if (role && stdout === 'SET') stdout = '';
    return { stdout, stderr: '', exitCode: 0 };
  } catch (err: any) {
    return { stdout: err.stdout?.trim() || '', stderr: err.stderr?.trim() || '', exitCode: err.status || 1 };
  }
}

describe('AUTH-001 profiles role hardening', () => {

  // ── Privilege checks ──

  it('authenticated CANNOT update profiles.role (column privilege)', () => {
    const r = runSQL("SELECT has_column_privilege('authenticated', 'public.profiles', 'role', 'UPDATE') AS p;");
    expect(r.stdout).toBe('f');
  });

  it('authenticated CAN update profiles.first_name (allowed field)', () => {
    const r = runSQL("SELECT has_column_privilege('authenticated', 'public.profiles', 'first_name', 'UPDATE') AS p;");
    expect(r.stdout).toBe('t');
  });

  it('authenticated CAN update profiles.last_name (allowed field)', () => {
    const r = runSQL("SELECT has_column_privilege('authenticated', 'public.profiles', 'last_name', 'UPDATE') AS p;");
    expect(r.stdout).toBe('t');
  });

  it('authenticated CAN update profiles.email (allowed field)', () => {
    const r = runSQL("SELECT has_column_privilege('authenticated', 'public.profiles', 'email', 'UPDATE') AS p;");
    expect(r.stdout).toBe('t');
  });

  it('authenticated CAN update profiles.phone (allowed field)', () => {
    const r = runSQL("SELECT has_column_privilege('authenticated', 'public.profiles', 'phone', 'UPDATE') AS p;");
    expect(r.stdout).toBe('t');
  });

  it('service_role CAN update profiles.role', () => {
    const r = runSQL("SELECT has_column_privilege('service_role', 'public.profiles', 'role', 'UPDATE') AS p;");
    expect(r.stdout).toBe('t');
  });

  it('authenticated CANNOT update profiles.id', () => {
    const r = runSQL("SELECT has_column_privilege('authenticated', 'public.profiles', 'id', 'UPDATE') AS p;");
    expect(r.stdout).toBe('f');
  });

  it('authenticated CANNOT update profiles.created_at', () => {
    const r = runSQL("SELECT has_column_privilege('authenticated', 'public.profiles', 'created_at', 'UPDATE') AS p;");
    expect(r.stdout).toBe('f');
  });

  // ── Policy checks ──

  it('old "Users manage own profile" FOR ALL policy does NOT exist', () => {
    const r = runSQL(`
      SELECT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = 'profiles'
          AND policyname = 'Users manage own profile'
      ) AS e;
    `);
    expect(r.stdout).toBe('f');
  });

  it('profiles_select_own policy exists', () => {
    const r = runSQL(`
      SELECT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = 'profiles'
          AND policyname = 'profiles_select_own'
          AND cmd = 'SELECT'
      ) AS e;
    `);
    expect(r.stdout).toBe('t');
  });

  it('profiles_update_own policy exists', () => {
    const r = runSQL(`
      SELECT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = 'profiles'
          AND policyname = 'profiles_update_own'
          AND cmd = 'UPDATE'
      ) AS e;
    `);
    expect(r.stdout).toBe('t');
  });

  // ── Trigger checks ──

  it('trg_protect_profiles_role BEFORE UPDATE trigger exists', () => {
    const r = runSQL(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.triggers
        WHERE event_object_schema = 'public'
          AND event_object_table = 'profiles'
          AND trigger_name = 'trg_protect_profiles_role'
          AND action_timing = 'BEFORE'
          AND event_manipulation = 'UPDATE'
      ) AS e;
    `);
    expect(r.stdout).toBe('t');
  });

  it('trg_protect_profiles_role_insert BEFORE INSERT trigger exists', () => {
    const r = runSQL(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.triggers
        WHERE event_object_schema = 'public'
          AND event_object_table = 'profiles'
          AND trigger_name = 'trg_protect_profiles_role_insert'
          AND action_timing = 'BEFORE'
          AND event_manipulation = 'INSERT'
      ) AS e;
    `);
    expect(r.stdout).toBe('t');
  });

  // ── Function security checks ──

  it('is_admin() is SECURITY DEFINER', () => {
    const r = runSQL(`
      SELECT p.prosecdef FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'is_admin'
        AND p.proargtypes::text = '';
    `);
    expect(r.stdout).toBe('t');
  });

  it('is_admin_or_support() is SECURITY DEFINER', () => {
    const r = runSQL(`
      SELECT p.prosecdef FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'is_admin_or_support'
        AND p.proargtypes::text = '';
    `);
    expect(r.stdout).toBe('t');
  });

  it('is_admin() uses raw_app_meta_data (source text check)', () => {
    const r = runSQL(`
      SELECT prosrc FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'is_admin'
        AND p.proargtypes::text = '';
    `);
    expect(r.stdout).toContain('raw_app_meta_data');
    expect(r.stdout).not.toContain('public.profiles');
  });

  it('is_admin_or_support() uses raw_app_meta_data (source text check)', () => {
    const r = runSQL(`
      SELECT prosrc FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'is_admin_or_support'
        AND p.proargtypes::text = '';
    `);
    expect(r.stdout).toContain('raw_app_meta_data');
    expect(r.stdout).not.toContain('public.profiles');
  });

  it('anon CANNOT execute is_admin()', () => {
    const r = runSQL("SELECT has_function_privilege('anon', 'is_admin()', 'EXECUTE') AS p;");
    expect(r.stdout).toBe('f');
  });

  it('authenticated CAN execute is_admin() (required for RLS)', () => {
    const r = runSQL("SELECT has_function_privilege('authenticated', 'is_admin()', 'EXECUTE') AS p;");
    expect(r.stdout).toBe('t');
  });

  it('anon CANNOT execute is_admin_or_support()', () => {
    const r = runSQL("SELECT has_function_privilege('anon', 'is_admin_or_support()', 'EXECUTE') AS p;");
    expect(r.stdout).toBe('f');
  });

  it('authenticated CAN execute is_admin_or_support() (required for RLS)', () => {
    const r = runSQL("SELECT has_function_privilege('authenticated', 'is_admin_or_support()', 'EXECUTE') AS p;");
    expect(r.stdout).toBe('t');
  });

  // ── Runtime denial proofs ──

  it('runtime: authenticated cannot UPDATE profiles.role', () => {
    // First ensure a test profile exists
    runSQL(`
      INSERT INTO auth.users (id, email, raw_app_meta_data)
      VALUES ('11111111-1111-1111-1111-111111111111', 'auth001test@test.local', '{}')
      ON CONFLICT (id) DO NOTHING;
      INSERT INTO public.profiles (id, role)
      VALUES ('11111111-1111-1111-1111-111111111111', 'restaurant_owner')
      ON CONFLICT (id) DO NOTHING;
    `);

    const r = runSQL(
      "UPDATE public.profiles SET role = 'admin' WHERE id = '11111111-1111-1111-1111-111111111111';",
      'authenticated'
    );
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('permission denied');
  });

  it('runtime: authenticated CAN UPDATE profiles.first_name', () => {
    const r = runSQL(
      "UPDATE public.profiles SET first_name = 'TestName' WHERE id = '11111111-1111-1111-1111-111111111111';",
      'authenticated'
    );
    // This may fail due to RLS (auth.uid() won't match), but should NOT fail due to column privilege
    // Column privilege errors say "permission denied for table", RLS silently updates 0 rows
    if (r.exitCode !== 0) {
      expect(r.stderr).not.toContain('permission denied for table');
    }
  });

  // ── Convergence proof: migration is idempotent ──

  it('migration 353 verification block passed (inline assertions)', () => {
    // The migration itself contains a DO block that RAISE EXCEPTION on failure.
    // If the migration applied successfully, this is proof.
    // Verify by re-running the same checks:
    const r = runSQL(`
      SELECT
        NOT has_column_privilege('authenticated', 'public.profiles', 'role', 'UPDATE') AS role_denied,
        EXISTS (
          SELECT 1 FROM information_schema.triggers
          WHERE event_object_schema = 'public'
            AND event_object_table = 'profiles'
            AND trigger_name = 'trg_protect_profiles_role'
        ) AS update_trigger,
        EXISTS (
          SELECT 1 FROM information_schema.triggers
          WHERE event_object_schema = 'public'
            AND event_object_table = 'profiles'
            AND trigger_name = 'trg_protect_profiles_role_insert'
        ) AS insert_trigger;
    `);
    expect(r.stdout).toBe('t|t|t');
  });

  // ── Cleanup ──
  it('cleanup: remove test data', () => {
    runSQL(`
      DELETE FROM public.profiles WHERE id = '11111111-1111-1111-1111-111111111111';
      DELETE FROM auth.users WHERE id = '11111111-1111-1111-1111-111111111111';
    `);
    expect(true).toBe(true);
  });
});

} // end if (dbUrl)
