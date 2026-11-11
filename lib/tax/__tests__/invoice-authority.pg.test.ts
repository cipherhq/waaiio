/** Disposable database proof for M533. Fixture models live column types; not provider/HTTP E2E. */
import { Client } from 'pg';
import { readFileSync } from 'node:fs';
import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
const url = process.env.TAX_INVOICE_TEST_DATABASE_URL;
if (!url && process.env.REQUIRE_TAX_PG_TESTS === 'true') throw new Error('TAX_INVOICE_TEST_DATABASE_URL required');
if (url) { const u = new URL(url); if (!['127.0.0.1', 'localhost'].includes(u.hostname) || u.pathname !== '/waaiio_tax_invoice_test') throw new Error('Dedicated disposable local invoice DB required'); }
let db: Client;
const b = '10000000-0000-4000-8000-000000000001';
const owner = '10000000-0000-4000-8000-000000000002';
const other = '10000000-0000-4000-8000-000000000003';
const read = (file: string) => readFileSync(file, 'utf8');
const body = (extra: object = {}) => ({ customer_name: 'Buyer', currency: 'GBP', tax_version: 1, items: [{ description: 'Consulting', quantity: 1.5, unit_price: 10 }], ...extra });
async function save(input: object, id: string | null = null) { return (await db.query('SELECT public.save_invoice_tax_980($1,$2,$3) AS result', [b, id, input])).rows[0].result; }
describe.skipIf(!url)('M533 atomic invoice and quote authority', () => {
 beforeAll(async () => {
  db = new Client({ connectionString: url }); await db.connect();
  await db.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public AUTHORIZATION postgres; DROP SCHEMA IF EXISTS private CASCADE; DROP SCHEMA IF EXISTS auth CASCADE; SET ROLE postgres;`);
  await db.query(read('lib/tax/__tests__/precision-fixture.sql'));
  await db.query(`CREATE TABLE public.countries(code text PRIMARY KEY,currency_code text); INSERT INTO public.countries VALUES('UK','GBP');
    CREATE TABLE public.invoice_items(id uuid DEFAULT gen_random_uuid() PRIMARY KEY,invoice_id uuid REFERENCES public.invoices(id),description text NOT NULL CHECK(description <> 'reject-after-calculation'),
    quantity numeric NOT NULL,unit_price numeric NOT NULL,amount numeric NOT NULL,sort_order integer NOT NULL,created_at timestamptz DEFAULT now());
    ALTER TABLE public.invoices ALTER amount_paid SET DEFAULT 0;
    ALTER TABLE public.quote_requests ALTER quoted_amount TYPE numeric(14,2);
    GRANT USAGE ON SCHEMA public,auth TO authenticated,anon,service_role;
    GRANT SELECT ON ALL TABLES IN SCHEMA public TO authenticated,service_role;
    INSERT INTO public.businesses(id,owner_id,country_code) VALUES('${b}','${owner}','UK');`);
  await db.query(read('supabase/migrations/528_merchant_tax_foundation.sql'));
  await db.query(read('supabase/migrations/530_merchant_tax_calculator.sql'));
  // Execute the complete shared snapshot schema/guard block, not unrelated order/booking replacements.
  await db.query(read('supabase/migrations/531_merchant_tax_purchase_authority.sql').split('-- Authoritative function replacements follow.')[0] + '\nCOMMIT;');
  await db.query(read('supabase/migrations/533_merchant_tax_invoices_quotes.sql'));
  // Real quote authority, with inventory isolated by a test-only deterministic stub.
  await db.query(`ALTER TABLE public.orders ALTER total_amount TYPE numeric(14,2), ALTER deposit_amount TYPE numeric(14,2), ALTER balance_amount TYPE numeric(14,2);
    ALTER TABLE public.order_items ALTER unit_price TYPE numeric(14,2);
    CREATE FUNCTION public.apply_order_stock_once(uuid,uuid,boolean) RETURNS jsonb LANGUAGE sql AS $$ SELECT jsonb_build_object('applied',COALESCE(current_setting('test.stock_fail',true),'')<>'true','reason','test_stock_failure') $$;`);
  const authority = read('supabase/migrations/531_merchant_tax_purchase_authority.sql');
  await db.query(authority.slice(authority.indexOf('CREATE OR REPLACE FUNCTION public.accept_order_quote_atomic'), authority.indexOf('CREATE FUNCTION public.quote_booking_tax_980')));
  await db.query(`INSERT INTO public.merchant_tax_settings(business_id,enabled,label,rate_bps) VALUES('${b}',true,'VAT',1000); SELECT set_config('test.uid','${owner}',false); SET ROLE authenticated;`);
 });
 beforeEach(async () => { await db.query(`RESET ROLE; SET ROLE postgres; UPDATE public.merchant_tax_settings SET rate_bps=1000,enabled=true WHERE business_id='${b}'; SELECT set_config('test.stock_fail','false',false); SELECT set_config('test.uid','${owner}',false); SET ROLE authenticated;`); });
 afterAll(async () => { await db?.end(); });
 it('calculates discounted fractional charges and stores item/snapshot atomically', async () => {
  const inv = await save(body({ discount_type: 'percent', discount_value: 10 }));
  expect(inv.tax_snapshot).toMatchObject({ netAmount: 1350, taxAmount: 135, grossAmount: 1485 });
  expect(Number(inv.total_amount)).toBe(14.85); expect(Number(inv.invoice_items[0].quantity)).toBe(1.5);
  expect(inv.tax_snapshot.lines[0]).toMatchObject({ quantity: 1, unitAmount: 1500 });
 });
 it('matches exact 0.333 decimal extensions and explicit zero-rate/inclusive rules', async () => {
  const inv = await save(body({ items: [{ description: 'Work', quantity: 0.333, unit_price: 10, tax_treatment: 'override', tax_label: 'Included', tax_rate_bps: 2000, tax_price_mode: 'inclusive' }] }));
  expect(Number(inv.invoice_items[0].quantity)).toBe(0.333);
  expect(inv.tax_snapshot).toMatchObject({ grossAmount: 333, taxAmount: 55, netAmount: 278 });
 });
 it('rejects cross-tenant owner and customer profile without creating invoices', async () => {
  await db.query(`SELECT set_config('test.uid','${other}',false)`);
  await expect(save(body())).rejects.toThrow('invoice_forbidden');
  await db.query(`SELECT set_config('test.uid','${owner}',false)`);
  await expect(save(body({ customer_profile_id: other }))).rejects.toThrow('customer_profile_forbidden');
 });
 it('rolls back a failed edit and preserves both old line rows and totals', async () => {
  const inv = await save(body());
  await expect(save(body({ items: [{ description: 'Bad', quantity: 1, unit_price: 10, tax_treatment: 'invalid' }] }), inv.id)).rejects.toThrow();
  const stored = (await db.query('SELECT tax_snapshot FROM public.invoices WHERE id=$1', [inv.id])).rows[0];
  expect(stored.tax_snapshot).toEqual(inv.tax_snapshot);
  expect((await db.query('SELECT description FROM public.invoice_items WHERE invoice_id=$1', [inv.id])).rows[0].description).toBe('Consulting');
 });
 it('requires preview match and service role for negotiated item prices', async () => {
  await expect(db.query('SELECT public.respond_order_quote_tax_980($1,$2,$3,null,null,true)', [b, other, []])).rejects.toThrow('permission denied');
  await db.query('RESET ROLE; SET ROLE postgres');
  await db.query('INSERT INTO public.quote_requests(id,business_id,status) VALUES($1,$2,\'pending\')', [other,b]);
  await db.query('SET ROLE service_role');
  const items = [{ id: 'custom', description: 'Negotiated work', quantity: 1, unit_price: 20 }];
  const preview = (await db.query('SELECT public.respond_order_quote_tax_980($1,$2,$3,null,null,true) AS result', [b,other,JSON.stringify(items)])).rows[0].result;
  expect(preview.tax_snapshot.grossAmount).toBe(2200);
  await expect(db.query('SELECT public.respond_order_quote_tax_980($1,$2,$3,null,null,false,null)', [b,other,JSON.stringify(items)])).rejects.toThrow('quote_tax_terms_changed');
  const saved = (await db.query('SELECT public.respond_order_quote_tax_980($1,$2,$3,null,null,false,$4) AS result', [b,other,JSON.stringify(items),preview.tax_snapshot])).rows[0].result;
  expect(saved.status).toBe('quoted'); expect(saved.quoted_items).toEqual(items);
  await db.query('RESET ROLE; SET ROLE authenticated');
 });
 it('rolls back the parent and item replacement when an item constraint fails after calculation', async () => {
  const inv = await save(body());
  await expect(save(body({ items: [{ description: 'reject-after-calculation', quantity: 1, unit_price: 99 }] }), inv.id)).rejects.toThrow();
  expect((await db.query('SELECT total_amount FROM public.invoices WHERE id=$1', [inv.id])).rows[0].total_amount).toBe('16.50');
  expect((await db.query('SELECT description FROM public.invoice_items WHERE invoice_id=$1', [inv.id])).rows[0].description).toBe('Consulting');
 });
 it('accepts negotiated catalog prices, preserves identity and rolls back failed stock atomically', async () => {
  const quoteId = '20000000-0000-4000-8000-000000000001';
  const productId = '20000000-0000-4000-8000-000000000002';
  await db.query('RESET ROLE; SET ROLE postgres');
  await db.query('INSERT INTO public.products(id,business_id,is_active,name) VALUES($1,$2,true,\'Cake\')', [productId,b]);
  const cart = [{ product_id: productId, name: 'Cake', quantity: 2, price: 10 }];
  await db.query('INSERT INTO public.quote_requests(id,business_id,status,customer_phone,cart_snapshot) VALUES($1,$2,\'pending\',\'+44123\',$3)', [quoteId,b,JSON.stringify(cart)]);
  await db.query('SET ROLE service_role');
  const items = [{ id: 'item-0', product_id: productId, description: 'Agreed cake', quantity: 2, unit_price: 12.25 }];
  const preview = (await db.query('SELECT public.respond_order_quote_tax_980($1,$2,$3,null,null,true) AS r',[b,quoteId,JSON.stringify(items)])).rows[0].r;
  await db.query('SELECT public.respond_order_quote_tax_980($1,$2,$3,null,null,false,$4)',[b,quoteId,JSON.stringify(items),preview.tax_snapshot]);
  expect((await db.query('SELECT public.accept_order_quote_atomic($1,\'wrong\',$2) AS r',[quoteId,preview.tax_snapshot])).rows[0].r.accepted).toBe(false);
  await db.query("SELECT set_config('test.stock_fail','true',false)");
  await expect(db.query('SELECT public.accept_order_quote_atomic($1,\'44123\',$2)',[quoteId,preview.tax_snapshot])).rejects.toThrow('stock_application_failed');
  await db.query("SELECT set_config('test.stock_fail','false',false)");
  const accepted = (await db.query('SELECT public.accept_order_quote_atomic($1,\'44123\',$2) AS r',[quoteId,preview.tax_snapshot])).rows[0].r;
  expect(accepted.total).toBe(26.95);
  const saved = (await db.query('SELECT product_id,quantity,unit_price FROM public.order_items WHERE order_id=$1',[accepted.order_id])).rows[0];
  expect(saved).toMatchObject({ product_id: productId, quantity: 2, unit_price: '12.25' });
  expect((await db.query('SELECT count(*)::int AS n FROM public.orders WHERE quote_request_id=$1',[quoteId])).rows[0].n).toBe(1);
 });
 it('retains explicit legacy invoice tax with business tax off at the entered precision', async () => {
  await db.query('RESET ROLE; SET ROLE postgres');
  await db.query('UPDATE public.merchant_tax_settings SET enabled=false WHERE business_id=$1',[b]);
  await db.query('SET ROLE authenticated');
  const inv = await save(body({ tax_rate: 8.875, items: [{ description: 'Work', quantity: 1, unit_price: 10 }] }));
  expect(Number(inv.tax_rate)).toBe(8.875); expect(inv.tax_snapshot.lines[0].rateBps).toBe(887.5);
  expect(inv.tax_snapshot.grossAmount).toBe(1089);
 });
 it('preserves historical recurring null-snapshot tax terms when defaults later enable', async () => {
  await db.query('RESET ROLE; SET ROLE postgres');
  await db.query('UPDATE public.merchant_tax_settings SET enabled=false WHERE business_id=$1',[b]);
  const inv = (await db.query(`INSERT INTO public.invoices(business_id,customer_name,status,subtotal,tax_rate,tax_amount,discount_value,discount_amount,total_amount,currency,is_recurring,recurring_frequency,recurring_next_date,metadata)
    VALUES($1,'Legacy buyer','sent',10,20,2,0,0,12,'GBP',true,'monthly','2026-11-01','{}') RETURNING id`,[b])).rows[0];
  await db.query("INSERT INTO public.invoice_items(invoice_id,description,quantity,unit_price,amount,sort_order) VALUES($1,'Legacy work',1,10,10,0)",[inv.id]);
  await db.query('UPDATE public.merchant_tax_settings SET enabled=true WHERE business_id=$1',[b]);
  await db.query('SET ROLE service_role');
  const child = (await db.query("SELECT public.clone_recurring_invoice_tax_980($1,'2026-11-01','2026-11-11') AS r",[inv.id])).rows[0].r;
  const saved = (await db.query('SELECT total_amount,tax_amount,tax_snapshot FROM public.invoices WHERE id=$1',[child.id])).rows[0];
  expect(saved).toMatchObject({ total_amount: '12.00', tax_amount: '2.00', tax_snapshot: null });
 });
 it('blocks issued tax invoice deletion and item mutation but permits operational status changes', async () => {
  const inv = await save(body());
  await db.query('RESET ROLE; SET ROLE postgres');
  await db.query("UPDATE public.invoices SET status='sent' WHERE id=$1",[inv.id]);
  await expect(db.query("UPDATE public.invoice_items SET unit_price=99 WHERE invoice_id=$1",[inv.id])).rejects.toThrow('issued_invoice_items_immutable');
  await expect(db.query('DELETE FROM public.invoices WHERE id=$1',[inv.id])).rejects.toThrow('issued_tax_invoice_immutable');
  await db.query("UPDATE public.invoices SET status='viewed' WHERE id=$1",[inv.id]);
 });
 it('freezes only reviewed terms before delivery without claiming the invoice was sent', async () => {
  const inv = await save(body());
  await db.query('RESET ROLE; SET ROLE service_role');
  await expect(db.query('SELECT public.freeze_invoice_tax_terms_980($1,$2,null)',[b,inv.id])).rejects.toThrow('invoice_tax_terms_changed');
  const frozen = (await db.query('SELECT public.freeze_invoice_tax_terms_980($1,$2,$3) AS r',[b,inv.id,inv.tax_snapshot])).rows[0].r;
  expect(frozen.status).toBe('draft'); expect(frozen.sent_at).toBeNull(); expect(frozen.tax_terms_locked_at).toBeTruthy();
  await db.query('RESET ROLE; SET ROLE authenticated');
  await expect(save(body(),inv.id)).rejects.toThrow('only_unpaid_draft_editable');
  await db.query('RESET ROLE; SET ROLE postgres');
  await expect(db.query('UPDATE public.invoice_items SET quantity=2 WHERE invoice_id=$1',[inv.id])).rejects.toThrow('issued_invoice_items_immutable');
  await db.query("UPDATE public.invoices SET status='sent',sent_at=now() WHERE id=$1",[inv.id]);
 });
 it.each(['GHS','EUR'])('preserves legacy %s invoice tax before discounts and draft edits', async currency => {
  await db.query('RESET ROLE; SET ROLE postgres');
  await db.query('UPDATE public.merchant_tax_settings SET enabled=false WHERE business_id=$1',[b]);
  await db.query('SET ROLE authenticated');
  const input = { customer_name: 'Legacy buyer', currency, tax_rate: 20, discount_type: 'flat', discount_value: 2,
    items: [{ description: 'Work', quantity: 1, unit_price: 10 }] };
  const inv = await save(input);
  expect(inv.tax_snapshot).toBeNull(); expect(Number(inv.tax_rate)).toBe(20);
  expect(Number(inv.tax_amount)).toBe(2); expect(Number(inv.total_amount)).toBe(10);
  expect(inv.metadata).not.toHaveProperty('tax_version');
  const updated = await save({ ...input, items: [{ description: 'Work', quantity: 2, unit_price: 10 }] }, inv.id);
  expect(updated.tax_snapshot).toBeNull(); expect(Number(updated.tax_amount)).toBe(4); expect(Number(updated.total_amount)).toBe(22);
  await expect(save({ ...input, tax_rate: undefined, tax_config: { enabled: true, label: 'VAT', rateBps: 2000, priceMode: 'inclusive' } })).rejects.toThrow('unsupported_tax_currency');
 });
 it('edits a UK merchant legacy EUR draft after GBP merchant tax is enabled', async () => {
  await db.query('RESET ROLE; SET ROLE postgres');
  await db.query('UPDATE public.merchant_tax_settings SET enabled=false WHERE business_id=$1',[b]);
  await db.query('SET ROLE authenticated');
  const input = { customer_name: 'Legacy buyer', currency: 'EUR', tax_rate: 20,
    items: [{ description: 'Work', quantity: 1, unit_price: 10 }] };
  const inv = await save(input);
  await db.query('RESET ROLE; SET ROLE postgres');
  await db.query('UPDATE public.merchant_tax_settings SET enabled=true WHERE business_id=$1',[b]);
  await db.query('SET ROLE authenticated');
  const updated = await save({ ...input, items: [{ description: 'Work', quantity: 2, unit_price: 10 }] }, inv.id);
  expect(updated.tax_snapshot).toBeNull(); expect(Number(updated.tax_amount)).toBe(4); expect(Number(updated.total_amount)).toBe(24);
  const zeroRated = await save({ ...input, tax_rate: 0 }, inv.id);
  expect(zeroRated.tax_snapshot).toBeNull(); expect(Number(zeroRated.tax_amount)).toBe(0); expect(Number(zeroRated.total_amount)).toBe(10);
 });
 it('clones saved recurring terms once despite changed defaults', async () => {
  const inv = await save(body({ is_recurring: true, recurring_frequency: 'monthly', recurring_next_date: '2026-11-01' }));
  await db.query('RESET ROLE; SET ROLE postgres');
  await db.query('UPDATE public.merchant_tax_settings SET rate_bps=2000 WHERE business_id=$1', [b]);
  await db.query('SET ROLE service_role');
  const args = [inv.id,'2026-11-01','2026-11-11'];
  const first = (await db.query('SELECT public.clone_recurring_invoice_tax_980($1,$2,$3) AS result', args)).rows[0].result;
  const replay = (await db.query('SELECT public.clone_recurring_invoice_tax_980($1,$2,$3) AS result', args)).rows[0].result;
  expect(replay).toMatchObject({ id: first.id, replayed: true });
  await db.query('RESET ROLE; SET ROLE postgres');
  const child = (await db.query('SELECT tax_snapshot FROM public.invoices WHERE id=$1', [first.id])).rows[0];
  expect(child.tax_snapshot).toEqual(inv.tax_snapshot);
  await db.query('SET ROLE authenticated');
 });
});
