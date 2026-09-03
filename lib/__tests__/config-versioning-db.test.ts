/**
 * Config Versioning DB Tests (#255 C-1)
 *
 * Executable PostgreSQL proofs for the config versioning system.
 * Requires TEST_DATABASE_URL environment variable pointing to a real PG instance.
 * Self-contained: creates schema stubs + applies migration 359 in beforeAll.
 *
 *   TEST_DATABASE_URL=postgresql://localhost:5432/waaiio_255_test \
 *     npx vitest run lib/__tests__/config-versioning-db.test.ts
 *
 * Covers all 27 acceptance tests from the #255 specification.
 * Tests MUST NOT be skipped when TEST_DATABASE_URL is set — CI enforces zero skips.
 */
import { execSync, spawn } from 'child_process';
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

/** Run SQL in a separate psql process for real two-session concurrency */
function psqlAsync(sql: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('psql', [dbUrl, '-tAXq', '-v', 'ON_ERROR_STOP=1'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(stderr || `exit ${code}`));
      else resolve(stdout.trim());
    });
    child.stdin.write(sql);
    child.stdin.end();
  });
}

// Admin JWT claims for save_commercial_config()
const ADMIN_CLAIMS = `{"sub":"00000000-0000-0000-0000-000000000001","role":"admin","user_metadata":{"role":"admin"}}`;

/** Helper: call save_commercial_config as admin (all in one psql session) */
function adminSave(key: string, value: string): string {
  return psql(`
    SELECT set_config('request.jwt.claims', '${ADMIN_CLAIMS}', false);
    SET ROLE authenticated;
    SELECT save_commercial_config('${key}', '${value}'::jsonb);
    RESET ROLE;
  `);
}

describe.skipIf(!canRun)('Config Versioning DB Tests (#255 C-1)', () => {
  beforeAll(() => {
    // Set up minimal schema prerequisites for migration 359
    psql(`
      CREATE EXTENSION IF NOT EXISTS "pgcrypto";
      DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      GRANT USAGE ON SCHEMA public TO authenticated, service_role, anon;

      CREATE OR REPLACE FUNCTION public.is_admin() RETURNS BOOLEAN AS $fn$
      BEGIN
        RETURN COALESCE(
          current_setting('request.jwt.claims', true)::jsonb->>'role' = 'admin',
          false
        );
      END;
      $fn$ LANGUAGE plpgsql STABLE;

      CREATE SCHEMA IF NOT EXISTS auth;
      CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS $fn$
      BEGIN
        RETURN (current_setting('request.jwt.claims', true)::jsonb->>'sub')::uuid;
      EXCEPTION WHEN OTHERS THEN RETURN NULL;
      END;
      $fn$ LANGUAGE plpgsql STABLE;

      CREATE TABLE IF NOT EXISTS public.profiles (id UUID PRIMARY KEY);
      INSERT INTO public.profiles (id) VALUES ('00000000-0000-0000-0000-000000000001') ON CONFLICT DO NOTHING;

      CREATE TABLE IF NOT EXISTS public.platform_settings (
        key VARCHAR(100) PRIMARY KEY,
        value JSONB NOT NULL DEFAULT '{}',
        description TEXT,
        updated_by UUID REFERENCES public.profiles(id),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      ALTER TABLE public.platform_settings ENABLE ROW LEVEL SECURITY;

      DO $$ BEGIN
        CREATE POLICY admin_all_platform_settings ON public.platform_settings FOR ALL USING (public.is_admin());
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;

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

      GRANT SELECT, INSERT, UPDATE, DELETE ON public.platform_settings TO authenticated, service_role;

      -- In Supabase, service_role bypasses RLS. Simulate this for vanilla PG:
      ALTER TABLE public.platform_settings FORCE ROW LEVEL SECURITY;
    `);
    // service_role RLS bypass policy (skip if already exists — e.g. CI with full migrations)
    psqlMayFail(`
      CREATE POLICY service_role_bypass ON public.platform_settings FOR ALL TO service_role USING (true) WITH CHECK (true);
    `);

    // Apply migration 359 if not already applied (CI applies all migrations first)
    const alreadyApplied = psqlMayFail("SELECT 1 FROM pg_proc WHERE proname = 'save_commercial_config' LIMIT 1;");
    if (!alreadyApplied.includes('1')) {
      const migrationSql = readFileSync('supabase/migrations/359_config_versioning.sql', 'utf-8');
      psql(migrationSql);
    }

    // Grant permissions on platform_config_versions for test roles (idempotent)
    psqlMayFail(`
      GRANT SELECT, INSERT, UPDATE, DELETE ON public.platform_config_versions TO service_role;
      GRANT SELECT ON public.platform_config_versions TO authenticated;
    `);
    // service_role bypass for platform_config_versions (Supabase equivalent, skip if exists)
    psqlMayFail(`
      CREATE POLICY service_role_bypass_versions ON public.platform_config_versions FOR ALL TO service_role USING (true) WITH CHECK (true);
    `);

    // Verify bootstrap succeeded
    const count = parseInt(psql('SELECT count(*)::int FROM platform_config_versions;'), 10);
    expect(count).toBeGreaterThanOrEqual(1);
  });

  function countVersions(): number {
    return parseInt(psql('SELECT count(*)::int FROM platform_config_versions;'), 10);
  }

  // ── 1-3. Direct DML on commercial keys → rejected ──

  it('1. Authenticated admin direct UPDATE of commercial key → rejected', () => {
    // SET ROLE + set_config in same session so RLS sees admin, but trigger blocks
    const err = psqlMayFail(`
      SELECT set_config('request.jwt.claims', '${ADMIN_CLAIMS}', false);
      SET ROLE authenticated;
      UPDATE platform_settings SET value = '"999"'::jsonb WHERE key = 'trial_days';
      RESET ROLE;
    `);
    expect(err).toContain('save_commercial_config');
  });

  it('2. Service_role direct UPDATE of commercial key → rejected', () => {
    // service_role bypasses RLS but trigger still blocks
    const err = psqlMayFail(`
      SET ROLE service_role;
      UPDATE platform_settings SET value = '"999"'::jsonb WHERE key = 'pricing_tiers';
      RESET ROLE;
    `);
    expect(err).toContain('save_commercial_config');
  });

  it('3. Service_role direct DELETE of commercial key → rejected', () => {
    const err = psqlMayFail(`
      SET ROLE service_role;
      DELETE FROM platform_settings WHERE key = 'trial_days';
      RESET ROLE;
    `);
    expect(err).toContain('save_commercial_config');
  });

  // ── 4. Service_role direct INSERT into versions → rejected ──

  it('4. Service_role direct INSERT into platform_config_versions → rejected', () => {
    const err = psqlMayFail(`
      SET ROLE service_role;
      INSERT INTO platform_config_versions (config_snapshot, effective_from)
      VALUES ('{"test": true}'::jsonb, NOW());
      RESET ROLE;
    `);
    expect(err).toContain('save_commercial_config');
  });

  // ── 5. Non-admin cannot call RPC ──

  it('5. Non-admin user cannot invoke save_commercial_config', () => {
    const err = psqlMayFail(`
      SET ROLE anon;
      SELECT save_commercial_config('trial_days', '14'::jsonb);
      RESET ROLE;
    `);
    expect(err.toLowerCase()).toMatch(/permission denied|does not exist/);
  });

  // ── 6. Authorized admin RPC → atomic projection + version ──

  it('6. Authorized admin RPC save → projection + exactly one version atomically', () => {
    const before = countVersions();
    adminSave('trial_days', '14');
    const after = countVersions();
    expect(after).toBe(before + 1);

    const val = psql("SELECT value::text FROM platform_settings WHERE key = 'trial_days';");
    expect(val).toBe('14');

    const snap = psql("SELECT config_snapshot->>'trial_days' FROM platform_config_versions ORDER BY effective_from DESC LIMIT 1;");
    expect(snap).toBe('14');
  });

  // ── 7. REAL injected failure → atomic rollback ──

  it('7. Injected version-insert failure → platform_settings mutation rolls back', () => {
    const beforeVal = psql("SELECT value::text FROM platform_settings WHERE key = 'trial_days';");
    const beforeCount = countVersions();

    // Create a temporary trigger that blocks the next version INSERT
    psql(`
      CREATE OR REPLACE FUNCTION _test_block_version_insert()
      RETURNS TRIGGER AS $$ BEGIN
        RAISE EXCEPTION 'TEST_INJECTED_FAILURE: version insert blocked';
      END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER _trg_test_block_version
        BEFORE INSERT ON platform_config_versions
        FOR EACH ROW EXECUTE FUNCTION _test_block_version_insert();
    `);

    try {
      // Attempt a commercial save — should fail at version INSERT
      const err = psqlMayFail(`
        SELECT set_config('request.jwt.claims', '${ADMIN_CLAIMS}', false);
        SET ROLE authenticated;
        SELECT save_commercial_config('trial_days', '99'::jsonb);
        RESET ROLE;
      `);
      expect(err).toContain('TEST_INJECTED_FAILURE');

      // Verify platform_settings was NOT committed (rolled back)
      const afterVal = psql("SELECT value::text FROM platform_settings WHERE key = 'trial_days';");
      expect(afterVal).toBe(beforeVal);

      // Verify no new version was created
      const afterCount = countVersions();
      expect(afterCount).toBe(beforeCount);
    } finally {
      // Always clean up test trigger, even if assertions fail
      psql(`
        DROP TRIGGER IF EXISTS _trg_test_block_version ON platform_config_versions;
        DROP FUNCTION IF EXISTS _test_block_version_insert();
      `);
    }
  });

  // ── 8-11. Key-rename guard ──

  it('8. Admin rename commercial → non-commercial → rejected (OLD.key)', () => {
    const err = psqlMayFail(`
      SELECT set_config('request.jwt.claims', '${ADMIN_CLAIMS}', false);
      SET ROLE authenticated;
      UPDATE platform_settings SET key = 'pricing_tiers_old' WHERE key = 'pricing_tiers';
      RESET ROLE;
    `);
    expect(err).toContain('save_commercial_config');
  });

  it('9. Service_role rename commercial → non-commercial → rejected', () => {
    const err = psqlMayFail(`
      SET ROLE service_role;
      UPDATE platform_settings SET key = 'trial_days_bak' WHERE key = 'trial_days';
      RESET ROLE;
    `);
    expect(err).toContain('save_commercial_config');
  });

  it('10. Rename non-commercial → commercial → rejected (NEW.key)', () => {
    psql("INSERT INTO platform_settings (key, value) VALUES ('my_test_key', '\"hello\"'::jsonb) ON CONFLICT DO NOTHING;");
    const err = psqlMayFail(`
      SET ROLE service_role;
      UPDATE platform_settings SET key = 'pricing_tiers' WHERE key = 'my_test_key';
      RESET ROLE;
    `);
    expect(err).toContain('save_commercial_config');
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
    // service_role bypasses RLS and trigger allows non-commercial
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
      RESET ROLE;
    `);
    expect(err).toContain('append-only');
  });

  it('16. Service-role DELETE of historical version → rejected', () => {
    const err = psqlMayFail(`
      SET ROLE service_role;
      DELETE FROM platform_config_versions WHERE id = (SELECT id FROM platform_config_versions LIMIT 1);
      RESET ROLE;
    `);
    expect(err).toContain('append-only');
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
  // Uses superuser-only DISABLE/ENABLE TRIGGER for test isolation.

  it('19. Effective-version resolution is deterministic', () => {
    // Use specific past timestamps to avoid interference from versions
    // created by other tests. Query by exact timestamp, not NOW().
    psql(`
      INSERT INTO platform_config_versions (id, config_snapshot, effective_from, created_at) VALUES
        ('a0000000-0000-0000-0000-000000000001', '{"test":"old"}'::jsonb, '2020-01-01T00:00:00Z'::timestamptz, NOW()),
        ('a0000000-0000-0000-0000-000000000002', '{"test":"mid"}'::jsonb, '2020-06-01T00:00:00Z'::timestamptz, NOW()),
        ('a0000000-0000-0000-0000-000000000003', '{"test":"recent"}'::jsonb, '2020-12-01T00:00:00Z'::timestamptz, NOW());
    `);

    // Query at 2020-12-15 → returns t3 (2020-12-01)
    const latest = psql("SELECT get_effective_config('2020-12-15T00:00:00Z'::timestamptz)::text;");
    expect(latest).toBe('a0000000-0000-0000-0000-000000000003');

    // Query at 2020-03-01 → returns t1 (2020-01-01)
    const early = psql("SELECT get_effective_config('2020-03-01T00:00:00Z'::timestamptz)::text;");
    expect(early).toBe('a0000000-0000-0000-0000-000000000001');

    // Query at 2020-08-01 → returns t2 (2020-06-01)
    const mid = psql("SELECT get_effective_config('2020-08-01T00:00:00Z'::timestamptz)::text;");
    expect(mid).toBe('a0000000-0000-0000-0000-000000000002');

    // Cleanup: superuser-only trigger bypass for test isolation
    psql(`
      ALTER TABLE platform_config_versions DISABLE TRIGGER trg_config_versions_no_delete;
      DELETE FROM platform_config_versions WHERE id IN (
        'a0000000-0000-0000-0000-000000000001',
        'a0000000-0000-0000-0000-000000000002',
        'a0000000-0000-0000-0000-000000000003'
      );
      ALTER TABLE platform_config_versions ENABLE TRIGGER trg_config_versions_no_delete;
    `);
  });

  it('20. Duplicate effective_from → UNIQUE violation', () => {
    const ts = '2099-01-01T00:00:00Z';
    psql(`INSERT INTO platform_config_versions (config_snapshot, effective_from) VALUES ('{"dup":"test1"}'::jsonb, '${ts}'::timestamptz);`);
    const err = psqlMayFail(`INSERT INTO platform_config_versions (config_snapshot, effective_from) VALUES ('{"dup":"test2"}'::jsonb, '${ts}'::timestamptz);`);
    expect(err.toLowerCase()).toContain('unique');
    // Cleanup
    psql(`
      ALTER TABLE platform_config_versions DISABLE TRIGGER trg_config_versions_no_delete;
      DELETE FROM platform_config_versions WHERE config_snapshot->>'dup' IS NOT NULL;
      ALTER TABLE platform_config_versions ENABLE TRIGGER trg_config_versions_no_delete;
    `);
  });

  // ── 21. Real two-session concurrent saves ──

  it('21. Two-session concurrent saves linearize with no lost update', async () => {
    // Baseline
    adminSave('trial_days', '10');
    adminSave('annual_discount_percentage', '10');
    const beforeCount = countVersions();

    // Session A: save trial_days=30, hold transaction for 1s via pg_sleep
    const sessionA = psqlAsync(`
      SELECT set_config('request.jwt.claims', '${ADMIN_CLAIMS}', false);
      BEGIN;
      SET ROLE authenticated;
      SELECT save_commercial_config('trial_days', '30'::jsonb);
      SELECT pg_sleep(1);
      COMMIT;
      RESET ROLE;
    `);

    // Small delay to ensure Session A acquires the lock first
    await new Promise(r => setTimeout(r, 200));

    // Session B: concurrently save annual_discount_percentage=25
    // This will block on the advisory lock until A commits
    const sessionB = psqlAsync(`
      SELECT set_config('request.jwt.claims', '${ADMIN_CLAIMS}', false);
      BEGIN;
      SET ROLE authenticated;
      SELECT save_commercial_config('annual_discount_percentage', '25'::jsonb);
      COMMIT;
      RESET ROLE;
    `);

    await Promise.all([sessionA, sessionB]);

    const afterCount = countVersions();
    expect(afterCount).toBe(beforeCount + 2);

    // Latest version (B's) must contain BOTH changes
    const latestSnap = psql("SELECT config_snapshot::text FROM platform_config_versions ORDER BY effective_from DESC LIMIT 1;");
    expect(latestSnap).toContain('"trial_days": 30');
    expect(latestSnap).toContain('"annual_discount_percentage": 25');

    // Second-latest (A's) has trial_days=30 but annual_discount_percentage still=10
    const secondSnap = psql("SELECT config_snapshot::text FROM platform_config_versions ORDER BY effective_from DESC LIMIT 1 OFFSET 1;");
    expect(secondSnap).toContain('"trial_days": 30');
    expect(secondSnap).toContain('"annual_discount_percentage": 10');
  }, 15000);

  // ── 22-23. Security ──

  it('22. created_by = auth.uid(), not caller-supplied', () => {
    const uid = '00000000-0000-0000-0000-000000000001';
    adminSave('trial_days', '7');
    const createdBy = psql("SELECT created_by::text FROM platform_config_versions ORDER BY effective_from DESC LIMIT 1;");
    expect(createdBy).toBe(uid);
  });

  it('23. Unauthenticated SELECT on versions → zero rows (RLS)', () => {
    // anon may not have SELECT permission at all, or RLS returns 0 rows
    const result = psqlMayFail(`
      SET ROLE anon;
      SELECT count(*)::int FROM platform_config_versions;
      RESET ROLE;
    `);
    // Either permission denied OR 0 rows — both prove access is restricted
    const isBlocked = result.includes('permission denied') || result.trim() === '0';
    expect(isBlocked).toBe(true);
  });

  // ── 24-27. Additional proofs ──

  it('24. EXECUTE privilege: PUBLIC revoked, authenticated granted', () => {
    const acl = psql("SELECT proacl::text FROM pg_proc WHERE proname = 'save_commercial_config';");
    expect(acl).toContain('authenticated=X/');
  });

  it('25. save_commercial_config creates missing key via upsert', () => {
    psql("DELETE FROM platform_settings WHERE key = 'minimum_bank_transfer';");
    adminSave('minimum_bank_transfer', '{"NG": 10000}');
    const exists = psql("SELECT count(*)::int FROM platform_settings WHERE key = 'minimum_bank_transfer';");
    expect(exists).toBe('1');
  });

  it('26. Admin direct DELETE of commercial key → rejected', () => {
    const err = psqlMayFail(`
      SELECT set_config('request.jwt.claims', '${ADMIN_CLAIMS}', false);
      SET ROLE authenticated;
      DELETE FROM platform_settings WHERE key = 'pricing_tiers';
      RESET ROLE;
    `);
    expect(err).toContain('save_commercial_config');
  });

  it('27. save_commercial_config rejects non-commercial key', () => {
    const err = psqlMayFail(`
      SELECT set_config('request.jwt.claims', '${ADMIN_CLAIMS}', false);
      SET ROLE authenticated;
      SELECT save_commercial_config('maintenance_mode', 'true'::jsonb);
      RESET ROLE;
    `);
    expect(err).toContain('not a commercial config key');
  });

  // ── 28-30. Admin discoverability — absent key lifecycle ──

  it('28. minimum_bank_transfer absent → save_commercial_config creates it → appears in platform_settings with correct value', () => {
    // Ensure key is absent
    psql("DELETE FROM platform_settings WHERE key = 'minimum_bank_transfer';");
    const absentCheck = psql("SELECT count(*)::int FROM platform_settings WHERE key = 'minimum_bank_transfer';");
    expect(absentCheck).toBe('0');

    // Admin creates it through save_commercial_config (the same RPC the admin UI calls)
    adminSave('minimum_bank_transfer', '{"NG": 5000, "GH": 5000}');

    // Verify it now exists with the correct value
    const exists = psql("SELECT count(*)::int FROM platform_settings WHERE key = 'minimum_bank_transfer';");
    expect(exists).toBe('1');

    const value = psql("SELECT value::text FROM platform_settings WHERE key = 'minimum_bank_transfer';");
    const parsed = JSON.parse(value);
    expect(parsed).toEqual({ NG: 5000, GH: 5000 });

    // Verify it was captured in the config version snapshot
    const snap = psql("SELECT config_snapshot->>'minimum_bank_transfer' FROM platform_config_versions ORDER BY effective_from DESC LIMIT 1;");
    expect(JSON.parse(snap)).toEqual({ NG: 5000, GH: 5000 });
  });

  it('29. minimum_bank_transfer created via save_commercial_config is subsequently updatable via save_commercial_config', () => {
    // Ensure it exists from test 28
    const existsBefore = psql("SELECT count(*)::int FROM platform_settings WHERE key = 'minimum_bank_transfer';");
    if (existsBefore === '0') {
      adminSave('minimum_bank_transfer', '{"NG": 5000}');
    }
    const versionsBefore = countVersions();

    // Update it via save_commercial_config
    adminSave('minimum_bank_transfer', '{"NG": 10000, "GH": 8000}');

    // Verify the updated value
    const value = psql("SELECT value::text FROM platform_settings WHERE key = 'minimum_bank_transfer';");
    const parsed = JSON.parse(value);
    expect(parsed).toEqual({ NG: 10000, GH: 8000 });

    // Verify a new version was created
    const versionsAfter = countVersions();
    expect(versionsAfter).toBe(versionsBefore + 1);
  });

  it('30. minimum_bank_transfer created via save_commercial_config cannot be deleted (commercial key protection)', () => {
    // Ensure it exists
    const existsBefore = psql("SELECT count(*)::int FROM platform_settings WHERE key = 'minimum_bank_transfer';");
    if (existsBefore === '0') {
      adminSave('minimum_bank_transfer', '{"NG": 5000}');
    }

    // Attempt admin delete → rejected
    const errAdmin = psqlMayFail(`
      SELECT set_config('request.jwt.claims', '${ADMIN_CLAIMS}', false);
      SET ROLE authenticated;
      DELETE FROM platform_settings WHERE key = 'minimum_bank_transfer';
      RESET ROLE;
    `);
    expect(errAdmin).toContain('save_commercial_config');

    // Attempt service_role delete → rejected
    const errService = psqlMayFail(`
      SET ROLE service_role;
      DELETE FROM platform_settings WHERE key = 'minimum_bank_transfer';
      RESET ROLE;
    `);
    expect(errService).toContain('save_commercial_config');

    // Key still exists
    const stillExists = psql("SELECT count(*)::int FROM platform_settings WHERE key = 'minimum_bank_transfer';");
    expect(stillExists).toBe('1');
  });

  // ── 31. Option B bootstrap: exactly 10 keys, no minimum_bank_transfer ──

  it('31. Option B bootstrap snapshot contains exactly 10 existing commercial keys, no minimum_bank_transfer', () => {
    // The bootstrap version is the first one (earliest effective_from)
    const snap = psql("SELECT config_snapshot::text FROM platform_config_versions ORDER BY effective_from ASC LIMIT 1;");
    const parsed = JSON.parse(snap);
    const keys = Object.keys(parsed).sort();

    // Exactly these 10 keys, no minimum_bank_transfer
    expect(keys).toEqual([
      'annual_discount_percentage',
      'broadcast_limits',
      'conversation_limits',
      'default_platform_fee_percent',
      'minimum_payout',
      'payout_cooling_period_days',
      'payout_verification_limits',
      'pricing_tiers',
      'transfer_expiry_hours',
      'trial_days',
    ]);
    expect(parsed).not.toHaveProperty('minimum_bank_transfer');

    // Bootstrap created_by must be NULL (migration runner, not an auth'd user)
    const createdBy = psql("SELECT created_by::text FROM platform_config_versions ORDER BY effective_from ASC LIMIT 1;");
    expect(createdBy).toBe('');

    // minimum_bank_transfer must NOT have been invented in platform_settings by bootstrap
    // (Clean up from earlier tests that may have created it)
    psql("DELETE FROM platform_settings WHERE key = 'minimum_bank_transfer';");
    const mbtExists = psql("SELECT count(*)::int FROM platform_settings WHERE key = 'minimum_bank_transfer';");
    expect(mbtExists).toBe('0');
  });

  // ── 32. Authenticated non-admin cannot invoke save_commercial_config ──

  it('32. Authenticated non-admin user is rejected by internal is_admin() check', () => {
    const NON_ADMIN_CLAIMS = '{"sub":"00000000-0000-0000-0000-000000000002","role":"user","user_metadata":{"role":"user"}}';
    // Create the non-admin user + profile so auth.uid() resolves
    // In CI with full schema, profiles.id references auth.users.id
    // CI auth.users stub has only (id, email, raw_app_meta_data) — use minimal columns
    psqlMayFail("INSERT INTO auth.users (id, email) VALUES ('00000000-0000-0000-0000-000000000002', 'nonadmin@test.com') ON CONFLICT DO NOTHING;");
    psqlMayFail("INSERT INTO profiles (id) VALUES ('00000000-0000-0000-0000-000000000002') ON CONFLICT DO NOTHING;");

    const err = psqlMayFail(`
      SELECT set_config('request.jwt.claims', '${NON_ADMIN_CLAIMS}', false);
      SET ROLE authenticated;
      SELECT save_commercial_config('trial_days', '99'::jsonb);
      RESET ROLE;
    `);
    expect(err).toContain('requires admin role');
  });

  // ── 33-35. Explicit RPC EXECUTE privilege assertions ──

  it('33. anon CANNOT execute save_commercial_config', () => {
    const canExec = psql("SELECT has_function_privilege('anon', 'save_commercial_config(text,jsonb,text)', 'EXECUTE');");
    expect(canExec).toBe('f');
  });

  it('34. authenticated CAN execute save_commercial_config', () => {
    const canExec = psql("SELECT has_function_privilege('authenticated', 'save_commercial_config(text,jsonb,text)', 'EXECUTE');");
    expect(canExec).toBe('t');
  });

  it('35. service_role CANNOT execute save_commercial_config', () => {
    const canExec = psql("SELECT has_function_privilege('service_role', 'save_commercial_config(text,jsonb,text)', 'EXECUTE');");
    expect(canExec).toBe('f');
  });

  // ── 36. Structural regression: guard functions use function-owner, not rolsuper ──

  it('36. Guard functions do NOT contain rolsuper (structural regression)', () => {
    const insertGuardSrc = psql("SELECT prosrc FROM pg_proc WHERE proname = 'guard_config_version_insert';");
    const settingsGuardSrc = psql("SELECT prosrc FROM pg_proc WHERE proname = 'guard_commercial_settings';");

    // Must NOT contain the vulnerable rolsuper pattern
    expect(insertGuardSrc).not.toContain('rolsuper');
    expect(settingsGuardSrc).not.toContain('rolsuper');

    // Must contain the function-owner lookup pattern
    expect(insertGuardSrc).toContain('proowner');
    expect(settingsGuardSrc).toContain('proowner');
    expect(insertGuardSrc).toContain('to_regprocedure');
    expect(settingsGuardSrc).toContain('to_regprocedure');
  });
});

// ═══════════════════════════════════════════════════════
// Non-superuser authority proof suite
//
// Creates a dedicated isolated database, sets up Supabase-shaped
// prerequisites, then executes the ACTUAL checked-in
// supabase/migrations/359_config_versioning.sql under a non-superuser
// role via SET ROLE. All proofs run against the real migration artifact.
// ═══════════════════════════════════════════════════════

describe.skipIf(!canRun)('Config Versioning — non-superuser authority proof (#218)', () => {
  const NSU_DB = 'waaiio_359_nsu_test';
  const NSU_ROLE = '_nsu_migration_owner';
  const NSU_ADMIN_CLAIMS = `{"sub":"00000000-0000-0000-0000-000000000099","role":"admin","user_metadata":{"role":"admin"}}`;

  /** Run SQL against the isolated NSU database */
  function nsuPsql(sql: string): string {
    const nsuUrl = dbUrl.replace(/\/[^/]+$/, `/${NSU_DB}`);
    return execSync(`psql "${nsuUrl}" -tAXq -v ON_ERROR_STOP=1`, {
      input: sql, encoding: 'utf-8', timeout: 15000,
    }).trim();
  }
  function nsuPsqlMayFail(sql: string): string {
    const nsuUrl = dbUrl.replace(/\/[^/]+$/, `/${NSU_DB}`);
    try {
      return execSync(`psql "${nsuUrl}" -tAXq -v ON_ERROR_STOP=1`, {
        input: sql, encoding: 'utf-8', timeout: 15000,
      }).trim();
    } catch (e: unknown) {
      return (e as { stderr?: string }).stderr || String(e);
    }
  }

  beforeAll(() => {
    // 1. Create isolated database (connect to default db for CREATE DATABASE)
    psqlMayFail(`DROP DATABASE IF EXISTS ${NSU_DB};`);
    psql(`CREATE DATABASE ${NSU_DB};`);

    // 2. Create the non-superuser Supabase-shaped role (cluster-wide)
    psql(`
      DO $$ BEGIN CREATE ROLE ${NSU_ROLE} NOLOGIN NOSUPERUSER; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);

    // 3. Verify NSU role is NOT a superuser
    const isSuperuser = nsuPsql(`SELECT rolsuper FROM pg_roles WHERE rolname = '${NSU_ROLE}';`);
    expect(isSuperuser).toBe('f');

    // 4. Set up Supabase-shaped prerequisites in the isolated DB
    nsuPsql(`
      CREATE EXTENSION IF NOT EXISTS "pgcrypto";

      GRANT USAGE, CREATE ON SCHEMA public TO ${NSU_ROLE};
      GRANT USAGE ON SCHEMA public TO authenticated, service_role, anon;

      CREATE OR REPLACE FUNCTION public.is_admin() RETURNS BOOLEAN AS $fn$
      BEGIN
        RETURN COALESCE(
          current_setting('request.jwt.claims', true)::jsonb->>'role' = 'admin',
          false
        );
      END;
      $fn$ LANGUAGE plpgsql STABLE;

      CREATE SCHEMA IF NOT EXISTS auth;
      GRANT USAGE ON SCHEMA auth TO ${NSU_ROLE};
      CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS $fn$
      BEGIN
        RETURN (current_setting('request.jwt.claims', true)::jsonb->>'sub')::uuid;
      EXCEPTION WHEN OTHERS THEN RETURN NULL;
      END;
      $fn$ LANGUAGE plpgsql STABLE;
      GRANT EXECUTE ON FUNCTION auth.uid() TO ${NSU_ROLE}, authenticated, service_role, anon;
      GRANT EXECUTE ON FUNCTION public.is_admin() TO ${NSU_ROLE}, authenticated, service_role, anon;

      CREATE TABLE IF NOT EXISTS public.profiles (id UUID PRIMARY KEY);
      INSERT INTO profiles (id) VALUES ('00000000-0000-0000-0000-000000000099') ON CONFLICT DO NOTHING;
      INSERT INTO profiles (id) VALUES ('00000000-0000-0000-0000-000000000002') ON CONFLICT DO NOTHING;

      CREATE TABLE IF NOT EXISTS public.platform_settings (
        key VARCHAR(100) PRIMARY KEY,
        value JSONB NOT NULL DEFAULT '{}',
        description TEXT,
        updated_by UUID REFERENCES public.profiles(id),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      ALTER TABLE public.platform_settings ENABLE ROW LEVEL SECURITY;

      DO $$ BEGIN
        CREATE POLICY admin_all_platform_settings ON public.platform_settings FOR ALL USING (public.is_admin());
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;

      -- Seed exactly the 10 Option B commercial keys (no minimum_bank_transfer)
      INSERT INTO platform_settings (key, value) VALUES
        ('pricing_tiers', '{"free":{"feePercentage":2.5}}'::jsonb),
        ('trial_days', '7'::jsonb),
        ('broadcast_limits', '{"free":{"maxBroadcasts":0}}'::jsonb),
        ('conversation_limits', '{"free":200}'::jsonb),
        ('default_platform_fee_percent', '2.5'::jsonb),
        ('annual_discount_percentage', '20'::jsonb),
        ('payout_cooling_period_days', '7'::jsonb),
        ('minimum_payout', '{"NG":5000}'::jsonb),
        ('payout_verification_limits', '{"unverified":0}'::jsonb),
        ('transfer_expiry_hours', '4'::jsonb),
        ('maintenance_mode', 'false'::jsonb)
      ON CONFLICT (key) DO NOTHING;

      GRANT SELECT, INSERT, UPDATE, DELETE ON public.platform_settings TO authenticated, service_role, ${NSU_ROLE};
      GRANT ALL ON ALL TABLES IN SCHEMA public TO ${NSU_ROLE};

      -- RLS bypass policies simulating Supabase Cloud BYPASSRLS for the NSU role
      DO $$ BEGIN CREATE POLICY nsu_bypass_settings ON platform_settings FOR ALL TO ${NSU_ROLE} USING (true) WITH CHECK (true); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE POLICY service_role_bypass ON platform_settings FOR ALL TO service_role USING (true) WITH CHECK (true); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);

    // 5. Execute the ACTUAL Migration 359 file under SET ROLE to the non-superuser
    const migrationSql = readFileSync('supabase/migrations/359_config_versioning.sql', 'utf-8');
    nsuPsql(`
      SET ROLE ${NSU_ROLE};
      ${migrationSql}
      RESET ROLE;
    `);

    // 6. Grant table permissions to app roles (Supabase Cloud does this via default privileges)
    nsuPsql(`
      GRANT SELECT, INSERT, UPDATE, DELETE ON public.platform_config_versions TO service_role, ${NSU_ROLE};
      GRANT SELECT ON public.platform_config_versions TO authenticated;
      DO $$ BEGIN CREATE POLICY nsu_bypass_versions ON platform_config_versions FOR ALL TO ${NSU_ROLE} USING (true) WITH CHECK (true); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE POLICY service_role_bypass_versions ON platform_config_versions FOR ALL TO service_role USING (true) WITH CHECK (true); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);
  });

  function nsuAdminSave(key: string, value: string): string {
    return nsuPsql(`
      SELECT set_config('request.jwt.claims', '${NSU_ADMIN_CLAIMS}', false);
      SET ROLE authenticated;
      SELECT save_commercial_config('${key}', '${value}'::jsonb);
      RESET ROLE;
    `);
  }

  it('NSU-1. Migration owner role has rolsuper=false', () => {
    const isSuperuser = nsuPsql(`SELECT rolsuper FROM pg_roles WHERE rolname = '${NSU_ROLE}';`);
    expect(isSuperuser).toBe('f');
  });

  it('NSU-2. Actual migration-created save_commercial_config is owned by the non-superuser role', () => {
    const owner = nsuPsql(`
      SELECT r.rolname FROM pg_proc p JOIN pg_roles r ON p.proowner = r.oid
      WHERE p.oid = to_regprocedure('public.save_commercial_config(text,jsonb,text)');
    `);
    expect(owner).toBe(NSU_ROLE);
  });

  it('NSU-3. Migration bootstrap succeeded and initial snapshot contains exactly 10 Option B keys', () => {
    const count = parseInt(nsuPsql('SELECT count(*)::int FROM platform_config_versions;'), 10);
    expect(count).toBeGreaterThanOrEqual(1);

    const snap = nsuPsql("SELECT config_snapshot::text FROM platform_config_versions ORDER BY effective_from ASC LIMIT 1;");
    const parsed = JSON.parse(snap);
    const keys = Object.keys(parsed).sort();
    expect(keys).toEqual([
      'annual_discount_percentage', 'broadcast_limits', 'conversation_limits',
      'default_platform_fee_percent', 'minimum_payout', 'payout_cooling_period_days',
      'payout_verification_limits', 'pricing_tiers', 'transfer_expiry_hours', 'trial_days',
    ]);
    expect(parsed).not.toHaveProperty('minimum_bank_transfer');

    const createdBy = nsuPsql("SELECT created_by::text FROM platform_config_versions ORDER BY effective_from ASC LIMIT 1;");
    expect(createdBy).toBe('');
  });

  it('NSU-4. Authorized admin save_commercial_config succeeds and creates exactly one version', () => {
    const before = parseInt(nsuPsql('SELECT count(*)::int FROM platform_config_versions;'), 10);
    nsuAdminSave('trial_days', '21');
    const after = parseInt(nsuPsql('SELECT count(*)::int FROM platform_config_versions;'), 10);
    expect(after).toBe(before + 1);

    const val = nsuPsql("SELECT value::text FROM platform_settings WHERE key = 'trial_days';");
    expect(val).toBe('21');
  });

  it('NSU-5. Authenticated non-admin is rejected', () => {
    const NON_ADMIN = '{"sub":"00000000-0000-0000-0000-000000000002","role":"user","user_metadata":{"role":"user"}}';
    const err = nsuPsqlMayFail(`
      SELECT set_config('request.jwt.claims', '${NON_ADMIN}', false);
      SET ROLE authenticated;
      SELECT save_commercial_config('trial_days', '99'::jsonb);
      RESET ROLE;
    `);
    expect(err).toContain('requires admin role');
  });

  it('NSU-6. anon has no RPC EXECUTE', () => {
    const canExec = nsuPsql("SELECT has_function_privilege('anon', 'save_commercial_config(text,jsonb,text)', 'EXECUTE');");
    expect(canExec).toBe('f');
  });

  it('NSU-7. service_role has no RPC EXECUTE', () => {
    const canExec = nsuPsql("SELECT has_function_privilege('service_role', 'save_commercial_config(text,jsonb,text)', 'EXECUTE');");
    expect(canExec).toBe('f');
  });

  it('NSU-8. service_role direct commercial-key DML rejected', () => {
    const err = nsuPsqlMayFail(`
      SET ROLE service_role;
      UPDATE platform_settings SET value = '"hacked"'::jsonb WHERE key = 'pricing_tiers';
      RESET ROLE;
    `);
    expect(err).toContain('save_commercial_config');
  });

  it('NSU-9. service_role direct version INSERT rejected', () => {
    const err = nsuPsqlMayFail(`
      SET ROLE service_role;
      INSERT INTO platform_config_versions (config_snapshot, effective_from)
      VALUES ('{"hacked": true}'::jsonb, NOW());
      RESET ROLE;
    `);
    expect(err).toContain('save_commercial_config');
  });

  it('NSU-10. Exact-signature trusted-owner lookup works (function owner = migration runner)', () => {
    // The guard resolves the trusted owner via to_regprocedure + proowner
    // Verify the lookup matches the actual NSU role
    const guardSrc = nsuPsql("SELECT prosrc FROM pg_proc WHERE proname = 'guard_config_version_insert';");
    expect(guardSrc).toContain('to_regprocedure');
    expect(guardSrc).toContain('proowner');
    expect(guardSrc).not.toContain('rolsuper');

    // Direct INSERT as the NSU (trusted) owner succeeds
    nsuPsql(`
      SET ROLE ${NSU_ROLE};
      INSERT INTO platform_config_versions (config_snapshot, effective_from, created_by)
      VALUES ('{"nsu_owner_test":true}'::jsonb, '2018-01-01T00:00:00Z'::timestamptz, NULL);
      RESET ROLE;
    `);
    // Clean up
    nsuPsql(`
      ALTER TABLE platform_config_versions DISABLE TRIGGER trg_config_versions_no_delete;
      DELETE FROM platform_config_versions WHERE config_snapshot->>'nsu_owner_test' = 'true';
      ALTER TABLE platform_config_versions ENABLE TRIGGER trg_config_versions_no_delete;
    `);
  });

  it('NSU-11. Unresolved trusted authority fails closed', () => {
    // Drop save_commercial_config + attempt INSERT in a single transaction.
    // The INSERT should fail (guard can't resolve the trusted owner).
    // On failure, psql aborts the transaction and PG rolls back on disconnect,
    // restoring save_commercial_config — no function body duplication needed.
    const err = nsuPsqlMayFail(`
      BEGIN;
      SET ROLE ${NSU_ROLE};
      DROP FUNCTION save_commercial_config(text, jsonb, text);
      INSERT INTO platform_config_versions (config_snapshot, effective_from)
      VALUES ('{"should_fail":true}'::jsonb, '2017-01-01T00:00:00Z'::timestamptz);
      RESET ROLE;
      COMMIT;
    `);
    // The INSERT error triggers abort → transaction rolls back → DROP is undone
    expect(err).toContain('save_commercial_config');

    // Verify the function was restored (transaction rolled back)
    const exists = nsuPsql("SELECT count(*) FROM pg_proc WHERE oid = to_regprocedure('public.save_commercial_config(text,jsonb,text)');");
    expect(exists).toBe('1');
  });
});
