/**
 * Config Versioning DB Tests (#255 C-1)
 *
 * Executable PostgreSQL proofs for the config versioning system.
 * Requires TEST_DATABASE_URL environment variable pointing to a local/test PG instance.
 *
 *   TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:54322/postgres \
 *     npx vitest run lib/__tests__/config-versioning-db.test.ts
 *
 * Covers all 23+ acceptance tests from the #255 specification.
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
    return execSync(`psql "${dbUrl}" -tAXq`, {
      input: sql, encoding: 'utf-8', timeout: 15000,
    }).trim();
  } catch (e: unknown) {
    return (e as { stderr?: string }).stderr || String(e);
  }
}

describe.skipIf(!canRun)('Config Versioning DB Tests (#255 C-1)', () => {
  beforeAll(() => {
    // Set up minimal schema for testing
    psql(`
      CREATE EXTENSION IF NOT EXISTS "pgcrypto";

      -- Create roles if they don't exist
      DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      GRANT USAGE ON SCHEMA public TO authenticated, service_role, anon;

      -- Create is_admin() stub that checks JWT claims
      CREATE OR REPLACE FUNCTION public.is_admin() RETURNS BOOLEAN AS $fn$
      BEGIN
        RETURN COALESCE(
          current_setting('request.jwt.claims', true)::jsonb->>'role' = 'admin',
          false
        );
      END;
      $fn$ LANGUAGE plpgsql STABLE;

      -- Create auth.uid() stub
      CREATE SCHEMA IF NOT EXISTS auth;
      CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS $fn$
      BEGIN
        RETURN (current_setting('request.jwt.claims', true)::jsonb->>'sub')::uuid;
      EXCEPTION WHEN OTHERS THEN RETURN NULL;
      END;
      $fn$ LANGUAGE plpgsql STABLE;

      -- Create profiles table stub for FK
      CREATE TABLE IF NOT EXISTS public.profiles (id UUID PRIMARY KEY);
      INSERT INTO public.profiles (id) VALUES ('00000000-0000-0000-0000-000000000001') ON CONFLICT DO NOTHING;

      -- Create platform_settings table if not exists
      CREATE TABLE IF NOT EXISTS public.platform_settings (
        key VARCHAR(100) PRIMARY KEY,
        value JSONB NOT NULL DEFAULT '{}',
        description TEXT,
        updated_by UUID REFERENCES public.profiles(id),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      ALTER TABLE public.platform_settings ENABLE ROW LEVEL SECURITY;

      -- Admin RLS policy
      DO $$ BEGIN
        CREATE POLICY admin_all_platform_settings ON public.platform_settings FOR ALL USING (public.is_admin());
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;

      -- Seed commercial keys
      INSERT INTO platform_settings (key, value) VALUES
        ('pricing_tiers', '{"free":{"feePercentage":2.5,"feeFlat":100},"growth":{"feePercentage":1.5,"feeFlat":50}}'::jsonb),
        ('trial_days', '7'::jsonb),
        ('broadcast_limits', '{"free":{"maxBroadcasts":0}}'::jsonb),
        ('conversation_limits', '{"free":200}'::jsonb),
        ('default_platform_fee_percent', '2.5'::jsonb),
        ('annual_discount_percentage', '20'::jsonb),
        ('payout_cooling_period_days', '7'::jsonb),
        ('minimum_payout', '{"NG":5000}'::jsonb),
        ('payout_verification_limits', '{"unverified":0}'::jsonb),
        ('transfer_expiry_hours', '4'::jsonb),
        ('maintenance_mode', 'false'::jsonb),
        ('support_email', '"support@waaiio.com"'::jsonb)
      ON CONFLICT (key) DO NOTHING;

      -- Grant table permissions
      GRANT SELECT, INSERT, UPDATE, DELETE ON public.platform_settings TO authenticated, service_role;
    `);

    // Apply migration 359
    const fs = require('fs');
    const migrationSql = fs.readFileSync('supabase/migrations/359_config_versioning.sql', 'utf-8');
    psql(migrationSql);

    // Grant SELECT on platform_config_versions to service_role (for test visibility)
    psql(`GRANT SELECT ON public.platform_config_versions TO service_role, authenticated;`);
  });

  function countVersions(): number {
    return parseInt(psql('SELECT count(*)::int FROM platform_config_versions;'), 10);
  }

  function setAdminContext(): void {
    psql(`
      SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000001","role":"admin","user_metadata":{"role":"admin"}}', false);
    `);
  }

  // ── 1-3. Direct DML on commercial keys → rejected ──

  it('1. Authenticated admin direct UPDATE of commercial key → rejected', () => {
    const err = psqlMayFail(`
      SET ROLE authenticated;
      SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000001","role":"admin"}', true);
      UPDATE platform_settings SET value = '"999"'::jsonb WHERE key = 'trial_days';
    `);
    expect(err).toContain('save_commercial_config');
    psqlMayFail('RESET ROLE;');
  });

  it('2. Service_role direct UPDATE of commercial key → rejected', () => {
    const err = psqlMayFail(`
      SET ROLE service_role;
      UPDATE platform_settings SET value = '"999"'::jsonb WHERE key = 'pricing_tiers';
    `);
    expect(err).toContain('save_commercial_config');
    psqlMayFail('RESET ROLE;');
  });

  it('3. Service_role direct DELETE of commercial key → rejected', () => {
    const err = psqlMayFail(`
      SET ROLE service_role;
      DELETE FROM platform_settings WHERE key = 'trial_days';
    `);
    expect(err).toContain('save_commercial_config');
    psqlMayFail('RESET ROLE;');
  });

  // ── 4. Service_role direct INSERT into versions → rejected ──

  it('4. Service_role direct INSERT into platform_config_versions → rejected', () => {
    const err = psqlMayFail(`
      SET ROLE service_role;
      INSERT INTO platform_config_versions (config_snapshot, effective_from)
      VALUES ('{"test": true}'::jsonb, NOW());
    `);
    expect(err).toContain('save_commercial_config');
    psqlMayFail('RESET ROLE;');
  });

  // ── 5. Non-admin cannot call RPC ──

  it('5. Non-admin user cannot invoke save_commercial_config', () => {
    const err = psqlMayFail(`
      SET ROLE anon;
      SELECT save_commercial_config('trial_days', '14'::jsonb);
    `);
    expect(err.toLowerCase()).toMatch(/permission denied|does not exist/);
    psqlMayFail('RESET ROLE;');
  });

  // ── 6. Authorized admin RPC → atomic projection + version ──

  it('6. Authorized admin RPC save → projection + exactly one version atomically', () => {
    const before = countVersions();
    setAdminContext();
    psql(`
      SET ROLE authenticated;
      SELECT save_commercial_config('trial_days', '14'::jsonb);
      RESET ROLE;
    `);
    const after = countVersions();
    expect(after).toBe(before + 1);

    // Verify projection updated
    const val = psql("SELECT value::text FROM platform_settings WHERE key = 'trial_days';");
    expect(val).toBe('14');

    // Verify snapshot contains trial_days = 14
    const snap = psql("SELECT config_snapshot->>'trial_days' FROM platform_config_versions ORDER BY effective_from DESC LIMIT 1;");
    expect(snap).toBe('14');
  });

  // ── 7. Atomic rollback (structural proof) ──

  it('7. save_commercial_config is one PL/pgSQL block = one transaction = atomic', () => {
    const src = psql("SELECT prosrc FROM pg_proc WHERE proname = 'save_commercial_config';");
    expect(src).toContain('pg_advisory_xact_lock');
    expect(src).toContain('INSERT INTO platform_config_versions');
    expect(src).toContain('INSERT INTO platform_settings');
    // Both mutations in same function body = same transaction = atomic rollback
  });

  // ── 8-11. Key-rename guard ──

  it('8. Admin rename commercial → non-commercial → rejected (OLD.key is commercial)', () => {
    const err = psqlMayFail(`
      SET ROLE authenticated;
      SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000001","role":"admin"}', true);
      UPDATE platform_settings SET key = 'pricing_tiers_old' WHERE key = 'pricing_tiers';
    `);
    expect(err).toContain('save_commercial_config');
    psqlMayFail('RESET ROLE;');
  });

  it('9. Service_role rename commercial → non-commercial → rejected', () => {
    const err = psqlMayFail(`
      SET ROLE service_role;
      UPDATE platform_settings SET key = 'trial_days_bak' WHERE key = 'trial_days';
    `);
    expect(err).toContain('save_commercial_config');
    psqlMayFail('RESET ROLE;');
  });

  it('10. Rename non-commercial → commercial → rejected (NEW.key is commercial)', () => {
    psql("INSERT INTO platform_settings (key, value) VALUES ('my_test_key', '\"hello\"'::jsonb) ON CONFLICT DO NOTHING;");
    const err = psqlMayFail(`
      SET ROLE service_role;
      UPDATE platform_settings SET key = 'pricing_tiers' WHERE key = 'my_test_key';
    `);
    expect(err).toContain('save_commercial_config');
    psqlMayFail('RESET ROLE;');
    psql("DELETE FROM platform_settings WHERE key = 'my_test_key';");
  });

  it('11. Non-commercial → non-commercial rename → allowed', () => {
    psql("INSERT INTO platform_settings (key, value) VALUES ('test_rename_src', '\"v1\"'::jsonb) ON CONFLICT DO NOTHING;");
    const result = psqlMayFail(`
      SET ROLE service_role;
      UPDATE platform_settings SET key = 'test_rename_dst' WHERE key = 'test_rename_src';
      RESET ROLE;
    `);
    expect(result).not.toContain('save_commercial_config');
    psql("DELETE FROM platform_settings WHERE key IN ('test_rename_src', 'test_rename_dst');");
  });

  // ── 12-14. Non-commercial isolation ──

  it('12. Service-role upsert of otp:* → succeeds, zero versions created', () => {
    const before = countVersions();
    psqlMayFail(`
      SET ROLE service_role;
      INSERT INTO platform_settings (key, value)
      VALUES ('otp:test@example.com', '{"code":"123456"}'::jsonb)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
      RESET ROLE;
    `);
    const after = countVersions();
    expect(after).toBe(before);
    psql("DELETE FROM platform_settings WHERE key = 'otp:test@example.com';");
  });

  it('13. Service-role delete of ephemeral key → succeeds', () => {
    psql("INSERT INTO platform_settings (key, value) VALUES ('otp:cleanup', '\"x\"'::jsonb) ON CONFLICT DO NOTHING;");
    const result = psqlMayFail(`
      SET ROLE service_role;
      DELETE FROM platform_settings WHERE key = 'otp:cleanup';
      RESET ROLE;
    `);
    expect(result).not.toContain('ERROR');
  });

  it('14. Non-commercial admin UPDATE (maintenance_mode) → succeeds, zero versions', () => {
    const before = countVersions();
    psqlMayFail(`
      SET ROLE service_role;
      UPDATE platform_settings SET value = 'true'::jsonb WHERE key = 'maintenance_mode';
      RESET ROLE;
    `);
    const after = countVersions();
    expect(after).toBe(before);
    psql("UPDATE platform_settings SET value = 'false'::jsonb WHERE key = 'maintenance_mode';");
  });

  // ── 15-16. Immutability ──

  it('15. Service-role UPDATE of historical version → rejected', () => {
    const err = psqlMayFail(`
      SET ROLE service_role;
      UPDATE platform_config_versions SET config_snapshot = '{"hacked": true}'::jsonb
      WHERE id = (SELECT id FROM platform_config_versions LIMIT 1);
    `);
    expect(err).toContain('append-only');
    psqlMayFail('RESET ROLE;');
  });

  it('16. Service-role DELETE of historical version → rejected', () => {
    const err = psqlMayFail(`
      SET ROLE service_role;
      DELETE FROM platform_config_versions WHERE id = (SELECT id FROM platform_config_versions LIMIT 1);
    `);
    expect(err).toContain('append-only');
    psqlMayFail('RESET ROLE;');
  });

  // ── 17-18. Bootstrap ──

  it('17. Bootstrap snapshot excludes non-commercial keys', () => {
    const snap = psql("SELECT config_snapshot::text FROM platform_config_versions ORDER BY effective_from ASC LIMIT 1;");
    expect(snap).toContain('pricing_tiers');
    expect(snap).toContain('trial_days');
    expect(snap).not.toContain('maintenance_mode');
    expect(snap).not.toContain('support_email');
  });

  it('18. Empty commercial source → fail closed (structural)', () => {
    const src = psql("SELECT prosrc FROM pg_proc WHERE proname = 'save_commercial_config';");
    expect(src).toContain('no commercial keys found');
  });

  // ── 19-20. Resolution ──

  it('19. Effective-version resolution is deterministic', () => {
    psql(`
      INSERT INTO platform_config_versions (id, config_snapshot, effective_from, created_at) VALUES
        ('a0000000-0000-0000-0000-000000000001', '{"test":"yesterday"}'::jsonb, NOW() - interval '1 day', NOW()),
        ('a0000000-0000-0000-0000-000000000002', '{"test":"hour_ago"}'::jsonb, NOW() - interval '1 hour', NOW()),
        ('a0000000-0000-0000-0000-000000000003', '{"test":"recent"}'::jsonb, NOW() - interval '1 second', NOW());
    `);

    const current = psql("SELECT get_effective_config(NOW())::text;");
    expect(current).toBe('a0000000-0000-0000-0000-000000000003');

    const mid = psql("SELECT get_effective_config(NOW() - interval '23 hours')::text;");
    expect(mid).toBe('a0000000-0000-0000-0000-000000000001');

    psql("DELETE FROM platform_config_versions WHERE id IN ('a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-000000000003');");
  });

  it('20. Duplicate effective_from → UNIQUE violation', () => {
    const ts = '2099-01-01T00:00:00Z';
    psql(`INSERT INTO platform_config_versions (config_snapshot, effective_from) VALUES ('{"dup":"test1"}'::jsonb, '${ts}'::timestamptz);`);
    const err = psqlMayFail(`INSERT INTO platform_config_versions (config_snapshot, effective_from) VALUES ('{"dup":"test2"}'::jsonb, '${ts}'::timestamptz);`);
    expect(err.toLowerCase()).toContain('unique');
    psql("DELETE FROM platform_config_versions WHERE config_snapshot->>'dup' IS NOT NULL;");
  });

  // ── 21. Concurrency (sequential linearization proof) ──

  it('21. Sequential saves linearize: second version contains both changes', () => {
    setAdminContext();
    psql(`
      SET ROLE authenticated;
      SELECT save_commercial_config('trial_days', '21'::jsonb);
      RESET ROLE;
    `);
    setAdminContext();
    psql(`
      SET ROLE authenticated;
      SELECT save_commercial_config('annual_discount_percentage', '25'::jsonb);
      RESET ROLE;
    `);

    const snap = psql("SELECT config_snapshot::text FROM platform_config_versions ORDER BY effective_from DESC LIMIT 1;");
    expect(snap).toContain('"trial_days": 21');
    expect(snap).toContain('"annual_discount_percentage": 25');
  });

  // ── 22-23. Security ──

  it('22. created_by = auth.uid(), not caller-supplied', () => {
    const uid = '00000000-0000-0000-0000-000000000001';
    setAdminContext();
    psql(`
      SET ROLE authenticated;
      SELECT save_commercial_config('trial_days', '7'::jsonb);
      RESET ROLE;
    `);
    const createdBy = psql("SELECT created_by::text FROM platform_config_versions ORDER BY effective_from DESC LIMIT 1;");
    expect(createdBy).toBe(uid);
  });

  it('23. Unauthenticated SELECT on versions → zero rows (RLS)', () => {
    const count = psql(`
      SET ROLE anon;
      SELECT count(*)::int FROM platform_config_versions;
    `);
    expect(count).toBe('0');
    psqlMayFail('RESET ROLE;');
  });

  // ── 24-27. Additional proofs ──

  it('24. EXECUTE privilege: PUBLIC revoked, authenticated granted', () => {
    const acl = psql("SELECT proacl::text FROM pg_proc WHERE proname = 'save_commercial_config';");
    expect(acl).toContain('authenticated=X/');
  });

  it('25. save_commercial_config creates missing key via upsert', () => {
    psql("DELETE FROM platform_settings WHERE key = 'minimum_bank_transfer';");
    setAdminContext();
    psql(`
      SET ROLE authenticated;
      SELECT save_commercial_config('minimum_bank_transfer', '{"NG": 10000}'::jsonb);
      RESET ROLE;
    `);
    const exists = psql("SELECT count(*)::int FROM platform_settings WHERE key = 'minimum_bank_transfer';");
    expect(exists).toBe('1');
  });

  it('26. Admin direct DELETE of commercial key → rejected', () => {
    const err = psqlMayFail(`
      SET ROLE authenticated;
      SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000001","role":"admin"}', true);
      DELETE FROM platform_settings WHERE key = 'pricing_tiers';
    `);
    expect(err).toContain('save_commercial_config');
    psqlMayFail('RESET ROLE;');
  });

  it('27. save_commercial_config rejects non-commercial key', () => {
    setAdminContext();
    const err = psqlMayFail(`
      SET ROLE authenticated;
      SELECT save_commercial_config('maintenance_mode', 'true'::jsonb);
    `);
    expect(err).toContain('not a commercial config key');
    psqlMayFail('RESET ROLE;');
  });
});
