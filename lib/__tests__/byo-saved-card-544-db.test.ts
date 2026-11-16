/** #1065 / M544 PostgreSQL proof: own-account (BYO) Paystack saved cards. CI runs this after migration bootstrap. */
import { execSync } from 'child_process';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

const dbUrl = process.env.TEST_DATABASE_URL || '';
function sql(statement: string) {
  return execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1`, { input: statement, encoding: 'utf8' }).trim();
}
function sqlError(statement: string): string {
  try {
    sql(statement);
  } catch (e) {
    return String((e as { stderr?: string }).stderr || e);
  }
  return '';
}

describe.skipIf(!dbUrl)('M544 own-account Paystack saved cards', () => {
  const ownerId = randomUUID();
  const businessId = randomUUID();
  const credentialId = randomUUID();
  const oldCredentialId = randomUUID();
  const phone = '+2348015440001';
  const card = (cols: string, vals: string) =>
    `INSERT INTO saved_payment_methods (customer_phone, gateway, is_active, authorization_code${cols}) VALUES ('${phone}','paystack',true${vals})`;

  function seed() {
    sql(`
      BEGIN;
      INSERT INTO auth.users (id) VALUES ('${ownerId}');
      INSERT INTO profiles (id) VALUES ('${ownerId}') ON CONFLICT (id) DO NOTHING;
      INSERT INTO businesses (id,owner_id,name,slug,address,city,phone,country_code,status)
        VALUES ('${businessId}','${ownerId}','BYO Saved Card','byo-card-${businessId}','1 Test','Lagos','+2340000544','NG','active');
      INSERT INTO business_payment_credentials (id,business_id,gateway,secret_key,platform_subaccount_code,is_active,verified_at)
        VALUES ('${oldCredentialId}','${businessId}','paystack','enc-old','ACCT_waaiio',false,now()),
               ('${credentialId}','${businessId}','paystack','enc-new','ACCT_waaiio',true,now());
      COMMIT;
    `);
  }

  it('replaces the single active index with shared and per-connection indexes, and keeps the RPC locked down', () => {
    expect(sql(`SELECT count(*) FROM pg_indexes WHERE schemaname='public' AND indexname='idx_saved_pm_customer_gateway_active'`)).toBe('0');
    expect(sql(`SELECT count(*) FROM pg_indexes WHERE schemaname='public' AND indexname IN ('idx_saved_pm_platform_active','idx_saved_pm_byo_active')`)).toBe('2');
    const fn = `'public.persist_verified_paystack_card_authorization(uuid,numeric,text,jsonb)'::regprocedure`;
    expect(sql(`SELECT prosecdef, proconfig FROM pg_proc WHERE oid=${fn}`)).toBe('t|{"search_path=pg_catalog, pg_temp"}');
    expect(sql(`SELECT has_function_privilege('service_role',${fn},'EXECUTE')`)).toBe('t');
    expect(sql(`SELECT has_function_privilege('anon',${fn},'EXECUTE')`)).toBe('f');
    expect(sql(`SELECT has_function_privilege('authenticated',${fn},'EXECUTE')`)).toBe('f');
    for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
      expect(sql(`SELECT has_table_privilege('anon','public.saved_payment_methods','${p}')`)).toBe('f');
      expect(sql(`SELECT has_table_privilege('authenticated','public.saved_payment_methods','${p}')`)).toBe('f');
    }
  });

  it('allows one shared and one own-account card per customer, scoped to the issuing connection', () => {
    seed();
    sql(card('', `,'AUTH-SHARED'`));
    // A shared card and the merchant's own-account card coexist.
    sql(card(',business_id,provider_credential_id', `,'AUTH-BYO','${businessId}','${credentialId}'`));
    // A second active shared card is still rejected.
    expect(sqlError(card('', `,'AUTH-SHARED-2'`))).toContain('idx_saved_pm_platform_active');
    // A second active card on the same connection is rejected.
    expect(sqlError(card(',business_id,provider_credential_id', `,'AUTH-BYO-2','${businessId}','${credentialId}'`)))
      .toContain('idx_saved_pm_byo_active');
    // A card from an earlier connection of the same merchant is a separate scope.
    sql(card(',business_id,provider_credential_id', `,'AUTH-BYO-OLD','${businessId}','${oldCredentialId}'`));
    // An own-account card must name its business.
    expect(sqlError(card(',provider_credential_id', `,'AUTH-BYO-NOBIZ','${credentialId}'`))).toContain('chk_saved_pm_byo_business');

    // Removing a connection removes only its cards.
    sql(`DELETE FROM business_payment_credentials WHERE id='${oldCredentialId}'`);
    expect(sql(`SELECT string_agg(authorization_code, ',' ORDER BY authorization_code) FROM saved_payment_methods WHERE customer_phone='${phone}'`))
      .toBe('AUTH-BYO,AUTH-SHARED');
    sql(`DELETE FROM saved_payment_methods WHERE customer_phone='${phone}'`);
  });

  it('records a reusable authorization for platform and own-account payments only', () => {
    const auth = `'{"authorization_code":"AUTH-544","email":"customer@example.com","reusable":true,"pan":"4111111111111111"}'::jsonb`;
    const results: Record<string, string> = {};
    for (const origin of ['byo', 'platform', 'connect']) {
      const id = randomUUID();
      sql(`INSERT INTO payments(id,business_id,amount,currency,gateway_reference,gateway,status,metadata)
        VALUES ('${id}','${businessId}',5000,'NGN','REF-544-${id}','paystack','pending','{"payment_origin":"${origin}"}')`);
      results[origin] = sql(`SET ROLE service_role; SELECT persist_verified_paystack_card_authorization('${id}',5000,'NGN',${auth}); RESET ROLE`);
      if (origin === 'byo') {
        expect(sql(`SELECT metadata->'_card_authorization'->>'authorization_code', metadata->'_card_authorization' ? 'pan' FROM payments WHERE id='${id}'`))
          .toBe('AUTH-544|f');
      }
      sql(`DELETE FROM payments WHERE id='${id}'`);
    }
    expect(results).toEqual({ byo: 't', platform: 't', connect: 'f' });
  });
});
