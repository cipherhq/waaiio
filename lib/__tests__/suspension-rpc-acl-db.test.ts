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
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

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
const ADMIN_JWT = `{"sub":"${ADMIN_UUID}","role":"authenticated","aal":"aal2"}`;
const NON_ADMIN_JWT = `{"sub":"${NON_ADMIN_UUID}","role":"authenticated","aal":"aal2"}`;

describe.skipIf(!canRun)('Suspension RPC ACL Tests (#287 / Migration 366)', () => {
  let BIZ_ID: string;
  let originalIsAdminDef: string;
  let originalJwtDef: string;
  let mfaHelperPresent = false;

  beforeAll(() => {
    // The full CI suite applies M439 before these tests. M439's is_admin()
    // MUST remain MFA-aware: replacing it with the M353 role-only function
    // would contaminate all subsequent PostgreSQL RLS tests.
    originalIsAdminDef = psql("SELECT pg_get_functiondef('public.is_admin()'::regprocedure);");
    originalJwtDef = psql("SELECT COALESCE((SELECT pg_get_functiondef(to_regprocedure('auth.jwt()'))), '');");
    mfaHelperPresent = psql("SELECT to_regprocedure('public.has_admin_role(text[])') IS NOT NULL;") === 't';

    if (!mfaHelperPresent) {
      // Isolated pre-M439 M366 fixture only. Restore its previous function
      // after the suite; do not change the full-migration security helper.
      psql(`
        CREATE OR REPLACE FUNCTION public.is_admin()
        RETURNS boolean
        LANGUAGE plpgsql
        STABLE
        SECURITY DEFINER
        SET search_path = ''
        AS $fn$
        DECLARE v_role text;
        BEGIN
          SELECT raw_app_meta_data ->> 'role' INTO v_role
          FROM auth.users WHERE id = auth.uid();
          RETURN COALESCE(v_role = 'admin', false);
        END;
        $fn$;
      `);
    }

    // Auth stub MUST reflect the active request, including MFA assurance.
    // Save and restore the existing implementation; this is shared CI DB.
    psql(`
      CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb
      LANGUAGE sql STABLE
      AS $jwt$
        SELECT COALESCE(
          NULLIF(current_setting('request.jwt.claims', true), '')::jsonb,
          '{}'::jsonb
        )
      $jwt$;
    `);

    // M439 revokes browser EXECUTE; never change live ACLs to make tests pass.

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

  afterAll(() => {
    // Restore BOTH functions, including M439's MFA-aware is_admin().
    // This is essential for subsequent M367/M368/M369 authorization tests.
    if (originalJwtDef) psql(originalJwtDef);
    else psql('DROP FUNCTION IF EXISTS auth.jwt();');
    if (originalIsAdminDef) psql(originalIsAdminDef);
  });

  // ── 0. Precondition: is_admin() is canonical (reads raw_app_meta_data) ──

  it('0. is_admin() reads canonical raw_app_meta_data, not JWT top-level role', () => {
    // After M439, is_admin() delegates to has_admin_role(). Its own source
    // need not contain raw_app_meta_data, but the canonical helper MUST.
    const src = psql("SELECT prosrc FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'is_admin';");
    if (mfaHelperPresent) {
      expect(src).toContain('has_admin_role');
      const canonical = psql("SELECT prosrc FROM pg_proc WHERE oid = 'public.has_admin_role(text[])'::regprocedure;");
      expect(canonical).toContain('raw_app_meta_data');
      expect(canonical).toContain('auth.jwt()');
      expect(canonical).toContain('aal2');
    } else {
      expect(src).toContain('raw_app_meta_data');
    }

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

  it('0b. aal1 Admin denied by the canonical MFA gate and suspension RPC', () => {
    if (!mfaHelperPresent) return; // Legacy M366 does not yet define MFA.
    const aal1 = ADMIN_JWT.replace('"aal":"aal2"', '"aal":"aal1"');
    const helper = psql(`
      SELECT set_config('request.jwt.claims', '${aal1}', false);
      SET ROLE authenticated;
      SELECT auth.jwt()->>'aal', public.is_admin();
      RESET ROLE;
    `);
    expect(helper.split('\n').filter(Boolean).slice(-1)[0]).toBe('aal1|f');
    const before = psql(`SELECT messaging_suspended FROM businesses WHERE id = '${BIZ_ID}';`);
    const error = psqlMayFail(`
      SELECT set_config('request.jwt.claims', '${aal1}', false);
      SET ROLE authenticated;
      SELECT toggle_messaging_suspension('${BIZ_ID}'::uuid, true, 'aal1 must be denied');
      RESET ROLE;
    `);
    expect(error.toLowerCase()).toContain('permission denied');
    expect(psql(`SELECT messaging_suspended FROM businesses WHERE id = '${BIZ_ID}';`)).toBe(before);
  });

  // ── 1-3. has_function_privilege assertions ──

  it('1. anon has no EXECUTE on toggle_messaging_suspension', () => {
    expect(psql("SELECT has_function_privilege('anon', 'toggle_messaging_suspension(uuid,boolean,text)', 'EXECUTE');")).toBe('f');
  });

  it('2. authenticated has NO EXECUTE on toggle_messaging_suspension', () => {
    expect(psql("SELECT has_function_privilege('authenticated', 'toggle_messaging_suspension(uuid,boolean,text)', 'EXECUTE');")).toBe('f');
  });

  it('3. service_role retains privileged EXECUTE on legacy wrapper', () => {
    expect(psql("SELECT has_function_privilege('service_role', 'toggle_messaging_suspension(uuid,boolean,text)', 'EXECUTE');")).toBe('t');
  });

  // ── 4. PUBLIC has no EXECUTE ACE ──

  it('4. PUBLIC has no EXECUTE ACE (direct ACL inspection)', () => {
    const acl = psql("SELECT proacl::text FROM pg_proc WHERE proname = 'toggle_messaging_suspension';");
    // PUBLIC grant would appear as "=X/" (empty grantee before =). Must be absent.
    expect(acl).not.toMatch(/(?<![a-z_])=X\//);
    expect(acl).not.toContain('authenticated=X/');
  });

  // ── 5. Admin suspend/resume with canonical authority ──

  it('5. Service-only wrapper uses canonical admin authority and writes durable audit', () => {
    // Suspend
    const suspendResult = psqlMayFail(`
      SET ROLE service_role;
      SELECT svc_toggle_messaging_suspension('${ADMIN_UUID}'::uuid, '${BIZ_ID}'::uuid, true, 'ACL test suspend 287');
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
      SET ROLE service_role;
      SELECT svc_toggle_messaging_suspension('${ADMIN_UUID}'::uuid, '${BIZ_ID}'::uuid, false, 'ACL test resume 287');
      RESET ROLE;
    `);
    expect(resumeResult).not.toContain('ERROR');

    const afterResume = psql(`SELECT messaging_suspended FROM businesses WHERE id = '${BIZ_ID}';`);
    expect(afterResume).toBe('f');
  });

  // ── 6. Non-admin rejected by service-only wrapper's DB role lookup ──

  it('6. Service-only wrapper rejects non-admin actor IDs', () => {
    const err = psqlMayFail(`
      SET ROLE service_role;
      SELECT svc_toggle_messaging_suspension('${NON_ADMIN_UUID}'::uuid, '${BIZ_ID}'::uuid, true);
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

  // ── 8. Service_role legacy call requires genuine caller context ──

  it('8. Service_role cannot use legacy wrapper without a caller identity', () => {
    const err = psqlMayFail(`
      SET ROLE service_role;
      SELECT toggle_messaging_suspension('${BIZ_ID}'::uuid, true);
      RESET ROLE;
    `);
    expect(err.toLowerCase()).toContain('requires authenticated caller');
  });

  // ── 9. Shared implementation is responsible for actual column update ──

  it('9. RPC retains identity checks and delegates mutation to protected implementation', () => {
    const src = psql("SELECT prosrc FROM pg_proc WHERE proname = 'toggle_messaging_suspension';");
    expect(src).toContain('auth.uid()');
    expect(src).toContain('is_admin()');
    expect(src).toContain('requires authenticated caller');
    expect(src).toContain('requires admin role');
    expect(src).toContain('_toggle_messaging_suspension_impl');
    const impl = psql("SELECT prosrc FROM pg_proc WHERE proname = '_toggle_messaging_suspension_impl';");
    expect(impl).toContain('messaging_suspended');
    expect(psql("SELECT has_function_privilege('authenticated', '_toggle_messaging_suspension_impl(uuid,uuid,boolean,text)', 'EXECUTE');")).toBe('f');
    expect(psql("SELECT has_function_privilege('service_role', 'svc_toggle_messaging_suspension(uuid,uuid,boolean,text)', 'EXECUTE');")).toBe('t');

    const secdef = psql("SELECT prosecdef FROM pg_proc WHERE proname = 'toggle_messaging_suspension';");
    expect(secdef).toBe('t');
  });
});
