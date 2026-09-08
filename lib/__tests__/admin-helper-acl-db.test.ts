/**
 * Admin Helper ACL Normalization Tests — M374 (#289)
 *
 * Real PostgreSQL tests verifying:
 * - has_function_privilege for all 4 roles × 3 functions
 * - Authenticated admin/non-admin RLS behavior
 * - SECURITY DEFINER RPC authorization
 * - anon cannot call helpers directly
 *
 *   TEST_DATABASE_URL=postgresql://localhost:5432/waaiio_test \
 *     npx vitest run lib/__tests__/admin-helper-acl-db.test.ts
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

// ══════════════════════════════════════════════════════════
// 1. has_function_privilege matrix (12 assertions)
// ══════════════════════════════════════════════════════════

describe.skipIf(!canRun)('has_function_privilege matrix', () => {
  const helpers = ['is_admin()', 'is_admin_or_support()', 'is_admin_or_finance()'];

  for (const fn of helpers) {
    it(`authenticated CAN execute ${fn}`, () => {
      const result = psql(`SELECT has_function_privilege('authenticated', 'public.${fn}', 'EXECUTE')`);
      expect(result).toBe('t');
    });

    it(`anon CANNOT execute ${fn}`, () => {
      const result = psql(`SELECT has_function_privilege('anon', 'public.${fn}', 'EXECUTE')`);
      expect(result).toBe('f');
    });

    it(`service_role CANNOT execute ${fn}`, () => {
      const result = psql(`SELECT has_function_privilege('service_role', 'public.${fn}', 'EXECUTE')`);
      expect(result).toBe('f');
    });
  }

  it('PUBLIC cannot execute is_admin()', () => {
    // Check via pg_proc: no PUBLIC grant should exist
    const result = psql(`
      SELECT count(*) FROM information_schema.role_routine_grants
      WHERE routine_name = 'is_admin'
        AND routine_schema = 'public'
        AND grantee = 'PUBLIC'
    `);
    expect(parseInt(result)).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════
// 2. Authenticated admin/non-admin RLS behavior
// ══════════════════════════════════════════════════════════

describe.skipIf(!canRun)('authenticated RLS behavior', () => {
  const ADMIN_ID = '28900000-0000-0000-0000-000000000001';
  const USER_ID = '28900000-0000-0000-0000-000000000002';

  beforeAll(() => {
    // Create admin and non-admin users
    psql(`
      INSERT INTO auth.users (id, email, raw_app_meta_data) VALUES
        ('${ADMIN_ID}', 'admin-289@test.local', '{"role":"admin"}'),
        ('${USER_ID}', 'user-289@test.local', '{}')
      ON CONFLICT (id) DO UPDATE SET raw_app_meta_data = EXCLUDED.raw_app_meta_data;

      INSERT INTO public.profiles (id, first_name, last_name, role) VALUES
        ('${ADMIN_ID}', 'Admin', '289', 'admin'),
        ('${USER_ID}', 'User', '289', 'restaurant_owner')
      ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role;

      -- Table-level SELECT needed for authenticated to evaluate RLS policies
      -- (production Supabase has broader default grants; CI needs explicit)
      GRANT SELECT ON public.platform_config_versions TO authenticated;
    `);
  });

  it('admin can read platform_config_versions via is_admin() RLS', () => {
    // Ensure there is at least one config version
    psql(`
      INSERT INTO public.platform_config_versions (id, config_snapshot, effective_from, created_at)
      VALUES (gen_random_uuid(), '{"m374_test":true}'::jsonb, NOW(), NOW())
    `);

    const count = psql(`
      CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS $$
        SELECT '${ADMIN_ID}'::UUID;
      $$ LANGUAGE SQL STABLE;
      SET ROLE authenticated;
      SELECT count(*) FROM public.platform_config_versions;
    `);
    psql(`RESET ROLE`);
    expect(parseInt(count)).toBeGreaterThan(0);
  });

  it('non-admin sees 0 rows in platform_config_versions', () => {
    const count = psql(`
      CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS $$
        SELECT '${USER_ID}'::UUID;
      $$ LANGUAGE SQL STABLE;
      SET ROLE authenticated;
      SELECT count(*) FROM public.platform_config_versions;
    `);
    psql(`RESET ROLE`);
    expect(parseInt(count)).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════
// 3. SECURITY DEFINER RPC regression
// ══════════════════════════════════════════════════════════

describe.skipIf(!canRun)('SECURITY DEFINER RPC authorization', () => {
  const ADMIN_ID = '28900000-0000-0000-0000-000000000001';
  const USER_ID = '28900000-0000-0000-0000-000000000002';
  const BIZ_ID = '28900000-0000-0000-0000-000000000010';

  beforeAll(() => {
    // Ensure business exists for toggle_messaging_suspension
    psql(`
      INSERT INTO public.businesses (id, owner_id, name, slug, category, address, city, phone, status, subscription_tier, country_code)
      VALUES ('${BIZ_ID}', '${ADMIN_ID}', 'ACL Test Biz', 'acl-test-289', 'restaurant', '1 St', 'Lagos', '+234000289', 'active', 'free', 'NG')
      ON CONFLICT (id) DO NOTHING;
    `);
  });

  it('save_commercial_config succeeds as authenticated admin', () => {
    const result = psql(`
      CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS $$
        SELECT '${ADMIN_ID}'::UUID;
      $$ LANGUAGE SQL STABLE;
      SET ROLE authenticated;
      SELECT public.save_commercial_config('trial_days', '30'::jsonb, 'acl-test');
    `);
    psql(`RESET ROLE`);
    // Should return a UUID (config version ID)
    expect(result).toMatch(/^[0-9a-f]{8}-/);
  });

  it('save_commercial_config rejected as authenticated non-admin', () => {
    const result = psqlMayFail(`
      CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS $$
        SELECT '${USER_ID}'::UUID;
      $$ LANGUAGE SQL STABLE;
      SET ROLE authenticated;
      SELECT public.save_commercial_config('trial_days', '30'::jsonb, 'acl-test');
    `);
    expect(result).toContain('requires admin role');
  });

  it('toggle_messaging_suspension succeeds as authenticated admin', () => {
    const result = psql(`
      CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS $$
        SELECT '${ADMIN_ID}'::UUID;
      $$ LANGUAGE SQL STABLE;
      SET ROLE authenticated;
      SELECT public.toggle_messaging_suspension('${BIZ_ID}'::uuid, true, 'acl-test');
    `);
    psql(`RESET ROLE`);
    expect(result).toContain('"success": true');
  });

  it('toggle_messaging_suspension rejected as authenticated non-admin', () => {
    const result = psqlMayFail(`
      CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS $$
        SELECT '${USER_ID}'::UUID;
      $$ LANGUAGE SQL STABLE;
      SET ROLE authenticated;
      SELECT public.toggle_messaging_suspension('${BIZ_ID}'::uuid, false, 'acl-test');
    `);
    expect(result).toContain('requires admin role');
  });
});

// ══════════════════════════════════════════════════════════
// 4. Anon direct call denial
// ══════════════════════════════════════════════════════════

describe.skipIf(!canRun)('anon direct call denial', () => {
  it('anon cannot call is_admin()', () => {
    const result = psqlMayFail(`SET ROLE anon; SELECT public.is_admin();`);
    expect(result.toLowerCase()).toContain('permission denied');
  });

  it('anon cannot call is_admin_or_support()', () => {
    const result = psqlMayFail(`SET ROLE anon; SELECT public.is_admin_or_support();`);
    expect(result.toLowerCase()).toContain('permission denied');
  });

  it('anon cannot call is_admin_or_finance()', () => {
    const result = psqlMayFail(`SET ROLE anon; SELECT public.is_admin_or_finance();`);
    expect(result.toLowerCase()).toContain('permission denied');
  });
});

// ══════════════════════════════════════════════════════════
// 5. Helper definitions remain canonical
// ══════════════════════════════════════════════════════════

describe.skipIf(!canRun)('helper definitions canonical', () => {
  it('all three are SECURITY DEFINER', () => {
    for (const fn of ['is_admin', 'is_admin_or_support', 'is_admin_or_finance']) {
      const secdef = psql(`SELECT prosecdef FROM pg_proc WHERE proname = '${fn}'`);
      expect(secdef).toBe('t');
    }
  });

  it('all three have search_path set', () => {
    for (const fn of ['is_admin', 'is_admin_or_support', 'is_admin_or_finance']) {
      const config = psql(`SELECT proconfig FROM pg_proc WHERE proname = '${fn}'`);
      expect(config).toContain('search_path=');
    }
  });
});
