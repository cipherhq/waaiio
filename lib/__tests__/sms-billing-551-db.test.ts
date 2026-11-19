/**
 * M551 SMS billing — real PostgreSQL tests (#1131, Owner decisions 2026-11-18).
 *
 * Proves, against the full migration history (CI waaiio_test database):
 * - SMS price per page = ceil(sms_cost * 1.2), times units (pages);
 * - no fallback to '*' or default_cost_minor for an unpriced country;
 * - NG/GH businesses only, recipient in the business's own country;
 * - units other than 1 are refused for every non-SMS category;
 * - charge and release settle exactly the reserved amount;
 * - the admin save path accepts sms_cost; sms_sends is server-only.
 *
 * This suite FAILS, never skips, without a database.
 *
 *   TEST_DATABASE_URL=postgresql://localhost:5432/waaiio_test \
 *     npx vitest run lib/__tests__/sms-billing-551-db.test.ts
 */
import { execSync } from 'child_process';
import { randomUUID } from 'crypto';
import { describe, it, expect, beforeAll } from 'vitest';

const dbUrl = process.env.TEST_DATABASE_URL || '';
if (!dbUrl) throw new Error('TEST_DATABASE_URL is required for the M551 SMS billing tests');

function psql(sql: string): string {
  return execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1`, { input: sql, encoding: 'utf-8', timeout: 30000 }).trim();
}

function psqlError(sql: string): string {
  try {
    execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1`, { input: sql, encoding: 'utf-8', timeout: 30000, stdio: 'pipe' });
    return '';
  } catch (e: unknown) {
    return String((e as { stderr?: string }).stderr || e);
  }
}

const BIZ_NG = 'b0000000-0000-0000-0000-000000005511';
const BIZ_GH = 'b0000000-0000-0000-0000-000000005512';
const BIZ_US = 'b0000000-0000-0000-0000-000000005513';
// Fresh per run, so its balance is exactly the seeded 1,000 kobo.
const BIZ_POOR = randomUUID();
const OWNER = '00000000-0000-0000-0000-000000005511';

const PRICING = {
  NGN: { default_cost_minor: 500, default_spend_cap_minor: 10000000,
    rates: { NG: { marketing: 800, utility: 300, service: 0, '*': 500, sms_cost: 698 } } },
  GHS: { default_cost_minor: 50, default_spend_cap_minor: 10000000,
    rates: { GH: { marketing: 80, utility: 30, '*': 50, sms_cost: 50 } } },
  USD: { default_cost_minor: 8, default_spend_cap_minor: 50000,
    rates: { US: { marketing: 12, utility: 5, '*': 8, sms_cost: 1 } } },
};

function setConfig(pricing: unknown, gate = true): string {
  return psql(`INSERT INTO platform_config_versions (config_snapshot, effective_from, created_by)
    VALUES ('${JSON.stringify({ messaging_financial_gate: gate, messaging_pricing: pricing })}'::jsonb, clock_timestamp(), '${OWNER}')
    RETURNING id;`);
}

function attempt(biz: string, recipientCountry: string, category: string, units = 1): string {
  return psql(`INSERT INTO message_send_attempts (business_id, recipient_phone, attempt_scope, recipient_country_code, message_category, units)
    VALUES ('${biz}', '+2348012345678', 'business', '${recipientCountry}', '${category}', ${units}) RETURNING id;`);
}

const authorize = (id: string) => JSON.parse(psql(`SELECT public.authorize_message_send('${id}');`));
const remaining = (biz: string) => Number(psql(`SELECT COALESCE(SUM(remaining_minor),0) FROM messaging_allowances WHERE business_id='${biz}';`));

describe('M551 SMS billing (real PostgreSQL)', () => {
  beforeAll(() => {
    psql(`INSERT INTO auth.users (id, email, raw_app_meta_data) VALUES ('${OWNER}', 'owner-551@test.com', '{"role":"admin"}') ON CONFLICT (id) DO NOTHING;`);
    for (const [id, slug, country] of [[BIZ_NG, 'sms551-ng', 'NG'], [BIZ_GH, 'sms551-gh', 'GH'], [BIZ_US, 'sms551-us', 'US'], [BIZ_POOR, `sms551-poor-${BIZ_POOR.slice(0, 8)}`, 'NG']]) {
      psql(`INSERT INTO businesses (id, name, slug, owner_id, country_code, address, city, neighborhood, phone)
        VALUES ('${id}', '${slug}', '${slug}', '${OWNER}', '${country}', '1 Test', 'T', 'T', '+1')
        ON CONFLICT (id) DO UPDATE SET country_code = EXCLUDED.country_code;`);
    }
    for (const [id, currency, amount] of [[BIZ_NG, 'NGN', 1000000], [BIZ_GH, 'GHS', 1000000], [BIZ_US, 'USD', 100000], [BIZ_POOR, 'NGN', 1000]] as const) {
      psql(`INSERT INTO messaging_allowances (business_id, type, amount_minor, currency_code, remaining_minor, source_ref)
        VALUES ('${id}', 'purchased', ${amount}, '${currency}', ${amount}, 'm551-seed-${id}-${Date.now()}');`);
    }
    setConfig(PRICING);
  });

  it('NG: one page costs ceil(698 x 1.2) = 838 kobo (₦8.38)', () => {
    const r = authorize(attempt(BIZ_NG, 'NG', 'sms'));
    expect(r).toMatchObject({ authorized: true, cost_minor: 838, currency_code: 'NGN' });
  });

  it('three pages cost 3 x 838 and reserve exactly that much', () => {
    const before = remaining(BIZ_NG);
    const id = attempt(BIZ_NG, 'NG', 'sms', 3);
    expect(authorize(id)).toMatchObject({ authorized: true, cost_minor: 2514 });
    expect(remaining(BIZ_NG)).toBe(before - 2514);
    expect(psql(`SELECT estimated_cost_minor || ':' || financial_disposition FROM message_send_attempts WHERE id='${id}';`)).toBe('2514:reserved');
  });

  it('GH: priced in GHS from the GH sms_cost (ceil(50 x 1.2) = 60)', () => {
    expect(authorize(attempt(BIZ_GH, 'GH', 'sms'))).toMatchObject({ authorized: true, cost_minor: 60, currency_code: 'GHS' });
  });

  it('refuses an NG business texting a Ghana number (same country only)', () => {
    const before = remaining(BIZ_NG);
    expect(authorize(attempt(BIZ_NG, 'GH', 'sms'))).toMatchObject({ authorized: false, reason: 'sms_country_not_allowed' });
    expect(remaining(BIZ_NG)).toBe(before);
  });

  it('refuses SMS for a business outside NG/GH even when a rate exists', () => {
    expect(authorize(attempt(BIZ_US, 'US', 'sms'))).toMatchObject({ authorized: false, reason: 'sms_country_not_allowed' });
  });

  it('refuses units other than 1 for WhatsApp categories; marketing is unchanged at 1 unit', () => {
    expect(authorize(attempt(BIZ_NG, 'NG', 'marketing', 2))).toMatchObject({ authorized: false, reason: 'invalid_units' });
    expect(authorize(attempt(BIZ_NG, 'NG', 'marketing'))).toMatchObject({ authorized: true, cost_minor: 800 });
  });

  it('the units column only accepts 1-10 pages', () => {
    expect(psqlError(`INSERT INTO message_send_attempts (business_id, recipient_phone, attempt_scope, message_category, units)
      VALUES ('${BIZ_NG}', '+2348012345678', 'business', 'sms', 11);`)).toContain('message_send_attempts_units_check');
    expect(psqlError(`INSERT INTO message_send_attempts (business_id, recipient_phone, attempt_scope, message_category, units)
      VALUES ('${BIZ_NG}', '+2348012345678', 'business', 'sms', 0);`)).toContain('message_send_attempts_units_check');
  });

  it('short credit refuses without reserving anything', () => {
    const before = remaining(BIZ_POOR);
    expect(authorize(attempt(BIZ_POOR, 'NG', 'sms', 2))).toMatchObject({ authorized: false, reason: 'insufficient_allowance_balance' });
    expect(remaining(BIZ_POOR)).toBe(before);
  });

  it('charged keeps the reserved amount; released gives it back', () => {
    const charged = attempt(BIZ_NG, 'NG', 'sms', 2);
    const start = remaining(BIZ_NG);
    authorize(charged);
    expect(JSON.parse(psql(`SELECT public.settle_message_cost('${charged}', 'charged');`)).settled).toBe(true);
    expect(remaining(BIZ_NG)).toBe(start - 1676);

    const released = attempt(BIZ_NG, 'NG', 'sms', 2);
    authorize(released);
    expect(remaining(BIZ_NG)).toBe(start - 1676 * 2);
    expect(JSON.parse(psql(`SELECT public.settle_message_cost('${released}', 'released');`)).settled).toBe(true);
    expect(remaining(BIZ_NG)).toBe(start - 1676);
  });

  it('with the financial gate off nothing is reserved (the app then refuses the SMS)', () => {
    setConfig(PRICING, false);
    const before = remaining(BIZ_NG);
    const id = attempt(BIZ_NG, 'NG', 'sms');
    expect(JSON.parse(psql(`SELECT public.check_or_authorize_send('${id}');`))).toMatchObject({ enforcement_required: false });
    expect(remaining(BIZ_NG)).toBe(before);
    setConfig(PRICING);
  });

  it('an unpriced country is refused, never charged the * or default rate', () => {
    setConfig({ ...PRICING, NGN: { ...PRICING.NGN, rates: { NG: { marketing: 800, utility: 300, '*': 500 } } } });
    expect(authorize(attempt(BIZ_NG, 'NG', 'sms'))).toMatchObject({ authorized: false, reason: 'unresolved_rate' });
    setConfig({ ...PRICING, NGN: { ...PRICING.NGN, rates: { NG: { ...PRICING.NGN.rates.NG, sms_cost: 0 } } } });
    expect(authorize(attempt(BIZ_NG, 'NG', 'sms'))).toMatchObject({ authorized: false, reason: 'unresolved_rate' });
    setConfig(PRICING);
  });

  it('the 3-argument overload (used by check_or_authorize_send) prices SMS the same way', () => {
    const id = attempt(BIZ_NG, 'NG', 'sms', 2);
    expect(JSON.parse(psql(`SELECT public.check_or_authorize_send('${id}');`))).toMatchObject({ authorized: true, cost_minor: 1676 });
  });

  it('the admin save path accepts sms_cost and still rejects unknown keys', () => {
    const latest = () => psql(`SELECT id FROM platform_config_versions WHERE effective_from <= clock_timestamp() ORDER BY effective_from DESC LIMIT 1;`);
    const save = (pricing: unknown) => `SELECT public._save_messaging_config_impl('${OWNER}', '${JSON.stringify(pricing)}'::jsonb, '{}'::jsonb, '{}'::jsonb, '${latest()}', 'm551 test');`;
    expect(psql(save(PRICING))).toMatch(/^[0-9a-f-]{36}$/);
    expect(psqlError(save({ ...PRICING, NGN: { ...PRICING.NGN, rates: { NG: { sms: 838 } } } }))).toContain('unknown rate key "sms"');
    expect(psqlError(save({ ...PRICING, NGN: { ...PRICING.NGN, rates: { NG: { sms_cost: 6.98 } } } }))).toContain('must be a non-negative integer');
    setConfig(PRICING);
  });

  it('M551 kept SECURITY DEFINER, search_path and service-role-only execution', () => {
    for (const sig of ['public.authorize_message_send(uuid)', 'public.authorize_message_send(uuid,uuid,timestamp with time zone)']) {
      expect(psql(`SELECT prosecdef || ':' || array_to_string(proconfig, ',') FROM pg_proc WHERE oid = '${sig}'::regprocedure;`)).toBe('true:search_path=""');
      expect(psql(`SELECT has_function_privilege('authenticated', '${sig}'::regprocedure, 'EXECUTE') OR has_function_privilege('anon', '${sig}'::regprocedure, 'EXECUTE');`)).toBe('f');
    }
  });

  it('sms_sends: deny-all RLS, no client rights, no deletes, one row per idempotency key, scope shape enforced', () => {
    expect(psql(`SELECT relrowsecurity FROM pg_class WHERE oid = 'public.sms_sends'::regclass;`)).toBe('t');
    for (const role of ['anon', 'authenticated']) {
      expect(psql(`SELECT has_table_privilege('${role}', 'public.sms_sends', 'SELECT') OR has_table_privilege('${role}', 'public.sms_sends', 'INSERT');`)).toBe('f');
    }
    expect(psql(`SELECT has_table_privilege('service_role', 'public.sms_sends', 'DELETE');`)).toBe('f');
    expect(psql(`SELECT has_table_privilege('service_role', 'public.sms_sends', 'INSERT') AND has_table_privilege('service_role', 'public.sms_sends', 'UPDATE');`)).toBe('t');

    const key = `m551-test-${Date.now()}`;
    const row = (k: string, scope: string, biz: string | null, purpose: string) =>
      `INSERT INTO sms_sends (idempotency_key, scope, business_id, purpose, phone, pages, unicode, status)
       VALUES ('${k}', '${scope}', ${biz ? `'${biz}'` : 'NULL'}, '${purpose}', '2348012345678', 1, false, 'sending');`;
    psql(row(key, 'business', BIZ_NG, 'campaign'));
    expect(psqlError(row(key, 'business', BIZ_NG, 'campaign'))).toContain('sms_sends_idempotency_key_key');
    expect(psqlError(row(`${key}-p`, 'platform', BIZ_NG, 'admin_broadcast'))).toContain('sms_sends_scope_shape_check');
    expect(psqlError(row(`${key}-q`, 'business', BIZ_NG, 'admin_broadcast'))).toContain('sms_sends_scope_shape_check');
    expect(psqlError(row(`${key}-r`, 'business', BIZ_NG, 'campaign').replace("'2348012345678'", "'14155550100'"))).toContain('sms_sends_phone_check');
    psql(row(`${key}-s`, 'platform', null, 'admin_broadcast'));
  });
});
