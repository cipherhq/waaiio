/**
 * Cross-Border Billing DB Tests — Lane 3
 *
 * Proves that authorize_message_send uses the BUSINESS country to resolve
 * billing currency, not the recipient country. Owner-approved policy:
 *   "Charge the business-country messaging rate in the business's configured
 *    currency, regardless of the recipient's country."
 *
 *   TEST_DATABASE_URL=postgresql://localhost:5432/waaiio_test \
 *     npx vitest run lib/__tests__/cross-border-billing-db.test.ts
 */
import { execSync } from 'child_process';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

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
  } catch (e: unknown) {
    return (e as { stderr?: string }).stderr || String(e);
  }
}

// Isolated test UUIDs to avoid collision with other suites
const BIZ_NG   = 'b0000000-0000-0000-0000-00000000cb01';  // Nigerian business
const BIZ_US   = 'b0000000-0000-0000-0000-00000000cb02';  // US business
const BIZ_GH   = 'b0000000-0000-0000-0000-00000000cb03';  // Ghanaian business
const OWNER_NG = '00000000-0000-0000-0000-00000000cb01';
const OWNER_US = '00000000-0000-0000-0000-00000000cb02';
const OWNER_GH = '00000000-0000-0000-0000-00000000cb03';

describe.skipIf(!canRun)('Cross-Border Billing — business-country pricing (#Lane3)', () => {
  let configVersionId: string;

  beforeAll(() => {
    // Seed test users
    for (const [uid, email] of [
      [OWNER_NG, 'ownerng-cb@test.com'],
      [OWNER_US, 'ownerus-cb@test.com'],
      [OWNER_GH, 'ownergh-cb@test.com'],
    ] as const) {
      psqlMayFail(`INSERT INTO auth.users (id, email, raw_app_meta_data) VALUES ('${uid}', '${email}', '{}') ON CONFLICT (id) DO NOTHING;`);
    }

    // Seed businesses with explicit country_code
    for (const [bizId, name, slug, owner, country] of [
      [BIZ_NG, 'TestNG-CB', 'testng-cb', OWNER_NG, 'NG'],
      [BIZ_US, 'TestUS-CB', 'testus-cb', OWNER_US, 'US'],
      [BIZ_GH, 'TestGH-CB', 'testgh-cb', OWNER_GH, 'GH'],
    ] as const) {
      const r = psqlMayFail(`
        INSERT INTO businesses (id, name, slug, owner_id, country_code, address, city, neighborhood, phone)
        VALUES ('${bizId}', '${name}', '${slug}', '${owner}', '${country}', '1 Test', 'T', 'T', '+1')
        ON CONFLICT (id) DO UPDATE SET country_code = '${country}';
      `);
      if (r.includes('ERROR') && !r.includes('duplicate')) throw new Error(r);
    }

    // Seed multi-currency pricing config with GHS added
    configVersionId = psql(`
      INSERT INTO platform_config_versions (config_snapshot, effective_from, created_by)
      VALUES ('${JSON.stringify({
        messaging_financial_gate: true,
        messaging_pricing: {
          NGN: {
            default_cost_minor: 500,
            rates: { NG: { marketing: 800, utility: 300, authentication: 200, service: 500, '*': 500 } },
            default_spend_cap_minor: 500000,
          },
          USD: {
            default_cost_minor: 8,
            rates: { US: { marketing: 12, utility: 5, authentication: 4, service: 8, '*': 8 }, CA: { marketing: 10, utility: 5, service: 8, '*': 8 } },
            default_spend_cap_minor: 50000,
          },
          GHS: {
            default_cost_minor: 50,
            rates: { GH: { marketing: 80, utility: 30, authentication: 20, service: 50, '*': 50 } },
            default_spend_cap_minor: 500000,
          },
        },
      })}'::JSONB, NOW() + INTERVAL '999 microseconds', '${OWNER_NG}')
      RETURNING id;
    `);

    // Seed generous allowances in each business's own currency
    for (const [bizId, currency, amount] of [
      [BIZ_NG, 'NGN', 1000000],
      [BIZ_US, 'USD', 100000],
      [BIZ_GH, 'GHS', 1000000],
    ] as const) {
      psql(`INSERT INTO messaging_allowances (business_id, type, amount_minor, currency_code, remaining_minor, source_ref)
            VALUES ('${bizId}', 'purchased', ${amount}, '${currency}', ${amount}, 'cb-test-seed-${bizId}-${Date.now()}');`);
    }
  });

  // Helper: create a business-scoped attempt with explicit recipient country
  function createAttempt(bizId: string, recipientCountry: string, category: string): string {
    return psql(`INSERT INTO message_send_attempts (business_id, recipient_phone, attempt_scope, recipient_country_code, message_category) VALUES ('${bizId}', '+1', 'business', '${recipientCountry}', '${category}') RETURNING id;`);
  }

  // ═══════════════════════════════════════════════════════
  // 1. Core cross-border: NG business → US recipient = NGN billing
  // ═══════════════════════════════════════════════════════

  it('1. NG business → US recipient charges in NGN at NG rate', () => {
    const attemptId = createAttempt(BIZ_NG, 'US', 'service');
    const result = JSON.parse(psql(`SELECT public.authorize_message_send('${attemptId}');`));

    expect(result.authorized).toBe(true);
    expect(result.currency_code).toBe('NGN');
    expect(result.cost_minor).toBe(500); // NG service rate, not US rate
  });

  it('2. US business → NG recipient charges in USD at US rate', () => {
    const attemptId = createAttempt(BIZ_US, 'NG', 'service');
    const result = JSON.parse(psql(`SELECT public.authorize_message_send('${attemptId}');`));

    expect(result.authorized).toBe(true);
    expect(result.currency_code).toBe('USD');
    expect(result.cost_minor).toBe(8); // US service rate, not NG rate
  });

  it('3. GH business → US recipient charges in GHS at GH rate', () => {
    const attemptId = createAttempt(BIZ_GH, 'US', 'marketing');
    const result = JSON.parse(psql(`SELECT public.authorize_message_send('${attemptId}');`));

    expect(result.authorized).toBe(true);
    expect(result.currency_code).toBe('GHS');
    expect(result.cost_minor).toBe(80); // GH marketing rate
  });

  // ═══════════════════════════════════════════════════════
  // 2. Same-country sends still work correctly
  // ═══════════════════════════════════════════════════════

  it('4. NG business → NG recipient (same-country) still charges NGN', () => {
    const attemptId = createAttempt(BIZ_NG, 'NG', 'marketing');
    const result = JSON.parse(psql(`SELECT public.authorize_message_send('${attemptId}');`));

    expect(result.authorized).toBe(true);
    expect(result.currency_code).toBe('NGN');
    expect(result.cost_minor).toBe(800); // NG marketing rate
  });

  it('5. US business → US recipient (same-country) still charges USD', () => {
    const attemptId = createAttempt(BIZ_US, 'US', 'utility');
    const result = JSON.parse(psql(`SELECT public.authorize_message_send('${attemptId}');`));

    expect(result.authorized).toBe(true);
    expect(result.currency_code).toBe('USD');
    expect(result.cost_minor).toBe(5); // US utility rate
  });

  // ═══════════════════════════════════════════════════════
  // 3. Recipient country stays on the attempt record (analytics)
  // ═══════════════════════════════════════════════════════

  it('6. Recipient country preserved on attempt after cross-border authorization', () => {
    const attemptId = createAttempt(BIZ_NG, 'US', 'utility');
    psql(`SELECT public.authorize_message_send('${attemptId}');`);

    const row = psql(`SELECT recipient_country_code || '|' || currency_code FROM message_send_attempts WHERE id = '${attemptId}';`);
    expect(row).toBe('US|NGN'); // recipient = US, billing = NGN
  });

  // ═══════════════════════════════════════════════════════
  // 4. Business with no matching currency → fail closed
  // ═══════════════════════════════════════════════════════

  it('7. Business in unconfigured country → no_currency_for_country', () => {
    // Create a business with country_code = 'ZZ' (not in pricing config)
    const zzBiz = psql(`SELECT gen_random_uuid();`);
    const zzOwner = psql(`SELECT gen_random_uuid();`);
    psqlMayFail(`INSERT INTO auth.users (id, email, raw_app_meta_data) VALUES ('${zzOwner}', '${zzBiz.substring(0,8)}@cbtest.com', '{}') ON CONFLICT (id) DO NOTHING;`);
    psqlMayFail(`INSERT INTO businesses (id, name, slug, owner_id, country_code, address, city, neighborhood, phone) VALUES ('${zzBiz}', 'TestZZ', 'testzz-${zzBiz.substring(0,8)}', '${zzOwner}', 'ZZ', '1 Test', 'T', 'T', '+1');`);

    const attemptId = createAttempt(zzBiz, 'US', 'service');
    const result = JSON.parse(psql(`SELECT public.authorize_message_send('${attemptId}');`));
    expect(result.authorized).toBe(false);
    expect(result.reason).toBe('no_currency_for_country');
  });

  // ═══════════════════════════════════════════════════════
  // 5. Insufficient balance in own currency (not cross-currency leak)
  // ═══════════════════════════════════════════════════════

  it('8. NG business with depleted NGN balance → insufficient even for US recipient', () => {
    // Create isolated NG business with zero remaining allowance
    const biz = psql(`SELECT gen_random_uuid();`);
    const owner = psql(`SELECT gen_random_uuid();`);
    psqlMayFail(`INSERT INTO auth.users (id, email, raw_app_meta_data) VALUES ('${owner}', '${biz.substring(0,8)}@cbdrain.com', '{}') ON CONFLICT (id) DO NOTHING;`);
    psqlMayFail(`INSERT INTO businesses (id, name, slug, owner_id, country_code, address, city, neighborhood, phone) VALUES ('${biz}', 'DrainNG', 'drainng-${biz.substring(0,8)}', '${owner}', 'NG', '1 Test', 'T', 'T', '+1');`);
    // Allowance with zero remaining
    psql(`INSERT INTO messaging_allowances (business_id, type, amount_minor, currency_code, remaining_minor, source_ref) VALUES ('${biz}', 'purchased', 100, 'NGN', 0, 'cb-drain-${Date.now()}');`);

    const attemptId = createAttempt(biz, 'US', 'service');
    const result = JSON.parse(psql(`SELECT public.authorize_message_send('${attemptId}');`));
    expect(result.authorized).toBe(false);
    expect(result.reason).toBe('insufficient_allowance_balance');
  });

  // ═══════════════════════════════════════════════════════
  // 6. 3-arg overload consistency
  // ═══════════════════════════════════════════════════════

  it('9. 3-arg overload: NG business → US recipient charges NGN', () => {
    const attemptId = createAttempt(BIZ_NG, 'US', 'utility');
    const result = JSON.parse(psql(`SELECT public.authorize_message_send('${attemptId}', '${configVersionId}'::UUID, NOW());`));

    expect(result.authorized).toBe(true);
    expect(result.currency_code).toBe('NGN');
    expect(result.cost_minor).toBe(300); // NG utility rate
  });
});
