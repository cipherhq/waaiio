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
// Sets JWT claims in the session so auth.uid() and is_admin() work
// inside SECURITY DEFINER functions. Uses set_config(..., false) for
// session-level persistence (not just transaction-local).
function adminContext(adminId: string): string {
  return `
    SELECT set_config('request.jwt.claims', '{"sub":"${adminId}","role":"admin","aud":"authenticated"}', false);
    SELECT set_config('request.jwt.claim.sub', '${adminId}', false);
    SET ROLE authenticated;
  `;
}

describe.skipIf(!canRun)('M377 Dynamic Market Controls — PostgreSQL proofs', () => {
  let adminId: string;
  let baseVersionId: string;

  beforeAll(() => {
    // Discover what auth.uid() actually returns in this environment
    const rawUid = psql('SELECT auth.uid()::text;');
    adminId = rawUid.trim();

    // Ensure that user exists with admin role (INSERT or UPDATE)
    psqlMayFail(`
      INSERT INTO auth.users (id, email, raw_app_meta_data)
      VALUES ('${adminId}', 'm377-admin@test.com', '{"role":"admin"}'::jsonb)
      ON CONFLICT (id) DO UPDATE SET raw_app_meta_data = '{"role":"admin"}'::jsonb;
    `);

    // Verify is_admin() returns true
    const isAdmin = psql(`
      ${adminContext(adminId)}
      SELECT public.is_admin();
      RESET ROLE;
    `);
    expect(isAdmin).toContain('t');

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

  // ── Paystack market+tier plan-code readiness ──

  it('15. Paystack market activation rejected without Growth plan code', () => {
    // Insert a Paystack market without plan codes
    psqlMayFail("UPDATE countries SET is_active = false WHERE code = 'ZZ';");
    psql(`
      UPDATE countries SET payment_gateway = 'paystack',
        pricing = '{"free":{"price":0,"feeFlat":0,"feePercentage":2.5},"growth":{"price":20000,"feeFlat":0,"feePercentage":1.5},"business":{"price":60000,"feeFlat":0,"feePercentage":1.5}}'::jsonb
      WHERE code = 'ZZ';
    `);
    const result = psqlMayFail("UPDATE countries SET is_active = true WHERE code = 'ZZ';");
    expect(result).toContain('paystack_plan_code');
  });

  it('16. Paystack market activation succeeds with both plan codes', () => {
    // First configure messaging for ZZ's currency (ZZD)
    const latestVersion = psql("SELECT id FROM platform_config_versions ORDER BY effective_from DESC LIMIT 1;");
    // Add ZZ to messaging config
    const v = psql(`
      ${adminContext(adminId)}
      SELECT save_messaging_config(
        '{"NGN":{"rates":{"NG":{"*":400}},"default_spend_cap_minor":5000000},"USD":{"rates":{"US":{"*":600}},"default_spend_cap_minor":10000000},"GBP":{"rates":{"GB":{"*":750}},"default_spend_cap_minor":8000000},"ZZD":{"rates":{"ZZ":{"*":100}},"default_spend_cap_minor":1000000}}'::jsonb,
        '{"NGN":50000,"USD":500,"GBP":400,"ZZD":10000}'::jsonb,
        '{"growth":{"NGN":100000,"USD":1000,"GBP":800,"ZZD":5000},"business":{"NGN":200000,"USD":2000,"GBP":1600,"ZZD":10000}}'::jsonb,
        '${latestVersion}'::uuid
      );
    `);
    expect(v).toBeTruthy();

    // Add plan codes to ZZ's pricing
    psql(`
      UPDATE countries SET pricing = '{"free":{"price":0,"feeFlat":0,"feePercentage":2.5},"growth":{"price":20000,"feeFlat":0,"feePercentage":1.5,"paystack_plan_code":"PLN_test_growth_zz"},"business":{"price":60000,"feeFlat":0,"feePercentage":1.5,"paystack_plan_code":"PLN_test_business_zz"}}'::jsonb
      WHERE code = 'ZZ';
    `);

    // Now activation should succeed
    const result = psqlMayFail("UPDATE countries SET is_active = true WHERE code = 'ZZ';");
    expect(result).not.toContain('ERROR');
    // Verify it's active
    const isActive = psql("SELECT is_active FROM countries WHERE code = 'ZZ';");
    expect(isActive).toBe('t');
  });

  // ── NG Paystack readiness (non-vacuous) ──

  it('17. NG: deactivate → strip plan codes → reactivation REJECTED → restore + reactivate', () => {
    // Save original NG pricing for restoration
    const origPricing = psql("SELECT pricing::text FROM countries WHERE code = 'NG';");
    expect(origPricing).toBeTruthy();

    // Deactivate NG
    psql("UPDATE countries SET is_active = false WHERE code = 'NG';");
    const deactivated = psql("SELECT is_active FROM countries WHERE code = 'NG';");
    expect(deactivated).toBe('f');

    // Strip plan codes from NG growth/business pricing
    psql(`
      UPDATE countries SET pricing = jsonb_set(
        jsonb_set(pricing, '{growth}', (pricing->'growth') - 'paystack_plan_code'),
        '{business}', (pricing->'business') - 'paystack_plan_code'
      ) WHERE code = 'NG';
    `);

    // Reactivation must fail — no plan codes
    const rejectResult = psqlMayFail("UPDATE countries SET is_active = true WHERE code = 'NG';");
    expect(rejectResult).toContain('paystack_plan_code');

    // NG is still inactive
    const stillInactive = psql("SELECT is_active FROM countries WHERE code = 'NG';");
    expect(stillInactive).toBe('f');

    // Restore plan codes
    psql(`
      UPDATE countries SET pricing = jsonb_set(
        jsonb_set(pricing, '{growth,paystack_plan_code}', '"PLN_test_ng_growth"'),
        '{business,paystack_plan_code}', '"PLN_test_ng_business"'
      ) WHERE code = 'NG';
    `);

    // Now reactivation succeeds
    const successResult = psqlMayFail("UPDATE countries SET is_active = true WHERE code = 'NG';");
    expect(successResult).not.toContain('ERROR');
    const reactivated = psql("SELECT is_active FROM countries WHERE code = 'NG';");
    expect(reactivated).toBe('t');
  });

  // ── GH Paystack readiness (non-vacuous) ──

  it('18. GH: ensure fixture exists → deactivate → strip plan codes → reactivation REJECTED → cleanup', () => {
    // Deterministically ensure GH exists as an inactive Paystack market with valid pricing
    const ghExists = psql("SELECT count(*) FROM countries WHERE code = 'GH';");
    if (ghExists === '0') {
      // Seed GH fixture deterministically
      psql(`
        INSERT INTO countries (code, name, flag, dialing_code, currency_code, currency_symbol, currency_locale,
          payment_gateway, phone_digits, phone_pattern, phone_placeholder, is_active, sort_order, pricing)
        VALUES ('GH', 'Ghana', '🇬🇭', '+233', 'GHS', 'GH₵', 'en-GH', 'paystack', 9, '', '', false, 5,
          '{"free":{"price":0,"feeFlat":0,"feePercentage":2.5},"growth":{"price":199,"feeFlat":0,"feePercentage":1.5},"business":{"price":499,"feeFlat":0,"feePercentage":1.5}}'::jsonb);
      `);
    }

    // Ensure GH is inactive for testing
    psqlMayFail("UPDATE countries SET is_active = false WHERE code = 'GH';");

    // Verify GH is a Paystack market
    const ghGateway = psql("SELECT payment_gateway FROM countries WHERE code = 'GH';");
    expect(ghGateway).toBe('paystack');

    // Strip any existing plan codes
    psql(`
      UPDATE countries SET pricing = jsonb_set(
        jsonb_set(COALESCE(pricing, '{}'::jsonb), '{growth}', COALESCE(pricing->'growth', '{}'::jsonb) - 'paystack_plan_code'),
        '{business}', COALESCE(pricing->'business', '{}'::jsonb) - 'paystack_plan_code'
      ) WHERE code = 'GH';
    `);

    // Activation must fail — no plan codes
    const rejectResult = psqlMayFail("UPDATE countries SET is_active = true WHERE code = 'GH';");
    expect(rejectResult).toContain('paystack_plan_code');

    // Add plan codes
    psql(`
      UPDATE countries SET pricing = jsonb_set(
        jsonb_set(pricing, '{growth,paystack_plan_code}', '"PLN_test_gh_growth"'),
        '{business,paystack_plan_code}', '"PLN_test_gh_business"'
      ) WHERE code = 'GH';
    `);

    // Verify GH is still inactive (cleanup state)
    psqlMayFail("UPDATE countries SET is_active = false WHERE code = 'GH';");
    const ghFinal = psql("SELECT is_active FROM countries WHERE code = 'GH';");
    expect(ghFinal).toBe('f');
  });

  // ── save_market_messaging_config orchestration RPC ──

  it('19. Orchestration: combined save updates maps + Paystack plan codes atomically', () => {
    // Get current version
    const ver = psql("SELECT id FROM platform_config_versions ORDER BY effective_from DESC LIMIT 1;");

    // Save with plan codes for NG (already active Paystack market)
    const origGrowthCode = psql("SELECT pricing->'growth'->>'paystack_plan_code' FROM countries WHERE code = 'NG';");

    const result = psql(`
      ${adminContext(adminId)}
      SELECT save_market_messaging_config(
        '{"NGN":{"rates":{"NG":{"*":400}},"default_spend_cap_minor":5000000},"USD":{"rates":{"US":{"*":600}},"default_spend_cap_minor":10000000},"GBP":{"rates":{"GB":{"*":750}},"default_spend_cap_minor":8000000}}'::jsonb,
        '{"NGN":50000,"USD":500,"GBP":400}'::jsonb,
        '{"growth":{"NGN":100000,"USD":1000,"GBP":800},"business":{"NGN":200000,"USD":2000,"GBP":1600}}'::jsonb,
        '{"NG":{"growth":"PLN_orch_ng_g","business":"PLN_orch_ng_b"}}'::jsonb,
        '${ver}'::uuid
      );
    `);
    expect(result).toBeTruthy();

    // Verify plan codes were set
    const ngGrowth = psql("SELECT pricing->'growth'->>'paystack_plan_code' FROM countries WHERE code = 'NG';");
    expect(ngGrowth).toBe('PLN_orch_ng_g');
    const ngBusiness = psql("SELECT pricing->'business'->>'paystack_plan_code' FROM countries WHERE code = 'NG';");
    expect(ngBusiness).toBe('PLN_orch_ng_b');

    // Verify unrelated pricing fields preserved
    const ngPrice = psql("SELECT (pricing->'growth'->>'price')::text FROM countries WHERE code = 'NG';");
    expect(ngPrice).toBeTruthy(); // price field not overwritten
  });

  it('20. Orchestration: stale CAS → zero messaging-map, config-version, AND plan-code mutation', () => {
    // Record current state
    const currentVer = psql("SELECT id FROM platform_config_versions ORDER BY effective_from DESC LIMIT 1;");
    const currentNgCode = psql("SELECT pricing->'growth'->>'paystack_plan_code' FROM countries WHERE code = 'NG';");

    const result = psqlMayFail(`
      ${adminContext(adminId)}
      SELECT save_market_messaging_config(
        '{"NGN":{"rates":{"NG":{"*":999}},"default_spend_cap_minor":9999999}}'::jsonb,
        '{"NGN":99999}'::jsonb,
        '{"growth":{"NGN":99999},"business":{"NGN":99999}}'::jsonb,
        '{"NG":{"growth":"PLN_stale","business":"PLN_stale"}}'::jsonb,
        '00000000-0000-0000-0000-000000000000'::uuid
      );
    `);
    expect(result).toContain('config_version_conflict');

    // Verify nothing changed
    const afterVer = psql("SELECT id FROM platform_config_versions ORDER BY effective_from DESC LIMIT 1;");
    expect(afterVer).toBe(currentVer);
    const afterNgCode = psql("SELECT pricing->'growth'->>'paystack_plan_code' FROM countries WHERE code = 'NG';");
    expect(afterNgCode).toBe(currentNgCode);
  });

  it('21. Orchestration: invalid country in plan-code bundle → complete rollback', () => {
    const currentVer = psql("SELECT id FROM platform_config_versions ORDER BY effective_from DESC LIMIT 1;");
    const currentNgCode = psql("SELECT pricing->'growth'->>'paystack_plan_code' FROM countries WHERE code = 'NG';");

    // XX does not exist — should fail and roll back everything
    const result = psqlMayFail(`
      ${adminContext(adminId)}
      SELECT save_market_messaging_config(
        '{"NGN":{"rates":{"NG":{"*":400}},"default_spend_cap_minor":5000000},"USD":{"rates":{"US":{"*":600}},"default_spend_cap_minor":10000000},"GBP":{"rates":{"GB":{"*":750}},"default_spend_cap_minor":8000000}}'::jsonb,
        '{"NGN":50000,"USD":500,"GBP":400}'::jsonb,
        '{"growth":{"NGN":100000,"USD":1000,"GBP":800},"business":{"NGN":200000,"USD":2000,"GBP":1600}}'::jsonb,
        '{"XX":{"growth":"PLN_bad","business":"PLN_bad"}}'::jsonb,
        '${currentVer}'::uuid
      );
    `);
    expect(result).toContain('unknown country');

    // Config version unchanged (rollback)
    const afterVer = psql("SELECT id FROM platform_config_versions ORDER BY effective_from DESC LIMIT 1;");
    expect(afterVer).toBe(currentVer);
    // NG plan codes unchanged (rollback)
    const afterNgCode = psql("SELECT pricing->'growth'->>'paystack_plan_code' FROM countries WHERE code = 'NG';");
    expect(afterNgCode).toBe(currentNgCode);
  });

  it('22. Orchestration: non-Paystack country in plan-code bundle → rejected', () => {
    const ver = psql("SELECT id FROM platform_config_versions ORDER BY effective_from DESC LIMIT 1;");
    // US is a Stripe market
    const result = psqlMayFail(`
      ${adminContext(adminId)}
      SELECT save_market_messaging_config(
        '{"NGN":{"rates":{"NG":{"*":400}},"default_spend_cap_minor":5000000},"USD":{"rates":{"US":{"*":600}},"default_spend_cap_minor":10000000},"GBP":{"rates":{"GB":{"*":750}},"default_spend_cap_minor":8000000}}'::jsonb,
        '{"NGN":50000,"USD":500,"GBP":400}'::jsonb,
        '{"growth":{"NGN":100000,"USD":1000,"GBP":800},"business":{"NGN":200000,"USD":2000,"GBP":1600}}'::jsonb,
        '{"US":{"growth":"PLN_bad","business":"PLN_bad"}}'::jsonb,
        '${ver}'::uuid
      );
    `);
    expect(result).toContain('not "paystack"');
  });

  // Cleanup
  it('99. cleanup test country ZZ', () => {
    psqlMayFail("UPDATE countries SET is_active = false WHERE code = 'ZZ';");
  });
});
