import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import baseline from './precision-catalog-baseline.json';
import manifest from './precision-change-manifest.json';

// This suite operates only on an expressly disposable local database. It never
// falls back to an application URL or an existing Supabase environment.
const url = process.env.TAX_PRECISION_TEST_DATABASE_URL;
if (!url && process.env.REQUIRE_TAX_PG_TESTS === 'true') throw new Error('TAX_PRECISION_TEST_DATABASE_URL required');
if (url) {
  const parsed = new URL(url);
  if (!['127.0.0.1', 'localhost'].includes(parsed.hostname) || parsed.pathname !== '/waaiio_tax_precision_test') {
    throw new Error('Precision tests require the dedicated disposable local database');
  }
}
const root = process.cwd();
function sql(statement: string): string {
  return execFileSync('psql', [url!, '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1'], {
    input: statement, encoding: 'utf8', timeout: 30_000, stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}
function json(statement: string) { return JSON.parse(sql(statement)); }
const business = '10000000-0000-4000-8000-000000000001';
const owner = '10000000-0000-4000-8000-000000000002';
const payment = '10000000-0000-4000-8000-000000000003';
const order = '10000000-0000-4000-8000-000000000004';

describe.skipIf(!url)('M529 major-unit decimal persistence (disposable PostgreSQL)', () => {
  beforeAll(() => {
    sql(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='postgres') THEN CREATE ROLE postgres SUPERUSER; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role BYPASSRLS; END IF;
    END $$;
    DROP SCHEMA public CASCADE; CREATE SCHEMA public AUTHORIZATION postgres;
    DROP SCHEMA IF EXISTS private CASCADE; DROP SCHEMA IF EXISTS auth CASCADE;
    SET ROLE postgres; SET check_function_bodies=off;
    ${readFileSync(resolve(root, 'lib/tax/__tests__/precision-fixture.sql'), 'utf8')}
    GRANT USAGE ON SCHEMA public,auth TO authenticated,service_role,anon;
    ${baseline.filter(row => manifest.functions.some(f => f.name === row.name && f.schema === row.schema)).map(row => {
      const sig = `${row.schema}.${row.name}(${row.args.split(',').map(a => a.trim().split(' ').slice(1).join(' ')).join(',')})`;
      return `${row.definition}; REVOKE ALL ON FUNCTION ${sig} FROM PUBLIC,anon,authenticated,service_role;
        ${['authenticated', 'service_role'].filter(role => row.acl.includes(`${role}=X/`)).map(role => `GRANT EXECUTE ON FUNCTION ${sig} TO ${role};`).join('\n')}`;
    }).join('\n')}
    INSERT INTO public.payments(id,amount) VALUES('${payment}',10);
    `);
    sql(`SET ROLE postgres; ${readFileSync(resolve(root, 'supabase/migrations/529_merchant_tax_money_precision.sql'), 'utf8')}`);
    // Exercise the actual unchanged provenance trigger alongside the altered RPC.
    const guardSource = readFileSync(resolve(root, 'supabase/migrations/485_verified_gateway_fee_claim.sql'), 'utf8');
    const start = guardSource.indexOf('CREATE FUNCTION public.guard_payment_gateway_fee_claim()');
    const end = guardSource.indexOf('-- Compatibility entry point:', start);
    sql(`SET ROLE postgres; ${guardSource.slice(start, end)}`);
  }, 60_000);

  it('keeps historical 10 as ten major units and stores fractional totals exactly', () => {
    expect(sql(`SELECT amount::text FROM public.payments WHERE id='${payment}'`)).toBe('10.00');
    sql(`UPDATE public.payments SET amount=10.75 WHERE id='${payment}';
      INSERT INTO public.platform_fees(id,transaction_amount,fee_total,fee_flat,gateway_fee,reseller_commission)
      VALUES(gen_random_uuid(),10.75,0.30,0.10,0.29,0.01);`);
    expect(sql(`SELECT amount::text FROM public.payments WHERE id='${payment}'`)).toBe('10.75');
    expect(sql('SELECT (transaction_amount-fee_total-gateway_fee)::text FROM public.platform_fees')).toBe('10.16');
  });

  it('replaces old integer RPC overloads and retains role grants', () => {
    for (const f of manifest.functions) {
      expect(sql(`SELECT to_regprocedure('${f.after}') IS NOT NULL`)).toBe('t');
      if (f.before !== f.after) expect(sql(`SELECT to_regprocedure('${f.before}') IS NULL`)).toBe('t');
      expect(sql(`SELECT has_function_privilege('anon','${f.after}','EXECUTE')`)).toBe('f');
      const previous = baseline.find(row => row.name === f.name && row.schema === f.schema)!;
      for (const role of ['authenticated', 'service_role']) {
        expect(sql(`SELECT has_function_privilege('${role}','${f.after}','EXECUTE')`)).toBe(previous.acl.includes(`${role}=X/`) ? 't' : 'f');
      }
    }
  });

  it('claims and seals a fractional provider fee; later conflicting evidence is refused', () => {
    sql(`DELETE FROM public.payments WHERE id='${payment}';
      INSERT INTO public.payments(id,business_id,amount,currency,gateway,gateway_reference,status,gateway_fee_contract_version,gateway_fee)
      VALUES('${payment}','${business}',10.75,'USD','paystack','tax-precision-ref','success',1,0);`);
    const call = (fee: number) => `SET ROLE service_role; SELECT public.claim_payment_finalization_with_verified_fee('${payment}','paystack','tax-precision-ref',10.75,'USD',true,${fee});`;
    expect(json(call(0.29))).toMatchObject({ claimed: true, amount: 10.75, gateway_fee: 0.29 });
    expect(sql(`SELECT concat_ws(',',gateway_fee,verified_gateway_fee,gateway_fee_claim_snapshot) FROM public.payments WHERE id='${payment}'`)).toBe('0.29,0.29,0.29');
    expect(json(call(0.30))).toMatchObject({ claimed: false, reason: 'fee_conflict' });
    expect(json(call(0.291))).toMatchObject({ claimed: false, reason: 'invalid_gateway_fee' });
    expect(() => sql(`SET ROLE authenticated; SELECT public.claim_payment_finalization_with_verified_fee('${payment}','paystack','tax-precision-ref',10.75,'USD',true,0.29)`)).toThrow();
  });

  it('preserves decimal customer spend once for an order payment', () => {
    sql(`INSERT INTO public.orders(id,business_id,delivery_phone,total_amount) VALUES('${order}','${business}','15550000001',10.75);
      UPDATE public.payments SET order_id='${order}' WHERE id='${payment}';`);
    const call = `SET ROLE service_role; SELECT public.apply_payment_customer_visit_once('${payment}');`;
    expect(json(call)).toMatchObject({ applied: true, already_applied: false, visit_amount: 10.75 });
    expect(json(call)).toMatchObject({ applied: true, already_applied: true });
    expect(sql('SELECT visit_amount::text FROM public.payment_visit_applications')).toBe('10.75');
    expect(sql('SELECT total_spent::text FROM public.customer_profiles')).toBe('10.75');
  });

  it('keeps fractional revenue and the owner authorization check', () => {
    sql(`INSERT INTO public.businesses(id,owner_id) VALUES('${business}','${owner}');
      UPDATE public.orders SET status='confirmed' WHERE id='${order}';`);
    expect(sql(`SET ROLE authenticated; SET test.uid='${owner}'; SELECT public.get_order_revenue('${business}');`)).toBe('10.75');
    expect(sql(`SET ROLE authenticated; SET test.uid='10000000-0000-4000-8000-000000000099'; SELECT public.get_order_revenue('${business}');`)).toBe('0');
  });

  it('passes fractional total and deposit through the real slot writer without altering counts', () => {
    const result = json(`SET ROLE service_role; SELECT row_to_json(r) FROM public.book_slot_atomic(
      '${business}',NULL,NULL,NULL,'2027-01-01','10:00',1,3,'scheduling',3.25,'pending','pending',
      'Test','15550000001',NULL,NULL,NULL,NULL,'[]',NULL,10.75,NULL) r;`);
    expect(result.slot_available).toBe(true);
    expect(json(`SELECT json_build_object('total',total_amount,'deposit',deposit_amount,'quantity',quantity) FROM public.bookings WHERE id='${result.booking_id}'`))
      .toEqual({ total: 10.75, deposit: 3.25, quantity: 1 });
  });

  it('preserves fractional amounts in report and customer-history projections', () => {
    const prefix = `SET ROLE authenticated; SET test.uid='${owner}';`;
    expect(json(`${prefix} SELECT row_to_json(r) FROM public.get_business_revenue_totals('${business}') r;`))
      .toEqual({ booking_revenue: 10.75, order_revenue: 10.75, invoice_revenue: 0, total_revenue: 21.5 });
    const transactions = json(`${prefix} SELECT json_agg(r) FROM public.get_business_transactions('${business}') r;`);
    expect(transactions).toHaveLength(2);
    expect(transactions.map((row: { amount: number }) => row.amount)).toEqual([10.75, 10.75]);
    const profile = sql('SELECT id FROM public.customer_profiles LIMIT 1');
    const history = json(`${prefix} SELECT json_agg(r) FROM public.get_customer_history('${business}','${profile}') r;`);
    expect(history).toHaveLength(2);
    expect(history.map((row: { amount: number }) => row.amount)).toEqual([10.75, 10.75]);
    expect(sql(`SET ROLE authenticated; SET test.uid='10000000-0000-4000-8000-000000000099'; SELECT count(*) FROM public.get_business_transactions('${business}');`)).toBe('0');
  });
});
