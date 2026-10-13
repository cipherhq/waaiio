/**
 * 442: Server-managed business columns guard — Real PostgreSQL tests
 *
 * Runs against the ACTUAL Waaiio migrated schema (waaiio_test).
 * Requires TEST_DATABASE_URL.
 *
 * Tests:
 * - authenticated role cannot UPDATE server-managed columns
 * - authenticated role CAN update normal columns (name)
 * - service_role can UPDATE all columns
 * - anon gets no rows (RLS)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';

const dbUrl = process.env.TEST_DATABASE_URL || '';

function psql(sql: string): string {
  return execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1`, {
    input: sql, encoding: 'utf-8', timeout: 15000,
  }).trim();
}

// Require TEST_DATABASE_URL AND the businesses table (with our trigger) to exist.
// The P0 ACL job sets TEST_DATABASE_URL but only has a minimal schema.
let canRun = dbUrl.length > 0;
if (canRun) {
  try {
    const triggerExists = psql(`
      SELECT count(*) FROM pg_trigger t
      JOIN pg_class c ON t.tgrelid = c.oid
      JOIN pg_namespace n ON c.relnamespace = n.oid
      WHERE n.nspname = 'public' AND c.relname = 'businesses'
        AND t.tgname = 'trg_guard_server_managed_columns';
    `);
    if (triggerExists !== '1') canRun = false;
  } catch {
    canRun = false;
  }
}

function psqlNoFail(sql: string): { stdout: string; error: boolean } {
  try {
    const stdout = execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1`, {
      input: sql, encoding: 'utf-8', timeout: 15000,
    }).trim();
    return { stdout, error: false };
  } catch (e: unknown) {
    const err = e as { stderr?: string; stdout?: string };
    return { stdout: err.stderr || err.stdout || '', error: true };
  }
}

const USER_ID = '00000000-0000-4000-f442-000000000001';
const BIZ_ID = '00000000-0000-4000-a442-000000000001';

describe.skipIf(!canRun)('442 DB: server-managed business columns guard (real migrated schema)', () => {
  beforeAll(() => {
    // Cleanup prior run
    psql(`
      DELETE FROM businesses WHERE id = '${BIZ_ID}';
      DELETE FROM profiles WHERE id = '${USER_ID}';
      DELETE FROM auth.users WHERE id = '${USER_ID}';
    `);

    // CI creates auth.users without phone; ensure column exists
    psql(`ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS phone TEXT;`);

    // Create test user
    psql(`
      INSERT INTO auth.users (id, phone) VALUES ('${USER_ID}', '+0004420001')
      ON CONFLICT (id) DO NOTHING;
    `);

    // Create business as service_role (bypass the trigger)
    psql(`
      SET ROLE service_role;
      INSERT INTO businesses (id, name, slug, owner_id, address, city, neighborhood, phone, status, payout_mode, country_code, verification_level, verification_status, payout_limit_monthly, custom_fee_percentage, custom_fee_flat, subscription_tier)
      VALUES ('${BIZ_ID}', 'Guard Test Biz', 'guard-test-442', '${USER_ID}', '1 Test', 'Lagos', 'VI', '+000', 'active', 'platform_managed', 'NG', 'basic', 'verified', 500000, NULL, NULL, 'free');
      RESET ROLE;
    `);
  });

  afterAll(() => {
    psql(`
      DELETE FROM businesses WHERE id = '${BIZ_ID}';
      DELETE FROM profiles WHERE id = '${USER_ID}';
      DELETE FROM auth.users WHERE id = '${USER_ID}';
    `);
  });

  // ── Server-managed columns: authenticated must fail ──

  // messaging_suspended is guarded by trg_guard_messaging_suspended (migration 363), not this trigger
  const serverManagedColumns: [string, string][] = [
    ['verification_level', "'standard'"],
    ['verification_status', "'rejected'"],
    ['payout_limit_monthly', '2000000'],
    ['payout_mode', "'self_managed'"],
    ['custom_fee_percentage', '5.0'],
    ['custom_fee_flat', '100'],
    ['subscription_tier', "'growth'"],
    ['owner_id', `'${USER_ID}'`],  // same value but trigger still fires on IS DISTINCT FROM check
    ['reseller_id', "gen_random_uuid()"],
  ];

  for (const [col, val] of serverManagedColumns) {
    it(`authenticated cannot UPDATE ${col}`, () => {
      const result = psqlNoFail(`
        SET ROLE authenticated;
        SET request.jwt.claims = '{"sub":"${USER_ID}","role":"authenticated"}';
        UPDATE businesses SET ${col} = ${val} WHERE id = '${BIZ_ID}';
        RESET ROLE;
      `);
      expect(result.error).toBe(true);
      expect(result.stdout).toContain('can only be modified');
    });
  }

  // ── Normal columns: authenticated can update ──

  it('authenticated can UPDATE name', () => {
    const result = psqlNoFail(`
      SET ROLE authenticated;
      SET request.jwt.claims = '{"sub":"${USER_ID}","role":"authenticated"}';
      UPDATE businesses SET name = 'Updated Name 442' WHERE id = '${BIZ_ID}';
      RESET ROLE;
    `);
    expect(result.error).toBe(false);

    const name = psql(`SELECT name FROM businesses WHERE id = '${BIZ_ID}';`);
    expect(name).toBe('Updated Name 442');

    // Restore
    psql(`SET ROLE service_role; UPDATE businesses SET name = 'Guard Test Biz' WHERE id = '${BIZ_ID}'; RESET ROLE;`);
  });

  // ── service_role can update all server-managed columns ──

  for (const [col, val] of serverManagedColumns) {
    it(`service_role can UPDATE ${col}`, () => {
      const result = psqlNoFail(`
        SET ROLE service_role;
        UPDATE businesses SET ${col} = ${val} WHERE id = '${BIZ_ID}';
        RESET ROLE;
      `);
      expect(result.error).toBe(false);
    });
  }

  // Reset after service_role tests
  afterAll(() => {
    psql(`
      SET ROLE service_role;
      UPDATE businesses SET
        verification_level = 'basic',
        verification_status = 'verified',
        payout_limit_monthly = 500000,
        payout_mode = 'platform_managed',
        custom_fee_percentage = NULL,
        custom_fee_flat = NULL,
        subscription_tier = 'free'
      WHERE id = '${BIZ_ID}';
      RESET ROLE;
    `);
  });

  // ── anon gets no rows ──

  it('anon SELECT returns no rows', () => {
    const count = psql(`
      SET ROLE anon;
      SELECT count(*) FROM businesses WHERE id = '${BIZ_ID}';
      RESET ROLE;
    `);
    expect(count).toBe('0');
  });

  // ── Old tier tampering trigger was removed ──

  it('old trg_prevent_tier_tampering trigger no longer exists', () => {
    const exists = psql(`
      SELECT count(*) FROM pg_trigger t
      JOIN pg_class c ON t.tgrelid = c.oid
      JOIN pg_namespace n ON c.relnamespace = n.oid
      WHERE n.nspname = 'public' AND c.relname = 'businesses' AND t.tgname = 'trg_prevent_tier_tampering';
    `);
    expect(exists).toBe('0');
  });

  it('new trg_guard_server_managed_columns trigger exists', () => {
    const exists = psql(`
      SELECT count(*) FROM pg_trigger t
      JOIN pg_class c ON t.tgrelid = c.oid
      JOIN pg_namespace n ON c.relnamespace = n.oid
      WHERE n.nspname = 'public' AND c.relname = 'businesses' AND t.tgname = 'trg_guard_server_managed_columns';
    `);
    expect(exists).toBe('1');
  });
});
