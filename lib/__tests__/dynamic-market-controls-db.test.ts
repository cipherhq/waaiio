/**
 * Dynamic Market Controls DB Tests — M377 (#313)
 *
 * Real PostgreSQL tests for save_messaging_config, save_commercial_config
 * bundle-only key rejection, guard_country_activation, guard_country_deletion,
 * code immutability, CAS, and active-market config preservation.
 *
 *   TEST_DATABASE_URL=postgresql://localhost:5432/waaiio_test \
 *     npx vitest run lib/__tests__/dynamic-market-controls-db.test.ts
 */
import { execSync } from 'child_process';
import { describe, it, expect, beforeAll } from 'vitest';

const dbUrl = process.env.TEST_DATABASE_URL || '';
const canRun = dbUrl.length > 0;

function psql(sql: string): string {
  return execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1`, {
    input: sql, encoding: 'utf-8', timeout: 30000,
  }).trim();
}
function psqlJson(sql: string): unknown { return JSON.parse(psql(sql)); }
function psqlMayFail(sql: string): string {
  try {
    return execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1`, {
      input: sql, encoding: 'utf-8', timeout: 30000,
    }).trim();
  } catch (e: unknown) { return (e as { stderr?: string }).stderr || String(e); }
}

// Helper: set up auth context for admin user
function adminContext(adminId: string): string {
  return `
    SELECT set_config('request.jwt.claims', json_build_object(
      'sub', '${adminId}', 'role', 'authenticated', 'aud', 'authenticated',
      'app_metadata', json_build_object('role', 'admin')
    )::text, true);
    SELECT set_config('request.jwt.claim.sub', '${adminId}', true);
    SELECT set_config('role', 'authenticated', true);
  `;
}

describe.skipIf(!canRun)('M377 Dynamic Market Controls — PostgreSQL proofs', () => {
  let adminId: string;
  let baseVersionId: string;

  beforeAll(() => {
    // Get an admin user
    adminId = psql("SELECT id FROM auth.users WHERE raw_app_meta_data->>'role' = 'admin' LIMIT 1;");
    expect(adminId).toBeTruthy();

    // Get current effective config version
    baseVersionId = psql("SELECT id FROM platform_config_versions ORDER BY effective_from DESC LIMIT 1;");
    expect(baseVersionId).toBeTruthy();
  });

  // ── save_commercial_config: bundle-only key rejection ──

  it('1. save_commercial_config rejects messaging_pricing (bundle-only)', () => {
    const result = psqlMayFail(`
      ${adminContext(adminId)}
      SELECT save_commercial_config('messaging_pricing', '{"NGN":{}}'::jsonb);
    `);
    expect(result).toContain('bundle-only messaging key');
  });

  it('2. save_commercial_config rejects trial_credit_minor_by_currency (bundle-only)', () => {
    const result = psqlMayFail(`
      ${adminContext(adminId)}
      SELECT save_commercial_config('trial_credit_minor_by_currency', '{"NGN":50000}'::jsonb);
    `);
    expect(result).toContain('bundle-only messaging key');
  });

  it('3. save_commercial_config rejects subscription_included_minor_by_tier_currency (bundle-only)', () => {
    const result = psqlMayFail(`
      ${adminContext(adminId)}
      SELECT save_commercial_config('subscription_included_minor_by_tier_currency', '{"growth":{"NGN":100000}}'::jsonb);
    `);
    expect(result).toContain('bundle-only messaging key');
  });

  // ── save_messaging_config: CAS ──

  it('4. save_messaging_config rejects NULL expected_version_id', () => {
    const result = psqlMayFail(`
      ${adminContext(adminId)}
      SELECT save_messaging_config(
        '{"NGN":{"rates":{"NG":{"*":400}},"default_spend_cap_minor":5000000}}'::jsonb,
        '{"NGN":50000}'::jsonb,
        '{"growth":{"NGN":100000},"business":{"NGN":200000}}'::jsonb,
        NULL
      );
    `);
    expect(result).toContain('non-NULL expected_version_id');
  });

  it('5. save_messaging_config rejects stale CAS version', () => {
    const result = psqlMayFail(`
      ${adminContext(adminId)}
      SELECT save_messaging_config(
        '{"NGN":{"rates":{"NG":{"*":400}},"default_spend_cap_minor":5000000}}'::jsonb,
        '{"NGN":50000}'::jsonb,
        '{"growth":{"NGN":100000},"business":{"NGN":200000}}'::jsonb,
        '00000000-0000-0000-0000-000000000000'::uuid
      );
    `);
    expect(result).toContain('config_version_conflict');
  });

  // ── save_messaging_config: validation ──

  it('6. save_messaging_config rejects fractional spend cap', () => {
    const result = psqlMayFail(`
      ${adminContext(adminId)}
      SELECT save_messaging_config(
        '{"NGN":{"rates":{"NG":{"*":400}},"default_spend_cap_minor":5000.5}}'::jsonb,
        '{"NGN":50000}'::jsonb,
        '{"growth":{"NGN":100000},"business":{"NGN":200000}}'::jsonb,
        '${baseVersionId}'::uuid
      );
    `);
    expect(result).toContain('positive integer');
  });

  it('7. save_messaging_config rejects unknown rate key', () => {
    const result = psqlMayFail(`
      ${adminContext(adminId)}
      SELECT save_messaging_config(
        '{"NGN":{"rates":{"NG":{"invalid_category":400}},"default_spend_cap_minor":5000000}}'::jsonb,
        '{"NGN":50000}'::jsonb,
        '{"growth":{"NGN":100000},"business":{"NGN":200000}}'::jsonb,
        '${baseVersionId}'::uuid
      );
    `);
    expect(result).toContain('unknown rate key');
  });

  it('8. save_messaging_config rejects negative rate value', () => {
    const result = psqlMayFail(`
      ${adminContext(adminId)}
      SELECT save_messaging_config(
        '{"NGN":{"rates":{"NG":{"*":-1}},"default_spend_cap_minor":5000000}}'::jsonb,
        '{"NGN":50000}'::jsonb,
        '{"growth":{"NGN":100000},"business":{"NGN":200000}}'::jsonb,
        '${baseVersionId}'::uuid
      );
    `);
    expect(result).toContain('non-negative integer');
  });

  it('9. save_messaging_config rejects duplicate country across buckets', () => {
    const result = psqlMayFail(`
      ${adminContext(adminId)}
      SELECT save_messaging_config(
        '{"NGN":{"rates":{"NG":{"*":400}},"default_spend_cap_minor":5000000},"USD":{"rates":{"NG":{"*":600}},"default_spend_cap_minor":10000000}}'::jsonb,
        '{"NGN":50000,"USD":500}'::jsonb,
        '{"growth":{"NGN":100000,"USD":1000},"business":{"NGN":200000,"USD":2000}}'::jsonb,
        '${baseVersionId}'::uuid
      );
    `);
    expect(result).toContain('multiple currency buckets');
  });

  // ── Country activation ──

  it('10. country activation rejected without messaging config', () => {
    // Insert inactive country first
    psqlMayFail("DELETE FROM countries WHERE code = 'ZZ';"); // cleanup
    psql(`
      INSERT INTO countries (code, name, flag, dialing_code, currency_code, currency_symbol, currency_locale,
        payment_gateway, phone_digits, phone_pattern, phone_placeholder, is_active, sort_order, pricing)
      VALUES ('ZZ', 'TestCountry', '🏁', '+99', 'ZZD', 'Z$', 'en-ZZ', 'stripe', 10, '', '', false, 99,
        '{"free":{"price":0,"feeFlat":0,"feePercentage":2.5},"growth":{"price":20,"feeFlat":0,"feePercentage":1.5},"business":{"price":45,"feeFlat":0,"feePercentage":1.5}}'::jsonb);
    `);
    const result = psqlMayFail("UPDATE countries SET is_active = true WHERE code = 'ZZ';");
    expect(result).toContain('Cannot activate market ZZ');
  });

  // ── Country deletion ──

  it('11. country deletion is rejected', () => {
    const result = psqlMayFail("DELETE FROM countries WHERE code = 'ZZ';");
    expect(result).toContain('deletion is not permitted');
  });

  // ── Country code immutability ──

  it('12. country code change is rejected', () => {
    const result = psqlMayFail("UPDATE countries SET code = 'YY' WHERE code = 'ZZ';");
    expect(result).toContain('immutable after creation');
  });

  // ── Deactivation ──

  it('13. country deactivation is always allowed', () => {
    // ZZ is inactive — deactivating an already-inactive country should pass
    const result = psqlMayFail("UPDATE countries SET is_active = false WHERE code = 'ZZ';");
    expect(result).not.toContain('ERROR');
  });

  // ── Scalar-after-bundle preserves messaging maps ──

  it('14. scalar save_commercial_config preserves messaging maps in snapshot', () => {
    // First do a valid bundle save
    const v1 = psql(`
      ${adminContext(adminId)}
      SELECT save_messaging_config(
        '{"NGN":{"rates":{"NG":{"*":400}},"default_spend_cap_minor":5000000},"USD":{"rates":{"US":{"*":600}},"default_spend_cap_minor":10000000},"GBP":{"rates":{"GB":{"*":750}},"default_spend_cap_minor":8000000}}'::jsonb,
        '{"NGN":50000,"USD":500,"GBP":400}'::jsonb,
        '{"growth":{"NGN":100000,"USD":1000,"GBP":800},"business":{"NGN":200000,"USD":2000,"GBP":1600}}'::jsonb,
        '${baseVersionId}'::uuid
      );
    `);
    expect(v1).toBeTruthy();

    // Now do a scalar save
    const v2 = psql(`
      ${adminContext(adminId)}
      SELECT save_commercial_config('trial_days', '14'::jsonb);
    `);
    expect(v2).toBeTruthy();

    // Verify the latest snapshot still contains messaging_pricing
    const snapshotKeys = psql(`
      SELECT jsonb_object_keys(config_snapshot) FROM platform_config_versions
      ORDER BY effective_from DESC LIMIT 1;
    `);
    expect(snapshotKeys).toContain('messaging_pricing');
    expect(snapshotKeys).toContain('trial_credit_minor_by_currency');
    expect(snapshotKeys).toContain('subscription_included_minor_by_tier_currency');
  });

  // Cleanup
  it('99. cleanup test country ZZ', () => {
    // ZZ can't be deleted (trigger), so deactivate it
    psqlMayFail("UPDATE countries SET is_active = false WHERE code = 'ZZ';");
  });
});
