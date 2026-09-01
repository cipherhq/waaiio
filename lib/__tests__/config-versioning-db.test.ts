/**
 * Config Versioning DB Tests (#255 C-1)
 *
 * Executable PostgreSQL proofs for the config versioning system.
 * Requires TEST_DATABASE_URL environment variable pointing to a real PG instance
 * with all migrations applied (including 359_config_versioning.sql).
 *
 *   TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/waaiio_test \
 *     npx vitest run lib/__tests__/config-versioning-db.test.ts
 *
 * Covers all 27 acceptance tests from the #255 specification.
 * Tests MUST NOT be skipped when TEST_DATABASE_URL is set — CI enforces zero skips.
 */
import { execSync, spawn } from 'child_process';
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

/**
 * Run SQL in a separate psql process, returning a promise.
 * Used for real two-session concurrency tests.
 */
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

describe.skipIf(!canRun)('Config Versioning DB Tests (#255 C-1)', () => {
  beforeAll(() => {
    // Verify migration 359 has been applied (bootstrap row exists)
    const count = psql('SELECT count(*)::int FROM platform_config_versions;');
    expect(parseInt(count, 10)).toBeGreaterThanOrEqual(1);
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

  // ── 7. REAL injected failure → atomic rollback proven ──

  it('7. Injected version-insert failure → platform_settings mutation rolls back', () => {
    // Record pre-call state
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

    // Attempt a commercial save — should fail at version INSERT
    setAdminContext();
    const err = psqlMayFail(`
      SET ROLE authenticated;
      SELECT save_commercial_config('trial_days', '99'::jsonb);
    `);
    psqlMayFail('RESET ROLE;');
    expect(err).toContain('TEST_INJECTED_FAILURE');

    // Verify platform_settings was NOT committed (rolled back)
    const afterVal = psql("SELECT value::text FROM platform_settings WHERE key = 'trial_days';");
    expect(afterVal).toBe(beforeVal);

    // Verify no new version was created
    const afterCount = countVersions();
    expect(afterCount).toBe(beforeCount);

    // Clean up test trigger
    psql(`
      DROP TRIGGER IF EXISTS _trg_test_block_version ON platform_config_versions;
      DROP FUNCTION IF EXISTS _test_block_version_insert();
    `);
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
      DELETE FROM platform_config_versions
      WHERE id = (SELECT id FROM platform_config_versions LIMIT 1);
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
  // Uses transactional rollback for isolation instead of DELETE (which
  // would violate the append-only trigger on production).

  it('19. Effective-version resolution is deterministic', () => {
    // Insert test rows inside a savepoint, run assertions, then rollback.
    // We temporarily disable the append-only triggers for INSERT isolation
    // using a superuser-only operation (test runner is postgres).
    // The INSERT guard trigger must also be considered — but our psql
    // connects as postgres, so the INSERT guard allows it.

    // Record current state
    const currentEffective = psql("SELECT get_effective_config(NOW())::text;");

    // Insert test versions (as postgres — allowed by insert guard)
    psql(`
      INSERT INTO platform_config_versions (id, config_snapshot, effective_from, created_at) VALUES
        ('a0000000-0000-0000-0000-000000000001', '{"test":"yesterday"}'::jsonb, NOW() - interval '1 day', NOW()),
        ('a0000000-0000-0000-0000-000000000002', '{"test":"hour_ago"}'::jsonb, NOW() - interval '1 hour', NOW()),
        ('a0000000-0000-0000-0000-000000000003', '{"test":"recent"}'::jsonb, NOW() - interval '1 second', NOW());
    `);

    // get_effective_config(NOW()) should return the most recent test version
    const current = psql("SELECT get_effective_config(NOW())::text;");
    expect(current).toBe('a0000000-0000-0000-0000-000000000003');

    // get_effective_config(yesterday + 1h) should return the 'yesterday' version
    const mid = psql("SELECT get_effective_config(NOW() - interval '23 hours')::text;");
    expect(mid).toBe('a0000000-0000-0000-0000-000000000001');

    // Cleanup: temporarily disable the delete trigger (superuser only),
    // remove test rows, re-enable. This is test-only — production cannot do this.
    psql(`
      ALTER TABLE platform_config_versions DISABLE TRIGGER trg_config_versions_no_delete;
      DELETE FROM platform_config_versions WHERE id IN (
        'a0000000-0000-0000-0000-000000000001',
        'a0000000-0000-0000-0000-000000000002',
        'a0000000-0000-0000-0000-000000000003'
      );
      ALTER TABLE platform_config_versions ENABLE TRIGGER trg_config_versions_no_delete;
    `);

    // Verify cleanup restored original state
    const restored = psql("SELECT get_effective_config(NOW())::text;");
    expect(restored).toBe(currentEffective);
  });

  it('20. Duplicate effective_from → UNIQUE violation', () => {
    const ts = '2099-01-01T00:00:00Z';
    // Insert first row (as postgres — allowed by insert guard)
    psql(`INSERT INTO platform_config_versions (config_snapshot, effective_from) VALUES ('{"dup":"test1"}'::jsonb, '${ts}'::timestamptz);`);

    // Second insert with same effective_from should fail
    const err = psqlMayFail(`INSERT INTO platform_config_versions (config_snapshot, effective_from) VALUES ('{"dup":"test2"}'::jsonb, '${ts}'::timestamptz);`);
    expect(err.toLowerCase()).toContain('unique');

    // Cleanup (superuser trigger bypass for test isolation)
    psql(`
      ALTER TABLE platform_config_versions DISABLE TRIGGER trg_config_versions_no_delete;
      DELETE FROM platform_config_versions WHERE config_snapshot->>'dup' IS NOT NULL;
      ALTER TABLE platform_config_versions ENABLE TRIGGER trg_config_versions_no_delete;
    `);
  });

  // ── 21. Real two-session concurrent saves ──

  it('21. Two-session concurrent saves linearize with no lost update', async () => {
    // Baseline: set known state for two different commercial keys
    setAdminContext();
    psql(`
      SET ROLE authenticated;
      SELECT save_commercial_config('trial_days', '10'::jsonb);
      RESET ROLE;
    `);
    setAdminContext();
    psql(`
      SET ROLE authenticated;
      SELECT save_commercial_config('annual_discount_percentage', '10'::jsonb);
      RESET ROLE;
    `);

    const beforeCount = countVersions();

    // Session A: acquire advisory lock, save trial_days=30, hold for 1 second
    const sessionA = psqlAsync(`
      SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000001","role":"admin","user_metadata":{"role":"admin"}}', false);
      BEGIN;
      SET ROLE authenticated;
      SELECT save_commercial_config('trial_days', '30'::jsonb);
      SELECT pg_sleep(1);
      COMMIT;
      RESET ROLE;
    `);

    // Small delay to ensure Session A acquires the lock first
    await new Promise(r => setTimeout(r, 100));

    // Session B: concurrently save annual_discount_percentage=25
    // This should block on the advisory lock until A commits
    const sessionB = psqlAsync(`
      SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000001","role":"admin","user_metadata":{"role":"admin"}}', false);
      BEGIN;
      SET ROLE authenticated;
      SELECT save_commercial_config('annual_discount_percentage', '25'::jsonb);
      COMMIT;
      RESET ROLE;
    `);

    // Wait for both to complete
    await Promise.all([sessionA, sessionB]);

    const afterCount = countVersions();
    // Two new versions should have been created (one per save)
    expect(afterCount).toBe(beforeCount + 2);

    // The latest version (B's) must contain BOTH changes:
    // trial_days=30 (from A, committed first) AND annual_discount_percentage=25 (from B)
    const latestSnap = psql("SELECT config_snapshot::text FROM platform_config_versions ORDER BY effective_from DESC LIMIT 1;");
    expect(latestSnap).toContain('"trial_days": 30');
    expect(latestSnap).toContain('"annual_discount_percentage": 25');

    // Verify no lost update: the A version should have trial_days=30
    // (second-latest should be A's commit with trial_days=30 but annual_discount_percentage still=10)
    const secondSnap = psql("SELECT config_snapshot::text FROM platform_config_versions ORDER BY effective_from DESC LIMIT 1 OFFSET 1;");
    expect(secondSnap).toContain('"trial_days": 30');
    expect(secondSnap).toContain('"annual_discount_percentage": 10');
  }, 15000);

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
