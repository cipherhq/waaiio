import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { readFileSync } from 'node:fs';
import baseline from './precision-catalog-baseline.json';
import manifest from './precision-change-manifest.json';

const url = process.env.TAX_AUTHORITY_TEST_DATABASE_URL;
if (!url && process.env.REQUIRE_TAX_PG_TESTS === 'true') throw new Error('TAX_AUTHORITY_TEST_DATABASE_URL required');
if (url) {
  const parsed = new URL(url);
  if (!['127.0.0.1','localhost'].includes(parsed.hostname) || parsed.pathname !== '/waaiio_tax_authority_test') throw new Error('Disposable local tax authority database required');
}
const suite = url ? describe : describe.skip;
const B='10000000-0000-4000-8000-000000000001', O='10000000-0000-4000-8000-000000000002';
const OTHER='10000000-0000-4000-8000-000000000003', OTHER_OWNER='10000000-0000-4000-8000-000000000004';
const P='20000000-0000-4000-8000-000000000001', S='20000000-0000-4000-8000-000000000002';
const SESSION='30000000-0000-4000-8000-000000000001';
let db: Client;
const sql = (query: string, values: unknown[] = []) => db.query(query,values);
const snapshot = async () => (await sql(`SELECT jsonb_build_object('orders',(SELECT count(*) FROM orders),'items',(SELECT count(*) FROM order_items),
 'markers',(SELECT count(*) FROM order_stock_applications),'promos',(SELECT count(*) FROM promo_reservations),
 'stock',(SELECT stock_quantity FROM products WHERE id='${P}'),'sequence',(SELECT last_value FROM tax_test_reference_sequence)) AS value`)).rows[0].value;
async function order(preview: boolean, expected: unknown = null, amount = 0) {
  return (await sql(`SELECT public.create_order_atomic(p_bot_session_id:=$1,p_business_id:=$2,p_user_id:=$3,
    p_total_amount:=$4,p_expected_total:=$4,p_items:=$5,p_validate_products:=true,p_expected_tax_snapshot:=$6,p_preview:=$7) result`,
  [SESSION,B,O,amount,JSON.stringify([{ product_id:P,quantity:1,unit_price:10 }]),JSON.stringify(expected),preview])).rows[0].result;
}

suite('M531 authoritative tax and settings concurrency',()=>{
  beforeAll(async()=>{
    db=new Client({connectionString:url}); await db.connect();
    await sql(`DO $$ BEGIN
      IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='postgres') THEN CREATE ROLE postgres SUPERUSER; END IF;
      IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
      IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
      IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role BYPASSRLS; END IF;
    END $$;
    ALTER ROLE service_role BYPASSRLS;
    DROP SCHEMA public CASCADE; CREATE SCHEMA public AUTHORIZATION postgres;
    DROP SCHEMA IF EXISTS private CASCADE; DROP SCHEMA IF EXISTS auth CASCADE;
    SET ROLE postgres; SET check_function_bodies=off;
    ${readFileSync('lib/tax/__tests__/precision-fixture.sql','utf8')}
    GRANT USAGE ON SCHEMA public,auth TO anon,authenticated,service_role;
    GRANT USAGE ON SCHEMA private TO service_role;
    ${baseline.filter(row=>manifest.functions.some(f=>f.name===row.name&&f.schema===row.schema)).map(row=>{
      const sig=`${row.schema}.${row.name}(${row.args.split(',').map(a=>a.trim().split(' ').slice(1).join(' ')).join(',')})`;
      return `${row.definition}; REVOKE ALL ON FUNCTION ${sig} FROM PUBLIC,anon,authenticated,service_role;
       ${['authenticated','service_role'].filter(role=>row.acl.includes(`${role}=X/`)).map(role=>`GRANT EXECUTE ON FUNCTION ${sig} TO ${role};`).join('\n')}`;
    }).join('\n')}
    CREATE TABLE countries(code text PRIMARY KEY,currency_code text);
    CREATE TABLE volume_discount_rules(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),business_id uuid,product_id uuid,name text,min_quantity integer,max_quantity integer,discount_type discount_type,discount_value numeric,is_active boolean);
    CREATE TABLE order_stock_applications(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),payment_id uuid,order_id uuid UNIQUE,applied_at timestamptz DEFAULT now(),item_count integer DEFAULT 0,reservation_class text,expires_at timestamptz);
    CREATE TABLE processed_webhook_events(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),event_id text UNIQUE,gateway text,event_type text,processed_at timestamptz);
    CREATE SEQUENCE tax_test_reference_sequence;
    ALTER TABLE orders ALTER COLUMN reference_code SET DEFAULT 'TAX'||nextval('tax_test_reference_sequence');
    ALTER TABLE bookings ALTER COLUMN reference_code SET DEFAULT 'TAX'||nextval('tax_test_reference_sequence');
    ALTER TABLE businesses ENABLE ROW LEVEL SECURITY;
    CREATE POLICY owner_select ON businesses FOR SELECT TO authenticated USING(owner_id=auth.uid());
    CREATE POLICY owner_update ON businesses FOR UPDATE TO authenticated USING(owner_id=auth.uid()) WITH CHECK(owner_id=auth.uid());
    GRANT SELECT,UPDATE ON businesses TO authenticated; GRANT SELECT ON countries TO authenticated;
    GRANT SELECT,INSERT,UPDATE ON invoices,orders,bookings TO authenticated;
    GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
    GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO service_role,authenticated;
    `);
    for(const path of ['528_merchant_tax_foundation.sql','529_merchant_tax_money_precision.sql','530_merchant_tax_calculator.sql','531_merchant_tax_purchase_authority.sql']) {
      await sql(readFileSync(`supabase/migrations/${path}`,'utf8'));
    }
    await sql('SET check_function_bodies=on');
  },60000);
  afterAll(async()=>{await db?.end();});
  beforeEach(async()=>{
    await sql(`RESET ROLE; SET ROLE postgres;
      TRUNCATE merchant_tax_settings,products,services,businesses,orders,order_items,bookings,bot_sessions,
        volume_discount_rules,promo_codes,promo_reservations,order_stock_applications,processed_webhook_events,quote_requests,invoices,countries,product_addons,delivery_zones CASCADE;
      INSERT INTO countries VALUES('US','USD');
      INSERT INTO businesses(id,owner_id,name,country_code,status,category,metadata) VALUES
        ('${B}','${O}','Tax Shop','US','active','salon','{"prepay_mode":"auto"}'),
        ('${OTHER}','${OTHER_OWNER}','Other Shop','US','active','shop','{}');
      INSERT INTO products(id,business_id,name,price,is_active,track_inventory,stock_quantity) VALUES('${P}','${B}','Product',10,true,true,10);
      INSERT INTO services(id,business_id,name,price,deposit_amount,is_active,max_capacity,duration_minutes,buffer_minutes,requires_staff,is_class,auto_approve,service_type)
        VALUES('${S}','${B}','Service',10,3,true,10,30,0,false,false,true,'booking');
      INSERT INTO merchant_tax_settings(business_id,enabled,label,rate_bps) VALUES('${B}',true,'Sales tax',750);
      SET ROLE service_role;`);
  });
  it('previews without stock, rows, markers, counters or sequence mutation, then commits exactly that snapshot',async()=>{
    const before=await snapshot(); const quote=await order(true);
    expect(quote).toMatchObject({is_preview:true,server_total:10.75,tax_snapshot:{grossAmount:1075,taxAmount:75}});
    expect(await snapshot()).toEqual(before);
    const result=await order(false,quote.tax_snapshot,quote.server_total);
    expect(result).toMatchObject({created:true,server_total:10.75,tax_snapshot:quote.tax_snapshot});
    expect((await sql('SELECT total_amount,tax_snapshot FROM orders')).rows[0]).toMatchObject({total_amount:'10.75',tax_snapshot:quote.tax_snapshot});
    expect((await snapshot()).stock).toBe(9);
  });
  it('rejects missing or stale snapshots before any mutation and replays the original after settings change',async()=>{
    const before=await snapshot();
    await expect(order(false,null,10)).rejects.toThrow(/tax_terms_changed/);
    expect(await snapshot()).toEqual(before);
    const quote=await order(true); await sql(`UPDATE merchant_tax_settings SET rate_bps=1000 WHERE business_id='${B}'`);
    await expect(order(false,quote.tax_snapshot,quote.server_total)).rejects.toThrow(/tax_terms_changed/);
    expect(await snapshot()).toEqual(before);
    const fresh=await order(true); const committed=await order(false,fresh.tax_snapshot,fresh.server_total);
    await sql(`UPDATE merchant_tax_settings SET rate_bps=2000 WHERE business_id='${B}'`);
    const replay=await order(false,fresh.tax_snapshot,fresh.server_total);
    expect(replay).toMatchObject({created:false,order_id:committed.order_id,tax_snapshot:fresh.tax_snapshot});
    expect((await snapshot()).stock).toBe(9);
  });
  it('previews refuse the legacy mutation branch and line tampering',async()=>{
    const before=await snapshot();
    await expect(sql(`SELECT create_order_atomic('${SESSION}','${B}','${O}',p_preview:=true)`)).rejects.toThrow(/validated_preview_required/);
    const quote=await order(true); quote.tax_snapshot.lines[0].description='Different offer';
    await expect(order(false,quote.tax_snapshot,10.75)).rejects.toThrow(/tax_terms_changed/);
    expect(await snapshot()).toEqual(before);
  });
  it('keeps tax-off checkout behavior and requires itemized taxable quotes',async()=>{
    await sql(`UPDATE merchant_tax_settings SET enabled=false WHERE business_id='${B}'`);
    expect(await order(false,null,10)).toMatchObject({created:true,server_total:10,tax_snapshot:null});
    await sql(`UPDATE merchant_tax_settings SET enabled=true WHERE business_id='${B}';
      INSERT INTO quote_requests(id,business_id,customer_phone,status,quoted_amount) VALUES('${SESSION}','${B}','15550000001','quoted',10);`);
    await expect(sql(`SELECT accept_order_quote_atomic('${SESSION}','15550000001')`)).rejects.toThrow(/itemized_tax_quote_required/);
  });
  it('catalog orders persist and return the tax total before a payment link can be created',async()=>{
    const result=(await sql(`SELECT create_catalog_order_atomic($1,$2,'15550000001','tax-meta-id','',$3) result`,[B,O,JSON.stringify([{product_id:P,quantity:1}])])).rows[0].result;
    expect(result).toMatchObject({success:true,total_amount:10.75,tax_snapshot:{grossAmount:1075}});
    expect((await sql('SELECT tax_snapshot FROM orders')).rows[0].tax_snapshot).toEqual(result.tax_snapshot);
  });
  it('keeps item volume reductions on the item, addons on its tax treatment, and delivery exempt',async()=>{
    const addon='40000000-0000-4000-8000-000000000001',zone='40000000-0000-4000-8000-000000000002';
    await sql(`INSERT INTO product_addons(id,business_id,product_id,name,price,price_type,is_active) VALUES($1,$2,$3,'Extra',2,'fixed',true);
    `,[addon,B,P]);
    await sql(`INSERT INTO delivery_zones(id,business_id,name,price,is_active) VALUES($1,$2,'Local',3,true)`,[zone,B]);
    await sql(`INSERT INTO volume_discount_rules(business_id,product_id,name,min_quantity,discount_type,discount_value,is_active) VALUES($1,$2,'Two items',2,'fixed_total',5,true)`,[B,P]);
    const items=[{product_id:P,quantity:2,unit_price:10,addons:[{id:addon,quantity:2}]}];
    const call=async(preview:boolean,expected:unknown=null)=> (await sql(`SELECT create_order_atomic(p_bot_session_id:=$1,p_business_id:=$2,p_user_id:=$3,p_items:=$4,
      p_delivery_zone_id:=$5,p_validate_products:=true,p_preview:=$6,p_expected_tax_snapshot:=$7,p_expected_total:=23.43,
      p_total_amount:=23.43,p_volume_discount_amount:=5,p_addons_total:=4) result`,[SESSION,B,O,JSON.stringify(items),zone,preview,JSON.stringify(expected)])).rows[0].result;
    const quote=await call(true);
    expect(quote).toMatchObject({server_total:23.43,server_volume_discount:5,server_addons_total:4,tax_snapshot:{netAmount:2200,taxAmount:143,grossAmount:2343}});
    expect(quote.tax_snapshot.lines).toMatchObject([{lineDiscountAmount:500,netAmount:1500,taxAmount:113},{lineDiscountAmount:0,netAmount:400,taxAmount:30},{treatment:'exempt',netAmount:300,taxAmount:0}]);
    expect((await call(false,quote.tax_snapshot)).tax_snapshot).toEqual(quote.tax_snapshot);
  });
  it('booking preview derives gross and a proportional rounded deposit, commit stores the same snapshot',async()=>{
    const terms={price:10,deposit:3,discount:0,country:'US',source:'public'};
    const quote=(await sql(`SELECT quote_booking_tax_980($1,$2,NULL,1,'[]',NULL,$3) result`,[B,S,JSON.stringify(terms)])).rows[0].result;
    expect(quote).toMatchObject({total:10.75,deposit:3.23,tax_snapshot:{grossAmount:1075}});
    const payload={business_id:B,user_id:O,service_id:S,date:'2030-01-01',time:'12:00',party_size:1,flow_type:'scheduling',
      total_amount:quote.total,deposit_amount:quote.deposit,guest_phone:'15550000001',expected_terms:{...terms,tax_snapshot:quote.tax_snapshot}};
    const result=(await sql('SELECT private.scheduling_604_create_booking($1) result',[JSON.stringify(payload)])).rows[0].result;
    expect(result).toMatchObject({success:true,committed_total:10.75,committed_deposit:3.23,tax_snapshot:quote.tax_snapshot});
    expect((await sql('SELECT tax_snapshot FROM bookings')).rows[0].tax_snapshot).toEqual(quote.tax_snapshot);
  });
  it('validates stored arithmetic and forbids snapshot rewrites',async()=>{
    const quote=await order(true); const committed=await order(false,quote.tax_snapshot,quote.server_total);
    await expect(sql(`UPDATE orders SET tax_snapshot=NULL WHERE id=$1`,[committed.order_id])).rejects.toThrow(/tax_snapshot_immutable/);
    const tampered=structuredClone(quote.tax_snapshot);tampered.lines[0].taxAmount++;tampered.lines[0].grossAmount++;tampered.taxAmount++;tampered.grossAmount++;
    await expect(sql('SELECT validate_merchant_tax_snapshot_980($1)',[JSON.stringify(tampered)])).rejects.toThrow(/invalid_tax_snapshot/);
  });
  it('preserves a zero-price service guest deposit as the original consideration, including tax-off',async()=>{
    await sql(`UPDATE services SET price=0,deposit_amount=0 WHERE id='${S}'; UPDATE businesses SET deposit_per_guest=3 WHERE id='${B}'`);
    const terms={price:0,deposit:0,discount:0,country:'US',source:'bot'};
    const preview=async()=> (await sql(`SELECT quote_booking_tax_980($1,$2,NULL,2,'[]',NULL,$3) result`,[B,S,JSON.stringify(terms)])).rows[0].result;
    expect(await preview()).toMatchObject({total:6.45,deposit:6.45,tax_snapshot:{netAmount:600,taxAmount:45,grossAmount:645}});
    await sql(`UPDATE merchant_tax_settings SET enabled=false WHERE business_id='${B}'`);
    expect(await preview()).toMatchObject({total:6,deposit:6,tax_snapshot:null});
  });
  it('previews manual bookings with no deposit and prepaid package redemption without a second tax charge',async()=>{
    const terms={price:10,deposit:3,discount:0,country:'US',source:'public'};
    const preview=async(extra:Record<string,unknown>)=> (await sql(`SELECT quote_booking_tax_980($1,$2,NULL,1,'[]',NULL,$3) result`,[B,S,JSON.stringify({...terms,...extra})])).rows[0].result;
    expect(await preview({_tax_mode:'manual'})).toMatchObject({total:10.75,deposit:0,tax_snapshot:{grossAmount:1075}});
    expect(await preview({_tax_package_redemption:true})).toMatchObject({total:10,deposit:0,tax_snapshot:null,tax_exempt_reason:'package_redemption'});
  });
  it('protects invoice historical tax metadata while allowing payment/status transitions',async()=>{
    const quote=await order(true);
    await sql(`INSERT INTO invoices(id,business_id,status,currency,total_amount,subtotal,tax_amount,tax_snapshot) VALUES($1,$2,'draft','USD',10.75,10,0.75,$3)`,[SESSION,B,JSON.stringify(quote.tax_snapshot)]);
    await sql('SET ROLE authenticated');
    await expect(sql(`UPDATE invoices SET tax_amount=0 WHERE id='${SESSION}'`)).rejects.toThrow(/invoice_tax_terms_immutable/);
    await expect(sql(`UPDATE invoices SET currency='GBP' WHERE id='${SESSION}'`)).rejects.toThrow(/invoice_tax_terms_immutable/);
    await sql('RESET ROLE; SET ROLE service_role');
    await sql(`UPDATE invoices SET status='sent' WHERE id='${SESSION}'`);
    await expect(sql(`UPDATE invoices SET subtotal=9 WHERE id='${SESSION}'`)).rejects.toThrow(/invoice_tax_terms_immutable/);
    await sql(`UPDATE invoices SET amount_paid=5 WHERE id='${SESSION}'`);
    expect((await sql(`SELECT tax_amount,amount_paid FROM invoices WHERE id='${SESSION}'`)).rows[0]).toMatchObject({tax_amount:'0.75',amount_paid:'5.00'});
  });
  it('executes owner allow, cross-owner deny, anonymous deny and item constraint checks',async()=>{
    await sql(`SET ROLE authenticated; SELECT set_config('test.uid','${O}',false);`);
    expect((await sql('SELECT business_id FROM merchant_tax_settings')).rows).toEqual([{business_id:B}]);
    await sql(`UPDATE merchant_tax_settings SET rate_bps=500 WHERE business_id='${B}'`);
    await expect(sql(`INSERT INTO merchant_tax_settings(business_id) VALUES('${OTHER}')`)).rejects.toThrow(/row-level security/);
    await expect(sql(`UPDATE merchant_tax_settings SET business_id='${OTHER}' WHERE business_id='${B}'`)).rejects.toThrow();
    await expect(sql(`DELETE FROM merchant_tax_settings WHERE business_id='${B}'`)).rejects.toThrow(/permission denied/);
    await sql('RESET ROLE; SET ROLE anon'); await expect(sql('SELECT * FROM merchant_tax_settings')).rejects.toThrow(/permission denied/);
    await sql('RESET ROLE; SET ROLE service_role');
    await expect(sql(`UPDATE products SET tax_treatment='override',tax_label=NULL,tax_rate_bps=500,tax_price_mode='exclusive' WHERE id='${P}'`)).rejects.toThrow(/check constraint/);
    await expect(sql(`UPDATE services SET tax_treatment='override',tax_label='Tax',tax_rate_bps=10001,tax_price_mode='exclusive' WHERE id='${S}'`)).rejects.toThrow(/check constraint/);
  });
  it('refuses unsupported paid capabilities only while tax is enabled and preserves free/legacy purchases',async()=>{
    const insert=(flow:string,amount:number)=>sql(`INSERT INTO bookings(business_id,flow_type,total_amount) VALUES($1,$2,$3)`,[B,flow,amount]);
    await expect(insert('table_reservation',10)).rejects.toThrow(/unsupported_tax_purchase/);
    await expect(insert('ticketing',10)).rejects.toThrow(/unsupported_tax_purchase/);
    await expect(insert('payment',10)).rejects.toThrow(/unsupported_tax_purchase/);
    await insert('ticketing',0);
    await sql(`UPDATE merchant_tax_settings SET enabled=false WHERE business_id='${B}'`);
    await insert('table_reservation',10);await insert('ticketing',10);await insert('payment',10);
    expect((await sql('SELECT count(*)::int count FROM bookings')).rows[0].count).toBe(4);
  });
  it('blocks enabling tax for unsupported currency while permitting disabled settings',async()=>{
    await sql(`INSERT INTO countries VALUES('FR','EUR'); UPDATE merchant_tax_settings SET enabled=false WHERE business_id='${B}'; UPDATE businesses SET country_code='FR' WHERE id='${B}'`);
    await sql(`SET ROLE authenticated; SELECT set_config('test.uid','${O}',false)`);
    await expect(sql(`UPDATE merchant_tax_settings SET enabled=true WHERE business_id='${B}'`)).rejects.toThrow(/unsupported_tax_currency/);
    await sql(`UPDATE merchant_tax_settings SET label='Tax',enabled=false WHERE business_id='${B}'`);
  });
  it('serializes first settings insertion against an in-flight checkout business lock',async()=>{
    await sql(`DELETE FROM merchant_tax_settings WHERE business_id='${B}'`);
    const writer=new Client({connectionString:url});await writer.connect();
    try {
      await sql('BEGIN'); const quote=await order(true);expect(quote.tax_snapshot).toBeNull();
      let finished=false;
      const write=writer.query(`SET ROLE postgres; INSERT INTO merchant_tax_settings(business_id,enabled,label,rate_bps) VALUES('${B}',true,'Tax',750)`).then(()=>{finished=true;});
      await new Promise(resolve=>setTimeout(resolve,100));expect(finished).toBe(false);
      await sql('COMMIT');await write;expect(finished).toBe(true);
      expect((await order(true)).tax_snapshot.taxAmount).toBe(75);
    } finally {await sql('ROLLBACK');await writer.end();}
  });
  it('reads stable settings without a tuple/business lock inversion while an update waits',async()=>{
    const writer=new Client({connectionString:url});await writer.connect();
    let write:Promise<unknown>|undefined;
    try {
      const pid=(await writer.query('SELECT pg_backend_pid() pid')).rows[0].pid;
      await sql(`BEGIN; SELECT id FROM businesses WHERE id='${B}' FOR SHARE`);
      write=writer.query(`SET ROLE postgres; UPDATE merchant_tax_settings SET rate_bps=1000 WHERE business_id='${B}'`);
      // Wait until the writer holds its settings tuple and is waiting for our business lock.
      let waiting=false;
      for(let attempt=0;attempt<100;attempt++){
        waiting=(await sql('SELECT cardinality(pg_blocking_pids($1))>0 waiting',[pid])).rows[0].waiting;
        if(waiting) break;
        await new Promise(resolve=>setTimeout(resolve,10));
      }
      expect(waiting).toBe(true);
      expect((await order(true)).tax_snapshot.taxAmount).toBe(75);
      await sql('COMMIT');await write;
      expect((await order(true)).tax_snapshot.taxAmount).toBe(100);
    } finally {await sql('ROLLBACK');await write;await writer.end();}
  });
});
