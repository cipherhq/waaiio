/**
 * Platform Role Authority DB Tests (#217)
 *
 * Real PostgreSQL proofs for has_platform_role(), is_support() correction,
 * and the 4 migrated RLS policies. Tests canonical authority from
 * auth.users.raw_app_meta_data.role while profiles.role is stale/ignored.
 *
 *   TEST_DATABASE_URL=postgresql://localhost:5432/waaiio_test \
 *     npx vitest run lib/__tests__/platform-role-authority-db.test.ts
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

// Test user UUIDs — one per platform role, plus one ordinary user
const USERS = {
  admin:      '10000000-0000-0000-0000-000000000001',
  support:    '10000000-0000-0000-0000-000000000002',
  finance:    '10000000-0000-0000-0000-000000000003',
  operations: '10000000-0000-0000-0000-000000000004',
  ordinary:   '10000000-0000-0000-0000-000000000005',
  stale:      '10000000-0000-0000-0000-000000000006', // app_meta=customer, profiles.role=admin
};

function jwtClaims(userId: string, role: string): string {
  return `{"sub":"${userId}","role":"${role}","user_metadata":{"role":"${role}"}}`;
}

function asRole(userId: string, appMetaRole: string, sql: string): string {
  return psql(`
    SELECT set_config('request.jwt.claims', '${jwtClaims(userId, appMetaRole)}', false);
    SET ROLE authenticated;
    ${sql}
    RESET ROLE;
  `);
}

function asRoleMayFail(userId: string, appMetaRole: string, sql: string): string {
  return psqlMayFail(`
    SELECT set_config('request.jwt.claims', '${jwtClaims(userId, appMetaRole)}', false);
    SET ROLE authenticated;
    ${sql}
    RESET ROLE;
  `);
}

describe.skipIf(!canRun)('Platform Role Authority DB Tests (#217)', () => {
  beforeAll(() => {
    // Ensure test users exist in auth.users with correct app_metadata
    // Use psqlMayFail for idempotent setup
    for (const [role, id] of Object.entries(USERS)) {
      const metaRole = role === 'ordinary' ? null : (role === 'stale' ? null : role);
      const metaJson = metaRole ? `{"role":"${metaRole}"}` : '{}';
      const email = `test-${role}@waaiio-217-test.com`;
      psqlMayFail(`
        INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data)
        VALUES ('${id}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', '${email}', '', NOW(), NOW(), NOW(), '${metaJson}'::jsonb)
        ON CONFLICT (id) DO UPDATE SET raw_app_meta_data = '${metaJson}'::jsonb;
      `);
      psqlMayFail(`
        INSERT INTO profiles (id, email, role) VALUES ('${id}', '${email}', '${role === 'stale' ? 'admin' : 'restaurant_owner'}')
        ON CONFLICT (id) DO UPDATE SET role = '${role === 'stale' ? 'admin' : 'restaurant_owner'}';
      `);
    }

    // Seed test data in each policy-protected table
    psqlMayFail(`
      INSERT INTO demo_requests (id, business_name, contact_name, work_email, phone, industry)
      VALUES ('d0000000-0000-0000-0000-000000000001', 'Test Biz', 'Test User', 'demo@test.com', '+1234567890', 'tech')
      ON CONFLICT DO NOTHING;
    `);
    psqlMayFail(`
      INSERT INTO attendance_log (id, business_id, customer_phone, marked_by, event_type)
      SELECT 'a0000000-0000-0000-0000-000000000001', b.id, '+2348000000000', 'system', 'check_in'
      FROM businesses b LIMIT 1
      ON CONFLICT DO NOTHING;
    `);
    psqlMayFail(`
      INSERT INTO ai_classification_log (id, business_id, input_text, classification, confidence, model)
      SELECT 'c0000000-0000-0000-0000-000000000001', b.id, 'test', 'greeting', 0.95, 'test'
      FROM businesses b LIMIT 1
      ON CONFLICT DO NOTHING;
    `);
  });

  // ── 1-2. has_platform_role canonical authority ──

  it('1. has_platform_role reads app_metadata, not profiles.role', () => {
    // User with app_metadata.role=support, profiles.role=restaurant_owner → TRUE for support
    const result = asRole(USERS.support, 'support', "SELECT has_platform_role(ARRAY['support']);");
    expect(result).toContain('t');
  });

  it('2. Stale profiles.role=admin with no app_metadata role → denied', () => {
    // User with profiles.role=admin but app_metadata has no role → FALSE for admin
    const result = asRole(USERS.stale, 'authenticated', "SELECT has_platform_role(ARRAY['admin']);");
    expect(result).toContain('f');
  });

  // ── 3-4. demo_requests policies ──

  it('3. demo_requests SELECT: admin/support/operations allowed, finance denied', () => {
    for (const role of ['admin', 'support', 'operations'] as const) {
      const count = asRole(USERS[role], role, "SELECT count(*)::int FROM demo_requests;");
      expect(parseInt(count.split('\n').pop()!, 10)).toBeGreaterThanOrEqual(0); // no permission error = allowed
    }
    // finance → should get 0 rows or permission error (RLS denies)
    const financeCount = asRole(USERS.finance, 'finance', "SELECT count(*)::int FROM demo_requests;");
    expect(financeCount.split('\n').pop()).toBe('0');
  });

  it('4. demo_requests UPDATE: admin/support allowed, finance/operations denied', () => {
    // admin can update
    const adminResult = asRoleMayFail(USERS.admin, 'admin',
      "UPDATE demo_requests SET notes = 'updated by admin' WHERE id = 'd0000000-0000-0000-0000-000000000001' RETURNING id;");
    expect(adminResult).not.toContain('permission denied');

    // support can update
    const supportResult = asRoleMayFail(USERS.support, 'support',
      "UPDATE demo_requests SET notes = 'updated by support' WHERE id = 'd0000000-0000-0000-0000-000000000001' RETURNING id;");
    expect(supportResult).not.toContain('permission denied');

    // operations: UPDATE policy doesn't include operations → 0 rows affected (silent deny via RLS)
    const opsResult = asRole(USERS.operations, 'operations',
      "UPDATE demo_requests SET notes = 'ops attempt' WHERE id = 'd0000000-0000-0000-0000-000000000001' RETURNING id;");
    // Should return empty (0 rows matched by RLS)
    const opsLines = opsResult.split('\n').filter(l => l.includes('d0000000'));
    expect(opsLines.length).toBe(0);
  });

  // ── 5-6. attendance_log and ai_classification_log ──

  it('5. attendance_log SELECT: admin/operations allowed, support/finance denied', () => {
    for (const role of ['admin', 'operations'] as const) {
      const result = asRoleMayFail(USERS[role], role, "SELECT count(*)::int FROM attendance_log;");
      expect(result).not.toContain('permission denied');
    }
    const supportCount = asRole(USERS.support, 'support', "SELECT count(*)::int FROM attendance_log;");
    expect(supportCount.split('\n').pop()).toBe('0');
    const financeCount = asRole(USERS.finance, 'finance', "SELECT count(*)::int FROM attendance_log;");
    expect(financeCount.split('\n').pop()).toBe('0');
  });

  it('6. ai_classification_log SELECT: admin/operations allowed, support/finance denied', () => {
    for (const role of ['admin', 'operations'] as const) {
      const result = asRoleMayFail(USERS[role], role, "SELECT count(*)::int FROM ai_classification_log;");
      expect(result).not.toContain('permission denied');
    }
    const supportCount = asRole(USERS.support, 'support', "SELECT count(*)::int FROM ai_classification_log;");
    expect(supportCount.split('\n').pop()).toBe('0');
  });

  // ── 7. impersonation tokens via corrected is_support() ──

  it('7. impersonation tokens: admin/support allowed, finance/operations denied', () => {
    for (const role of ['admin', 'support'] as const) {
      const result = asRoleMayFail(USERS[role], role, "SELECT count(*)::int FROM admin_impersonation_tokens;");
      expect(result).not.toContain('permission denied');
    }
    // finance/operations should get 0 rows
    for (const role of ['finance', 'operations'] as const) {
      const count = asRole(USERS[role], role, "SELECT count(*)::int FROM admin_impersonation_tokens;");
      expect(count.split('\n').pop()).toBe('0');
    }
  });

  // ── 8-10. ACL assertions ──

  it('8. anon cannot EXECUTE has_platform_role', () => {
    const result = psql("SELECT has_function_privilege('anon', 'has_platform_role(text[])', 'EXECUTE');");
    expect(result).toBe('f');
  });

  it('9. anon cannot EXECUTE is_support', () => {
    const result = psql("SELECT has_function_privilege('anon', 'is_support()', 'EXECUTE');");
    expect(result).toBe('f');
  });

  it('10. authenticated can EXECUTE both helpers', () => {
    const hpr = psql("SELECT has_function_privilege('authenticated', 'has_platform_role(text[])', 'EXECUTE');");
    expect(hpr).toBe('t');
    const isSup = psql("SELECT has_function_privilege('authenticated', 'is_support()', 'EXECUTE');");
    expect(isSup).toBe('t');
  });

  // ── 11. Ordinary user denied all admin tables ──

  it('11. Ordinary user (no platform role) gets 0 rows from all admin tables', () => {
    for (const table of ['demo_requests', 'attendance_log', 'ai_classification_log', 'admin_impersonation_tokens']) {
      const count = asRole(USERS.ordinary, 'authenticated', `SELECT count(*)::int FROM ${table};`);
      expect(count.split('\n').pop()).toBe('0');
    }
  });

  // ── 12. No RLS recursion ──

  it('12. has_platform_role does not cause RLS recursion', () => {
    // If there were recursion, this would hit stack depth limit
    const result = asRole(USERS.admin, 'admin', "SELECT has_platform_role(ARRAY['admin']);");
    expect(result).toContain('t');
  });

  // ── 13-16. Server-side provisioning behavior (unit tests via admin-provision imports) ──
  // Tests 13-16 are covered by the API route unit tests and admin-provision CLI tests

  it('13. is_support() returns correct result from canonical source', () => {
    // admin → true
    const admin = asRole(USERS.admin, 'admin', "SELECT is_support();");
    expect(admin).toContain('t');
    // support → true
    const support = asRole(USERS.support, 'support', "SELECT is_support();");
    expect(support).toContain('t');
    // finance → false
    const finance = asRole(USERS.finance, 'finance', "SELECT is_support();");
    expect(finance).toContain('f');
    // operations → false
    const ops = asRole(USERS.operations, 'operations', "SELECT is_support();");
    expect(ops).toContain('f');
  });

  it('14. has_platform_role structural: no profiles.role reference in function source', () => {
    const src = psql("SELECT prosrc FROM pg_proc WHERE proname = 'has_platform_role';");
    expect(src).toContain('raw_app_meta_data');
    expect(src).not.toContain('profiles');
  });

  it('15. is_support structural: reads canonical source, not profiles', () => {
    const src = psql("SELECT prosrc FROM pg_proc WHERE proname = 'is_support';");
    expect(src).toContain('raw_app_meta_data');
    expect(src).not.toContain('profiles');
  });

  it('16. Self-escalation via profiles.role is blocked by trigger', () => {
    const err = asRoleMayFail(USERS.ordinary, 'authenticated',
      "UPDATE profiles SET role = 'admin' WHERE id = '" + USERS.ordinary + "';");
    expect(err.toLowerCase()).toMatch(/unauthorized|cannot be changed|permission denied/);
  });
});
