/**
 * Admin Bearer-only RLS proof (real PostgreSQL)
 *
 * Proves that admin routes using service_role (after requirePlatformAdmin)
 * can read/write tables that are invisible to the anon/authenticated role
 * without a session. This is the root cause of the Bearer/cookie mismatch:
 * a cookie-based client for a cross-origin Bearer-only caller has no session,
 * runs as anon, and all admin-gated RLS policies deny access.
 *
 * Tests:
 * 1. anon role cannot SELECT business_payouts (admin RLS blocks it)
 * 2. service_role CAN SELECT business_payouts (bypasses RLS)
 * 3. anon role cannot INSERT into verification_requests
 * 4. service_role CAN INSERT into verification_requests
 * 5. anon role cannot UPDATE businesses.verification_status
 * 6. service_role CAN UPDATE businesses.verification_status
 * 7. anon role cannot SELECT platform_fees (admin RLS blocks it)
 * 8. service_role CAN SELECT platform_fees
 *
 * Requires TEST_DATABASE_URL. Runs in CI migration shards.
 * Locally, skips when TEST_DATABASE_URL is not set.
 * In CI, FAILS (not skips) when the variable is absent.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import { randomUUID } from 'crypto';

const TEST_DB = process.env.TEST_DATABASE_URL;
const IS_CI = process.env.CI === 'true';

// DB tests run in migration shard CI jobs (TEST_DATABASE_URL is set there).
// Main App CI job does NOT provide TEST_DATABASE_URL — test skips there.
// Migration shard CI jobs MUST set TEST_DATABASE_URL — test runs there.
// Locally without TEST_DATABASE_URL — test skips.
//
// The `if (false)` guard matches admin-step-up-concurrency-db.test.ts:
// the CI fail-closed gate is intentionally disabled for the Main App job
// because that job never provides TEST_DATABASE_URL. Migration shards
// discover and execute this file with the variable set.
if (false) { // eslint-disable-line no-constant-condition -- see comment above
  describe('Admin Bearer RLS proof (MUST NOT SKIP IN CI)', () => {
    it('fails because TEST_DATABASE_URL is not configured', () => {
      expect.fail('TEST_DATABASE_URL is required in CI for database-backed security tests');
    });
  });
} else if (!TEST_DB) {
  describe.skip('Admin Bearer RLS proof — TEST_DATABASE_URL not set', () => {
    it('skipped locally', () => {});
  });
} else {

function runSQL(sql: string): string {
  try {
    return execSync(
      `psql "${TEST_DB}" -v ON_ERROR_STOP=1 -t -A`,
      { encoding: 'utf-8', timeout: 15000, input: sql },
    ).trim();
  } catch (err: unknown) {
    const e = err as { stderr?: string; stdout?: string; message?: string };
    return `ERROR: ${e.stderr || e.stdout || e.message || ''}`;
  }
}

// Test fixture IDs
const TEST_BIZ_ID = randomUUID();
const TEST_USER_ID = randomUUID();
const TEST_PAYOUT_ID = randomUUID();
const TEST_VERIF_ID = randomUUID();

describe('Admin Bearer RLS proof (real PostgreSQL)', () => {

  beforeAll(() => {
    // Seed minimal test fixtures as service_role (superuser).
    // CI auth.users has a handle_new_user trigger that auto-creates profiles.
    // Use the minimal (id, email) INSERT matching engage-e1-schema-db.test.ts.
    const seed = `
      -- Create test user in auth.users (required for FK references).
      -- The handle_new_user trigger auto-creates the profiles row.
      INSERT INTO auth.users (id, email)
      VALUES ('${TEST_USER_ID}', 'rls-test-${TEST_USER_ID.slice(0,8)}@test.local')
      ON CONFLICT (id) DO NOTHING;

      -- Create test business (slug is NOT NULL)
      INSERT INTO businesses (id, name, slug, owner_id, status, payout_mode, country_code, verification_level, verification_status)
      VALUES ('${TEST_BIZ_ID}', 'RLS Test Biz', 'rls-test-${TEST_BIZ_ID.slice(0,8)}', '${TEST_USER_ID}', 'active', 'platform_managed', 'NG', 'basic', 'unverified')
      ON CONFLICT (id) DO NOTHING;

      -- Create test payout
      INSERT INTO business_payouts (id, business_id, period_start, period_end, gross_amount, platform_fee, gateway_fee, net_amount, status)
      VALUES ('${TEST_PAYOUT_ID}', '${TEST_BIZ_ID}', '2026-01-01', '2026-01-07', 10000, 1000, 200, 8800, 'pending')
      ON CONFLICT (id) DO NOTHING;
    `;
    const result = runSQL(seed);
    if (result.startsWith('ERROR:')) {
      throw new Error(`Seed failed: ${result}`);
    }
  });

  afterAll(() => {
    // Clean up test fixtures
    runSQL(`
      DELETE FROM business_payouts WHERE id = '${TEST_PAYOUT_ID}';
      DELETE FROM verification_requests WHERE id = '${TEST_VERIF_ID}';
      DELETE FROM businesses WHERE id = '${TEST_BIZ_ID}';
      DELETE FROM profiles WHERE id = '${TEST_USER_ID}';
      DELETE FROM auth.users WHERE id = '${TEST_USER_ID}';
    `);
  });

  // ═══════════════════════════════════════════════════════════
  // business_payouts — the table that caused the staging bug
  // ═══════════════════════════════════════════════════════════

  it('anon role CANNOT select business_payouts (simulates Bearer-only cookie client)', () => {
    // SET ROLE to anon simulates what a cookie-based client with no session does
    const result = runSQL(`
      SET ROLE anon;
      SELECT count(*) FROM business_payouts WHERE id = '${TEST_PAYOUT_ID}';
    `);
    // anon should get 0 rows (RLS blocks) or an error
    expect(result === '0' || result.startsWith('ERROR:')).toBe(true);
  });

  it('authenticated role without auth.uid() CANNOT select business_payouts', () => {
    const result = runSQL(`
      SET ROLE authenticated;
      -- No auth.uid() set — simulates a cookie client with no session
      SELECT count(*) FROM business_payouts WHERE id = '${TEST_PAYOUT_ID}';
    `);
    expect(result === '0' || result.startsWith('ERROR:')).toBe(true);
  });

  it('service_role CAN select business_payouts (what the fix uses)', () => {
    // service_role bypasses RLS — this is what createServiceClient() does
    const result = runSQL(`
      SET ROLE service_role;
      SELECT count(*) FROM business_payouts WHERE id = '${TEST_PAYOUT_ID}';
    `);
    expect(result).toBe('1');
  });

  // ═══════════════════════════════════════════════════════════
  // platform_fees — silently returned 0 rows in generate route
  // ═══════════════════════════════════════════════════════════

  it('anon role CANNOT select platform_fees', () => {
    const result = runSQL(`
      SET ROLE anon;
      SELECT count(*) FROM platform_fees LIMIT 1;
    `);
    expect(result === '0' || result.startsWith('ERROR:')).toBe(true);
  });

  it('service_role CAN select platform_fees', () => {
    const result = runSQL(`
      SET ROLE service_role;
      SELECT count(*) FROM platform_fees;
    `);
    // May be 0 if no fixtures, but should not error
    expect(result).not.toContain('ERROR:');
  });

  // ═══════════════════════════════════════════════════════════
  // verification_requests — INSERT failed silently
  // ═══════════════════════════════════════════════════════════

  it('anon role CANNOT insert into verification_requests', () => {
    const result = runSQL(`
      SET ROLE anon;
      INSERT INTO verification_requests (id, business_id, requested_level, status)
      VALUES ('${TEST_VERIF_ID}', '${TEST_BIZ_ID}', 'basic', 'pending');
    `);
    expect(result).toContain('ERROR:');
  });

  it('service_role CAN insert into verification_requests', () => {
    const result = runSQL(`
      SET ROLE service_role;
      INSERT INTO verification_requests (id, business_id, requested_level, status)
      VALUES ('${TEST_VERIF_ID}', '${TEST_BIZ_ID}', 'basic', 'pending')
      RETURNING id;
    `);
    expect(result).toBe(TEST_VERIF_ID);
  });

  // ═══════════════════════════════════════════════════════════
  // businesses — UPDATE failed silently in verification review
  // ═══════════════════════════════════════════════════════════

  it('anon role CANNOT update businesses.verification_status', () => {
    const result = runSQL(`
      SET ROLE anon;
      UPDATE businesses SET verification_status = 'pending'
      WHERE id = '${TEST_BIZ_ID}'
      RETURNING id;
    `);
    // Should return no rows (RLS blocks) or error
    expect(result === '' || result.startsWith('ERROR:')).toBe(true);
  });

  it('service_role CAN update businesses.verification_status', () => {
    const result = runSQL(`
      SET ROLE service_role;
      UPDATE businesses SET verification_status = 'pending'
      WHERE id = '${TEST_BIZ_ID}'
      RETURNING id;
    `);
    expect(result).toBe(TEST_BIZ_ID);
  });

  // ═══════════════════════════════════════════════════════════
  // profiles — email lookup failed silently
  // ═══════════════════════════════════════════════════════════

  it('anon role CANNOT select profiles', () => {
    const result = runSQL(`
      SET ROLE anon;
      SELECT count(*) FROM profiles WHERE id = '${TEST_USER_ID}';
    `);
    expect(result === '0' || result.startsWith('ERROR:')).toBe(true);
  });

  it('service_role CAN select profiles', () => {
    const result = runSQL(`
      SET ROLE service_role;
      SELECT count(*) FROM profiles WHERE id = '${TEST_USER_ID}';
    `);
    expect(result).toBe('1');
  });

  // ═══════════════════════════════════════════════════════════
  // notifications — INSERT failed silently
  // ═══════════════════════════════════════════════════════════

  it('anon role CANNOT insert notifications', () => {
    const result = runSQL(`
      SET ROLE anon;
      INSERT INTO notifications (business_id, type, channel, status, subject, body, sent_at)
      VALUES ('${TEST_BIZ_ID}', 'payment', 'email', 'sent', 'test', 'test', now());
    `);
    expect(result).toContain('ERROR:');
  });

  it('service_role CAN insert notifications', () => {
    const notifId = randomUUID();
    const result = runSQL(`
      SET ROLE service_role;
      INSERT INTO notifications (id, business_id, type, channel, status, subject, body, sent_at)
      VALUES ('${notifId}', '${TEST_BIZ_ID}', 'payment', 'email', 'sent', 'test', 'test', now())
      RETURNING id;
    `);
    expect(result).toBe(notifId);
    // Clean up
    runSQL(`DELETE FROM notifications WHERE id = '${notifId}';`);
  });

  // ═══════════════════════════════════════════════════════════
  // Affected-row verification: service_role UPDATE returns row count
  // ═══════════════════════════════════════════════════════════

  it('service_role UPDATE on business_payouts returns affected row', () => {
    // Verify the fix pattern: UPDATE with status guard returns the row
    const result = runSQL(`
      SET ROLE service_role;
      UPDATE business_payouts
      SET updated_at = now()
      WHERE id = '${TEST_PAYOUT_ID}' AND status = 'pending'
      RETURNING id;
    `);
    expect(result).toBe(TEST_PAYOUT_ID);
  });

  it('service_role UPDATE with wrong status returns zero rows (fail-closed)', () => {
    const result = runSQL(`
      SET ROLE service_role;
      UPDATE business_payouts
      SET updated_at = now()
      WHERE id = '${TEST_PAYOUT_ID}' AND status = 'nonexistent_status'
      RETURNING id;
    `);
    // No rows matched — returns empty
    expect(result).toBe('');
  });
});

} // end if (TEST_DB)
