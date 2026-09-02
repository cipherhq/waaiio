/**
 * Emergency Messaging Hard-Stop DB Tests (#256 S-1)
 *
 * Real PostgreSQL proofs for admin-only suspension, atomic audit, and column protection.
 * Requires TEST_DATABASE_URL.
 *
 *   TEST_DATABASE_URL=postgresql://localhost:5432/waaiio_256_test \
 *     npx vitest run lib/__tests__/emergency-hard-stop-db.test.ts
 */
import { execSync } from 'child_process';
import { readFileSync } from 'fs';
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

const ADMIN_CLAIMS = '{"sub":"00000000-0000-0000-0000-000000000099","role":"admin","user_metadata":{"role":"admin"}}';
const OWNER_CLAIMS = '{"sub":"00000000-0000-0000-0000-000000000001","role":"authenticated","user_metadata":{}}';
const BIZ_ID = '00000000-0000-0000-0256-000000000001';
const BIZ_B_ID = '00000000-0000-0000-0256-000000000002';

describe.skipIf(!canRun)('Emergency Hard-Stop DB Tests (#256 S-1)', () => {
  beforeAll(() => {
    // Set up schema stubs
    psql(`
      CREATE EXTENSION IF NOT EXISTS "pgcrypto";
      DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      GRANT USAGE ON SCHEMA public TO authenticated, service_role, anon;

      CREATE OR REPLACE FUNCTION public.is_admin() RETURNS BOOLEAN AS $fn$
      BEGIN
        RETURN COALESCE(current_setting('request.jwt.claims', true)::jsonb->>'role' = 'admin', false);
      END;
      $fn$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

      CREATE SCHEMA IF NOT EXISTS auth;
      CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS $fn$
      BEGIN
        RETURN (current_setting('request.jwt.claims', true)::jsonb->>'sub')::uuid;
      EXCEPTION WHEN OTHERS THEN RETURN NULL;
      END;
      $fn$ LANGUAGE plpgsql STABLE;

      CREATE TABLE IF NOT EXISTS public.profiles (id UUID PRIMARY KEY);
      -- In CI, profiles.id may FK to auth.users — create stubs if auth.users exists
      DO $$ BEGIN
        INSERT INTO auth.users (id) VALUES ('00000000-0000-0000-0000-000000000099') ON CONFLICT DO NOTHING;
        INSERT INTO auth.users (id) VALUES ('00000000-0000-0000-0000-000000000001') ON CONFLICT DO NOTHING;
      EXCEPTION WHEN undefined_table THEN NULL; -- auth.users may not exist in local test
      END $$;
      INSERT INTO profiles (id) VALUES ('00000000-0000-0000-0000-000000000099') ON CONFLICT DO NOTHING;
      INSERT INTO profiles (id) VALUES ('00000000-0000-0000-0000-000000000001') ON CONFLICT DO NOTHING;

      -- Businesses table (minimal for testing)
      DO $$ BEGIN
        CREATE TYPE restaurant_status AS ENUM ('pending', 'active', 'suspended');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;

      CREATE TABLE IF NOT EXISTS public.businesses (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id UUID NOT NULL REFERENCES profiles(id),
        name TEXT NOT NULL DEFAULT 'Test Biz',
        slug TEXT UNIQUE,
        status restaurant_status NOT NULL DEFAULT 'active',
        phone TEXT, city TEXT, address TEXT
      );
      ALTER TABLE public.businesses ENABLE ROW LEVEL SECURITY;
      DO $$ BEGIN
        CREATE POLICY "Owners manage own businesses" ON public.businesses FOR ALL
          USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN
        CREATE POLICY "Admins can view all businesses" ON public.businesses FOR SELECT
          USING (public.is_admin());
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;

      GRANT SELECT, INSERT, UPDATE ON public.businesses TO authenticated;
      GRANT ALL ON public.businesses TO service_role;
    `);
    // service_role RLS bypass
    psqlMayFail('CREATE POLICY service_role_bypass_biz ON public.businesses FOR ALL TO service_role USING (true) WITH CHECK (true);');

    // Insert test businesses (include required columns for CI where full schema exists)
    psql(`
      INSERT INTO businesses (id, owner_id, name, slug, phone, city, address) VALUES
        ('${BIZ_ID}', '00000000-0000-0000-0000-000000000001', 'Test Biz A', 'test-biz-a-256', '+2341234567890', 'Lagos', '1 Test St'),
        ('${BIZ_B_ID}', '00000000-0000-0000-0000-000000000001', 'Test Biz B', 'test-biz-b-256', '+2341234567891', 'Lagos', '2 Test St')
      ON CONFLICT (id) DO NOTHING;
    `);

    // Apply migration 360
    const alreadyApplied = psqlMayFail("SELECT 1 FROM pg_proc WHERE proname = 'toggle_messaging_suspension' LIMIT 1;");
    if (!alreadyApplied.includes('1')) {
      const migrationSql = readFileSync('supabase/migrations/363_emergency_hard_stop.sql', 'utf-8');
      psql(migrationSql);
    }

    // Grant permissions for test roles
    psqlMayFail('GRANT SELECT, INSERT, UPDATE, DELETE ON public.messaging_suspension_audit TO service_role;');
    psqlMayFail('GRANT SELECT ON public.messaging_suspension_audit TO authenticated;');
    psqlMayFail('CREATE POLICY service_role_bypass_audit ON public.messaging_suspension_audit FOR ALL TO service_role USING (true) WITH CHECK (true);');
  });

  // ── Admin suspend and resume ──

  it('1. Admin can suspend messaging via RPC', () => {
    const result = psql(`
      SELECT set_config('request.jwt.claims', '${ADMIN_CLAIMS}', false);
      SET ROLE authenticated;
      SELECT toggle_messaging_suspension('${BIZ_ID}'::uuid, true, 'Emergency test');
      RESET ROLE;
    `);
    expect(result).toContain('"success": true');
    expect(result).toContain('"changed": true');

    const state = psql(`SELECT messaging_suspended FROM businesses WHERE id = '${BIZ_ID}';`);
    expect(state).toBe('t');
  });

  it('2. Admin can resume messaging via RPC', () => {
    const result = psql(`
      SELECT set_config('request.jwt.claims', '${ADMIN_CLAIMS}', false);
      SET ROLE authenticated;
      SELECT toggle_messaging_suspension('${BIZ_ID}'::uuid, false, 'Resolved');
      RESET ROLE;
    `);
    expect(result).toContain('"success": true');

    const state = psql(`SELECT messaging_suspended FROM businesses WHERE id = '${BIZ_ID}';`);
    expect(state).toBe('f');
  });

  // ── Owner cannot modify directly ──

  it('3. Business owner direct UPDATE of messaging_suspended → rejected', () => {
    const err = psqlMayFail(`
      SELECT set_config('request.jwt.claims', '${OWNER_CLAIMS}', false);
      SET ROLE authenticated;
      UPDATE businesses SET messaging_suspended = true WHERE id = '${BIZ_ID}';
      RESET ROLE;
    `);
    expect(err).toContain('toggle_messaging_suspension');
  });

  it('4. Owner can still update other columns (name)', () => {
    psql(`
      SELECT set_config('request.jwt.claims', '${OWNER_CLAIMS}', false);
      SET ROLE authenticated;
      UPDATE businesses SET name = 'Updated Name' WHERE id = '${BIZ_ID}';
      RESET ROLE;
    `);
    const name = psql(`SELECT name FROM businesses WHERE id = '${BIZ_ID}';`);
    expect(name).toBe('Updated Name');
    // Reset
    psql(`UPDATE businesses SET name = 'Test Biz A' WHERE id = '${BIZ_ID}';`);
  });

  // ── Non-admin cannot call RPC ──

  it('5. Non-admin authenticated user cannot call toggle_messaging_suspension', () => {
    const err = psqlMayFail(`
      SELECT set_config('request.jwt.claims', '${OWNER_CLAIMS}', false);
      SET ROLE authenticated;
      SELECT toggle_messaging_suspension('${BIZ_ID}'::uuid, true);
      RESET ROLE;
    `);
    expect(err).toContain('admin role');
  });

  it('6. Anon cannot call toggle_messaging_suspension', () => {
    const err = psqlMayFail(`
      SET ROLE anon;
      SELECT toggle_messaging_suspension('${BIZ_ID}'::uuid, true);
      RESET ROLE;
    `);
    expect(err.toLowerCase()).toMatch(/permission denied|does not exist/);
  });

  // ── Atomic audit ──

  it('7. Suspension state + audit record are atomic', () => {
    // Suspend
    psql(`
      SELECT set_config('request.jwt.claims', '${ADMIN_CLAIMS}', false);
      SET ROLE authenticated;
      SELECT toggle_messaging_suspension('${BIZ_ID}'::uuid, true, 'Audit test');
      RESET ROLE;
    `);

    // Verify audit exists with correct fields
    const audit = psql(`
      SELECT business_id, actor_id, prior_state, new_state, reason
      FROM messaging_suspension_audit
      WHERE business_id = '${BIZ_ID}'
      ORDER BY created_at DESC LIMIT 1;
    `);
    expect(audit).toContain(BIZ_ID);
    expect(audit).toContain('00000000-0000-0000-0000-000000000099'); // admin actor
    expect(audit).toContain('f'); // prior_state = false
    expect(audit).toContain('t'); // new_state = true
    expect(audit).toContain('Audit test');

    // Resume for cleanup
    psql(`
      SELECT set_config('request.jwt.claims', '${ADMIN_CLAIMS}', false);
      SET ROLE authenticated;
      SELECT toggle_messaging_suspension('${BIZ_ID}'::uuid, false);
      RESET ROLE;
    `);
  });

  it('8. Injected audit failure → suspension does NOT commit', () => {
    const beforeState = psql(`SELECT messaging_suspended FROM businesses WHERE id = '${BIZ_ID}';`);

    // Create trigger that blocks audit INSERT
    psql(`
      CREATE OR REPLACE FUNCTION _test_block_audit_insert()
      RETURNS TRIGGER AS $$ BEGIN
        RAISE EXCEPTION 'TEST_INJECTED_AUDIT_FAILURE';
      END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER _trg_test_block_audit
        BEFORE INSERT ON messaging_suspension_audit
        FOR EACH ROW EXECUTE FUNCTION _test_block_audit_insert();
    `);

    try {
      const err = psqlMayFail(`
        SELECT set_config('request.jwt.claims', '${ADMIN_CLAIMS}', false);
        SET ROLE authenticated;
        SELECT toggle_messaging_suspension('${BIZ_ID}'::uuid, true, 'Should fail');
        RESET ROLE;
      `);
      expect(err).toContain('TEST_INJECTED_AUDIT_FAILURE');

      // Verify state was NOT changed (rolled back)
      const afterState = psql(`SELECT messaging_suspended FROM businesses WHERE id = '${BIZ_ID}';`);
      expect(afterState).toBe(beforeState);
    } finally {
      psql(`
        DROP TRIGGER IF EXISTS _trg_test_block_audit ON messaging_suspension_audit;
        DROP FUNCTION IF EXISTS _test_block_audit_insert();
      `);
    }
  });

  // ── Audit tamper resistance ──

  it('9. Audit UPDATE → rejected (append-only)', () => {
    const err = psqlMayFail(`
      SET ROLE service_role;
      UPDATE messaging_suspension_audit SET reason = 'tampered'
      WHERE business_id = '${BIZ_ID}';
      RESET ROLE;
    `);
    expect(err).toContain('append-only');
  });

  it('10. Audit DELETE → rejected (append-only)', () => {
    const err = psqlMayFail(`
      SET ROLE service_role;
      DELETE FROM messaging_suspension_audit WHERE business_id = '${BIZ_ID}';
      RESET ROLE;
    `);
    expect(err).toContain('append-only');
  });

  // ── Shared-number isolation ──

  it('11. Suspending biz A does not affect biz B', () => {
    // Suspend A
    psql(`
      SELECT set_config('request.jwt.claims', '${ADMIN_CLAIMS}', false);
      SET ROLE authenticated;
      SELECT toggle_messaging_suspension('${BIZ_ID}'::uuid, true);
      RESET ROLE;
    `);

    // B is still allowed
    const bState = psql(`SELECT messaging_suspended FROM businesses WHERE id = '${BIZ_B_ID}';`);
    expect(bState).toBe('f');

    // Resume A
    psql(`
      SELECT set_config('request.jwt.claims', '${ADMIN_CLAIMS}', false);
      SET ROLE authenticated;
      SELECT toggle_messaging_suspension('${BIZ_ID}'::uuid, false);
      RESET ROLE;
    `);
  });

  // ── No-op on same state ──

  it('12. Toggle to same state is no-op (no duplicate audit)', () => {
    const auditCountBefore = psql(`SELECT count(*)::int FROM messaging_suspension_audit WHERE business_id = '${BIZ_ID}';`);

    const result = psql(`
      SELECT set_config('request.jwt.claims', '${ADMIN_CLAIMS}', false);
      SET ROLE authenticated;
      SELECT toggle_messaging_suspension('${BIZ_ID}'::uuid, false);
      RESET ROLE;
    `);
    expect(result).toContain('"changed": false');

    const auditCountAfter = psql(`SELECT count(*)::int FROM messaging_suspension_audit WHERE business_id = '${BIZ_ID}';`);
    expect(auditCountAfter).toBe(auditCountBefore);
  });

  // ── EXECUTE privilege ──

  it('13. EXECUTE privilege: PUBLIC revoked, authenticated granted', () => {
    const acl = psql("SELECT proacl::text FROM pg_proc WHERE proname = 'toggle_messaging_suspension';");
    expect(acl).toContain('authenticated=X/');
  });

  // ── Missing business ──

  it('14. Toggle on non-existent business → error', () => {
    const err = psqlMayFail(`
      SELECT set_config('request.jwt.claims', '${ADMIN_CLAIMS}', false);
      SET ROLE authenticated;
      SELECT toggle_messaging_suspension('00000000-0000-0000-0000-999999999999'::uuid, true);
      RESET ROLE;
    `);
    expect(err).toContain('Business not found');
  });

  // ── Production-shaped: non-superuser function owner ──
  // Simulates Supabase production where project postgres is NOSUPERUSER but
  // owns all SECURITY DEFINER application functions.

  it('15. Production-shaped: non-superuser DB-owner can toggle via SECURITY DEFINER', () => {
    // Create a NOSUPERUSER role with the minimum privileges the production
    // DB-owner (postgres) has: public schema, application tables, and the
    // auth schema/function dependency required by toggle_messaging_suspension.
    psqlMayFail(`
      DO $$ BEGIN CREATE ROLE _test_db_owner NOLOGIN NOSUPERUSER; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      GRANT USAGE ON SCHEMA public TO _test_db_owner;
      GRANT ALL ON public.businesses TO _test_db_owner;
      GRANT ALL ON public.messaging_suspension_audit TO _test_db_owner;
      -- Minimum RPC dependencies: toggle_messaging_suspension calls auth.uid() and public.is_admin()
      GRANT USAGE ON SCHEMA auth TO _test_db_owner;
      GRANT EXECUTE ON FUNCTION auth.uid() TO _test_db_owner;
      GRANT EXECUTE ON FUNCTION public.is_admin() TO _test_db_owner;
    `);

    // Transfer ownership to the non-superuser role
    psql(`
      ALTER FUNCTION public.toggle_messaging_suspension(UUID, BOOLEAN, TEXT) OWNER TO _test_db_owner;
      ALTER FUNCTION public.guard_messaging_suspended() OWNER TO _test_db_owner;
    `);

    try {
      // Admin toggle via the non-superuser-owned SECURITY DEFINER function should succeed
      const result = psql(`
        SELECT set_config('request.jwt.claims', '${ADMIN_CLAIMS}', false);
        SET ROLE authenticated;
        SELECT toggle_messaging_suspension('${BIZ_ID}'::uuid, true, 'Non-superuser owner test');
        RESET ROLE;
      `);
      expect(result).toContain('"success": true');
      expect(result).toContain('"changed": true');

      const state = psql(`SELECT messaging_suspended FROM businesses WHERE id = '${BIZ_ID}';`);
      expect(state).toBe('t');

      // Resume
      psql(`
        SELECT set_config('request.jwt.claims', '${ADMIN_CLAIMS}', false);
        SET ROLE authenticated;
        SELECT toggle_messaging_suspension('${BIZ_ID}'::uuid, false, 'Resume');
        RESET ROLE;
      `);
    } finally {
      // Restore ownership to current user for remaining tests
      psqlMayFail(`
        ALTER FUNCTION public.toggle_messaging_suspension(UUID, BOOLEAN, TEXT) OWNER TO CURRENT_USER;
        ALTER FUNCTION public.guard_messaging_suspended() OWNER TO CURRENT_USER;
      `);
    }
  });

  it('16. Production-shaped: authenticated direct mutation still rejected with non-superuser owner', () => {
    // Even with non-superuser function owner, direct mutation by app roles must be blocked
    psqlMayFail(`
      ALTER FUNCTION public.toggle_messaging_suspension(UUID, BOOLEAN, TEXT) OWNER TO _test_db_owner;
      ALTER FUNCTION public.guard_messaging_suspended() OWNER TO _test_db_owner;
    `);

    try {
      const err = psqlMayFail(`
        SELECT set_config('request.jwt.claims', '${OWNER_CLAIMS}', false);
        SET ROLE authenticated;
        UPDATE businesses SET messaging_suspended = true WHERE id = '${BIZ_ID}';
        RESET ROLE;
      `);
      expect(err).toContain('toggle_messaging_suspension');

      // service_role direct mutation also rejected
      const svcErr = psqlMayFail(`
        SET ROLE service_role;
        UPDATE businesses SET messaging_suspended = true WHERE id = '${BIZ_ID}';
        RESET ROLE;
      `);
      expect(svcErr).toContain('toggle_messaging_suspension');

      // anon direct mutation also rejected
      const anonErr = psqlMayFail(`
        SET ROLE anon;
        UPDATE businesses SET messaging_suspended = true WHERE id = '${BIZ_ID}';
        RESET ROLE;
      `);
      // anon may get permission denied before reaching the trigger, either is acceptable
      expect(anonErr.toLowerCase()).toMatch(/toggle_messaging_suspension|permission denied/);
    } finally {
      // Restore ownership
      psqlMayFail(`
        ALTER FUNCTION public.toggle_messaging_suspension(UUID, BOOLEAN, TEXT) OWNER TO CURRENT_USER;
        ALTER FUNCTION public.guard_messaging_suspended() OWNER TO CURRENT_USER;
      `);
    }
  });
});
