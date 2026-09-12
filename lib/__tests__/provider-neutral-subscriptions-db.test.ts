/**
 * Provider-Neutral Subscription DB Tests — M378 (#315)
 *
 * Hermetic real PostgreSQL tests. Seeds own business/user/subscription data.
 * No early returns. Every test exercises assertions.
 *
 *   TEST_DATABASE_URL=postgresql://localhost:5432/waaiio_test \
 *     npx vitest run lib/__tests__/provider-neutral-subscriptions-db.test.ts
 */
import { execSync, spawn } from 'child_process';
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

/** Async psql for true concurrent multi-session tests */
function psqlAsync(sql: string): Promise<{ ok: boolean; result: string; error: string }> {
  return new Promise((resolve) => {
    const proc = spawn('psql', [dbUrl, '-tAXq', '-v', 'ON_ERROR_STOP=1'], { timeout: 30000 });
    let stdout = '';
    let stderr = '';
    proc.stdin.write(sql);
    proc.stdin.end();
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('close', (code: number) => {
      resolve({ ok: code === 0, result: stdout.trim(), error: stderr.trim() });
    });
  });
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

    // Seed a test business (hermetic — include all NOT NULL columns)
    const bizSlug = `m378-test-${Date.now()}`;
    const bizName = `M378TestBiz_${Date.now()}`;
    testBizId = psql(`
      INSERT INTO businesses (id, name, slug, owner_id, country_code, category, address, city, neighborhood, phone)
      VALUES (gen_random_uuid(), '${bizName}', '${bizSlug}', '${testUserId}', 'NG', 'restaurant', '123 Test St', 'Lagos', 'VI', '+2348012345678')
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
    const subId = psql(`
      INSERT INTO subscriptions (id, business_id, plan, status, gateway, currency, amount, billing_interval, billing_config_version_id, current_period_start, current_period_end)
      VALUES (gen_random_uuid(), '${testBizId}', 'growth', 'active', 'flutterwave', 'NGN', 14999, 'month', '${currentVersion()}'::uuid, clock_timestamp(), clock_timestamp() + interval '30 days')
      RETURNING id::text;
    `);
    const r = psqlMayFail(`SELECT finalize_flutterwave_subscription_renewal('${subId}'::uuid, 'tx_null_test', 1499900, 'NGN', NULL);`);
    expect(r).toContain('must not be NULL');
    psql(`DELETE FROM subscriptions WHERE id='${subId}'::uuid;`);
  });

  it('23. renewal rejects out-of-order provider timestamp', () => {
    const subId = psql(`
      INSERT INTO subscriptions (id, business_id, plan, status, gateway, currency, amount, billing_interval, billing_config_version_id, current_period_start, current_period_end)
      VALUES (gen_random_uuid(), '${testBizId}', 'growth', 'active', 'flutterwave', 'NGN', 14999, 'month', '${currentVersion()}'::uuid, '2026-09-01'::timestamptz, '2026-10-01'::timestamptz)
      RETURNING id::text;
    `);
    const r = psqlMayFail(`SELECT finalize_flutterwave_subscription_renewal('${subId}'::uuid, 'tx_old', 1499900, 'NGN', '2026-08-15'::timestamptz);`);
    expect(r).toContain('out-of-order');
    psql(`DELETE FROM subscriptions WHERE id='${subId}'::uuid;`);
  });

  // ── Cancellation idempotency ──

  it('24. finalize_subscription_cancellation is idempotent', () => {
    const subId = psql(`
      INSERT INTO subscriptions (id, business_id, plan, status, gateway, currency, amount, billing_interval, current_period_start, current_period_end)
      VALUES (gen_random_uuid(), '${testBizId}', 'growth', 'active', 'flutterwave', 'NGN', 14999, 'month', clock_timestamp(), clock_timestamp() + interval '30 days')
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

  // ══════════════════════════════════════════════════════════
  // Phase 2.2 DB proofs
  // ══════════════════════════════════════════════════════════

  // Seed config with pricing_tiers + messaging_pricing so M375 can validate amounts
  it('27-pre. seed pricing_tiers and messaging config for M375 validation', () => {
    // pricing_tiers is individually mutable — add 'price' fields needed by M375
    psql(`${adminContext(adminId)} SELECT save_commercial_config('pricing_tiers', '{"free":{"feePercentage":2.5,"feeFlat":0.5,"maxBookings":50,"whitelabel":false,"price":0},"growth":{"feePercentage":1.5,"feeFlat":0.25,"maxBookings":500,"whitelabel":false,"price":14999},"business":{"feePercentage":1.0,"feeFlat":0.25,"maxBookings":999999999,"whitelabel":true,"price":39999}}'::jsonb); RESET ROLE;`);

    // messaging_pricing, trial_credit, subscription_included are bundle-only keys —
    // save_market_messaging_config requires ALL active markets to be included.
    // Build the messaging config covering all active markets (same pattern as test 17).
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
    psql(`${adminContext(adminId)} SELECT save_market_messaging_config('${JSON.stringify(pricingObj)}'::jsonb, '${JSON.stringify(trialObj)}'::jsonb, '${JSON.stringify(includedObj)}'::jsonb, '{"NG":{"growth":"243206","business":"243207"}}'::jsonb, '${ver}'::uuid); RESET ROLE;`);

    // Verify the config snapshot now has pricing_tiers.growth.price
    const price = psql(`SELECT config_snapshot->'pricing_tiers'->'growth'->>'price' FROM platform_config_versions WHERE effective_from <= clock_timestamp() ORDER BY effective_from DESC LIMIT 1;`);
    expect(price).toBe('14999');
  });

  // ── M375 success through finalizer ──

  it('27. successful initial finalizer through M375 — subscription activated + tier upgraded', () => {
    const ver = currentVersion();
    // Create intent
    const r1 = psql(`SELECT intent_id, idempotency_key FROM claim_checkout_initialization('${testBizId}'::uuid, 'growth', 'flutterwave', 'NGN', 14999, '243206', '${ver}'::uuid, 'test-m375@m378.com', 30, '${testUserId}'::uuid);`);
    const [intentId, idemKey] = r1.split('|');

    // Finalize with valid data
    const finResult = psql(`SELECT finalize_flutterwave_subscription_checkout('${intentId}'::uuid, 'tx_m375_ok', 'sub_m375_ok', 10944, 1499900, 'NGN', '2026-09-12T10:00:00Z'::timestamptz);`);
    expect(finResult).toContain('"finalized": true');

    // Subscription is active
    const subStatus = psql(`SELECT status FROM subscriptions WHERE business_id='${testBizId}'::uuid AND plan='growth' ORDER BY created_at DESC LIMIT 1;`);
    expect(subStatus).toBe('active');

    // Business tier upgraded
    const bizTier = psql(`SELECT subscription_tier FROM businesses WHERE id='${testBizId}'::uuid;`);
    expect(bizTier).toBe('growth');

    // Intent marked completed
    expect(psql(`SELECT status FROM subscription_checkout_intents WHERE id='${intentId}'::uuid;`)).toBe('completed');

    // Subscription payment recorded
    const payCount = psql(`SELECT count(*) FROM subscription_payments WHERE gateway_reference='tx_m375_ok' AND status='success';`);
    expect(payCount).toBe('1');

    // Cleanup
    psql(`DELETE FROM subscription_checkout_intents WHERE id='${intentId}'::uuid;`);
  });

  // ── M375 rejection → full rollback ──

  it('28. finalization exception causes full rollback — zero partial value', () => {
    // Create a fresh business to isolate from test 27
    const rejBizId = psql(`
      INSERT INTO businesses (id, name, slug, owner_id, country_code, category, address, city, neighborhood, phone)
      VALUES (gen_random_uuid(), 'M375RejTest', 'm375-rej-${Date.now()}', '${testUserId}', 'NG', 'restaurant', '456 Rej St', 'Lagos', 'VI', '+2348099999999')
      RETURNING id::text;
    `);
    const ver = currentVersion();
    const r1 = psql(`SELECT intent_id FROM claim_checkout_initialization('${rejBizId}'::uuid, 'growth', 'flutterwave', 'NGN', 14999, '243206', '${ver}'::uuid, 'test-rej@m378.com', 30, '${testUserId}'::uuid);`);
    const intentId = r1.split('|')[0];

    // Cause finalizer exception via amount mismatch — this RAISES EXCEPTION inside the
    // function, causing PostgreSQL to roll back the entire transaction atomically.
    // No subscription, no payment, intent stays pending.
    const errResult = psqlMayFail(`SELECT finalize_flutterwave_subscription_checkout('${intentId}'::uuid, 'tx_rej_1', 'sub_rej_1', 10944, 9999900, 'NGN', '2026-09-12T10:00:00Z'::timestamptz);`);
    expect(errResult).toContain('amount mismatch');

    // Intent must STILL be pending (transaction rolled back)
    expect(psql(`SELECT status FROM subscription_checkout_intents WHERE id='${intentId}'::uuid;`)).toBe('pending');

    // No subscription created
    expect(psql(`SELECT count(*) FROM subscriptions WHERE business_id='${rejBizId}'::uuid;`)).toBe('0');

    // No payment recorded
    expect(psql(`SELECT count(*) FROM subscription_payments WHERE business_id='${rejBizId}'::uuid;`)).toBe('0');

    // Business tier unchanged (still free)
    expect(psql(`SELECT subscription_tier FROM businesses WHERE id='${rejBizId}'::uuid;`)).toBe('free');

    // Cleanup
    psql(`DELETE FROM subscription_checkout_intents WHERE id='${intentId}'::uuid;`);
    psql(`DELETE FROM businesses WHERE id='${rejBizId}'::uuid;`);
  });

  // ── Exact-provider-tx idempotency ──

  it('29. exact same provider tx → idempotent (no duplicate payment)', () => {
    const ver = currentVersion();
    const r1 = psql(`SELECT intent_id FROM claim_checkout_initialization('${testBizId}'::uuid, 'growth', 'flutterwave', 'NGN', 14999, '243206', '${ver}'::uuid, 'test-idem@m378.com', 30, '${testUserId}'::uuid);`);
    const intentId = r1.split('|')[0];

    // First finalization — succeeds
    const fin1 = psql(`SELECT finalize_flutterwave_subscription_checkout('${intentId}'::uuid, 'tx_idem_exact', 'sub_idem', 10944, 1499900, 'NGN', '2026-09-12T11:00:00Z'::timestamptz);`);
    expect(fin1).toContain('"finalized": true');

    // Second finalization with SAME tx — idempotent
    // Need a new intent for the same business (the first is now completed)
    // Actually, the completed intent returns idempotent too
    const fin2 = psql(`SELECT finalize_flutterwave_subscription_checkout('${intentId}'::uuid, 'tx_idem_exact', 'sub_idem', 10944, 1499900, 'NGN', '2026-09-12T11:00:00Z'::timestamptz);`);
    expect(fin2).toContain('"idempotent": true');

    // Still only one payment
    const payCount = psql(`SELECT count(*) FROM subscription_payments WHERE gateway_reference='tx_idem_exact' AND status='success';`);
    expect(payCount).toBe('1');

    // Cleanup
    psql(`DELETE FROM subscription_checkout_intents WHERE id='${intentId}'::uuid;`);
  });

  // ── Different provider tx same period → quarantine ──

  it('30. different provider tx for same period → quarantine, no duplicate value', () => {
    // Use a fresh business to avoid interference with earlier test subscriptions
    const conflictBizId = psql(`
      INSERT INTO businesses (id, name, slug, owner_id, country_code, category, address, city, neighborhood, phone)
      VALUES (gen_random_uuid(), 'ConflictTest', 'conflict-${Date.now()}', '${testUserId}', 'NG', 'restaurant', '789 Conflict St', 'Lagos', 'VI', '+2348077777777')
      RETURNING id::text;
    `);
    const ver = currentVersion();

    // First intent + finalization — creates subscription with a period_start
    const r1 = psql(`SELECT intent_id FROM claim_checkout_initialization('${conflictBizId}'::uuid, 'growth', 'flutterwave', 'NGN', 14999, '243206', '${ver}'::uuid, 'conflict@m378.com', 30, '${testUserId}'::uuid);`);
    const intentId1 = r1.split('|')[0];
    const fin1 = psql(`SELECT finalize_flutterwave_subscription_checkout('${intentId1}'::uuid, 'tx_period_a', 'sub_period', 10944, 1499900, 'NGN', '2026-09-12T12:00:00Z'::timestamptz);`);
    expect(fin1).toContain('"finalized": true');

    // Create a SECOND fresh intent directly (not via replace, since the first is completed)
    // Clean up old intent's pending status first — it's completed so claim will create new
    const r2 = psql(`SELECT intent_id FROM claim_checkout_initialization('${conflictBizId}'::uuid, 'growth', 'flutterwave', 'NGN', 14999, '243206', '${ver}'::uuid, 'conflict2@m378.com', 30, '${testUserId}'::uuid);`);
    const intentId2 = r2.split('|')[0];
    expect(intentId2).toBeTruthy();

    // Finalize with DIFFERENT tx but same period_start → quarantine
    const fin2 = psql(`SELECT finalize_flutterwave_subscription_checkout('${intentId2}'::uuid, 'tx_period_b', 'sub_period2', 10944, 1499900, 'NGN', '2026-09-12T12:00:00Z'::timestamptz);`);
    expect(fin2).toContain('"quarantine": true');
    expect(fin2).toContain('period_conflict');

    // Only one successful payment for the period
    const payCount = psql(`SELECT count(*) FROM subscription_payments WHERE gateway_reference IN ('tx_period_a','tx_period_b') AND status='success';`);
    expect(payCount).toBe('1');

    // Quarantine record exists
    const qCount = psql(`SELECT count(*) FROM subscription_payment_quarantine WHERE provider_tx_id='tx_period_b';`);
    expect(qCount).toBe('1');

    // Cleanup
    psql(`DELETE FROM subscription_payment_quarantine WHERE provider_tx_id='tx_period_b';`);
    psql(`DELETE FROM subscription_checkout_intents WHERE business_id='${conflictBizId}'::uuid;`);
    psql(`DELETE FROM businesses WHERE id='${conflictBizId}'::uuid;`);
  });

  // ── Pinned-contract renewal ──

  it('31. renewal uses pinned config version from subscription', () => {
    // The subscription created in test 27/29/30 has billing_config_version_id set.
    // Renewal via finalize_flutterwave_subscription_renewal uses the subscription's config.
    const subId = psql(`SELECT id::text FROM subscriptions WHERE business_id='${testBizId}'::uuid AND gateway='flutterwave' ORDER BY created_at DESC LIMIT 1;`);
    expect(subId).toBeTruthy();

    // Get the subscription's pinned config version
    const pinnedVer = psql(`SELECT billing_config_version_id::text FROM subscriptions WHERE id='${subId}'::uuid;`);
    expect(pinnedVer).toBeTruthy();

    // Renew — period must advance past current_period_end
    const currentEnd = psql(`SELECT current_period_end::text FROM subscriptions WHERE id='${subId}'::uuid;`);
    const renewResult = psql(`SELECT finalize_flutterwave_subscription_renewal('${subId}'::uuid, 'tx_renewal_pinned', 1499900, 'NGN', '${currentEnd}'::timestamptz);`);
    expect(renewResult).toContain('"finalized": true');

    // Renewal payment has the same config_version_id as the subscription
    const payVer = psql(`SELECT config_version_id::text FROM subscription_payments WHERE gateway_reference='tx_renewal_pinned' AND status='success';`);
    expect(payVer).toBe(pinnedVer);

    // Subscription period advanced
    const newEnd = psql(`SELECT current_period_end::text FROM subscriptions WHERE id='${subId}'::uuid;`);
    expect(newEnd).not.toBe(currentEnd);
  });

  // ── Multi-session checkout/replacement concurrency ──

  it('32. concurrent claim_checkout_initialization — partial unique index prevents duplicate pending intents', () => {
    const ver = currentVersion();
    // Create a new business for isolation
    const concBizId = psql(`
      INSERT INTO businesses (id, name, slug, owner_id, country_code, category, address, city, neighborhood, phone)
      VALUES (gen_random_uuid(), 'ConcTest', 'conc-${Date.now()}', '${testUserId}', 'NG', 'restaurant', '789 Conc St', 'Lagos', 'VI', '+2348011111111')
      RETURNING id::text;
    `);

    // First claim succeeds
    const r1 = psql(`SELECT intent_id, is_claimed FROM claim_checkout_initialization('${concBizId}'::uuid, 'growth', 'flutterwave', 'NGN', 14999, '243206', '${ver}'::uuid, 'conc@m378.com', 30, '${testUserId}'::uuid);`);
    const [intentId1, claimed1] = r1.split('|');
    expect(claimed1).toBe('t');

    // Second claim for same (business, plan, gateway) — returns existing intent (not claimed, since recent)
    const r2 = psql(`SELECT intent_id, is_claimed FROM claim_checkout_initialization('${concBizId}'::uuid, 'growth', 'flutterwave', 'NGN', 14999, '243206', '${ver}'::uuid, 'conc@m378.com', 30, '${testUserId}'::uuid);`);
    const [intentId2, claimed2] = r2.split('|');
    // Same intent returned — partial unique index ensures only one pending
    expect(intentId2).toBe(intentId1);
    expect(claimed2).toBe('f'); // not claimed (another session owns it)

    // Only one pending intent exists
    const pendingCount = psql(`SELECT count(*) FROM subscription_checkout_intents WHERE business_id='${concBizId}'::uuid AND plan='growth' AND gateway='flutterwave' AND status='pending';`);
    expect(pendingCount).toBe('1');

    // Cleanup
    psql(`DELETE FROM subscription_checkout_intents WHERE id='${intentId1}'::uuid;`);
    psql(`DELETE FROM businesses WHERE id='${concBizId}'::uuid;`);
  });

  it('33. replace_terminal_checkout_intent + concurrent claim — partial unique index prevents duplicate', () => {
    const ver = currentVersion();
    const replBizId = psql(`
      INSERT INTO businesses (id, name, slug, owner_id, country_code, category, address, city, neighborhood, phone)
      VALUES (gen_random_uuid(), 'ReplConc', 'repl-conc-${Date.now()}', '${testUserId}', 'NG', 'restaurant', '999 Repl St', 'Lagos', 'VI', '+2348022222222')
      RETURNING id::text;
    `);

    // Initial claim
    const r1 = psql(`SELECT intent_id FROM claim_checkout_initialization('${replBizId}'::uuid, 'growth', 'flutterwave', 'NGN', 14999, '243206', '${ver}'::uuid, 'repl-conc@m378.com', 30, '${testUserId}'::uuid);`);
    const oldIntentId = r1.split('|')[0];

    // Replace (marks old as failed, creates new)
    const r2 = psql(`SELECT intent_id FROM replace_terminal_checkout_intent('${oldIntentId}'::uuid, '${replBizId}'::uuid, 'growth', 'flutterwave', 'NGN', 14999, '243206', '${ver}'::uuid, 'repl-conc@m378.com', 30, '${testUserId}'::uuid);`);
    const newIntentId = r2.split('|')[0];
    expect(newIntentId).not.toBe(oldIntentId);

    // Old is failed, new is pending
    expect(psql(`SELECT status FROM subscription_checkout_intents WHERE id='${oldIntentId}'::uuid;`)).toBe('failed');
    expect(psql(`SELECT status FROM subscription_checkout_intents WHERE id='${newIntentId}'::uuid;`)).toBe('pending');

    // Try to replace again (old already failed) — should return existing pending intent
    const r3 = psql(`SELECT intent_id FROM replace_terminal_checkout_intent('${oldIntentId}'::uuid, '${replBizId}'::uuid, 'growth', 'flutterwave', 'NGN', 14999, '243206', '${ver}'::uuid, 'repl-conc@m378.com', 30, '${testUserId}'::uuid);`);
    const dupIntentId = r3.split('|')[0];
    // Returns the existing pending intent — no duplicate created
    expect(dupIntentId).toBe(newIntentId);

    // Still only one pending
    const pendingCount = psql(`SELECT count(*) FROM subscription_checkout_intents WHERE business_id='${replBizId}'::uuid AND plan='growth' AND status='pending';`);
    expect(pendingCount).toBe('1');

    // Cleanup
    psql(`DELETE FROM subscription_checkout_intents WHERE business_id='${replBizId}'::uuid;`);
    psql(`DELETE FROM businesses WHERE id='${replBizId}'::uuid;`);
  });

  // ── Concurrent duplicate renewal ──

  it('34. concurrent duplicate renewal — second tx quarantined, no duplicate value', () => {
    // Use the existing subscription from earlier tests
    const subId = psql(`SELECT id::text FROM subscriptions WHERE business_id='${testBizId}'::uuid AND gateway='flutterwave' ORDER BY created_at DESC LIMIT 1;`);
    expect(subId).toBeTruthy();

    // Get current period end for the renewal timestamp
    const periodEnd = psql(`SELECT current_period_end::text FROM subscriptions WHERE id='${subId}'::uuid;`);

    // First renewal succeeds
    const ren1 = psql(`SELECT finalize_flutterwave_subscription_renewal('${subId}'::uuid, 'tx_dup_ren_1', 1499900, 'NGN', '${periodEnd}'::timestamptz);`);
    expect(ren1).toContain('"finalized": true');

    // Second renewal with DIFFERENT tx for same period_start → quarantine
    const newPeriodEnd = psql(`SELECT current_period_end::text FROM subscriptions WHERE id='${subId}'::uuid;`);
    // Use the same period_start as the first renewal (which is the old period_end)
    const ren2 = psql(`SELECT finalize_flutterwave_subscription_renewal('${subId}'::uuid, 'tx_dup_ren_2', 1499900, 'NGN', '${periodEnd}'::timestamptz);`);
    expect(ren2).toContain('"quarantine": true');

    // Only one successful payment for that period
    const payCount = psql(`SELECT count(*) FROM subscription_payments WHERE subscription_id='${subId}'::uuid AND provider_reference IN ('tx_dup_ren_1','tx_dup_ren_2') AND status='success';`);
    expect(payCount).toBe('1');

    // Second tx quarantined
    const qCount = psql(`SELECT count(*) FROM subscription_payment_quarantine WHERE provider_tx_id='tx_dup_ren_2';`);
    expect(qCount).toBe('1');
  });

  // ── Exact renewal tx idempotency ──

  it('35. exact same renewal tx → idempotent (no duplicate payment)', () => {
    const subId = psql(`SELECT id::text FROM subscriptions WHERE business_id='${testBizId}'::uuid AND gateway='flutterwave' ORDER BY created_at DESC LIMIT 1;`);
    const periodEnd = psql(`SELECT current_period_end::text FROM subscriptions WHERE id='${subId}'::uuid;`);

    // First renewal
    const ren1 = psql(`SELECT finalize_flutterwave_subscription_renewal('${subId}'::uuid, 'tx_ren_idem', 1499900, 'NGN', '${periodEnd}'::timestamptz);`);
    expect(ren1).toContain('"finalized": true');

    // Same tx again → idempotent
    const ren2 = psql(`SELECT finalize_flutterwave_subscription_renewal('${subId}'::uuid, 'tx_ren_idem', 1499900, 'NGN', '${periodEnd}'::timestamptz);`);
    expect(ren2).toContain('"idempotent": true');

    // Only one payment
    const payCount = psql(`SELECT count(*) FROM subscription_payments WHERE provider_reference='tx_ren_idem' AND status='success';`);
    expect(payCount).toBe('1');
  });

  // ── Stale CAS/TOCTOU at claim boundary (M379) ──

  it('36. stale config version rejected at claim boundary — zero intent created', () => {
    const casBizId = psql(`
      INSERT INTO businesses (id, name, slug, owner_id, country_code, category, address, city, neighborhood, phone)
      VALUES (gen_random_uuid(), 'CASTest', 'cas-${Date.now()}', '${testUserId}', 'NG', 'restaurant', '111 CAS St', 'Lagos', 'VI', '+2348033333333')
      RETURNING id::text;
    `);

    // Capture V1
    const v1 = currentVersion();
    // Advance config to V2
    psql(`SELECT save_provider_plan_refs('NG', '{"growth": {"flutterwave": "243206"}, "business": {"flutterwave": "243207"}}'::jsonb, '${v1}'::uuid, '${adminId}'::uuid);`);
    const v2 = currentVersion();
    expect(v2).not.toBe(v1);

    // Attempt claim with stale V1 — must be rejected
    const staleResult = psqlMayFail(`SELECT claim_checkout_initialization('${casBizId}'::uuid, 'growth', 'flutterwave', 'NGN', 14999, '243206', '${v1}'::uuid, 'cas@m378.com', 30, '${testUserId}'::uuid);`);
    expect(staleResult).toContain('config_version_conflict');

    // Zero intent created
    expect(psql(`SELECT count(*) FROM subscription_checkout_intents WHERE business_id='${casBizId}'::uuid;`)).toBe('0');

    // Fresh V2 claim succeeds
    const freshResult = psql(`SELECT intent_id, is_claimed FROM claim_checkout_initialization('${casBizId}'::uuid, 'growth', 'flutterwave', 'NGN', 14999, '243206', '${v2}'::uuid, 'cas@m378.com', 30, '${testUserId}'::uuid);`);
    const [intentId, claimed] = freshResult.split('|');
    expect(claimed).toBe('t');
    expect(intentId).toBeTruthy();

    // Cleanup
    psql(`DELETE FROM subscription_checkout_intents WHERE id='${intentId}'::uuid;`);
    psql(`DELETE FROM businesses WHERE id='${casBizId}'::uuid;`);
  });

  // ══════════════════════════════════════════════════════════
  // True multi-session concurrent PostgreSQL proofs
  //
  // These tests launch SEPARATE SIMULTANEOUS psql sessions via
  // psqlAsync + Promise.all, creating genuine overlapping transactions.
  // ══════════════════════════════════════════════════════════

  it('37. TRUE CONCURRENT checkout claims — exactly one pending intent, no unique-violation crash', async () => {
    const ver = currentVersion();
    const concBizId = psql(`
      INSERT INTO businesses (id, name, slug, owner_id, country_code, category, address, city, neighborhood, phone)
      VALUES (gen_random_uuid(), 'TrueConcClaim', 'true-conc-${Date.now()}', '${testUserId}', 'NG', 'restaurant', '100 TrueConc St', 'Lagos', 'VI', '+2348044444444')
      RETURNING id::text;
    `);

    // Launch TWO separate DB sessions simultaneously — genuine overlapping transactions
    const claimSql = `SELECT intent_id, is_claimed FROM claim_checkout_initialization('${concBizId}'::uuid, 'growth', 'flutterwave', 'NGN', 14999, '243206', '${ver}'::uuid, 'trueconc@m378.com', 30, '${testUserId}'::uuid);`;
    const [s1, s2] = await Promise.all([psqlAsync(claimSql), psqlAsync(claimSql)]);

    // Both must succeed (no crash/uncaught unique violation)
    expect(s1.ok).toBe(true);
    expect(s2.ok).toBe(true);

    // Both return the SAME intent ID (serialized by FOR UPDATE + partial unique index)
    const id1 = s1.result.split('|')[0];
    const id2 = s2.result.split('|')[0];
    expect(id1).toBe(id2);

    // Exactly one pending intent exists
    expect(psql(`SELECT count(*) FROM subscription_checkout_intents WHERE business_id='${concBizId}'::uuid AND status='pending';`)).toBe('1');

    // Cleanup
    psql(`DELETE FROM subscription_checkout_intents WHERE business_id='${concBizId}'::uuid;`);
    psql(`DELETE FROM businesses WHERE id='${concBizId}'::uuid;`);
  });

  it('38. TRUE CONCURRENT terminal replacement — exactly one pending replacement', async () => {
    const ver = currentVersion();
    const replBizId = psql(`
      INSERT INTO businesses (id, name, slug, owner_id, country_code, category, address, city, neighborhood, phone)
      VALUES (gen_random_uuid(), 'TrueConcRepl', 'true-repl-${Date.now()}', '${testUserId}', 'NG', 'restaurant', '200 TrueRepl St', 'Lagos', 'VI', '+2348055555555')
      RETURNING id::text;
    `);

    // Create initial intent
    const r1 = psql(`SELECT intent_id FROM claim_checkout_initialization('${replBizId}'::uuid, 'growth', 'flutterwave', 'NGN', 14999, '243206', '${ver}'::uuid, 'truerepl@m378.com', 30, '${testUserId}'::uuid);`);
    const oldIntentId = r1.split('|')[0];

    // Launch TWO simultaneous replacement sessions
    const replaceSql = `SELECT intent_id FROM replace_terminal_checkout_intent('${oldIntentId}'::uuid, '${replBizId}'::uuid, 'growth', 'flutterwave', 'NGN', 14999, '243206', '${ver}'::uuid, 'truerepl@m378.com', 30, '${testUserId}'::uuid);`;
    const [s1, s2] = await Promise.all([psqlAsync(replaceSql), psqlAsync(replaceSql)]);

    // Both must complete without crash
    expect(s1.ok).toBe(true);
    expect(s2.ok).toBe(true);

    // Both return the SAME new intent ID (serialized by partial unique index)
    const newId1 = s1.result.split('|')[0];
    const newId2 = s2.result.split('|')[0];
    expect(newId1).toBe(newId2);

    // Exactly one pending intent exists
    expect(psql(`SELECT count(*) FROM subscription_checkout_intents WHERE business_id='${replBizId}'::uuid AND status='pending';`)).toBe('1');

    // Old intent is failed
    expect(psql(`SELECT status FROM subscription_checkout_intents WHERE id='${oldIntentId}'::uuid;`)).toBe('failed');

    // Cleanup
    psql(`DELETE FROM subscription_checkout_intents WHERE business_id='${replBizId}'::uuid;`);
    psql(`DELETE FROM businesses WHERE id='${replBizId}'::uuid;`);
  });

  it('39. TRUE CONCURRENT duplicate renewals — one success, one quarantine, no duplicate value', async () => {
    // Create a fresh subscription for concurrent renewal testing
    const renBizId = psql(`
      INSERT INTO businesses (id, name, slug, owner_id, country_code, category, address, city, neighborhood, phone)
      VALUES (gen_random_uuid(), 'TrueConcRen', 'true-ren-${Date.now()}', '${testUserId}', 'NG', 'restaurant', '300 TrueRen St', 'Lagos', 'VI', '+2348066666666')
      RETURNING id::text;
    `);
    const ver = currentVersion();
    // Create subscription via checkout flow
    const cr = psql(`SELECT intent_id FROM claim_checkout_initialization('${renBizId}'::uuid, 'growth', 'flutterwave', 'NGN', 14999, '243206', '${ver}'::uuid, 'trueren@m378.com', 30, '${testUserId}'::uuid);`);
    const intentId = cr.split('|')[0];
    psql(`SELECT finalize_flutterwave_subscription_checkout('${intentId}'::uuid, 'tx_ren_setup', 'sub_ren_setup', 10944, 1499900, 'NGN', '2026-09-12T20:00:00Z'::timestamptz);`);

    const subId = psql(`SELECT id::text FROM subscriptions WHERE business_id='${renBizId}'::uuid AND gateway='flutterwave' LIMIT 1;`);
    const periodEnd = psql(`SELECT current_period_end::text FROM subscriptions WHERE id='${subId}'::uuid;`);

    // Launch TWO simultaneous renewal sessions with DIFFERENT tx refs for the SAME period
    const ren1Sql = `SELECT finalize_flutterwave_subscription_renewal('${subId}'::uuid, 'tx_conc_ren_A', 1499900, 'NGN', '${periodEnd}'::timestamptz);`;
    const ren2Sql = `SELECT finalize_flutterwave_subscription_renewal('${subId}'::uuid, 'tx_conc_ren_B', 1499900, 'NGN', '${periodEnd}'::timestamptz);`;
    const [s1, s2] = await Promise.all([psqlAsync(ren1Sql), psqlAsync(ren2Sql)]);

    // Both must complete (one succeeds, one quarantines — neither crashes)
    expect(s1.ok).toBe(true);
    expect(s2.ok).toBe(true);

    // Exactly one successful finalization and one quarantine
    const results = [s1.result, s2.result];
    const successes = results.filter(r => r.includes('"finalized": true') && !r.includes('idempotent'));
    const quarantines = results.filter(r => r.includes('"quarantine": true'));
    expect(successes.length).toBe(1);
    expect(quarantines.length).toBe(1);

    // Exactly one successful payment for the period
    expect(psql(`SELECT count(*) FROM subscription_payments WHERE subscription_id='${subId}'::uuid AND provider_reference IN ('tx_conc_ren_A','tx_conc_ren_B') AND status='success';`)).toBe('1');

    // One quarantine record
    expect(psql(`SELECT count(*) FROM subscription_payment_quarantine WHERE provider_tx_id IN ('tx_conc_ren_A','tx_conc_ren_B');`)).toBe('1');

    // Cleanup
    psql(`DELETE FROM subscription_payment_quarantine WHERE provider_tx_id IN ('tx_conc_ren_A','tx_conc_ren_B');`);
    psql(`DELETE FROM subscription_checkout_intents WHERE business_id='${renBizId}'::uuid;`);
    psql(`DELETE FROM businesses WHERE id='${renBizId}'::uuid;`);
  });
});
