/**
 * Provider-Neutral Subscription DB Tests — M378 (#315)
 *
 * Hermetic real PostgreSQL tests. Seeds own business/user/subscription data.
 * No early returns. Every test exercises assertions.
 *
 *   TEST_DATABASE_URL=postgresql://localhost:5432/waaiio_test \
 *     npx vitest run lib/__tests__/provider-neutral-subscriptions-db.test.ts
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

function adminContext(adminId: string): string {
  return `
    SELECT set_config('request.jwt.claims', '{"sub":"${adminId}","role":"admin","aud":"authenticated"}', false);
    SELECT set_config('request.jwt.claim.sub', '${adminId}', false);
    SET ROLE authenticated;
  `;
}

function currentVersion(): string {
  return psql("SELECT id FROM platform_config_versions WHERE effective_from <= clock_timestamp() ORDER BY effective_from DESC LIMIT 1;").trim();
}

describe.skipIf(!canRun)('M378 Provider-Neutral Subscriptions — PostgreSQL proofs', () => {
  let adminId: string;
  let testBizId: string;
  let testUserId: string;

  beforeAll(() => {
    // Discover admin identity
    adminId = psql('SELECT auth.uid()::text;').trim();
    psqlMayFail(`
      INSERT INTO auth.users (id, email, raw_app_meta_data)
      VALUES ('${adminId}', 'm378-admin@test.com', '{"role":"admin"}'::jsonb)
      ON CONFLICT (id) DO UPDATE SET raw_app_meta_data = '{"role":"admin"}'::jsonb;
    `);
    const isAdmin = psql(`${adminContext(adminId)} SELECT public.is_admin(); RESET ROLE;`);
    expect(isAdmin).toContain('t');

    testUserId = adminId;

    // Seed a test business (hermetic — use unique slug to avoid conflicts)
    const bizSlug = `m378-test-${Date.now()}`;
    const bizName = `M378TestBiz_${Date.now()}`;
    testBizId = psql(`
      INSERT INTO businesses (id, name, slug, owner_id, country_code, category)
      VALUES (gen_random_uuid(), '${bizName}', '${bizSlug}', '${testUserId}', 'NG', 'restaurant')
      RETURNING id::text;
    `).trim();
    expect(testBizId).toBeTruthy();
  });

  // ── Schema existence ──

  it('1. subscription_checkout_intents table exists', () => {
    expect(psql("SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='subscription_checkout_intents';")).toBe('1');
  });

  it('2. subscription_payment_quarantine table exists', () => {
    expect(psql("SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='subscription_payment_quarantine';")).toBe('1');
  });

  it('3. subscriptions has billing_config_version_id and flutterwave columns', () => {
    const cols = psql("SELECT column_name FROM information_schema.columns WHERE table_name='subscriptions' AND column_name IN ('billing_config_version_id','flutterwave_subscription_id','flutterwave_plan_id','flutterwave_subscriber_email') ORDER BY column_name;");
    expect(cols).toContain('billing_config_version_id');
    expect(cols).toContain('flutterwave_plan_id');
    expect(cols).toContain('flutterwave_subscriber_email');
    expect(cols).toContain('flutterwave_subscription_id');
  });

  it('4. provider-tx unique index exists', () => {
    expect(psql("SELECT count(*) FROM pg_indexes WHERE indexname='uq_subscription_payment_provider_tx';")).toBe('1');
  });

  // ── ACL: service_role only ──

  it('5. authenticated role denied on save_provider_plan_refs', () => {
    const r = psqlMayFail(`${adminContext(adminId)} SELECT save_provider_plan_refs('NG', '{}'::jsonb, '${currentVersion()}'::uuid); RESET ROLE;`);
    expect(r).toContain('permission denied');
  });

  it('6. authenticated role denied on switch_country_provider', () => {
    const r = psqlMayFail(`${adminContext(adminId)} SELECT switch_country_provider('NG', 'stripe', '${currentVersion()}'::uuid); RESET ROLE;`);
    expect(r).toContain('permission denied');
  });

  it('7. authenticated role denied on claim_checkout_initialization', () => {
    const r = psqlMayFail(`${adminContext(adminId)} SELECT claim_checkout_initialization('${testBizId}'::uuid, 'growth', 'flutterwave', 'NGN', 14999, '243206', '${currentVersion()}'::uuid, 'test@test.com'); RESET ROLE;`);
    expect(r).toContain('permission denied');
  });

  // ── Provider ref round-trip + CAS ──

  it('8. save_provider_plan_refs: Flutterwave ref round-trip with CAS advancement', () => {
    const ver = currentVersion();
    const newVer = psql(`SELECT save_provider_plan_refs('NG', '{"growth": {"flutterwave": "243206"}, "business": {"flutterwave": "243207"}}'::jsonb, '${ver}'::uuid, '${adminId}'::uuid);`);
    expect(newVer).toBeTruthy();
    expect(newVer).not.toBe(ver);
    expect(psql("SELECT pricing->'growth'->'provider_plan_refs'->>'flutterwave' FROM countries WHERE code='NG';")).toBe('243206');
    expect(psql("SELECT pricing->'business'->'provider_plan_refs'->>'flutterwave' FROM countries WHERE code='NG';")).toBe('243207');
  });

  it('9. stale CAS rejected after successful save', () => {
    const ver = currentVersion();
    psql(`SELECT save_provider_plan_refs('NG', '{"growth": {"flutterwave": "999001"}, "business": {"flutterwave": "999002"}}'::jsonb, '${ver}'::uuid, '${adminId}'::uuid);`);
    const r = psqlMayFail(`SELECT save_provider_plan_refs('NG', '{"growth": {"flutterwave": "999003"}, "business": {"flutterwave": "999004"}}'::jsonb, '${ver}'::uuid, '${adminId}'::uuid);`);
    expect(r).toContain('config_version_conflict');
  });

  it('10. save_provider_plan_refs mirrors paystack to legacy paystack_plan_code', () => {
    const ver = currentVersion();
    psql(`SELECT save_provider_plan_refs('NG', '{"growth": {"paystack": "PLN_m378_g"}, "business": {"paystack": "PLN_m378_b"}}'::jsonb, '${ver}'::uuid, '${adminId}'::uuid);`);
    expect(psql("SELECT pricing->'growth'->>'paystack_plan_code' FROM countries WHERE code='NG';")).toBe('PLN_m378_g');
    expect(psql("SELECT pricing->'growth'->'provider_plan_refs'->>'paystack' FROM countries WHERE code='NG';")).toBe('PLN_m378_g');
  });

  // ── Provider switch + inactive-ref preservation ──

  it('11. switch to provider without refs fails', () => {
    const r = psqlMayFail(`SELECT switch_country_provider('US', 'flutterwave', '${currentVersion()}'::uuid, '${adminId}'::uuid);`);
    expect(r).toContain('plan ref missing');
  });

  it('12. switch preserves inactive provider refs', () => {
    const v1 = currentVersion();
    const v2 = psql(`SELECT save_provider_plan_refs('US', '{"growth": {"flutterwave": "FLW_US_G"}, "business": {"flutterwave": "FLW_US_B"}}'::jsonb, '${v1}'::uuid, '${adminId}'::uuid);`);
    const v3 = psql(`SELECT switch_country_provider('US', 'flutterwave', '${v2}'::uuid, '${adminId}'::uuid);`);
    expect(psql("SELECT payment_gateway FROM countries WHERE code='US';")).toBe('flutterwave');
    // Switch back to stripe — flutterwave refs preserved
    psql(`SELECT switch_country_provider('US', 'stripe', '${v3}'::uuid, '${adminId}'::uuid);`);
    expect(psql("SELECT pricing->'growth'->'provider_plan_refs'->>'flutterwave' FROM countries WHERE code='US';")).toBe('FLW_US_G');
    expect(psql("SELECT payment_gateway FROM countries WHERE code='US';")).toBe('stripe');
  });

  // ── Guard enforcement ──

  it('13. direct UPDATE of provider_plan_refs blocked', () => {
    const r = psqlMayFail("UPDATE countries SET pricing = jsonb_set(pricing, '{growth,provider_plan_refs,flutterwave}', '\"HACKED\"') WHERE code='NG';");
    expect(r).toContain('save_provider_plan_refs');
  });

  it('14. direct UPDATE of payment_gateway blocked', () => {
    const r = psqlMayFail("UPDATE countries SET payment_gateway = 'flutterwave' WHERE code='US';");
    expect(r).toContain('switch_country_provider');
  });

  // ── Checkout claim with actor identity ──

  it('15. claim_checkout_initialization creates intent with valid idempotency key and actor', () => {
    const ver = currentVersion();
    const r = psql(`SELECT intent_id, is_claimed, idempotency_key FROM claim_checkout_initialization('${testBizId}'::uuid, 'growth', 'flutterwave', 'NGN', 14999, '243206', '${ver}'::uuid, 'test@m378.com', 30, '${testUserId}'::uuid);`);
    const [intentId, isClaimed, idemKey] = r.split('|');
    expect(intentId).toBeTruthy();
    expect(isClaimed).toBe('t');
    expect(idemKey.length).toBe(41);
    expect(idemKey).toMatch(/^waaiiosub[a-f0-9]{32}$/);
    // Verify actor recorded
    const userId = psql(`SELECT user_id::text FROM subscription_checkout_intents WHERE id='${intentId}'::uuid;`);
    expect(userId).toBe(testUserId);
    // Cleanup
    psql(`DELETE FROM subscription_checkout_intents WHERE id='${intentId}'::uuid;`);
  });

  // ── DB-authoritative timeout ──

  it('16. persist_checkout_provider_response sets provider_timeout_not_before via DB clock', () => {
    const ver = currentVersion();
    const r = psql(`SELECT intent_id, idempotency_key FROM claim_checkout_initialization('${testBizId}'::uuid, 'growth', 'flutterwave', 'NGN', 14999, '243206', '${ver}'::uuid, 'test2@m378.com', 30, '${testUserId}'::uuid);`);
    const [intentId, idemKey] = r.split('|');
    psql(`SELECT persist_checkout_provider_response('${intentId}'::uuid, 'https://flw.test/pay', '${idemKey}');`);
    const diffMin = psql(`SELECT EXTRACT(EPOCH FROM (provider_timeout_not_before - clock_timestamp())) / 60 FROM subscription_checkout_intents WHERE id='${intentId}'::uuid;`);
    const minutes = parseFloat(diffMin);
    expect(minutes).toBeGreaterThan(30);
    expect(minutes).toBeLessThan(40);
    psql(`DELETE FROM subscription_checkout_intents WHERE id='${intentId}'::uuid;`);
  });

  // ── Legacy M377 backward compat ──

  it('17. M377 save_market_messaging_config mirrors to provider_plan_refs.paystack (Blocker 6)', () => {
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
      for (const c of codes) rates[c] = { utility: 100, marketing: 200 };
      pricingObj[currency] = { rates, default_spend_cap_minor: 5000000 };
    }
    const trialObj: Record<string, number> = {};
    const includedObj: Record<string, Record<string, number>> = { growth: {}, business: {} };
    for (const currency of Object.keys(buckets)) {
      trialObj[currency] = 50000;
      includedObj.growth[currency] = 100000;
      includedObj.business[currency] = 200000;
    }
    const ver = currentVersion();
    const r = psql(`${adminContext(adminId)} SELECT save_market_messaging_config('${JSON.stringify(pricingObj)}'::jsonb, '${JSON.stringify(trialObj)}'::jsonb, '${JSON.stringify(includedObj)}'::jsonb, '{"NG":{"growth":"PLN_legacy_g","business":"PLN_legacy_b"}}'::jsonb, '${ver}'::uuid); RESET ROLE;`);
    expect(r).toBeTruthy();
    // Legacy key set
    expect(psql("SELECT pricing->'growth'->>'paystack_plan_code' FROM countries WHERE code='NG';")).toBe('PLN_legacy_g');
    // provider_plan_refs.paystack also set coherently (Blocker 6 fix)
    expect(psql("SELECT pricing->'growth'->'provider_plan_refs'->>'paystack' FROM countries WHERE code='NG';")).toBe('PLN_legacy_g');
  });

  // ── Data backfill ──

  it('18. backfill preserved legacy paystack_plan_code alongside provider_plan_refs', () => {
    const legacyG = psql("SELECT pricing->'growth'->>'paystack_plan_code' FROM countries WHERE code='NG';");
    const refG = psql("SELECT pricing->'growth'->'provider_plan_refs'->>'paystack' FROM countries WHERE code='NG';");
    expect(legacyG).toBeTruthy();
    expect(refG).toBeTruthy();
    // They should be coherent
    expect(refG).toBe(legacyG);
  });

  // ── Stripe activation without plan refs ──

  it('19. Stripe activation succeeds without plan refs', () => {
    psql("UPDATE countries SET is_active = false WHERE code='US';");
    const r = psqlMayFail("UPDATE countries SET is_active = true WHERE code='US';");
    expect(r).not.toContain('plan ref missing');
    expect(psql("SELECT is_active FROM countries WHERE code='US';")).toBe('t');
  });

  // ── M377 objects preserved ──

  it('20. M377 save_commercial_config (4-arg) still exists', () => {
    expect(psql("SELECT pronargs FROM pg_proc WHERE proname='save_commercial_config' AND pronamespace='public'::regnamespace;")).toBe('4');
  });

  it('21. old trg_guard_paystack_plan_codes replaced by trg_guard_provider_refs', () => {
    expect(psql("SELECT count(*) FROM information_schema.triggers WHERE trigger_name='trg_guard_paystack_plan_codes' AND event_object_table='countries';")).toBe('0');
    expect(parseInt(psql("SELECT count(*) FROM information_schema.triggers WHERE trigger_name='trg_guard_provider_refs' AND event_object_table='countries';"))).toBeGreaterThan(0);
  });

  // ── Renewal ordering protection (Blocker 4) ──

  it('22. renewal rejects NULL provider_paid_at', () => {
    // Create a minimal subscription for testing
    const subId = psql(`
      INSERT INTO subscriptions (id, business_id, plan, status, gateway, currency, amount, billing_interval, billing_config_version_id, current_period_start, current_period_end)
      VALUES (gen_random_uuid(), '${testBizId}', 'growth', 'active', 'flutterwave', 'NGN', 14999, 'month', '${currentVersion()}'::uuid, clock_timestamp(), clock_timestamp() + interval '30 days')
      RETURNING id::text;
    `);
    const r = psqlMayFail(`SELECT finalize_flutterwave_subscription_renewal('${subId}'::uuid, 'tx_null_test', 1499900, 'NGN', NULL);`);
    expect(r).toContain('must not be NULL');
    // Cleanup
    psql(`DELETE FROM subscriptions WHERE id='${subId}'::uuid;`);
  });

  it('23. renewal rejects out-of-order provider timestamp', () => {
    const subId = psql(`
      INSERT INTO subscriptions (id, business_id, plan, status, gateway, currency, amount, billing_interval, billing_config_version_id, current_period_start, current_period_end)
      VALUES (gen_random_uuid(), '${testBizId}', 'growth', 'active', 'flutterwave', 'NGN', 14999, 'month', '${currentVersion()}'::uuid, '2026-09-01'::timestamptz, '2026-10-01'::timestamptz)
      RETURNING id::text;
    `);
    // Try to finalize a renewal with timestamp BEFORE current_period_start
    const r = psqlMayFail(`SELECT finalize_flutterwave_subscription_renewal('${subId}'::uuid, 'tx_old', 1499900, 'NGN', '2026-08-15'::timestamptz);`);
    expect(r).toContain('out-of-order');
    psql(`DELETE FROM subscriptions WHERE id='${subId}'::uuid;`);
  });

  // ── Cancellation idempotency ──

  it('24. finalize_subscription_cancellation is idempotent', () => {
    const subId = psql(`
      INSERT INTO subscriptions (id, business_id, plan, status, gateway, currency, amount, billing_interval)
      VALUES (gen_random_uuid(), '${testBizId}', 'growth', 'active', 'flutterwave', 'NGN', 14999, 'month')
      RETURNING id::text;
    `);
    // First cancellation
    psql(`SELECT finalize_subscription_cancellation('${subId}'::uuid, 'evt_cancel_1', 'provider_cancelled');`);
    expect(psql(`SELECT status FROM subscriptions WHERE id='${subId}'::uuid;`)).toBe('cancelled');
    // Second cancellation — idempotent
    const r = psqlMayFail(`SELECT finalize_subscription_cancellation('${subId}'::uuid, 'evt_cancel_1', 'provider_cancelled');`);
    expect(r).not.toContain('ERROR');
    // Cleanup
    psql(`DELETE FROM subscriptions WHERE id='${subId}'::uuid;`);
  });

  // ── Terminal replacement concurrency ──

  it('25. replace_terminal_checkout_intent creates exactly one replacement', () => {
    const ver = currentVersion();
    const r1 = psql(`SELECT intent_id, idempotency_key FROM claim_checkout_initialization('${testBizId}'::uuid, 'business', 'flutterwave', 'NGN', 39999, '243207', '${ver}'::uuid, 'test-replace@m378.com', 30, '${testUserId}'::uuid);`);
    const [oldIntentId] = r1.split('|');

    // Replace
    const r2 = psql(`SELECT intent_id, idempotency_key FROM replace_terminal_checkout_intent('${oldIntentId}'::uuid, '${testBizId}'::uuid, 'business', 'flutterwave', 'NGN', 39999, '243207', '${ver}'::uuid, 'test-replace@m378.com', 30, '${testUserId}'::uuid);`);
    const [newIntentId, newKey] = r2.split('|');
    expect(newIntentId).toBeTruthy();
    expect(newIntentId).not.toBe(oldIntentId);
    expect(newKey).toMatch(/^waaiiosub[a-f0-9]{32}$/);

    // Old intent is now failed
    expect(psql(`SELECT status FROM subscription_checkout_intents WHERE id='${oldIntentId}'::uuid;`)).toBe('failed');
    // New intent is pending
    expect(psql(`SELECT status FROM subscription_checkout_intents WHERE id='${newIntentId}'::uuid;`)).toBe('pending');

    // Cleanup
    psql(`DELETE FROM subscription_checkout_intents WHERE id IN ('${oldIntentId}'::uuid, '${newIntentId}'::uuid);`);
  });

  // ── Checkout finalization rejects NULL timestamp ──

  it('26. finalize_checkout rejects NULL provider_paid_at', () => {
    const ver = currentVersion();
    const r1 = psql(`SELECT intent_id FROM claim_checkout_initialization('${testBizId}'::uuid, 'growth', 'flutterwave', 'NGN', 14999, '243206', '${ver}'::uuid, 'test-fin@m378.com', 30, '${testUserId}'::uuid);`);
    const intentId = r1.split('|')[0];
    const r = psqlMayFail(`SELECT finalize_flutterwave_subscription_checkout('${intentId}'::uuid, 'tx_1', 'sub_1', 10944, 1499900, 'NGN', NULL);`);
    expect(r).toContain('must not be NULL');
    psql(`DELETE FROM subscription_checkout_intents WHERE id='${intentId}'::uuid;`);
  });
});
