import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import modernBaseline from './finance-modern-refund-baseline.json';
import publicRefundBaseline from './finance-public-refund-baseline.json';
import bankOrderBaseline from './finance-bank-order-baseline.json';
const precisionSql = readFileSync('supabase/migrations/529_merchant_tax_money_precision.sql','utf8');
const bankNonorder = precisionSql.match(/CREATE OR REPLACE FUNCTION public\.confirm_nonorder_transfer_atomic\([\s\S]*?AS \$function\$[\s\S]*?\$function\$/)![0];

// Reduced, catalog-typed fixture: these tests execute M532 RPCs, not HTTP/provider
// integration or a full migration replay. Existing environments are never used.
const url = process.env.TAX_FINANCE_TEST_DATABASE_URL;
if (!url && process.env.REQUIRE_TAX_PG_TESTS === 'true') throw new Error('TAX_FINANCE_TEST_DATABASE_URL required');
if (url) {
  const parsed = new URL(url);
  if (!['127.0.0.1', 'localhost'].includes(parsed.hostname) || parsed.pathname !== '/waaiio_tax_finance_test') {
    throw new Error('Finance tests require the dedicated disposable local database');
  }
}
function sql(statement: string): string {
  return execFileSync('psql', [url!, '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1'], {
    input: statement, encoding: 'utf8', timeout: 30_000, stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}
function json(statement: string) { return JSON.parse(sql(statement)); }
const b = '10000000-0000-4000-8000-000000000001';
const actor = '10000000-0000-4000-8000-000000000002';
const q = (value: unknown) => `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
let counter = 10;
function sale(lines = [{ id: 'item', quantity: 2, netAmount: 1000, taxAmount: 200, grossAmount: 1200 }]) {
  const id = `10000000-0000-4000-8000-${String(counter++).padStart(12, '0')}`;
  const snapshot = { version: 1, currency: 'USD', lines, netAmount: lines.reduce((s,l)=>s+l.netAmount,0),
    taxAmount: lines.reduce((s,l)=>s+l.taxAmount,0), grossAmount: lines.reduce((s,l)=>s+l.grossAmount,0) };
  sql(`INSERT INTO public.orders(id,business_id,tax_snapshot) VALUES('${id}','${b}',${q(snapshot)})`);
  return id;
}
function reserve(id: string, amount: number, extra: object = {}) {
  return json(`SET ROLE service_role; SELECT public.reserve_merchant_tax_payment_980(${q({business_id:b, order_id:id,
    amount,currency:'USD',gateway:'stripe',gateway_reference:`ref-${counter++}`, ...extra})});`);
}
function settle(id: string) {
  sql(`SET ROLE service_role; SELECT public.bind_merchant_tax_fee_980('${id}'); RESET ROLE;
    UPDATE public.payments SET provider_init_state='dispatched',status='success' WHERE id='${id}';`);
}
function refund(id: string, amount: number, selection: unknown = null, request: string|null = null) {
  return json(`SET ROLE service_role; SELECT public.reserve_merchant_tax_refund_980('${id}','${b}',${amount},${selection===null?'NULL':q(selection)},${request?`'${request}'`:'NULL'},'test','${actor}','business');`);
}
describe.skipIf(!url)('M532 payment/refund authority (disposable PostgreSQL)', () => {
  beforeAll(() => {
    sql(`SET ROLE postgres; DROP SCHEMA public CASCADE; CREATE SCHEMA public AUTHORIZATION postgres;
      DROP SCHEMA IF EXISTS private CASCADE; DROP SCHEMA IF EXISTS auth CASCADE; DROP SCHEMA IF EXISTS accounting_private CASCADE;
      ${readFileSync('lib/tax/__tests__/precision-fixture.sql','utf8')}
      ALTER TABLE public.payments ALTER COLUMN amount TYPE numeric(20,2);
      ALTER TABLE public.orders ADD COLUMN tax_snapshot jsonb, ALTER COLUMN total_amount TYPE numeric(20,2);
      ALTER TABLE public.bookings ADD COLUMN tax_snapshot jsonb;
      ALTER TABLE public.invoices ADD COLUMN tax_snapshot jsonb;
      CREATE SCHEMA accounting_private;
      CREATE FUNCTION accounting_private.accounting_business_lock(uuid) RETURNS void LANGUAGE sql SET search_path='' AS $$ SELECT pg_advisory_xact_lock(hashtext('payout_settle:'||$1::text)) $$;
      CREATE TABLE public.merchant_accounting_holds(business_id uuid,active boolean);
      CREATE TABLE public.business_payouts(id uuid DEFAULT gen_random_uuid() PRIMARY KEY,business_id uuid,status varchar,currency varchar,period_start date,period_end date,net_amount numeric,gross_amount numeric,platform_fee numeric,gateway_fee numeric,payout_account_id uuid,covered_from timestamptz,covered_to timestamptz,flags jsonb,auto_generated boolean);
      CREATE TABLE public.payout_accounts(id uuid,business_id uuid,is_active boolean);
      CREATE TABLE public.payout_adjustments(id uuid default gen_random_uuid(),business_id uuid REFERENCES public.businesses(id),payout_id uuid NOT NULL REFERENCES public.business_payouts(id),payment_id uuid REFERENCES public.payments(id),amount numeric,reason text,currency varchar,applied_to_payout_id uuid REFERENCES public.business_payouts(id));
      SET check_function_bodies=off;
      ${modernBaseline[0].definition};
      ${publicRefundBaseline[0].definition};
      CREATE TABLE public.legacy_refund_accounting_membership(payment_id uuid);
      ${bankOrderBaseline[0].definition};
      ${bankNonorder};
      SET check_function_bodies=on;
      ALTER TABLE public.platform_fees ALTER COLUMN fee_total TYPE numeric(20,2);
      ALTER TABLE public.platform_fees ALTER COLUMN fee_flat TYPE numeric(20,2);
      ALTER TABLE public.platform_fees ALTER COLUMN transaction_amount TYPE numeric(20,2);
      CREATE TABLE public.pending_transfers(id uuid primary key,order_id uuid,business_id uuid,expected_amount integer,currency text,
        reference_code text,status text,expires_at timestamptz,metadata jsonb,customer_phone text,customer_name text,
        proof_submitted_at timestamptz,proof_protected boolean,confirmed_by uuid,confirmed_at timestamptz,
        booking_id uuid,invoice_id uuid,reservation_id uuid,campaign_id uuid);
      CREATE TABLE public.order_stock_applications(id uuid primary key default gen_random_uuid(),order_id uuid,reservation_class text,expires_at timestamptz,payment_id uuid);
      CREATE TABLE public.platform_settings(key text PRIMARY KEY,value jsonb);
      CREATE TABLE public.platform_config_versions(id uuid PRIMARY KEY,config_snapshot jsonb);
      GRANT USAGE ON SCHEMA public TO service_role,authenticated,anon;
      INSERT INTO public.businesses(id,subscription_tier) VALUES('${b}','free');
      INSERT INTO public.platform_settings VALUES('pricing_tiers','{"free":{"feePercentage":3,"feeFlat":0}}');
      ${readFileSync('supabase/migrations/532_merchant_tax_payment_refund_authority.sql','utf8')}`);
  },60_000);

  it.each([
    ['orders', 'order_id'], ['bookings', 'booking_id'], ['invoices', 'invoice_id'],
  ])('preserves untaxed GHS %s payments without creating a tax reservation', (table, sourceKey) => {
    const id = `10000000-0000-4000-8000-${String(counter++).padStart(12, '0')}`;
    sql(`INSERT INTO public.${table}(id,business_id,tax_snapshot) VALUES('${id}','${b}',NULL)`);
    const payment = { business_id: b, [sourceKey]: id, amount: 12.5, currency: 'GHS', gateway: 'paystack', gateway_reference: `legacy-${counter++}` };
    expect(json(`SET ROLE service_role; SELECT public.reserve_merchant_tax_payment_980(${q(payment)})`)).toEqual({ taxable: false });
    expect(sql(`SELECT count(*) FROM public.merchant_tax_payment_ledger WHERE entity_id='${id}'`)).toBe('0');
    expect(sql(`SELECT count(*) FROM public.payments WHERE gateway_reference='${payment.gateway_reference}'`)).toBe('0');
  });

  it('still rejects a taxable source in an unsupported currency', () => {
    const order = sale();
    sql(`UPDATE public.orders SET tax_snapshot=jsonb_set(tax_snapshot,'{currency}','"GHS"') WHERE id='${order}'`);
    expect(() => reserve(order, 12, { currency: 'GHS', gateway: 'paystack' })).toThrow(/invalid_tax_payment/);
    expect(sql(`SELECT count(*) FROM public.merchant_tax_payment_ledger WHERE entity_id='${order}'`)).toBe('0');
  });

  it('reserves deposit and balance exactly, including previously refunded collections', () => {
    const order = sale(); const first = reserve(order,6).payment;
    expect(first.tax_allocation).toMatchObject({netAmount:500,taxAmount:100,grossAmount:600});
    expect(() => reserve(order,6)).toThrow();
    settle(first.id);
    sql(`UPDATE public.payments SET status='refunded' WHERE id='${first.id}'`);
    const second = reserve(order,6).payment;
    expect(second.tax_allocation).toEqual(first.tax_allocation);
    settle(second.id);
    expect(() => reserve(order,0.01)).toThrow();
  });

  it('pins v0 fee using pre-tax net and preserves whole-major percentage rounding', () => {
    const p = reserve(sale(),12).payment;
    const fee = json(`SET ROLE service_role; SELECT public.bind_merchant_tax_fee_980('${p.id}')`);
    expect(fee).toMatchObject({feePolicyVersion:0,feePercentage:3,feeTotal:0,netAmount:1000,grossAmount:1200});
    sql(`UPDATE public.platform_settings SET value='{"free":{"feePercentage":50,"feeFlat":0}}' WHERE key='pricing_tiers'`);
    expect(json(`SET ROLE service_role; SELECT public.bind_merchant_tax_fee_980('${p.id}')`)).toEqual(fee);
    sql(`UPDATE public.platform_settings SET value='{"free":{"feePercentage":3,"feeFlat":0}}' WHERE key='pricing_tiers'`);
    expect(() => sql(`UPDATE public.payments SET tax_fee_basis='{}' WHERE id='${p.id}'`)).toThrow();
    expect(() => sql(`UPDATE public.payments SET amount=11 WHERE id='${p.id}'`)).toThrow();
  });

  it('holds uncertain failures until an explicit evidenced release', () => {
    const order=sale();const p=reserve(order,6).payment;
    sql(`UPDATE public.payments SET status='failed' WHERE id='${p.id}'`);
    expect(() => reserve(order,6)).toThrow();
    expect(() => sql(`SET ROLE service_role; SELECT public.release_merchant_tax_payment_980('${p.id}','provider_declined','{}')`)).toThrow();
    expect(sql(`SET ROLE service_role; SELECT public.release_merchant_tax_payment_980('${p.id}','not_dispatched')`)).toBe('t');
    expect(reserve(order,6).taxable).toBe(true);
    expect(() => sql(`UPDATE public.payments SET status='success' WHERE id='${p.id}'`)).toThrow();
  });

  it('requires a reservation and denies application roles direct authority', () => {
    const order=sale();
    expect(() => sql(`INSERT INTO public.payments(id,business_id,order_id,amount,currency) VALUES(gen_random_uuid(),'${b}','${order}',12,'USD')`)).toThrow();
    expect(() => sql(`SET ROLE authenticated; SELECT public.reserve_merchant_tax_payment_980('{}')`)).toThrow();
    expect(() => sql(`SET ROLE service_role; SELECT * FROM public.merchant_tax_payment_ledger`)).toThrow();
    expect(() => reserve(order,12,{business_id:actor})).toThrow();
  });

  it('reserves item refund money and quantities, replays requests, and refuses over-return', () => {
    const p=reserve(sale(),12).payment;settle(p.id);
    const selection={mode:'items',items:[{id:'item',quantity:1}]};
    const request='20000000-0000-4000-8000-000000000001';
    const r=refund(p.id,6,selection,request);
    expect(r.allocation).toMatchObject({netAmount:500,taxAmount:100,grossAmount:600});
    expect(refund(p.id,6,selection,request)).toMatchObject({refund_id:r.refund_id,reused:true});
    expect(() => refund(p.id,3)).toThrow();
    sql(`UPDATE public.refunds SET status='success' WHERE id='${r.refund_id}'`);
    expect(() => refund(p.id,12,{mode:'items',items:[{id:'item',quantity:2}]},'20000000-0000-4000-8000-000000000002')).toThrow();
    const rest=refund(p.id,6);expect(rest.allocation).toMatchObject({netAmount:500,taxAmount:100,grossAmount:600});
    expect(() => sql(`UPDATE public.refunds SET amount=5 WHERE id='${rest.refund_id}'`)).toThrow();
  });

  it('records zero-value item returns once without a provider refund', () => {
    const p=reserve(sale([{id:'paid',quantity:1,netAmount:1000,taxAmount:200,grossAmount:1200},
      {id:'free',quantity:1,netAmount:0,taxAmount:0,grossAmount:0}]),12).payment;settle(p.id);
    const request='20000000-0000-4000-8000-000000000003';
    const selection={mode:'items',items:[{id:'free',quantity:1}]};
    const r=refund(p.id,0,selection,request);expect(r.zero_value).toBe(true);
    expect(refund(p.id,0,selection,request)).toMatchObject({zero_value:true,reused:true,return_id:r.return_id});
    expect(sql(`SELECT count(*) FROM public.refunds WHERE payment_id='${p.id}'`)).toBe('0');
    expect(() => refund(p.id,0,selection,'20000000-0000-4000-8000-000000000004')).toThrow();
  });
  it('reverses mixed-rate fees and enforces append-only tax payout provenance across partial/full refunds', () => {
    sql(`UPDATE public.platform_settings SET value='{"free":{"feePercentage":10,"feeFlat":1}}' WHERE key='pricing_tiers'`);
    const p=reserve(sale([{id:'taxed',quantity:1,netAmount:1000,taxAmount:200,grossAmount:1200},
      {id:'exempt',quantity:1,netAmount:1000,taxAmount:0,grossAmount:1000}]),22).payment;
    settle(p.id);
    sql(`INSERT INTO public.platform_fees(id,payment_id,business_id,order_id,transaction_amount,fee_percentage,fee_flat,fee_total,is_direct_transfer,waived)
      VALUES(gen_random_uuid(),'${p.id}','${b}','${p.order_id}',22,10,1,3,false,false);`);
    const r=refund(p.id,12,{mode:'items',items:[{id:'taxed',quantity:1}]},'20000000-0000-4000-8000-000000000005');
    const historical='30000000-0000-4000-8000-000000000001';
    sql(`INSERT INTO public.business_payouts(id,business_id,status,currency,net_amount) VALUES('${historical}','${b}','paid','USD',0);
      INSERT INTO public.payout_adjustments(id,business_id,payout_id,amount,currency,applied_to_payout_id)
      VALUES('${historical}','${b}','${historical}',0,'USD','${historical}');`);

    sql(`UPDATE public.refunds SET status='provider_success_unfinalized' WHERE id='${r.refund_id}';
      SELECT public.finalize_refund_execution('${r.refund_id}');`);
    // Original percentage 200 minor / 2, plus 55 minor of the flat fee.
    expect(sql(`SELECT fee_total::text FROM public.platform_fees WHERE payment_id='${p.id}'`)).toBe('1.45');
    expect(sql(`SELECT sum(amount)::text FROM public.payout_adjustments WHERE payment_id='${p.id}'`)).toBe('-12.00');
    const projection=json(`SET ROLE service_role; SELECT public.tax_refund_payout_projection_980('${b}','USD')`);
    expect(projection).toMatchObject({affected:true,gross:22,platformFee:1.45,gatewayFee:0,adjustments:-12,commitments:0,netAvailable:8.55});
    expect(()=>sql(`DELETE FROM public.payout_adjustments WHERE tax_refund_id='${r.refund_id}'`)).toThrow(/tax_adjustment_/);
    expect(()=>sql(`UPDATE public.payout_adjustments SET amount=0 WHERE tax_refund_id='${r.refund_id}'`)).toThrow(/tax_adjustment_/);
    expect(()=>sql(`DELETE FROM public.refunds WHERE id='${r.refund_id}'`)).toThrow();
    expect(()=>sql(`UPDATE public.payout_adjustments SET currency='NGN' WHERE tax_refund_id='${r.refund_id}'`)).toThrow(/tax_adjustment_/);
    expect(()=>sql(`UPDATE public.payout_adjustments SET applied_to_payout_id='${historical}' WHERE tax_refund_id='${r.refund_id}'`)).toThrow(/tax_adjustment_unlinked_980/);
    expect(sql(`SELECT applied_to_payout_id::text FROM public.payout_adjustments WHERE id='${historical}'`)).toBe(historical);

    expect(()=>sql(`INSERT INTO public.payout_adjustments(business_id,amount,currency) VALUES('${b}',1,'USD')`)).toThrow(/tax_adjustment_source_980/);
    expect(()=>sql(`INSERT INTO public.payout_adjustments(business_id,payment_id,amount,currency,tax_refund_id)
      VALUES('${actor}','${p.id}',-12,'USD','${r.refund_id}')`)).toThrow(/tax_adjustment_refund_mismatch/);
    expect(()=>sql(`INSERT INTO public.payout_adjustments(business_id,payment_id,amount,currency,tax_refund_id)
      VALUES('${b}','${p.id}',-12,'NGN','${r.refund_id}')`)).toThrow(/tax_adjustment_refund_mismatch/);
    sql(`SELECT public.finalize_refund_execution('${r.refund_id}')`);
    expect(sql(`SELECT count(*) FROM public.payout_adjustments WHERE tax_refund_id='${r.refund_id}'`)).toBe('1');

    const rest=refund(p.id,10);
    sql(`UPDATE public.refunds SET status='provider_success_unfinalized' WHERE id='${rest.refund_id}';
      SELECT public.finalize_refund_execution('${rest.refund_id}');`);
    expect(sql(`SELECT fee_total::text FROM public.platform_fees WHERE payment_id='${p.id}'`)).toBe('0.00');
    expect(sql(`SELECT refund_amount::text FROM public.payments WHERE id='${p.id}'`)).toBe('22.00');
    expect(sql(`SELECT sum(amount)::text FROM public.payout_adjustments WHERE payment_id='${p.id}'`)).toBe('0.00');
  });

  it('preserves direct bank approval and zero fee with fractional taxed order totals', () => {
    const order=sale([{id:'item',quantity:1,netAmount:1000,taxAmount:75,grossAmount:1075}]);
    const transfer='30000000-0000-4000-8000-000000000001';
    sql(`UPDATE public.orders SET status='pending',total_amount=10.75 WHERE id='${order}';
      INSERT INTO public.pending_transfers(id,order_id,business_id,expected_amount,currency,reference_code,status,expires_at)
      VALUES('${transfer}','${order}','${b}',1075,'USD','bank-tax','pending','2099-01-01');
      INSERT INTO public.order_stock_applications(order_id,reservation_class,expires_at) VALUES('${order}','bank_transfer','2099-01-01');`);
    const result=json(`SELECT public.confirm_order_transfer_atomic('${transfer}','${order}','${b}','${actor}',false)`);
    expect(result.confirmed).toBe(true);
    expect(json(`SELECT json_build_object('amount',amount,'tax',tax_allocation->'taxAmount','fee',tax_fee_basis->'feeTotal') FROM public.payments WHERE id='${result.payment_id}'`))
      .toEqual({amount:10.75,tax:75,fee:0});
    expect(sql(`SELECT status FROM public.orders WHERE id='${order}'`)).toBe('paid_pending_approval');
  });

  it('uses the original intent key after the provider reference changes', () => {
    const order=sale(); const input={gateway_reference:'stable-intent'};
    const p=reserve(order,6,input).payment;settle(p.id);
    sql(`UPDATE public.payments SET status='pending',provider_init_state='provider_confirmed',gateway_reference='provider-session' WHERE id='${p.id}'`);
    expect(reserve(order,6,input)).toMatchObject({reused:true,payment:{id:p.id,gateway_reference:'provider-session'}});
    expect(() => reserve(order,6,{gateway_reference:'different-intent'})).toThrow();
  });

  it('lets the customer pay again after the provider proves the checkout expired (Owner decision #980)', () => {
    const order=sale(); const input={gateway_reference:'retry-intent'};
    const p=reserve(order,12,input).payment;
    sql(`SET ROLE service_role; SELECT public.bind_merchant_tax_fee_980('${p.id}'); RESET ROLE;
      UPDATE public.payments SET provider_init_state='dispatched' WHERE id='${p.id}';
      UPDATE public.payments SET provider_init_state='provider_confirmed',gateway_reference='cs_retry_expired' WHERE id='${p.id}';`);
    // Still open: the retry gets the same attempt back, never a second one.
    expect(reserve(order,12,input)).toMatchObject({reused:true,payment:{id:p.id,status:'pending'}});
    // Wrong evidence cannot release it.
    expect(() => sql(`SET ROLE service_role; SELECT public.confirm_merchant_tax_payment_failure_980('${p.id}','stripe','cs_other','expired')`)).toThrow();
    expect(sql(`SET ROLE service_role; SELECT public.confirm_merchant_tax_payment_failure_980('${p.id}','stripe','cs_retry_expired','expired')`)).toBe('t');
    const again=reserve(order,12,input);
    expect(again).toMatchObject({taxable:true,reused:false});
    expect(again.payment.id).not.toBe(p.id);
    expect(again.payment.tax_allocation).toEqual(p.tax_allocation);
    // The expired attempt can never also be collected, so the sale cannot be paid twice.
    expect(() => sql(`UPDATE public.payments SET status='success' WHERE id='${p.id}'`)).toThrow();
  });

  it('rejects nonfinite and fractional minor-unit input before recording a hold', () => {
    const order=sale();
    for (const amount of ['NaN','Infinity',1.001]) expect(() => reserve(order,12,{amount})).toThrow();
    expect(sql(`SELECT count(*) FROM public.merchant_tax_payment_ledger WHERE entity_id='${order}'`)).toBe('0');
  });

  it('serializes concurrent reservations so only one can reserve the same sale', async () => {
    const order=sale();
    const input={business_id:b,order_id:order,amount:6,currency:'USD',gateway:'stripe',gateway_reference:'concurrent-first'};
    const first=spawn('psql',[url!,'-X','-q','-t','-A','-v','ON_ERROR_STOP=1']);
    let output=''; let error='';
    const held=new Promise<void>((resolve,reject)=> {
      first.stdout.on('data',chunk=>{output+=chunk; if(output.includes('HELD')) resolve();});
      first.stderr.on('data',chunk=>{error+=chunk;});
      first.once('error',reject);
      first.once('exit',code=>{if(code) reject(new Error(error));});
    });
    const complete=new Promise<number|null>(resolve=>first.once('exit',resolve));
    first.stdin.end(`BEGIN; SET ROLE service_role; SELECT public.reserve_merchant_tax_payment_980(${q(input)}); SELECT 'HELD'; SELECT pg_sleep(0.4); COMMIT;`);
    await held;
    // This blocks on the real business/entity lock, then sees the committed hold.
    expect(() => reserve(order,6,{gateway_reference:'concurrent-second'})).toThrow();
    expect(await complete).toBe(0);
    expect(sql(`SELECT count(*) FROM public.merchant_tax_payment_ledger WHERE entity_id='${order}'`)).toBe('1');
  });

  it('seals Stripe saved-card replay parameters to the allocated net fee before dispatch', () => {
    sql(`UPDATE public.platform_settings SET value='{"free":{"feePercentage":10,"feeFlat":1}}' WHERE key='pricing_tiers'`);
    const p=reserve(sale(),12,{payment_method:'saved_card',metadata:{pi_params:{amount:'1200',currency:'usd',
      'transfer_data[destination]':'acct_merchant',application_fee_amount:'999'}}}).payment;
    sql(`SET ROLE service_role; SELECT public.bind_merchant_tax_fee_980('${p.id}')`);
    expect(()=>sql(`UPDATE public.payments SET provider_init_state='dispatched' WHERE id='${p.id}'`)).toThrow();
    sql(`UPDATE public.payments SET metadata=jsonb_set(metadata,'{pi_params,application_fee_amount}','"200"') WHERE id='${p.id}';
      UPDATE public.payments SET provider_init_state='dispatched' WHERE id='${p.id}';`);
    expect(()=>sql(`UPDATE public.payments SET metadata=jsonb_set(metadata,'{pi_params,application_fee_amount}','"100"') WHERE id='${p.id}'`)).toThrow();
  });

  it('commits a confirmed failure and release together, preserving ambiguous intents', () => {
    const order=sale();const p=reserve(order,6,{gateway_reference:'failure-intent'}).payment;
    sql(`SET ROLE service_role; SELECT public.bind_merchant_tax_fee_980('${p.id}'); RESET ROLE;
      UPDATE public.payments SET provider_init_state='dispatched' WHERE id='${p.id}'`);
    expect(()=>sql(`SET ROLE service_role; SELECT public.confirm_merchant_tax_payment_failure_980('${p.id}','stripe','wrong','failed')`)).toThrow();
    expect(sql(`SELECT status FROM public.payments WHERE id='${p.id}'`)).toBe('pending');
    expect(()=>reserve(order,6)).toThrow();
    expect(sql(`SET ROLE service_role; SELECT public.confirm_merchant_tax_payment_failure_980('${p.id}','stripe','failure-intent','failed')`)).toBe('t');
    expect(sql(`SELECT status FROM public.payments WHERE id='${p.id}'`)).toBe('failed');
    expect(reserve(order,6).taxable).toBe(true);
  });

  it('refuses migration when the approved public refund dispatcher is missing', () => {
    expect(()=>sql(`BEGIN; DROP FUNCTION public.finalize_refund_execution(uuid);
      ${readFileSync('supabase/migrations/532_merchant_tax_payment_refund_authority.sql','utf8')}`)).toThrow(/requires the approved M501 public refund dispatcher/);
    // The failed test transaction rolls back its DROP; it cannot alter this fixture's dispatcher.
    expect(sql(`SELECT to_regprocedure('public.finalize_refund_execution(uuid)') IS NOT NULL`)).toBe('t');
  });

});
