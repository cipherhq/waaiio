/**
 * Emergency Suspension RPC ACL Tests (#287 / Migration 366)
 *
 * Real PostgreSQL proofs that toggle_messaging_suspension EXECUTE ACL
 * matches the accepted caller architecture after Migration 366.
 *
 * Hermetic: seeds its own auth.users with canonical raw_app_meta_data,
 * verifies is_admin() reads canonical source before admin-success test.
 * Does not depend on any earlier test suite's stub/state.
 *
 *   TEST_DATABASE_URL=postgresql://localhost:5432/waaiio_test \
 *     npx vitest run lib/__tests__/suspension-rpc-acl-db.test.ts
 */
import { execSync } from 'child_process';
import { describe, it, expect, beforeAll } from 'vitest';

const dbUrl = process.env.TEST_DATABASE_URL || '';
const canRun = dbUrl.length > 0;

function psql(sql: string): string {
  return execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1`, {
    input: sql, encoding: 'utf-8', timeout: 15000,
  }).trim();
}

function psqlMayFail(sql: string): string {
  try {
    return execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1`, {
      input: sql, encoding: 'utf-8', timeout: 15000,
    }).trim();
  } catch (e: unknown) {
    return (e as { stderr?: string }).stderr || String(e);
  }
}

// Dedicated UUIDs for this suite — avoid cross-test contamination
const ADMIN_UUID = '20000000-0000-0000-0000-000000000287';
const NON_ADMIN_UUID = '20000000-0000-0000-0000-000000000288';

// JWT claims carry identity/session context only. Authority comes from canonical app_metadata.
const ADMIN_JWT = `{"sub":"${ADMIN_UUID}","role":"authenticated"}`;
const NON_ADMIN_JWT = `{"sub":"${NON_ADMIN_UUID}","role":"authenticated"}`;

describe.skipIf(!canRun)('Suspension RPC ACL Tests (#287 / Migration 366)', () => {
  let BIZ_ID: string;

  beforeAll(() => {
    // 0. Restore canonical is_admin() if contaminated by earlier test suites.
    // The 363 test suite replaces is_admin() with a stub that reads JWT top-level role.
    // We must restore the canonical definition that reads raw_app_meta_data.
    // This matches the production definition from Migration 353.
    psql(`
      CREATE OR REPLACE FUNCTION public.is_admin()
      RETURNS boolean
      LANGUAGE plpgsql
      STABLE
      SECURITY DEFINER
      SET search_path = ''
      AS $fn$
      DECLARE
        v_role text;
      BEGIN
        SELECT raw_app_meta_data ->> 'role'
        INTO v_role
        FROM auth.users
        WHERE id = auth.uid();
        RETURN COALESCE(v_role = 'admin', false);
      END;
      $fn$;
    `);

    // 1. Seed dedicated admin user with canonical raw_app_meta_data.role = 'admin'
    const adminResult = psqlMayFail(`
      INSERT INTO auth.users (id, email, raw_app_meta_data)
      VALUES ('${ADMIN_UUID}', 'acl-admin-287@test.com', '{"role":"admin"}'::jsonb)
      ON CONFLICT (id) DO UPDATE SET raw_app_meta_data = '{"role":"admin"}'::jsonb;
    `);
    if (adminResult.includes('ERROR')) throw new Error(`Failed to seed admin user: ${adminResult}`);

    const adminProfileResult = psqlMayFail(`
      INSERT INTO profiles (id, email) VALUES ('${ADMIN_UUID}', 'acl-admin-287@test.com')
      ON CONFLICT (id) DO NOTHING;
    `);
    if (adminProfileResult.includes('ERROR')) throw new Error(`Failed to seed admin profile: ${adminProfileResult}`);

    // 2. Seed non-admin user with NO platform role in app_metadata
    const nonAdminResult = psqlMayFail(`
      INSERT INTO auth.users (id, email, raw_app_meta_data)
      VALUES ('${NON_ADMIN_UUID}', 'acl-nonadmin-287@test.com', '{}'::jsonb)
      ON CONFLICT (id) DO UPDATE SET raw_app_meta_data = '{}'::jsonb;
    `);
    if (nonAdminResult.includes('ERROR')) throw new Error(`Failed to seed non-admin user: ${nonAdminResult}`);

    const nonAdminProfileResult = psqlMayFail(`
      INSERT INTO profiles (id, email) VALUES ('${NON_ADMIN_UUID}', 'acl-nonadmin-287@test.com')
      ON CONFLICT (id) DO NOTHING;
    `);
    if (nonAdminProfileResult.includes('ERROR')) throw new Error(`Failed to seed non-admin profile: ${nonAdminProfileResult}`);

    // 3. Find a business for toggle tests
    BIZ_ID = psql("SELECT id::text FROM businesses LIMIT 1;");
    if (!BIZ_ID) throw new Error('No business found for suspension toggle tests');
  });

  // ── 0. Precondition: is_admin() is canonical (reads raw_app_meta_data) ──

  it('0. is_admin() reads canonical raw_app_meta_data, not JWT top-level role', () => {
    // Verify is_admin() source reads raw_app_meta_data
    const src = psql("SELECT prosrc FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'is_admin';");
    expect(src).toContain('raw_app_meta_data');

    // Positive: admin user with raw_app_meta_data.role='admin' → is_admin() = true
    const adminCheck = psql(`
      SELECT set_config('request.jwt.claims', '${ADMIN_JWT}', false);
      SET ROLE authenticated;
      SELECT is_admin();
      RESET ROLE;
    `);
    // Last line is the result
    const lines = adminCheck.split('\n');
    expect(lines[lines.length - 1]).toBe('t');

    // Negative: non-admin user with empty raw_app_meta_data → is_admin() = false
    const nonAdminCheck = psql(`
      SELECT set_config('request.jwt.claims', '${NON_ADMIN_JWT}', false);
      SET ROLE authenticated;
      SELECT is_admin();
      RESET ROLE;
    `);
    const lines2 = nonAdminCheck.split('\n');
    expect(lines2[lines2.length - 1]).toBe('f');
  });

  // ── 1-3. has_function_privilege assertions ──

  it('1. anon has no EXECUTE on toggle_messaging_suspension', () => {
    expect(psql("SELECT has_function_privilege('anon', 'toggle_messaging_suspension(uuid,boolean,text)', 'EXECUTE');")).toBe('f');
  });

  it('2. authenticated has EXECUTE on toggle_messaging_suspension', () => {
    expect(psql("SELECT has_function_privilege('authenticated', 'toggle_messaging_suspension(uuid,boolean,text)', 'EXECUTE');")).toBe('t');
  });

  it('3. service_role has no EXECUTE on toggle_messaging_suspension', () => {
    expect(psql("SELECT has_function_privilege('service_role', 'toggle_messaging_suspension(uuid,boolean,text)', 'EXECUTE');")).toBe('f');
  });

  // ── 4. PUBLIC has no EXECUTE ACE ──

  it('4. PUBLIC has no EXECUTE ACE (direct ACL inspection)', () => {
    const acl = psql("SELECT proacl::text FROM pg_proc WHERE proname = 'toggle_messaging_suspension';");
    // PUBLIC grant would appear as "=X/" (empty grantee before =). Must be absent.
    expect(acl).not.toMatch(/(?<![a-z_])=X\//);
    expect(acl).toContain('authenticated=X/');
  });

  // ── 5. Admin suspend/resume with canonical authority ──

  it('5. Authenticated admin (canonical app_metadata) can suspend and resume with durable audit', () => {
    // Suspend
    const suspendResult = psqlMayFail(`
      SELECT set_config('request.jwt.claims', '${ADMIN_JWT}', false);
      SET ROLE authenticated;
      SELECT toggle_messaging_suspension('${BIZ_ID}'::uuid, true, 'ACL test suspend 287');
      RESET ROLE;
    `);
    expect(suspendResult).not.toContain('ERROR');

    // Verify suspended
    const afterSuspend = psql(`SELECT messaging_suspended FROM businesses WHERE id = '${BIZ_ID}';`);
    expect(afterSuspend).toBe('t');

    // Verify audit record
    const auditExists = psql(`
      SELECT count(*)::int FROM messaging_suspension_audit
      WHERE business_id = '${BIZ_ID}' AND new_state = true AND reason = 'ACL test suspend 287';
    `);
    expect(parseInt(auditExists, 10)).toBeGreaterThan(0);

    // Resume
    const resumeResult = psqlMayFail(`
      SELECT set_config('request.jwt.claims', '${ADMIN_JWT}', false);
      SET ROLE authenticated;
      SELECT toggle_messaging_suspension('${BIZ_ID}'::uuid, false, 'ACL test resume 287');
      RESET ROLE;
    `);
    expect(resumeResult).not.toContain('ERROR');

    const afterResume = psql(`SELECT messaging_suspended FROM businesses WHERE id = '${BIZ_ID}';`);
    expect(afterResume).toBe('f');
  });

  // ── 6. Non-admin denied by internal is_admin() ──

  it('6. Ordinary authenticated non-admin is denied by internal is_admin()', () => {
    const err = psqlMayFail(`
      SELECT set_config('request.jwt.claims', '${NON_ADMIN_JWT}', false);
      SET ROLE authenticated;
      SELECT toggle_messaging_suspension('${BIZ_ID}'::uuid, true);
      RESET ROLE;
    `);
    expect(err).toContain('requires admin role');
  });

  // ── 7. Anon denied at EXECUTE privilege boundary ──

  it('7. Anon invocation denied at EXECUTE privilege boundary', () => {
    const err = psqlMayFail(`
      SET ROLE anon;
      SELECT toggle_messaging_suspension('${BIZ_ID}'::uuid, true);
      RESET ROLE;
    `);
    expect(err.toLowerCase()).toContain('permission denied');
  });

  // ── 8. Service_role denied at EXECUTE privilege boundary ──

  it('8. Service_role invocation denied at EXECUTE privilege boundary', () => {
    const err = psqlMayFail(`
      SET ROLE service_role;
      SELECT toggle_messaging_suspension('${BIZ_ID}'::uuid, true);
      RESET ROLE;
    `);
    expect(err.toLowerCase()).toContain('permission denied');
  });

  // ── 9. RPC definition unchanged from 363 ──

  it('9. RPC body still contains auth.uid() and is_admin() checks, semantically unchanged', () => {
    const src = psql("SELECT prosrc FROM pg_proc WHERE proname = 'toggle_messaging_suspension';");
    expect(src).toContain('auth.uid()');
    expect(src).toContain('is_admin()');
    expect(src).toContain('requires authenticated caller');
    expect(src).toContain('requires admin role');
    expect(src).toContain('messaging_suspended');

    const secdef = psql("SELECT prosecdef FROM pg_proc WHERE proname = 'toggle_messaging_suspension';");
    expect(secdef).toBe('t');
  });
});
