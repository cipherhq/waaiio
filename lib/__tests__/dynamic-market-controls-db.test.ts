/**
 * Dynamic Market Controls DB Tests — M377 (#313)
 *
 * Real PostgreSQL tests for save_messaging_config, save_market_messaging_config,
 * save_commercial_config bundle-only rejection, guard_country_activation,
 * guard_country_deletion, code immutability, plan-code authority guard,
 * CAS, and active-market preservation.
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
function psqlMayFail(sql: string): string {
  try {
    return execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1`, {
      input: sql, encoding: 'utf-8', timeout: 30000,
    }).trim();
  } catch (e: unknown) { return (e as { stderr?: string }).stderr || String(e); }
}

// Admin context — matches production CAS semantics
function adminContext(adminId: string): string {
  return `
    SELECT set_config('request.jwt.claims', '{"sub":"${adminId}","role":"admin","aud":"authenticated"}', false);
    SELECT set_config('request.jwt.claim.sub', '${adminId}', false);
    SET ROLE authenticated;
  `;
}

/** Authoritative current version — matches M377 production CAS */
function currentVersion(): string {
  return psql("SELECT id FROM platform_config_versions WHERE effective_from <= clock_timestamp() ORDER BY effective_from DESC LIMIT 1;").trim();
}

describe.skipIf(!canRun)('M377 Dynamic Market Controls — PostgreSQL proofs', () => {
  let adminId: string;

  /** Build a valid messaging bundle covering all currently active markets */
  function fullBundle(): { pricing: string; trial: string; included: string } {
    // Query active markets and build deterministic coverage
    const activeRows = psql("SELECT code, currency_code FROM countries WHERE is_active = true ORDER BY code;");
    const markets = activeRows.split('\n').filter(Boolean).map(r => {
      const [code, currency] = r.split('|');
      return { code: code.trim(), currency: currency.trim() };
    });

    const buckets: Record<string, string[]> = {};
    for (const m of markets) {
      if (!buckets[m.currency]) buckets[m.currency] = [];
      buckets[m.currency].push(m.code);
    }

    // Build messaging_pricing
    const pricingObj: Record<string, unknown> = {};
    for (const [currency, codes] of Object.entries(buckets)) {
      const rates: Record<string, Record<string, number>> = {};
      for (const c of codes) rates[c] = { '*': 400 };
      pricingObj[currency] = { rates, default_spend_cap_minor: 5000000 };
    }

    // Build trial_credit and included
    const trialObj: Record<string, number> = {};
    const includedObj: Record<string, Record<string, number>> = { growth: {}, business: {} };
    for (const currency of Object.keys(buckets)) {
      trialObj[currency] = 50000;
      includedObj.growth[currency] = 100000;
      includedObj.business[currency] = 200000;
    }

    return {
      pricing: JSON.stringify(pricingObj),
      trial: JSON.stringify(trialObj),
      included: JSON.stringify(includedObj),
    };
  }

  beforeAll(() => {
    // Discover auth.uid() in this environment
    adminId = psql('SELECT auth.uid()::text;').trim();

    // Ensure admin user row exists with admin role
    psqlMayFail(`
      INSERT INTO auth.users (id, email, raw_app_meta_data)
      VALUES ('${adminId}', 'm377-admin@test.com', '{"role":"admin"}'::jsonb)
      ON CONFLICT (id) DO UPDATE SET raw_app_meta_data = '{"role":"admin"}'::jsonb;
    `);

    // Verify admin context works
    const isAdmin = psql(`${adminContext(adminId)} SELECT public.is_admin(); RESET ROLE;`);
    expect(isAdmin).toContain('t');
    expect(currentVersion()).toBeTruthy();

    // Ensure ZZ test country exists (idempotent — cannot delete)
    psqlMayFail(`
      INSERT INTO countries (code, name, flag, dialing_code, currency_code, currency_symbol, currency_locale,
        payment_gateway, phone_digits, phone_pattern, phone_placeholder, is_active, sort_order, pricing)
      VALUES ('ZZ', 'TestCountry', '🏁', '+99', 'ZZD', 'Z$', 'en-ZZ', 'stripe', 10, '', '', false, 99,
        '{"free":{"price":0,"feeFlat":0,"feePercentage":2.5},"growth":{"price":20,"feeFlat":0,"feePercentage":1.5},"business":{"price":45,"feeFlat":0,"feePercentage":1.5}}'::jsonb)
      ON CONFLICT (code) DO UPDATE SET is_active = false, payment_gateway = 'stripe';
    `);

    // Establish production-like state: save full messaging bundle + Paystack plan codes for NG/GH
    // CI starts with a fresh DB where plan codes don't exist yet.
    const b = fullBundle();
    const paystackCountries = psql("SELECT code FROM countries WHERE payment_gateway = 'paystack' AND is_active = true ORDER BY code;")
      .split('\n').filter(Boolean).map(s => s.trim());
    const planCodes: Record<string, { growth: string; business: string }> = {};
    for (const code of paystackCountries) {
      planCodes[code] = { growth: `PLN_setup_g_${code}`, business: `PLN_setup_b_${code}` };
    }
    const planCodesJson = Object.keys(planCodes).length > 0 ? `'${JSON.stringify(planCodes)}'::jsonb` : 'NULL';
    psql(`${adminContext(adminId)} SELECT save_market_messaging_config('${b.pricing}'::jsonb, '${b.trial}'::jsonb, '${b.included}'::jsonb, ${planCodesJson}, '${currentVersion()}'::uuid); RESET ROLE;`);
  });

  // ── save_commercial_config: bundle-only key rejection ──

  it('1. rejects messaging_pricing via save_commercial_config', () => {
    const r = psqlMayFail(`${adminContext(adminId)} SELECT save_commercial_config('messaging_pricing', '{}'::jsonb);`);
    expect(r).toContain('bundle-only messaging key');
  });

  it('2. rejects trial_credit_minor_by_currency via save_commercial_config', () => {
    const r = psqlMayFail(`${adminContext(adminId)} SELECT save_commercial_config('trial_credit_minor_by_currency', '{}'::jsonb);`);
    expect(r).toContain('bundle-only messaging key');
  });

  it('3. rejects subscription_included via save_commercial_config', () => {
    const r = psqlMayFail(`${adminContext(adminId)} SELECT save_commercial_config('subscription_included_minor_by_tier_currency', '{}'::jsonb);`);
    expect(r).toContain('bundle-only messaging key');
  });

  // ── CAS ──

  it('4. rejects NULL CAS', () => {
    const b = fullBundle();
    const r = psqlMayFail(`${adminContext(adminId)} SELECT save_messaging_config('${b.pricing}'::jsonb, '${b.trial}'::jsonb, '${b.included}'::jsonb, NULL);`);
    expect(r).toContain('non-NULL expected_version_id');
  });

  it('5. rejects stale CAS', () => {
    const b = fullBundle();
    const r = psqlMayFail(`${adminContext(adminId)} SELECT save_messaging_config('${b.pricing}'::jsonb, '${b.trial}'::jsonb, '${b.included}'::jsonb, '00000000-0000-0000-0000-ffffffffffff'::uuid);`);
    expect(r).toContain('config_version_conflict');
  });

  // ── Validation ──

  it('6. rejects fractional spend cap', () => {
    const r = psqlMayFail(`${adminContext(adminId)} SELECT save_messaging_config('{"NGN":{"rates":{"NG":{"*":400}},"default_spend_cap_minor":5000.5}}'::jsonb, '{"NGN":50000}'::jsonb, '{"growth":{"NGN":100000},"business":{"NGN":200000}}'::jsonb, '${currentVersion()}'::uuid);`);
    expect(r).toContain('positive integer');
  });

  it('7. rejects unknown rate key', () => {
    const r = psqlMayFail(`${adminContext(adminId)} SELECT save_messaging_config('{"NGN":{"rates":{"NG":{"bad_key":400}},"default_spend_cap_minor":5000000}}'::jsonb, '{"NGN":50000}'::jsonb, '{"growth":{"NGN":100000},"business":{"NGN":200000}}'::jsonb, '${currentVersion()}'::uuid);`);
    expect(r).toContain('unknown rate key');
  });

  it('8. rejects negative rate', () => {
    const r = psqlMayFail(`${adminContext(adminId)} SELECT save_messaging_config('{"NGN":{"rates":{"NG":{"*":-1}},"default_spend_cap_minor":5000000}}'::jsonb, '{"NGN":50000}'::jsonb, '{"growth":{"NGN":100000},"business":{"NGN":200000}}'::jsonb, '${currentVersion()}'::uuid);`);
    expect(r).toContain('non-negative integer');
  });

  it('9. rejects duplicate country across buckets', () => {
    const r = psqlMayFail(`${adminContext(adminId)} SELECT save_messaging_config('{"NGN":{"rates":{"NG":{"*":400}},"default_spend_cap_minor":5000000},"USD":{"rates":{"NG":{"*":600}},"default_spend_cap_minor":10000000}}'::jsonb, '{"NGN":50000,"USD":500}'::jsonb, '{"growth":{"NGN":100000,"USD":1000},"business":{"NGN":200000,"USD":2000}}'::jsonb, '${currentVersion()}'::uuid);`);
    expect(r).toContain('multiple currency buckets');
  });

  // ── Country lifecycle ──

  it('10. activation rejected without messaging config', () => {
    const r = psqlMayFail("UPDATE countries SET is_active = true WHERE code = 'ZZ';");
    expect(r).toContain('Cannot activate market ZZ');
  });

  it('11. deletion rejected', () => {
    const r = psqlMayFail("DELETE FROM countries WHERE code = 'ZZ';");
    expect(r).toContain('deletion is not permitted');
  });

  it('12. code change rejected', () => {
    const r = psqlMayFail("UPDATE countries SET code = 'YY' WHERE code = 'ZZ';");
    expect(r).toContain('immutable after creation');
  });

  it('13. deactivation always allowed', () => {
    const r = psqlMayFail("UPDATE countries SET is_active = false WHERE code = 'ZZ';");
    expect(r).not.toContain('ERROR');
  });

  // ── Full bundle save + scalar preservation ──

  it('14. save_messaging_config with complete active-market bundle succeeds + scalar preserves maps', () => {
    const b = fullBundle();
    const v1 = psql(`${adminContext(adminId)} SELECT save_messaging_config('${b.pricing}'::jsonb, '${b.trial}'::jsonb, '${b.included}'::jsonb, '${currentVersion()}'::uuid);`);
    expect(v1).toBeTruthy();

    // Capture the exact messaging map values after bundle save
    const afterBundleSnapshot = psql(`
      SELECT config_snapshot::text FROM platform_config_versions
      WHERE effective_from <= clock_timestamp()
      ORDER BY effective_from DESC LIMIT 1;
    `);
    const bundleSnap = JSON.parse(afterBundleSnapshot);
    const origPricing = JSON.stringify(bundleSnap.messaging_pricing);
    const origTrial = JSON.stringify(bundleSnap.trial_credit_minor_by_currency);
    const origIncluded = JSON.stringify(bundleSnap.subscription_included_minor_by_tier_currency);

    // Scalar save must preserve messaging maps
    const v2 = psql(`${adminContext(adminId)} SELECT save_commercial_config('trial_days', '14'::jsonb);`);
    expect(v2).toBeTruthy();

    // Select the new version row first, then check keys and values
    const afterScalarSnapshot = psql(`
      SELECT config_snapshot::text FROM platform_config_versions
      WHERE effective_from <= clock_timestamp()
      ORDER BY effective_from DESC LIMIT 1;
    `);
    const scalarSnap = JSON.parse(afterScalarSnapshot);

    // All three messaging map keys must exist
    expect(scalarSnap).toHaveProperty('messaging_pricing');
    expect(scalarSnap).toHaveProperty('trial_credit_minor_by_currency');
    expect(scalarSnap).toHaveProperty('subscription_included_minor_by_tier_currency');

    // Values must be exactly preserved
    expect(JSON.stringify(scalarSnap.messaging_pricing)).toBe(origPricing);
    expect(JSON.stringify(scalarSnap.trial_credit_minor_by_currency)).toBe(origTrial);
    expect(JSON.stringify(scalarSnap.subscription_included_minor_by_tier_currency)).toBe(origIncluded);

    // Scalar key must also be present
    expect(scalarSnap.trial_days).toBe(14);
  });

  // ── Category-specific rate round-trip ──

  it('14b. utility + marketing rates survive round-trip independently', () => {
    // Build a bundle with category-specific rates (utility + marketing) for NG
    const activeRows = psql("SELECT code, currency_code FROM countries WHERE is_active = true ORDER BY code;");
    const markets = activeRows.split('\n').filter(Boolean).map(r => {
      const [code, currency] = r.split('|');
      return { code: code.trim(), currency: currency.trim() };
    });
    const buckets: Record<string, string[]> = {};
    for (const m of markets) {
      if (!buckets[m.currency]) buckets[m.currency] = [];
      buckets[m.currency].push(m.code);
    }

    const pricingObj: Record<string, unknown> = {};
    for (const [currency, codes] of Object.entries(buckets)) {
      const rates: Record<string, Record<string, number>> = {};
      for (const c of codes) {
        if (c === 'NG') {
          // Category-specific: utility=890, marketing=6850 (owner-approved W1 shape)
          rates[c] = { utility: 890, marketing: 6850 };
        } else if (c === 'GH') {
          rates[c] = { utility: 5, marketing: 26 };
        } else {
          rates[c] = { utility: 1, marketing: 3 };
        }
      }
      pricingObj[currency] = { rates, default_spend_cap_minor: 5000000 };
    }
    const trialObj: Record<string, number> = {};
    const includedObj: Record<string, Record<string, number>> = { growth: {}, business: {} };
    for (const currency of Object.keys(buckets)) {
      trialObj[currency] = 50000;
      includedObj.growth[currency] = 100000;
      includedObj.business[currency] = 200000;
    }

    // Save the category-specific bundle
    const v1 = psql(`${adminContext(adminId)} SELECT save_messaging_config('${JSON.stringify(pricingObj)}'::jsonb, '${JSON.stringify(trialObj)}'::jsonb, '${JSON.stringify(includedObj)}'::jsonb, '${currentVersion()}'::uuid);`);
    expect(v1).toBeTruthy();

    // Read back and verify category rates are preserved independently
    const snap = JSON.parse(psql(`
      SELECT config_snapshot::text FROM platform_config_versions
      WHERE effective_from <= clock_timestamp()
      ORDER BY effective_from DESC LIMIT 1;
    `));

    // NG must have both utility and marketing, not collapsed to *
    const ngRates = snap.messaging_pricing.NGN.rates.NG;
    expect(ngRates.utility).toBe(890);
    expect(ngRates.marketing).toBe(6850);
    expect(ngRates['*']).toBeUndefined(); // Must not have wildcard if not sent

    // GH category rates preserved
    const ghRates = snap.messaging_pricing.GHS.rates.GH;
    expect(ghRates.utility).toBe(5);
    expect(ghRates.marketing).toBe(26);

    // Second save: scalar trial_days must not destroy category rates
    psql(`${adminContext(adminId)} SELECT save_commercial_config('trial_days', '14'::jsonb);`);
    const snap2 = JSON.parse(psql(`
      SELECT config_snapshot::text FROM platform_config_versions
      WHERE effective_from <= clock_timestamp()
      ORDER BY effective_from DESC LIMIT 1;
    `));
    const ngRates2 = snap2.messaging_pricing.NGN.rates.NG;
    expect(ngRates2.utility).toBe(890);
    expect(ngRates2.marketing).toBe(6850);
  });

  // ── Paystack activation readiness ──

  it('15. Paystack market rejected without plan codes', () => {
    // M378 guard requires orchestration marker for gateway changes
    psql("SELECT set_config('waaiio.gateway_switch_auth', 'true', true); SELECT set_config('waaiio.provider_ref_auth', 'true', true); UPDATE countries SET payment_gateway = 'paystack', pricing = jsonb_set(jsonb_set(pricing, '{growth}', (pricing->'growth') - 'paystack_plan_code'), '{business}', (pricing->'business') - 'paystack_plan_code') WHERE code = 'ZZ';");
    const r = psqlMayFail("UPDATE countries SET is_active = true WHERE code = 'ZZ';");
    expect(r).toContain('plan ref missing');
    // Restore ZZ to stripe for later tests
    psql("SELECT set_config('waaiio.gateway_switch_auth', 'true', true); SELECT set_config('waaiio.provider_ref_auth', 'true', true); UPDATE countries SET payment_gateway = 'stripe' WHERE code = 'ZZ';");
  });

  // ── NG readiness (positive proof) ──

  it('16. NG: exists, paystack gateway, plan codes present, deactivate/reactivate succeeds', () => {
    // Assert country exists with paystack gateway
    const gateway = psql("SELECT payment_gateway FROM countries WHERE code = 'NG';");
    expect(gateway).toBe('paystack');

    // Assert Growth and Business plan codes are present and nonblank
    const growthCode = psql("SELECT pricing->'growth'->>'paystack_plan_code' FROM countries WHERE code = 'NG';");
    const businessCode = psql("SELECT pricing->'business'->>'paystack_plan_code' FROM countries WHERE code = 'NG';");
    expect(growthCode.length).toBeGreaterThanOrEqual(3);
    expect(businessCode.length).toBeGreaterThanOrEqual(3);

    const origActive = psql("SELECT is_active FROM countries WHERE code = 'NG';");

    // Deactivate
    psql("UPDATE countries SET is_active = false WHERE code = 'NG';");
    expect(psql("SELECT is_active FROM countries WHERE code = 'NG';")).toBe('f');

    // Reactivate — must succeed through guard_country_activation
    const r = psqlMayFail("UPDATE countries SET is_active = true WHERE code = 'NG';");
    expect(r).not.toContain('ERROR');
    expect(psql("SELECT is_active FROM countries WHERE code = 'NG';")).toBe('t');

    // Restore original active state if it was inactive
    if (origActive === 'f') {
      psql("UPDATE countries SET is_active = false WHERE code = 'NG';");
    }
  });

  // ── GH readiness (positive proof) ──

  it('17. GH: exists, paystack gateway, plan codes present, deactivate/reactivate succeeds', () => {
    // Assert country exists with paystack gateway
    const gateway = psql("SELECT payment_gateway FROM countries WHERE code = 'GH';");
    expect(gateway).toBe('paystack');

    // Assert Growth and Business plan codes are present and nonblank
    const growthCode = psql("SELECT pricing->'growth'->>'paystack_plan_code' FROM countries WHERE code = 'GH';");
    const businessCode = psql("SELECT pricing->'business'->>'paystack_plan_code' FROM countries WHERE code = 'GH';");
    expect(growthCode.length).toBeGreaterThanOrEqual(3);
    expect(businessCode.length).toBeGreaterThanOrEqual(3);

    const origActive = psql("SELECT is_active FROM countries WHERE code = 'GH';");

    // Deactivate
    psql("UPDATE countries SET is_active = false WHERE code = 'GH';");
    expect(psql("SELECT is_active FROM countries WHERE code = 'GH';")).toBe('f');

    // Reactivate — must succeed through guard_country_activation
    const r = psqlMayFail("UPDATE countries SET is_active = true WHERE code = 'GH';");
    expect(r).not.toContain('ERROR');
    expect(psql("SELECT is_active FROM countries WHERE code = 'GH';")).toBe('t');

    // Restore original active state if it was inactive
    if (origActive === 'f') {
      psql("UPDATE countries SET is_active = false WHERE code = 'GH';");
    }
  });

  // ── Orchestration RPC ──

  it('18. orchestration: combined save + plan codes atomically', () => {
    const b = fullBundle();
    const origNgPrice = psql("SELECT pricing->'growth'->>'price' FROM countries WHERE code = 'NG';");

    const r = psql(`${adminContext(adminId)} SELECT save_market_messaging_config('${b.pricing}'::jsonb, '${b.trial}'::jsonb, '${b.included}'::jsonb, '{"NG":{"growth":"PLN_orch_g","business":"PLN_orch_b"}}'::jsonb, '${currentVersion()}'::uuid);`);
    expect(r).toBeTruthy();

    // Plan codes set
    expect(psql("SELECT pricing->'growth'->>'paystack_plan_code' FROM countries WHERE code = 'NG';")).toBe('PLN_orch_g');
    // Unrelated pricing preserved
    expect(psql("SELECT pricing->'growth'->>'price' FROM countries WHERE code = 'NG';")).toBe(origNgPrice);
  });

  it('19. orchestration: stale CAS → zero mutation', () => {
    const ver = currentVersion();
    const ngCode = psql("SELECT pricing->'growth'->>'paystack_plan_code' FROM countries WHERE code = 'NG';");
    const b = fullBundle();

    const r = psqlMayFail(`${adminContext(adminId)} SELECT save_market_messaging_config('${b.pricing}'::jsonb, '${b.trial}'::jsonb, '${b.included}'::jsonb, '{"NG":{"growth":"PLN_stale","business":"PLN_stale"}}'::jsonb, '00000000-0000-0000-0000-ffffffffffff'::uuid);`);
    expect(r).toContain('config_version_conflict');

    expect(currentVersion()).toBe(ver);
    expect(psql("SELECT pricing->'growth'->>'paystack_plan_code' FROM countries WHERE code = 'NG';")).toBe(ngCode);
  });

  it('20. orchestration: invalid country → complete rollback', () => {
    const ver = currentVersion();
    const b = fullBundle();

    const r = psqlMayFail(`${adminContext(adminId)} SELECT save_market_messaging_config('${b.pricing}'::jsonb, '${b.trial}'::jsonb, '${b.included}'::jsonb, '{"XX":{"growth":"PLN_bad","business":"PLN_bad"}}'::jsonb, '${ver}'::uuid);`);
    expect(r).toContain('unknown country');
    expect(currentVersion()).toBe(ver); // version unchanged
  });

  it('21. orchestration: non-Paystack country → rejected', () => {
    const b = fullBundle();
    const r = psqlMayFail(`${adminContext(adminId)} SELECT save_market_messaging_config('${b.pricing}'::jsonb, '${b.trial}'::jsonb, '${b.included}'::jsonb, '{"US":{"growth":"PLN_bad","business":"PLN_bad"}}'::jsonb, '${currentVersion()}'::uuid);`);
    expect(r).toContain('not "paystack"');
  });

  it('22. orchestration: partial plan codes (growth only) → rejected', () => {
    const b = fullBundle();
    const r = psqlMayFail(`${adminContext(adminId)} SELECT save_market_messaging_config('${b.pricing}'::jsonb, '${b.trial}'::jsonb, '${b.included}'::jsonb, '{"NG":{"growth":"PLN_only"}}'::jsonb, '${currentVersion()}'::uuid);`);
    expect(r).toContain('both growth and business');
  });

  // ── Plan-code authority guard ──

  it('23a. authenticated-admin direct UPDATE blocked by table ACL (defense-in-depth)', () => {
    const origPlanCode = psql("SELECT pricing->'growth'->>'paystack_plan_code' FROM countries WHERE code = 'NG';");

    const r = psqlMayFail(`${adminContext(adminId)} UPDATE countries SET pricing = jsonb_set(pricing, '{growth,paystack_plan_code}', '"PLN_direct"') WHERE code = 'NG'; RESET ROLE;`);
    expect(r).toContain('permission denied');

    const afterPlanCode = psql("SELECT pricing->'growth'->>'paystack_plan_code' FROM countries WHERE code = 'NG';");
    expect(afterPlanCode).toBe(origPlanCode);
  });

  it('23b. DB-owner direct UPDATE rejected by provider ref authority guard', () => {
    const origPlanCode = psql("SELECT pricing->'growth'->>'paystack_plan_code' FROM countries WHERE code = 'NG';");
    expect(origPlanCode.length).toBeGreaterThanOrEqual(3);

    // Direct UPDATE as DB owner — no orchestration markers set
    // M378 guard_provider_ref_authority rejects without provider_ref_auth or plan_code_auth marker
    const r = psqlMayFail("UPDATE countries SET pricing = jsonb_set(pricing, '{growth,paystack_plan_code}', '\"PLN_direct_dbowner\"') WHERE code = 'NG';");
    const rejected = r.includes('save_provider_plan_refs') || r.includes('save_market_messaging_config') || r.includes('orchestration authorization');
    expect(rejected).toBe(true);

    const afterPlanCode = psql("SELECT pricing->'growth'->>'paystack_plan_code' FROM countries WHERE code = 'NG';");
    expect(afterPlanCode).toBe(origPlanCode);
  });

  it('24. direct country INSERT with plan codes rejected by authority guard', () => {
    const r = psqlMayFail(`
      INSERT INTO countries (code, name, flag, dialing_code, currency_code, currency_symbol, currency_locale,
        payment_gateway, phone_digits, phone_pattern, phone_placeholder, is_active, sort_order, pricing)
      VALUES ('YY', 'TestDirect', '🏁', '+98', 'YYD', 'Y$', 'en-YY', 'paystack', 10, '', '', false, 98,
        '{"free":{"price":0},"growth":{"price":20,"paystack_plan_code":"PLN_sneak"},"business":{"price":45}}'::jsonb);
    `);
    // Trigger fires: either first check (save_market_messaging_config) or second check (orchestration authorization)
    const blocked = r.includes('save_market_messaging_config') || r.includes('orchestration authorization');
    expect(blocked).toBe(true);
  });

  it('25. unrelated country pricing edits allowed', () => {
    const r = psqlMayFail("UPDATE countries SET pricing = jsonb_set(pricing, '{growth,price}', '25000') WHERE code = 'NG';");
    expect(r).not.toContain('ERROR');
  });
});
