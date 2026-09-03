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

// Test user UUIDs — one per platform role, plus ordinary + stale
const USERS = {
  admin:      '10000000-0000-0000-0000-000000000001',
  support:    '10000000-0000-0000-0000-000000000002',
  finance:    '10000000-0000-0000-0000-000000000003',
  operations: '10000000-0000-0000-0000-000000000004',
  ordinary:   '10000000-0000-0000-0000-000000000005',
  stale:      '10000000-0000-0000-0000-000000000006', // app_meta has NO role, profiles.role=admin
};

// Fixed fixture IDs for deterministic assertions
const DEMO_ID = 'd0000000-0000-0000-0000-000000000001';
const TOKEN_ID = 't0000000-0000-0000-0000-000000000001';

function jwtClaims(userId: string, role: string): string {
  return `{"sub":"${userId}","role":"${role}","user_metadata":{"role":"${role}"}}`;
}

/** Execute SQL as an authenticated role. Returns only the query result (last line). */
function asRole(userId: string, appMetaRole: string, sql: string): string {
  const raw = psql(`
    SELECT set_config('request.jwt.claims', '${jwtClaims(userId, appMetaRole)}', false);
    SET ROLE authenticated;
    ${sql}
    RESET ROLE;
  `);
  // set_config returns the value on its own line; the actual query result is the last non-empty line
  const lines = raw.split('\n').filter(l => l.trim() !== '');
  return lines.length > 1 ? lines.slice(1).join('\n') : lines[0] || '';
}

function asRoleMayFail(userId: string, appMetaRole: string, sql: string): string {
  const raw = psqlMayFail(`
    SELECT set_config('request.jwt.claims', '${jwtClaims(userId, appMetaRole)}', false);
    SET ROLE authenticated;
    ${sql}
    RESET ROLE;
  `);
  return raw;
}

describe.skipIf(!canRun)('Platform Role Authority DB Tests (#217)', () => {
  beforeAll(() => {
    // Seed test users in auth.users with correct app_metadata — MUST succeed
    for (const [role, id] of Object.entries(USERS)) {
      const metaRole = (role === 'ordinary' || role === 'stale') ? null : role;
      const metaJson = metaRole ? `{"role":"${metaRole}"}` : '{}';
      const email = `test-${role}@waaiio-217-test.com`;

      // auth.users insert — CI stub has only (id, email, raw_app_meta_data)
      const userResult = psqlMayFail(`
        INSERT INTO auth.users (id, email, raw_app_meta_data)
        VALUES ('${id}', '${email}', '${metaJson}'::jsonb)
        ON CONFLICT (id) DO UPDATE SET raw_app_meta_data = '${metaJson}'::jsonb;
      `);
      if (userResult.includes('ERROR')) throw new Error(`Failed to seed auth user ${role}: ${userResult}`);

      // profiles insert — stale user has profiles.role='admin' but no app_metadata role
      const profileRole = role === 'stale' ? 'admin' : 'restaurant_owner';
      const profResult = psqlMayFail(`
        INSERT INTO profiles (id, email, role) VALUES ('${id}', '${email}', '${profileRole}')
        ON CONFLICT (id) DO UPDATE SET role = '${profileRole}';
      `);
      if (profResult.includes('ERROR')) throw new Error(`Failed to seed profile ${role}: ${profResult}`);
    }

    // Seed demo_requests with known ID — MUST succeed
    const demoResult = psqlMayFail(`
      INSERT INTO demo_requests (id, business_name, contact_name, work_email, phone, industry, notes)
      VALUES ('${DEMO_ID}', 'Test Biz', 'Test User', 'demo@test.com', '+1234567890', 'tech', 'seed-note')
      ON CONFLICT (id) DO UPDATE SET notes = 'seed-note';
    `);
    if (demoResult.includes('ERROR')) throw new Error(`Failed to seed demo_requests: ${demoResult}`);

    // Ensure a test business exists for FK references — use minimal columns
    const BIZ_ID = 'b0000000-0000-0000-0000-000000000217';
    const bizResult = psqlMayFail(`
      INSERT INTO businesses (id, name, slug, owner_id, address, city, neighborhood, phone)
      VALUES ('${BIZ_ID}', 'Test217', 'test217-' || substr(md5(random()::text), 1, 8), '${USERS.admin}', '1 Test St', 'TestCity', 'TestArea', '+1234567890')
      ON CONFLICT (id) DO NOTHING;
    `);
    if (bizResult.includes('ERROR')) throw new Error(`Failed to seed business: ${bizResult}`);

    // Seed attendance_log with known data
    const attResult = psqlMayFail(`
      INSERT INTO attendance_log (id, business_id, customer_phone, marked_by, event_type)
      VALUES ('a0000000-0000-0000-0000-000000000001', '${BIZ_ID}', '+2348000000000', 'system', 'check_in')
      ON CONFLICT DO NOTHING;
    `);
    if (attResult.includes('ERROR')) throw new Error(`Failed to seed attendance_log: ${attResult}`);

    // Seed ai_classification_log with known data
    const aiResult = psqlMayFail(`
      INSERT INTO ai_classification_log (id, business_id, input_text, classification, confidence, model)
      VALUES ('c0000000-0000-0000-0000-000000000001', '${BIZ_ID}', 'test', 'greeting', 0.95, 'test')
      ON CONFLICT DO NOTHING;
    `);
    if (aiResult.includes('ERROR')) throw new Error(`Failed to seed ai_classification_log: ${aiResult}`);

    // Seed impersonation token with known ID
    const tokenResult = psqlMayFail(`
      INSERT INTO admin_impersonation_tokens (id, admin_id, business_id, token, expires_at)
      VALUES ('${TOKEN_ID}', '${USERS.admin}', '${BIZ_ID}', 'test-token-217', NOW() + INTERVAL '1 hour')
      ON CONFLICT DO NOTHING;
    `);
    if (tokenResult.includes('ERROR')) throw new Error(`Failed to seed impersonation token: ${tokenResult}`);
  });

  // ── 1-2. has_platform_role canonical authority ──

  it('1. has_platform_role reads app_metadata, not profiles.role', () => {
    const result = asRole(USERS.support, 'support', "SELECT has_platform_role(ARRAY['support']);");
    expect(result).toContain('t');
  });

  it('2. Stale profiles.role=admin with no app_metadata role → denied', () => {
    const result = asRole(USERS.stale, 'authenticated', "SELECT has_platform_role(ARRAY['admin']);");
    expect(result).toContain('f');
  });

  // ── 3-4. demo_requests (known fixture: DEMO_ID with notes='seed-note') ──

  it('3. demo_requests SELECT: admin/support/operations see the seeded row, finance sees nothing', () => {
    for (const role of ['admin', 'support', 'operations'] as const) {
      const notes = asRole(USERS[role], role, `SELECT notes FROM demo_requests WHERE id = '${DEMO_ID}';`);
      expect(notes.split('\n').pop()).toBe('seed-note');
    }
    const financeResult = asRole(USERS.finance, 'finance', `SELECT notes FROM demo_requests WHERE id = '${DEMO_ID}';`);
    expect(financeResult.split('\n').pop()).toBe('');
  });

  it('4. demo_requests UPDATE: admin/support change the row, operations/finance cannot', () => {
    // admin updates
    asRole(USERS.admin, 'admin', `UPDATE demo_requests SET notes = 'admin-edited' WHERE id = '${DEMO_ID}';`);
    let check = psql(`SELECT notes FROM demo_requests WHERE id = '${DEMO_ID}';`);
    expect(check).toBe('admin-edited');

    // support updates
    asRole(USERS.support, 'support', `UPDATE demo_requests SET notes = 'support-edited' WHERE id = '${DEMO_ID}';`);
    check = psql(`SELECT notes FROM demo_requests WHERE id = '${DEMO_ID}';`);
    expect(check).toBe('support-edited');

    // operations cannot update (RLS silently returns 0 rows)
    asRole(USERS.operations, 'operations', `UPDATE demo_requests SET notes = 'ops-attempt' WHERE id = '${DEMO_ID}';`);
    check = psql(`SELECT notes FROM demo_requests WHERE id = '${DEMO_ID}';`);
    expect(check).toBe('support-edited'); // unchanged

    // finance cannot update
    asRole(USERS.finance, 'finance', `UPDATE demo_requests SET notes = 'fin-attempt' WHERE id = '${DEMO_ID}';`);
    check = psql(`SELECT notes FROM demo_requests WHERE id = '${DEMO_ID}';`);
    expect(check).toBe('support-edited'); // still unchanged

    // Reset
    psql(`UPDATE demo_requests SET notes = 'seed-note' WHERE id = '${DEMO_ID}';`);
  });

  // ── 5-6. attendance_log and ai_classification_log ──

  it('5. attendance_log: admin/operations see rows, support/finance see nothing', () => {
    for (const role of ['admin', 'operations'] as const) {
      const count = asRole(USERS[role], role, "SELECT count(*)::int FROM attendance_log;");
      expect(parseInt(count.split('\n').pop()!, 10)).toBeGreaterThan(0);
    }
    const supportCount = asRole(USERS.support, 'support', "SELECT count(*)::int FROM attendance_log;");
    expect(supportCount.split('\n').pop()).toBe('0');
    const financeCount = asRole(USERS.finance, 'finance', "SELECT count(*)::int FROM attendance_log;");
    expect(financeCount.split('\n').pop()).toBe('0');
  });

  it('6. ai_classification_log: admin/operations see rows, support/finance see nothing', () => {
    for (const role of ['admin', 'operations'] as const) {
      const count = asRole(USERS[role], role, "SELECT count(*)::int FROM ai_classification_log;");
      expect(parseInt(count.split('\n').pop()!, 10)).toBeGreaterThan(0);
    }
    const supportCount = asRole(USERS.support, 'support', "SELECT count(*)::int FROM ai_classification_log;");
    expect(supportCount.split('\n').pop()).toBe('0');
  });

  // ── 7. impersonation tokens (deterministic fixture) ──

  it('7. impersonation tokens: admin/support see the fixture, finance/operations cannot', () => {
    // admin sees the token
    const adminResult = asRole(USERS.admin, 'admin', `SELECT token FROM admin_impersonation_tokens WHERE id = '${TOKEN_ID}';`);
    expect(adminResult.split('\n').pop()).toBe('test-token-217');

    // support sees the token
    const supportResult = asRole(USERS.support, 'support', `SELECT token FROM admin_impersonation_tokens WHERE id = '${TOKEN_ID}';`);
    expect(supportResult.split('\n').pop()).toBe('test-token-217');

    // finance cannot see the token
    const financeResult = asRole(USERS.finance, 'finance', `SELECT token FROM admin_impersonation_tokens WHERE id = '${TOKEN_ID}';`);
    expect(financeResult.split('\n').pop()).toBe('');

    // operations cannot see the token
    const opsResult = asRole(USERS.operations, 'operations', `SELECT token FROM admin_impersonation_tokens WHERE id = '${TOKEN_ID}';`);
    expect(opsResult.split('\n').pop()).toBe('');
  });

  // ── 8-10. ACL assertions (anon, authenticated, service_role) ──

  it('8. anon cannot EXECUTE has_platform_role or is_support', () => {
    expect(psql("SELECT has_function_privilege('anon', 'has_platform_role(text[])', 'EXECUTE');")).toBe('f');
    expect(psql("SELECT has_function_privilege('anon', 'is_support()', 'EXECUTE');")).toBe('f');
  });

  it('9. authenticated can EXECUTE both helpers', () => {
    expect(psql("SELECT has_function_privilege('authenticated', 'has_platform_role(text[])', 'EXECUTE');")).toBe('t');
    expect(psql("SELECT has_function_privilege('authenticated', 'is_support()', 'EXECUTE');")).toBe('t');
  });

  it('10. service_role can EXECUTE both helpers', () => {
    expect(psql("SELECT has_function_privilege('service_role', 'has_platform_role(text[])', 'EXECUTE');")).toBe('t');
    expect(psql("SELECT has_function_privilege('service_role', 'is_support()', 'EXECUTE');")).toBe('t');
  });

  // ── 11. Ordinary user denied ──

  it('11. Ordinary user sees 0 rows from all admin tables', () => {
    for (const table of ['demo_requests', 'attendance_log', 'ai_classification_log', 'admin_impersonation_tokens']) {
      const count = asRole(USERS.ordinary, 'authenticated', `SELECT count(*)::int FROM ${table};`);
      expect(count.split('\n').pop()).toBe('0');
    }
  });

  // ── 12. No RLS recursion ──

  it('12. has_platform_role does not cause RLS recursion', () => {
    const result = asRole(USERS.admin, 'admin', "SELECT has_platform_role(ARRAY['admin']);");
    expect(result).toContain('t');
  });

  // ── 13. is_support per-role behavior ──

  it('13. is_support returns correct result from canonical source for all roles', () => {
    expect(asRole(USERS.admin, 'admin', "SELECT is_support();")).toContain('t');
    expect(asRole(USERS.support, 'support', "SELECT is_support();")).toContain('t');
    expect(asRole(USERS.finance, 'finance', "SELECT is_support();")).toContain('f');
    expect(asRole(USERS.operations, 'operations', "SELECT is_support();")).toContain('f');
  });

  // ── 14-15. Structural checks ──

  it('14. has_platform_role source reads raw_app_meta_data, not profiles', () => {
    const src = psql("SELECT prosrc FROM pg_proc WHERE proname = 'has_platform_role';");
    expect(src).toContain('raw_app_meta_data');
    expect(src).not.toContain('profiles');
  });

  it('15. is_support source reads canonical, not profiles', () => {
    const src = psql("SELECT prosrc FROM pg_proc WHERE proname = 'is_support';");
    expect(src).toContain('raw_app_meta_data');
    expect(src).not.toContain('profiles');
  });

  // ── 16. Self-escalation blocked ──

  it('16. Self-escalation via profiles.role is blocked by trigger', () => {
    const err = asRoleMayFail(USERS.ordinary, 'authenticated',
      `UPDATE profiles SET role = 'admin' WHERE id = '${USERS.ordinary}';`);
    expect(err.toLowerCase()).toMatch(/unauthorized|cannot be changed|permission denied/);
  });
});
