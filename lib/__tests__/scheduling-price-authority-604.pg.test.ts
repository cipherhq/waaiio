import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const url = process.env.TEST_DATABASE_URL;
if (process.env.REQUIRE_PG_TESTS === 'true' && !url) throw new Error('Disposable PostgreSQL is required');
const suite = url ? describe : describe.skip;
const id = (n: number) => '00000000-0000-4000-a604-' + n.toString(16).padStart(12, '0');
const business=id(1), user=id(2), service=id(3), promo=id(4), addon=id(5);
suite('M518 final-state scheduling authority', () => {
 let pool: pg.Pool;
 let admin: pg.Pool;
 const databaseName = 'core604_' + randomUUID().replaceAll('-', '');
 let databaseCreated = false;
 function payload(overrides: Record<string, unknown> = {}) {
   return { p_business_id:business,p_user_id:user,p_service_id:service,p_staff_id:null,
     p_date:'2027-12-01',p_time:'10:00',p_party_size:1,p_max_capacity:99,p_flow_type:'scheduling',
     p_deposit_amount:1000,p_deposit_status:'pending',p_status:'pending',
     p_guest_name:'Guest',p_guest_phone:'+2348000000604',p_guest_email:'core604@example.test',
     p_special_requests:null,p_venue_address:null,p_end_date:null,p_addons_snapshot:null,
     p_promo_code_id:null,p_total_amount:1000,p_staff_name:null,
     p_expected_terms:{price:1000,deposit:0,discount:0,country:'NG'},
     ...overrides };
 }
 async function rpc(overrides: Record<string,unknown> = {}, role='service_role') {
   const p=payload(overrides), entries=Object.entries(p);
   const client=await pool.connect();
   try {
     await client.query('BEGIN');
     await client.query('SET LOCAL ROLE '+role);
     const result=await client.query('SELECT to_jsonb(r) AS result FROM public.book_slot_authoritative_604('+
       entries.map(([k],i)=>k+' => $'+(i+1)).join(',')+') r',entries.map(([,v])=>typeof v==='object'&&v!==null?JSON.stringify(v):v));
     await client.query('COMMIT');
     return result.rows[0].result;
   } catch(error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
 }
 beforeAll(async()=>{
   // Bootstrap a fresh, owned database; CI's shared template contains skeletal app tables.
   const endpoint = new URL(url!);
   if (!['localhost', '127.0.0.1', '[::1]', 'postgres'].includes(endpoint.hostname)) {
     throw new Error('Core604 requires a disposable local CI PostgreSQL endpoint');
   }
   admin=new pg.Pool({connectionString:url,max:1});
   await admin.query('CREATE DATABASE "' + databaseName + '" TEMPLATE template0');
   databaseCreated = true;
   const isolatedUrl = new URL(url!);
   isolatedUrl.pathname = '/' + databaseName;
   execFileSync('bash',['scripts/ci-bootstrap-test-db.sh',isolatedUrl.toString()],{encoding:'utf8',timeout:180000,stdio:'pipe'});
   pool=new pg.Pool({connectionString:isolatedUrl.toString(),max:6});
   await pool.query("INSERT INTO auth.users(id,email) VALUES($1,'core604@example.test') ON CONFLICT DO NOTHING",[user]);
   await pool.query("INSERT INTO profiles(id,phone) VALUES($1,'+2348000000604') ON CONFLICT(id) DO UPDATE SET phone=EXCLUDED.phone",[user]);
   await pool.query(`INSERT INTO businesses(id,name,slug,address,city,neighborhood,phone,country_code,owner_id,status,metadata)
     VALUES($1,'Core604','core604','1 Test','Lagos','VI','+2348000000604','NG',$2,'active','{"prepay_mode":"full"}')`,[business,user]);
   await pool.query("INSERT INTO services(id,business_id,name,price,deposit_amount,is_active,max_capacity,duration_minutes) VALUES($1,$2,'Service',1000,0,true,1,30)",[service,business]);
 },200000);
 /** A WhatsApp session whose confirm step stored the claim the RPC must match. */
 async function botSession(terms: Record<string,unknown>, claim: Record<string,unknown> = {}) {
   const sid=randomUUID();
   await pool.query(`INSERT INTO bot_sessions(id,whatsapp_number,business_id,user_id,session_data)
     VALUES($1,'2348000000604',$2,$3,$4)`,[sid,business,user,JSON.stringify({_604_confirmation:{
       service_id:service,date:'2027-12-01',time:'10:00:00',party_size:1,terms,...claim}})]);
   return sid;
 }
 beforeEach(async()=>{
   await pool.query('UPDATE bookings SET payment_id=NULL WHERE business_id=$1',[business]);
   await pool.query('DELETE FROM payments WHERE business_id=$1',[business]);
   await pool.query('DELETE FROM bookings WHERE business_id=$1',[business]);
   await pool.query('DELETE FROM bot_sessions WHERE business_id=$1',[business]);
   await pool.query('DELETE FROM appointments WHERE business_id=$1',[business]);
   await pool.query('DELETE FROM service_addons WHERE business_id=$1',[business]);
   await pool.query('DELETE FROM promo_codes WHERE business_id=$1',[business]);
   await pool.query("UPDATE businesses SET metadata='{\"prepay_mode\":\"full\"}',deposit_per_guest=0 WHERE id=$1",[business]);
   await pool.query('UPDATE services SET price=1000,deposit_amount=0,max_capacity=1,is_active=true,price_is_variable=false WHERE id=$1',[service]);
 });
 afterAll(async()=>{
   await pool?.end();
   try {
     if (databaseCreated) await admin.query('DROP DATABASE "' + databaseName + '"');
   } finally { await admin?.end(); }
 });
 it('commits full value and payable from authoritative rows',async()=>{
   const r=await rpc();
   expect(r).toMatchObject({slot_available:true,committed_total:1000,committed_deposit:1000});
   expect((await pool.query('SELECT total_amount::int,deposit_amount::int FROM bookings WHERE id=$1',[r.booking_id])).rows[0])
     .toEqual({total_amount:1000,deposit_amount:1000});
 });
 it('multiplies service value by participants',async()=>{
   expect(await rpc({p_party_size:3,p_total_amount:3000,p_deposit_amount:3000})).toMatchObject({committed_total:3000,committed_deposit:3000});
 });
 it('keeps explicit service deposit flat and separate from full value',async()=>{
   await pool.query('UPDATE services SET deposit_amount=200 WHERE id=$1',[service]);
   expect(await rpc({p_party_size:3,p_total_amount:3000,p_deposit_amount:200,
     p_expected_terms:{price:1000,deposit:200,discount:0,country:'NG'}})).toMatchObject({committed_total:3000,committed_deposit:200});
 });
 it('rejects stale price without creating a booking',async()=>{
   await pool.query('UPDATE services SET price=1200 WHERE id=$1',[service]);
   await expect(rpc()).rejects.toThrow('terms_changed');
   expect((await pool.query('SELECT count(*)::int n FROM bookings WHERE business_id=$1',[business])).rows[0].n).toBe(0);
 });
 it('rejects mismatched business identity',async()=>{
   await expect(rpc({p_business_id:id(99)})).rejects.toThrow('business_unavailable');
 });
 it('books a "price varies" item without a session claim at its stored starting price',async()=>{
   await pool.query('UPDATE services SET price_is_variable=true WHERE id=$1',[service]);
   const r=await rpc();
   expect(r).toMatchObject({slot_available:true,committed_total:1000,committed_deposit:1000});
 });
 it('rejects a "price varies" amount other than the starting price without a session claim',async()=>{
   await pool.query('UPDATE services SET price_is_variable=true WHERE id=$1',[service]);
   for (const price of [900,1500]) {
     await expect(rpc({p_total_amount:price,p_deposit_amount:price,
       p_expected_terms:{price,deposit:0,discount:0,country:'NG'}})).rejects.toThrow('terms_changed');
   }
   expect((await pool.query('SELECT count(*)::int n FROM bookings WHERE business_id=$1',[business])).rows[0].n).toBe(0);
 });
 it('books a "price varies" item from the dashboard at its starting price with nothing due',async()=>{
   await pool.query('UPDATE services SET price_is_variable=true WHERE id=$1',[service]);
   const client=await pool.connect();
   try {
     await client.query('BEGIN');
     await client.query('SET LOCAL ROLE service_role');
     const r=(await client.query(`SELECT to_jsonb(m) AS m FROM public.book_manual_slot_authoritative_604(p_business_id=>$1,p_user_id=>$2,
       p_service_id=>$3,p_staff_id=>NULL,p_date=>'2027-12-06',p_time=>'10:00',p_party_size=>1,p_max_capacity=>99,
       p_guest_name=>'Desk',p_guest_phone=>'+2348000000607',p_guest_email=>NULL,p_notes=>NULL,p_total_amount=>1000,
       p_staff_name=>NULL,p_expected_terms=>$4::jsonb) m`,[business,user,service,JSON.stringify({price:1000,deposit:0,discount:0,country:'NG'})])).rows[0].m;
     await client.query('COMMIT');
     expect(r).toMatchObject({slot_available:true,committed_total:1000,committed_deposit:0});
   } catch(error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
 });
 it('books a "price varies" item with a deposit above its starting price from the public page',async()=>{
   await pool.query('UPDATE services SET price_is_variable=true,deposit_amount=5000 WHERE id=$1',[service]);
   expect(await rpc({p_total_amount:5000,p_deposit_amount:5000,
     p_expected_terms:{price:1000,deposit:5000,discount:0,country:'NG',quantity:1,source:'public'}}))
     .toMatchObject({slot_available:true,committed_total:5000,committed_deposit:5000});
 });
 it('books a "price varies" item with a deposit above its starting price from WhatsApp',async()=>{
   await pool.query('UPDATE services SET price_is_variable=true,deposit_amount=5000 WHERE id=$1',[service]);
   const terms={price:1000,deposit:5000,discount:0,country:'NG'};
   const sid=await botSession(terms);
   expect(await rpc({p_bot_session_id:sid,p_total_amount:5000,p_deposit_amount:5000,p_expected_terms:terms}))
     .toMatchObject({slot_available:true,committed_total:5000,committed_deposit:5000});
 });
 it('keeps public and dashboard bookings of a service with a required add-on working',async()=>{
   await pool.query("INSERT INTO service_addons(id,business_id,service_id,name,price,is_active,is_required) VALUES($1,$2,$3,'Required',100,true,true)",[addon,business,service]);
   expect(await rpc({p_expected_terms:{price:1000,deposit:0,discount:0,country:'NG',quantity:1,source:'public'}}))
     .toMatchObject({slot_available:true,committed_total:1000});
 });
 it('still requires the required add-on in WhatsApp bookings',async()=>{
   await pool.query("INSERT INTO service_addons(id,business_id,service_id,name,price,is_active,is_required) VALUES($1,$2,$3,'Required',100,true,true)",[addon,business,service]);
   const terms={price:1000,deposit:0,discount:0,country:'NG'};
   const sid=await botSession(terms);
   await expect(rpc({p_bot_session_id:sid,p_expected_terms:terms})).rejects.toThrow('required_addon_missing');
 });
 it('books a free service at a business with a per-guest deposit, as the bot did',async()=>{
   await pool.query('UPDATE services SET price=0,max_capacity=5 WHERE id=$1',[service]);
   await pool.query('UPDATE businesses SET deposit_per_guest=500 WHERE id=$1',[business]);
   expect(await rpc({p_party_size:2,p_total_amount:1000,p_deposit_amount:1000,
     p_expected_terms:{price:0,deposit:0,discount:0,country:'NG'}}))
     .toMatchObject({slot_available:true,committed_total:1000,committed_deposit:1000});
 });
 it('books an appointment whose numeric price is stored with decimals',async()=>{
   const appt=randomUUID();
   await pool.query("INSERT INTO appointments(id,business_id,name,price,deposit_amount,is_active,duration_minutes,max_capacity) VALUES($1,$2,'Appt',1500.00,0.00,true,30,1)",[appt,business]);
   expect(await rpc({p_service_id:null,p_appointment_id:appt,p_total_amount:1500,p_deposit_amount:1500,
     p_expected_terms:{price:1500,deposit:0,discount:0,country:'NG'}}))
     .toMatchObject({slot_available:true,committed_total:1500,committed_deposit:1500});
 });
 it('lets a WhatsApp customer rebook in the same session after cancelling an unpaid booking',async()=>{
   await pool.query('UPDATE services SET max_capacity=5 WHERE id=$1',[service]);
   const terms={price:1000,deposit:0,discount:0,country:'NG'};
   const sid=await botSession(terms);
   const first=await rpc({p_bot_session_id:sid,p_expected_terms:terms});
   expect((await rpc({p_bot_session_id:sid,p_expected_terms:terms})).booking_id).toBe(first.booking_id);
   await pool.query("UPDATE bookings SET status='cancelled' WHERE id=$1",[first.booking_id]);
   await pool.query(`UPDATE bot_sessions SET session_data=jsonb_set(session_data,'{_604_confirmation,date}','"2027-12-02"') WHERE id=$1`,[sid]);
   const second=await rpc({p_bot_session_id:sid,p_date:'2027-12-02',p_expected_terms:terms});
   expect(second).toMatchObject({slot_available:true});
   expect(second.booking_id).not.toBe(first.booking_id);
 });
 it('reserves a promo, then counts it once on payment even when another checkout is linked',async()=>{
   await pool.query("INSERT INTO promo_codes(id,business_id,code,discount_type,discount_value,max_uses,current_uses,is_active) VALUES($1,$2,'P604','fixed',100,5,0,true)",[promo,business]);
   const r=await rpc({p_promo_code_id:promo,p_total_amount:900,p_deposit_amount:900,
     p_expected_terms:{price:1000,deposit:0,discount:100,country:'NG'}});
   expect(r).toMatchObject({committed_total:900,committed_deposit:900});
   expect((await pool.query('SELECT state FROM promo_reservations WHERE booking_id=$1',[r.booking_id])).rows).toEqual([{state:'reserved'}]);
   const pay1=randomUUID(), pay2=randomUUID();
   for (const [pid,ref] of [[pay1,'core604-a'],[pay2,'core604-b']]) {
     await pool.query("INSERT INTO payments(id,booking_id,business_id,amount,gateway_reference,status) VALUES($1,$2,$3,900,$4,'pending')",[pid,r.booking_id,business,ref]);
   }
   // initializePayment repointed the booking at the newer checkout; the earlier one is paid.
   await pool.query('UPDATE bookings SET payment_id=$2 WHERE id=$1',[r.booking_id,pay2]);
   await pool.query("UPDATE payments SET status='success' WHERE id=$1",[pay1]);
   await pool.query("UPDATE bookings SET deposit_status='paid',status='confirmed',confirmed_at=now() WHERE id=$1 AND status='pending'",[r.booking_id]);
   const after=async()=>(await pool.query(`SELECT b.status::text,b.deposit_status::text,pr.state,pc.current_uses
     FROM bookings b JOIN promo_reservations pr ON pr.booking_id=b.id JOIN promo_codes pc ON pc.id=pr.promo_code_id WHERE b.id=$1`,[r.booking_id])).rows[0];
   expect(await after()).toEqual({status:'confirmed',deposit_status:'paid',state:'finalized',current_uses:1});
   const client=await pool.connect();
   try {
     await client.query('BEGIN'); await client.query('SET LOCAL ROLE service_role');
     const f=(await client.query('SELECT public.finalize_booking_promo_reservation($1,$2) AS f',[r.booking_id,pay1])).rows[0].f;
     await client.query('COMMIT');
     expect(f).toMatchObject({finalized:true});
   } finally { client.release(); }
   expect(await after()).toEqual({status:'confirmed',deposit_status:'paid',state:'finalized',current_uses:1});
 });
 it('releases the promo when an unpaid booking is cancelled',async()=>{
   await pool.query("INSERT INTO promo_codes(id,business_id,code,discount_type,discount_value,max_uses,current_uses,is_active) VALUES($1,$2,'P604','fixed',100,1,0,true)",[promo,business]);
   const terms={price:1000,deposit:0,discount:100,country:'NG'};
   const r=await rpc({p_promo_code_id:promo,p_total_amount:900,p_deposit_amount:900,p_expected_terms:terms});
   await expect(rpc({p_promo_code_id:promo,p_guest_phone:'+2348000000609',p_time:'11:00',p_total_amount:900,p_deposit_amount:900,p_expected_terms:terms}))
     .rejects.toThrow('promo_exhausted');
   await pool.query("UPDATE bookings SET status='cancelled' WHERE id=$1",[r.booking_id]);
   expect((await pool.query('SELECT state FROM promo_reservations WHERE booking_id=$1',[r.booking_id])).rows).toEqual([{state:'released'}]);
   expect((await pool.query('SELECT current_uses FROM promo_codes WHERE id=$1',[promo])).rows[0].current_uses).toBe(0);
 });
 it('derives addon value from its locked row',async()=>{
   await pool.query("INSERT INTO service_addons(id,business_id,service_id,name,price,is_active,is_required) VALUES($1,$2,$3,'Addon',100,true,false)",[addon,business,service]);
   expect(await rpc({p_addons_snapshot:[{id:addon,name:'Addon',price:100}],p_total_amount:1100,p_deposit_amount:1100}))
     .toMatchObject({committed_total:1100,committed_deposit:1100});
 });
 it('rejects stale addon terms',async()=>{
   await pool.query("INSERT INTO service_addons(id,business_id,service_id,name,price,is_active,is_required) VALUES($1,$2,$3,'Addon',100,true,false)",[addon,business,service]);
   await expect(rpc({p_addons_snapshot:[{id:addon,price:1}]})).rejects.toThrow('addon_terms_changed');
 });
 it('serializes the last authoritative slot despite caller capacity 99',async()=>{
   const results=await Promise.all([rpc(),rpc({p_guest_phone:'+2348000000605'})]);
   expect(results.filter(r=>r.slot_available)).toHaveLength(1);
 });
 it.each(['anon','authenticated'])('denies the %s HTTP role at the RPC boundary',async role=>{
   await expect(rpc({},role)).rejects.toThrow(/permission denied/);
 });
 it('books the live public-route payload unchanged through the untouched legacy function',async()=>{
   // Live public route before this deploy: total = deposit = deposit x party, no expected terms.
   await pool.query('UPDATE services SET price=5000,deposit_amount=1000,max_capacity=5 WHERE id=$1',[service]);
   const client=await pool.connect();
   try {
     await client.query('BEGIN');
     await client.query('SET LOCAL ROLE service_role');
     const r=(await client.query(`SELECT * FROM public.book_slot_atomic(p_business_id=>$1,p_user_id=>$2,p_service_id=>$3,
       p_staff_id=>NULL,p_date=>'2027-12-04',p_time=>'10:00',p_party_size=>2,p_max_capacity=>5,p_flow_type=>'scheduling',
       p_deposit_amount=>2000,p_deposit_status=>'pending',p_status=>'pending',p_guest_name=>'Live',p_guest_phone=>'+2348000000606',
       p_guest_email=>NULL,p_special_requests=>NULL,p_venue_address=>NULL,p_end_date=>NULL,p_addons_snapshot=>NULL,
       p_promo_code_id=>NULL,p_total_amount=>2000,p_staff_name=>NULL)`,[business,user,service])).rows[0];
     await client.query('COMMIT');
     expect(r.slot_available).toBe(true);
     const row=(await pool.query('SELECT total_amount::int,deposit_amount::int,status::text,metadata FROM bookings WHERE id=$1',[r.booking_id])).rows[0];
     expect(row).toMatchObject({total_amount:2000,deposit_amount:2000,status:'pending'});
     expect(row.metadata?.scheduling_authority_604).toBeUndefined();
   } catch(error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
 });
 it('keeps the new entry points service-role only and the old ones unchanged in place',async()=>{
   const rows=(await pool.query(`SELECT p.proname, n.nspname,
       has_function_privilege('anon',p.oid,'EXECUTE') anon, has_function_privilege('authenticated',p.oid,'EXECUTE') auth,
       has_function_privilege('service_role',p.oid,'EXECUTE') svc
     FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE p.proname IN ('book_slot_atomic','book_manual_slot_atomic','book_with_package_atomic',
       'book_slot_authoritative_604','book_manual_slot_authoritative_604','book_with_package_authoritative_604',
       'finalize_booking_promo_reservation') ORDER BY 1`)).rows;
   expect(rows.map(r=>r.proname)).toEqual(['book_manual_slot_atomic','book_manual_slot_authoritative_604',
     'book_slot_atomic','book_slot_authoritative_604','book_with_package_atomic','book_with_package_authoritative_604',
     'finalize_booking_promo_reservation']);
   for (const r of rows) expect(r).toMatchObject({nspname:'public',anon:false,auth:false,svc:true});
 });
 it('preserves the exact legacy signature and direct-payment function',async()=>{
   const row=(await pool.query(`SELECT
    to_regprocedure('public.book_slot_atomic(uuid,uuid,uuid,uuid,date,text,integer,integer,text,integer,text,text,text,text,text,text,text,date,jsonb,uuid,integer,text,uuid,uuid,integer,integer,uuid,uuid,integer,integer)') IS NOT NULL AS legacy,
    to_regprocedure('public.create_payment_booking_atomic(uuid,uuid,uuid,uuid,integer,text,text,text,integer)') IS NOT NULL AS direct,
    to_regprocedure('public.cancel_booking_with_release(uuid,text,uuid)') IS NOT NULL AS cancel`)).rows[0];
   expect(row).toEqual({legacy:true,direct:true,cancel:true});
 });
});
