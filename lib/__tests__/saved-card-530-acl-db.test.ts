/** #530 / M427 PostgreSQL proof; CI runs this after migration bootstrap. */
import { execSync } from 'child_process';
import { describe, expect, it } from 'vitest';

const dbUrl = process.env.TEST_DATABASE_URL || '';
function sql(statement: string) {
  return execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1`, { input: statement, encoding: 'utf8' }).trim();
}

describe.skipIf(!dbUrl)('M427 saved-card ACL and RPC', () => {
  it('grants service CRUD, denies client access, and enforces canonical payment predicates', () => {
    expect(sql(`SELECT relrowsecurity FROM pg_class WHERE oid='public.saved_payment_methods'::regclass`)).toBe('t');
    for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
      expect(sql(`SELECT has_table_privilege('service_role','public.saved_payment_methods','${p}')`)).toBe('t');
      expect(sql(`SELECT has_table_privilege('anon','public.saved_payment_methods','${p}')`)).toBe('f');
      expect(sql(`SELECT has_table_privilege('authenticated','public.saved_payment_methods','${p}')`)).toBe('f');
    }
    const id = '00000000-0000-4530-a000-000000000001';
    sql(`DELETE FROM payments WHERE id='${id}'; INSERT INTO payments(id,amount,currency,gateway_reference,gateway,status,metadata) VALUES ('${id}',5000,'NGN','REF-530-TEST','paystack','pending','{"payment_origin":"platform","keep":"yes"}')`);
    const auth = `'{"authorization_code":"AUTH-530","email":"customer@example.test","reusable":true,"pan":"4111111111111111","cvv":"123"}'::jsonb`;
    const args = `'${id}',5000,'NGN',${auth}`;
    expect(sql(`SET ROLE service_role; SELECT persist_verified_paystack_card_authorization(${args}); RESET ROLE`)).toBe('t');
    expect(sql(`SET ROLE service_role; SELECT persist_verified_paystack_card_authorization(${args}); RESET ROLE`)).toBe('t');
    expect(sql(`SELECT metadata->>'keep' FROM payments WHERE id='${id}'`)).toBe('yes');
    expect(sql(`SELECT (metadata->'_card_authorization' ? 'pan') OR (metadata->'_card_authorization' ? 'cvv') FROM payments WHERE id='${id}'`)).toBe('f');
    expect(sql(`SET ROLE service_role; SELECT persist_verified_paystack_card_authorization('${id}',4000,'NGN',${auth}); RESET ROLE`)).toBe('f');
    sql(`DELETE FROM payments WHERE id='${id}'`);
  });
});
